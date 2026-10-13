import { randomUUID } from "node:crypto";
import { and, eq, isNull, or, gte, lt } from "drizzle-orm";
import { Temporal } from "@js-temporal/polyfill";
import { db, sqlite } from "./db";
import { calendarEvents } from "./schema";
import { HttpError } from "./http";
import { completionEvent } from "./jobs";
import { journalPeriodSql, journalStartSql } from "./journal-classification";
import {
  resolveTaskSchedule,
  storedTaskScheduleSchema,
} from "../task-planning";
import {
  eventInput,
  eventPayload,
  eventOccurrences,
  addDays,
  zoneDay,
  localInstant,
  type CalendarEvent,
  type EventInput,
  type CalendarItem,
  type CalendarRange,
} from "../calendar";
const rangeCaches = new WeakMap<
  ReturnType<typeof sqlite>,
  Map<string, { stamp: string; at: number; value: CalendarRange }>
>();
const tables = {
  note: "notes",
  journal: "notes",
  task: "tasks",
  bookmark: "bookmarks",
  artifact: "artifacts",
  form: "forms",
};
export function getEvent(owner: string, id: string): CalendarEvent {
  const row = db()
    .select()
    .from(calendarEvents)
    .where(and(eq(calendarEvents.id, id), eq(calendarEvents.ownerId, owner)))
    .get();
  if (!row) throw new HttpError(404, "This event was not found.");
  return {
    ...row.data,
    id: row.id,
    ownerId: owner,
    revision: row.revision,
    trashedAt: row.trashedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
function validateLinks(owner: string, input: EventInput) {
  for (const link of input.links) {
    const row = sqlite()
      .prepare(
        "SELECT id FROM " +
          tables[link.type] +
          " WHERE id=? AND owner_id=? AND trashed_at IS NULL" +
          (link.type === "journal"
            ? ` AND ${journalPeriodSql("notes")} IS NOT NULL`
            : link.type === "note"
              ? ` AND kind='note' AND ${journalPeriodSql("notes")} IS NULL`
              : ""),
      )
      .get(link.id, owner);
    if (!row) throw new HttpError(400, "A linked item is no longer available.");
  }
}
function syncLinks(event: CalendarEvent) {
  const d = sqlite();
  d.prepare("DELETE FROM calendar_links WHERE event_id=?").run(event.id);
  for (const link of event.links)
    d.prepare("INSERT OR IGNORE INTO calendar_links VALUES(?,?,?)").run(
      event.id,
      link.type,
      link.id,
    );
}
export function createEvent(owner: string, input: unknown) {
  return sqlite()
    .transaction(() => {
      const value = eventInput.parse(input);
      validateLinks(owner, value);
      const now = Date.now();
      const row = db()
        .insert(calendarEvents)
        .values({
          id: randomUUID(),
          ownerId: owner,
          title: value.title,
          description: value.description,
          startDate: value.start.slice(0, 10),
          endDate: value.end.slice(0, 10),
          recurring: !!value.recurrence,
          data: value,
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .get();
      const event = getEvent(owner, row.id);
      syncLinks(event);
      completionEvent(owner, "content", row.id, "changed");
      return event;
    })
    .immediate();
}
export type EventScope = "series" | "occurrence" | "following";
function requireOccurrence(event: CalendarEvent, occurrence?: string) {
  if (!occurrence || !event.recurrence)
    throw new HttpError(400, "Choose a recurring occurrence.");
  const day = occurrence.slice(0, 10);
  if (
    !eventOccurrences(
      event,
      addDays(day, -2),
      addDays(day, 3),
      event.timezone,
    ).some((item) => item.occurrence === occurrence)
  )
    throw new HttpError(400, "This occurrence is outside the series.");
  return occurrence;
}
function writeEvent(
  owner: string,
  id: string,
  revision: number,
  input: EventInput,
) {
  const row = db()
    .update(calendarEvents)
    .set({
      title: input.title,
      description: input.description,
      startDate: input.start.slice(0, 10),
      endDate: input.end.slice(0, 10),
      recurring: !!input.recurrence,
      data: input,
      updatedAt: Date.now(),
      revision: revision + 1,
    })
    .where(
      and(
        eq(calendarEvents.id, id),
        eq(calendarEvents.ownerId, owner),
        eq(calendarEvents.revision, revision),
        isNull(calendarEvents.trashedAt),
      ),
    )
    .returning()
    .get();
  if (!row)
    throw new HttpError(409, "This event changed. Reload it before saving.");
  const event = getEvent(owner, id);
  syncLinks(event);
  sqlite()
    .prepare(
      "UPDATE calendar_reminders SET state='cancelled' WHERE source_type='event' AND source_id=? AND state='queued'",
    )
    .run(id);
  completionEvent(owner, "content", id, "changed");
  return event;
}
export function updateEvent(
  owner: string,
  id: string,
  revision: number,
  input: unknown,
  scope: EventScope = "series",
  occurrence?: string,
) {
  const value = eventInput.parse(input);
  validateLinks(owner, value);
  return sqlite()
    .transaction(() => {
      const current = getEvent(owner, id);
      if (current.trashedAt || current.revision !== revision)
        throw new HttpError(
          409,
          "This event changed. Reload it before saving.",
        );
      if (scope === "series") return writeEvent(owner, id, revision, value);
      const key = requireOccurrence(current, occurrence);
      if (scope === "occurrence") {
        const existing = sqlite()
          .prepare(
            "SELECT override_id AS id FROM calendar_exceptions WHERE event_id=? AND occurrence=?",
          )
          .get(id, key) as { id: string | null } | undefined;
        const previous = existing?.id ? getEvent(owner, existing.id) : null;
        const event =
          previous && !previous.trashedAt
            ? writeEvent(owner, previous.id, previous.revision, {
                ...value,
                recurrence: null,
              })
            : createEvent(owner, { ...value, recurrence: null });
        sqlite()
          .prepare(
            "INSERT OR IGNORE INTO event_tags(event_id,tag_id) SELECT ?,tag_id FROM event_tags WHERE event_id=?",
          )
          .run(event.id, id);
        sqlite()
          .prepare(
            "INSERT INTO calendar_exceptions VALUES(?,?,?) ON CONFLICT(event_id,occurrence) DO UPDATE SET override_id=excluded.override_id",
          )
          .run(id, key, event.id);
        writeEvent(owner, id, revision, eventPayload(current));
        return event;
      }
      const end = addDays(key.slice(0, 10), -1);
      writeEvent(owner, id, revision, {
        ...eventPayload(current),
        recurrence: { ...current.recurrence!, count: null, until: end },
      });
      let following = value;
      if (
        current.recurrence?.count &&
        value.recurrence?.count === current.recurrence.count
      ) {
        const before = eventOccurrences(
          current,
          current.start.slice(0, 10),
          addDays(key.slice(0, 10), 1),
          current.timezone,
        ).filter((item) => item.occurrence! < key).length;
        following = {
          ...value,
          recurrence: {
            ...value.recurrence,
            count: Math.max(1, current.recurrence.count - before),
          },
        };
      }
      const event = createEvent(owner, following);
      sqlite()
        .prepare(
          "INSERT OR IGNORE INTO event_tags(event_id,tag_id) SELECT ?,tag_id FROM event_tags WHERE event_id=?",
        )
        .run(event.id, id);
      sqlite()
        .prepare(
          "UPDATE calendar_exceptions SET event_id=? WHERE event_id=? AND occurrence>=?",
        )
        .run(event.id, id, key);
      return event;
    })
    .immediate();
}
export function trashEvent(
  owner: string,
  id: string,
  revision: number,
  scope: EventScope = "series",
  occurrence?: string,
) {
  return sqlite()
    .transaction(() => {
      const current = getEvent(owner, id);
      if (current.revision !== revision || current.trashedAt)
        throw new HttpError(
          409,
          "This event changed. Reload Calendar and try again.",
        );
      let target = current;
      if (scope !== "series") {
        const key = requireOccurrence(current, occurrence);
        const items = eventOccurrences(
          current,
          addDays(key.slice(0, 10), -1),
          addDays(key.slice(0, 10), 2),
          current.timezone,
        );
        const item = items.find((v) => v.occurrence === key)!;
        const input = {
          ...eventPayload(current),
          start: key,
          end: current.allDay
            ? item.endDate!
            : localInstant(item.endAt!, current.timezone),
          recurrence: scope === "following" ? current.recurrence : null,
        };
        target = updateEvent(owner, id, revision, input, scope, key);
      }
      db()
        .update(calendarEvents)
        .set({
          trashedAt: Date.now(),
          updatedAt: Date.now(),
          revision: target.revision + 1,
        })
        .where(eq(calendarEvents.id, target.id))
        .run();
      const trashedAt = getEvent(owner, target.id).trashedAt!;
      sqlite()
        .prepare(
          "UPDATE calendar_events SET trashed_at=?,updated_at=?,revision=revision+1 WHERE owner_id=? AND trashed_at IS NULL AND id IN (SELECT override_id FROM calendar_exceptions WHERE event_id=?)",
        )
        .run(trashedAt, trashedAt, owner, target.id);
      sqlite()
        .prepare(
          "UPDATE calendar_reminders SET state='cancelled' WHERE source_type='event' AND source_id=? AND state='queued'",
        )
        .run(target.id);
      completionEvent(owner, "content", target.id, "trashed");
      return { ok: true };
    })
    .immediate();
}
function taskItems(
  owner: string,
  from: string,
  to: string,
  zone: string,
): CalendarItem[] {
  const rows = sqlite()
    .prepare(
      "SELECT id,title,revision,planned_date AS plannedDate,due_date AS dueDate,completed_at AS completedAt,schedule_start_local AS scheduleStartLocal,schedule_timezone AS scheduleTimezone,schedule_duration_minutes AS scheduleDurationMinutes,schedule_disambiguation AS scheduleDisambiguation,schedule_issue AS scheduleIssue FROM tasks INDEXED BY tasks_owner_planned_idx WHERE owner_id=? AND trashed_at IS NULL AND planned_date>=? AND planned_date<? UNION SELECT id,title,revision,planned_date AS plannedDate,due_date AS dueDate,completed_at AS completedAt,schedule_start_local AS scheduleStartLocal,schedule_timezone AS scheduleTimezone,schedule_duration_minutes AS scheduleDurationMinutes,schedule_disambiguation AS scheduleDisambiguation,schedule_issue AS scheduleIssue FROM tasks INDEXED BY tasks_owner_due_idx WHERE owner_id=? AND trashed_at IS NULL AND due_date>=? AND due_date<? UNION SELECT id,title,revision,planned_date AS plannedDate,due_date AS dueDate,completed_at AS completedAt,schedule_start_local AS scheduleStartLocal,schedule_timezone AS scheduleTimezone,schedule_duration_minutes AS scheduleDurationMinutes,schedule_disambiguation AS scheduleDisambiguation,schedule_issue AS scheduleIssue FROM tasks INDEXED BY tasks_owner_schedule_idx WHERE owner_id=? AND trashed_at IS NULL AND schedule_start_local>=? AND schedule_start_local<?",
    )
    .all(
      owner,
      from,
      to,
      owner,
      from,
      to,
      owner,
      `${addDays(from, -2)}T00:00`,
      `${addDays(to, 2)}T00:00`,
    ) as {
    id: string;
    title: string;
    revision: number;
    plannedDate: string | null;
    dueDate: string | null;
    completedAt: number | null;
    scheduleStartLocal: string | null;
    scheduleTimezone: string | null;
    scheduleDurationMinutes: number | null;
    scheduleDisambiguation: "earlier" | "later" | "reject" | null;
    scheduleIssue: "needs-scheduling" | null;
  }[];
  return rows.flatMap((row) => {
    const items: CalendarItem[] = [];
    const hasSchedule =
      row.scheduleStartLocal !== null &&
      row.scheduleTimezone !== null &&
      row.scheduleDurationMinutes !== null &&
      row.scheduleDisambiguation !== null;
    let scheduleDate: string | null = null;
    if (hasSchedule) {
      try {
        const schedule = storedTaskScheduleSchema.parse({
          start: row.scheduleStartLocal,
          timezone: row.scheduleTimezone,
          durationMinutes: row.scheduleDurationMinutes,
          disambiguation: row.scheduleDisambiguation,
        });
        const resolved = resolveTaskSchedule(schedule);
        scheduleDate = Temporal.Instant.fromEpochMilliseconds(resolved.startAt)
          .toZonedDateTimeISO(zone)
          .toPlainDate()
          .toString();
        if (scheduleDate >= from && scheduleDate < to) {
          if (row.scheduleIssue) {
            items.push({
              id: `${row.id}:schedule-issue`,
              sourceId: row.id,
              type: "task",
              title: row.title,
              date: scheduleDate,
              label: "Needs scheduling",
              revision: row.revision,
              completed: row.completedAt !== null,
              scheduleIssue: "needs-scheduling",
            });
          } else {
            items.push({
              id: `${row.id}:schedule`,
              sourceId: row.id,
              type: "task",
              title: row.title,
              date: scheduleDate,
              startAt: resolved.startAt,
              endAt: resolved.endAt,
              label:
                row.dueDate === scheduleDate ? "Scheduled · Due" : "Scheduled",
              revision: row.revision,
              completed: row.completedAt !== null,
            });
          }
        }
      } catch {
        scheduleDate = row.plannedDate;
        if (scheduleDate && scheduleDate >= from && scheduleDate < to)
          items.push({
            id: `${row.id}:schedule-issue`,
            sourceId: row.id,
            type: "task",
            title: row.title,
            date: scheduleDate,
            label: "Needs scheduling",
            revision: row.revision,
            completed: row.completedAt !== null,
            scheduleIssue: "needs-scheduling",
          });
      }
    }
    const markerDates = [
      ...new Set(
        (hasSchedule ? [row.dueDate] : [row.plannedDate, row.dueDate]).filter(
          (value): value is string =>
            !!value && value >= from && value < to && value !== scheduleDate,
        ),
      ),
    ];
    for (const date of markerDates) {
      const planned = date === row.plannedDate;
      const due = date === row.dueDate;
      items.push({
        id: `${row.id}:${date}`,
        sourceId: row.id,
        type: "task",
        title: row.title,
        date,
        label: planned && due ? "Planned · Due" : planned ? "Planned" : "Due",
        revision: row.revision,
        completed: row.completedAt !== null,
      });
    }
    return items;
  });
}
function activity(
  owner: string,
  from: string,
  to: string,
  zone: string,
): CalendarItem[] {
  const a = zoneDay(from, zone),
    b = zoneDay(to, zone);
  const boundaries = [{ date: from, at: a }];
  for (let day = addDays(from, 1); day < to; day = addDays(day, 1))
    boundaries.push({ date: day, at: zoneDay(day, zone) });
  const activityDate = (at: number) => {
    let low = 0,
      high = boundaries.length;
    while (low + 1 < high) {
      const mid = (low + high) >>> 1;
      if (boundaries[mid].at <= at) low = mid;
      else high = mid;
    }
    return boundaries[low].date;
  };
  const result: CalendarItem[] = [];
  for (const [type, table] of Object.entries(tables)) {
    if (type === "journal") continue;
    const rows = sqlite()
      .prepare(
        "SELECT id," +
          (type === "artifact" ? "coalesce(nullif(title,''),name)" : "title") +
          " AS title,revision,created_at AS at" +
          (type === "note"
            ? ",daily_date AS dailyDate,journal_period AS journalPeriod,journal_period_start AS journalPeriodStart"
            : "") +
          " FROM " +
          table +
          (type === "note" ? " INDEXED BY notes_activity_idx" : "") +
          " WHERE owner_id=? AND trashed_at IS NULL AND created_at>=? AND created_at<? ORDER BY created_at DESC",
      )
      .all(owner, a, b) as {
      id: string;
      title: string;
      revision: number;
      at: number;
      dailyDate?: string;
      journalPeriod?: string | null;
      journalPeriodStart?: string | null;
    }[];
    result.push(
      ...rows.map((row) => ({
        id: "created:" + row.id,
        sourceId: row.id,
        type:
          row.journalPeriod || row.dailyDate
            ? "journal"
            : (type as CalendarItem["type"]),
        title: row.title,
        date: activityDate(row.at),
        startAt: row.at,
        label: "Created",
        revision: row.revision,
      })),
    );
  }
  const completed = sqlite()
    .prepare(
      "SELECT id,title,revision,completed_at AS at FROM tasks INDEXED BY tasks_completed_activity_idx WHERE owner_id=? AND trashed_at IS NULL AND completed_at>=? AND completed_at<?",
    )
    .all(owner, a, b) as {
    id: string;
    title: string;
    revision: number;
    at: number;
  }[];
  result.push(
    ...completed.map((row) => ({
      id: "completed:" + row.id,
      sourceId: row.id,
      type: "task" as const,
      title: row.title,
      date: activityDate(row.at),
      startAt: row.at,
      label: "Completed",
      revision: row.revision,
      completed: true,
    })),
  );
  const days = boundaries.map((day, index) => [
    day.date,
    day.at,
    boundaries[index + 1]?.at ?? b,
  ]);
  const responses = sqlite()
    .prepare(
      `WITH days(date,start,finish) AS (VALUES ${days.map(() => "(?,?,?)").join(",")}) SELECT f.id,f.title,f.revision,days.date,count(*) AS count FROM days JOIN form_responses r ON r.created_at>=days.start AND r.created_at<days.finish JOIN forms f ON f.id=r.form_id WHERE f.owner_id=? AND f.trashed_at IS NULL AND r.trashed_at IS NULL GROUP BY f.id,days.date`,
    )
    .all(...days.flat(), owner) as {
    id: string;
    title: string;
    revision: number;
    date: string;
    count: number;
  }[];
  result.push(
    ...responses.map((row) => ({
      id: `form-responses:${row.id}:${row.date}`,
      sourceId: row.id,
      type: "form" as const,
      title: row.title,
      date: row.date,
      label: `${row.count.toLocaleString()} ${row.count === 1 ? "submission" : "submissions"}`,
      revision: row.revision,
    })),
  );
  return result;
}
export function calendarRange(
  owner: string,
  from: string,
  to: string,
  zone: string,
  options: {
    mode?: string;
    eventsOnly?: boolean;
    includeCompleted?: boolean;
    preview?: number;
    offset?: number;
    limit?: number;
    tag?: string;
    query?: string;
  } = {},
): CalendarRange {
  if (
    Temporal.PlainDate.from(to).since(Temporal.PlainDate.from(from)).days >
      370 ||
    to <= from
  )
    throw new HttpError(400, "Choose a calendar range of at most one year.");
  const connection = sqlite(),
    stamp =
      String(connection.pragma("data_version", { simple: true })) +
      ":" +
      String(
        (
          connection.prepare("SELECT total_changes() AS n").get() as {
            n: number;
          }
        ).n,
      ),
    key = JSON.stringify([owner, from, to, zone, options]);
  let cache = rangeCaches.get(connection);
  if (!cache) {
    cache = new Map();
    rangeCaches.set(connection, cache);
  }
  const cached = cache.get(key);
  if (cached && cached.stamp === stamp && Date.now() - cached.at < 30000)
    return cached.value;
  let items: CalendarItem[] = [];
  if (options.mode === "activity") items = activity(owner, from, to, zone);
  else {
    items = options.eventsOnly ? [] : taskItems(owner, from, to, zone);
    const journals = sqlite()
      .prepare(
        `SELECT id,title,revision,${journalStartSql("notes")} AS date FROM notes WHERE owner_id=? AND kind='note' AND trashed_at IS NULL AND ${journalPeriodSql("notes")} IS NOT NULL AND ${journalStartSql("notes")}>=? AND ${journalStartSql("notes")}<?`,
      )
      .all(owner, options.eventsOnly ? to : from, to) as {
      id: string;
      title: string;
      revision: number;
      date: string;
    }[];
    items.push(
      ...journals.map((row) => ({
        ...row,
        sourceId: row.id,
        type: "journal" as const,
        label: "Journal",
      })),
    );
    if (!options.eventsOnly) {
      const deadlines = sqlite()
        .prepare(
          "SELECT id,title,revision,closes_at AS closesAt FROM forms WHERE owner_id=? AND trashed_at IS NULL AND status!='draft' AND closes_at>? AND closes_at<=?",
        )
        .all(owner, zoneDay(from, zone), zoneDay(to, zone)) as {
        id: string;
        title: string;
        revision: number;
        closesAt: number;
      }[];
      items.push(
        ...deadlines.map((row) => ({
          id: `form-closing:${row.id}`,
          sourceId: row.id,
          type: "form" as const,
          title: row.title,
          date: localInstant(row.closesAt - 1, zone).slice(0, 10),
          endAt: row.closesAt,
          label: "Closes",
          revision: row.revision,
        })),
      );
    }
    const events = db()
      .select()
      .from(calendarEvents)
      .where(
        and(
          eq(calendarEvents.ownerId, owner),
          isNull(calendarEvents.trashedAt),
          or(
            eq(calendarEvents.recurring, true),
            and(
              lt(calendarEvents.startDate, addDays(to, 2)),
              gte(calendarEvents.endDate, addDays(from, -2)),
            ),
          ),
        ),
      )
      .all();
    const exceptionRows = sqlite()
      .prepare(
        "SELECT x.event_id,x.occurrence FROM calendar_exceptions x JOIN calendar_events e ON e.id=x.event_id WHERE e.owner_id=? AND e.trashed_at IS NULL",
      )
      .all(owner) as { event_id: string; occurrence: string }[];
    const exclusions = new Map<string, Set<string>>();
    for (const x of exceptionRows) {
      if (!exclusions.has(x.event_id)) exclusions.set(x.event_id, new Set());
      exclusions.get(x.event_id)!.add(x.occurrence);
    }
    for (const row of events) {
      const exceptions = exclusions.get(row.id) ?? new Set<string>();
      items.push(
        ...eventOccurrences(
          {
            ...row.data,
            id: row.id,
            ownerId: owner,
            revision: row.revision,
            trashedAt: row.trashedAt,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
          },
          from,
          to,
          zone,
        ).filter((item) => !exceptions.has(item.occurrence!)),
      );
    }
  }
  if (options.includeCompleted === false)
    items = items.filter((item) => !item.completed);
  if (options.tag) {
    const tagged = new Map<string, Set<string>>();
    for (const type of new Set(
      items.map((item) => (item.type === "journal" ? "note" : item.type)),
    )) {
      const rows = connection
        .prepare(`SELECT ${type}_id AS id FROM ${type}_tags WHERE tag_id=?`)
        .all(options.tag) as { id: string }[];
      tagged.set(type, new Set(rows.map((row) => row.id)));
    }
    items = items.filter((item) =>
      tagged
        .get(item.type === "journal" ? "note" : item.type)
        ?.has(item.sourceId),
    );
  }
  if (options.query)
    items = items.filter((item) =>
      item.title
        .toLocaleLowerCase()
        .includes(options.query!.toLocaleLowerCase()),
    );
  items.sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      (a.startAt ?? 0) - (b.startAt ?? 0) ||
      a.id.localeCompare(b.id),
  );
  const counts: Record<string, number> = {};
  const visitDays = (item: CalendarItem, visit: (date: string) => void) => {
    if (!item.endDate) {
      if (item.date >= from && item.date < to) visit(item.date);
      return;
    }
    const end =
      item.endAt && localInstant(item.endAt, zone).slice(11) !== "00:00"
        ? addDays(item.endDate, 1)
        : item.endDate;
    for (
      let day = item.date < from ? from : item.date;
      day < to && day < end;
      day = addDays(day, 1)
    )
      visit(day);
  };
  for (const item of items) {
    visitDays(item, (date) => {
      counts[date] = (counts[date] ?? 0) + 1;
    });
  }
  const offset = options.offset ?? 0,
    limit = options.limit ?? 500;
  const stats = sqlite()
    .prepare(
      "SELECT count(*) FILTER(WHERE planned_date IS NULL AND due_date IS NULL) AS unscheduled,count(*) FILTER(WHERE due_date<?) AS overdue FROM tasks INDEXED BY tasks_active_counts_idx WHERE owner_id=? AND completed_at IS NULL AND trashed_at IS NULL",
    )
    .get(localInstant(Date.now(), zone).slice(0, 10), owner) as {
    unscheduled: number;
    overdue: number;
  };
  let selected = items.slice(offset, offset + limit);
  const preview = options.preview;
  if (preview) {
    const seen = new Map<string, CalendarItem>();
    const buckets = new Map<string, number>();
    for (const item of items) {
      visitDays(item, (date) => {
        if ((buckets.get(date) ?? 0) < preview) {
          seen.set(item.id, item);
          buckets.set(date, (buckets.get(date) ?? 0) + 1);
        }
      });
    }
    selected = [...seen.values()];
  }
  const value: CalendarRange = {
    items: selected,
    counts,
    total: items.length,
    nextOffset:
      !options.preview && offset + limit < items.length ? offset + limit : null,
    ...stats,
  };
  cache.set(key, { stamp, at: Date.now(), value });
  if (cache.size > 24) cache.delete(cache.keys().next().value!);
  return value;
}
export function eventLinks(owner: string, id: string) {
  return getEvent(owner, id).links.map((link) => {
    const row = sqlite()
      .prepare(
        "SELECT " +
          (link.type === "artifact"
            ? "coalesce(nullif(title,''),name)"
            : "title") +
          " AS title,trashed_at AS trashedAt FROM " +
          tables[link.type] +
          " WHERE id=? AND owner_id=?",
      )
      .get(link.id, owner) as
      { title: string; trashedAt: number | null } | undefined;
    return {
      ...link,
      title: row?.title ?? "Unavailable item",
      available: !!row && !row.trashedAt,
    };
  });
}
