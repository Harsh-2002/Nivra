import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import type Database from "better-sqlite3";
import { Temporal } from "@js-temporal/polyfill";
import {
  addDays,
  dateSchema,
  eventInput,
  eventOccurrences,
  zoneSchema,
  type CalendarEvent,
  type EventInput,
} from "../calendar";
import {
  resolveTaskSchedule,
  storedTaskScheduleSchema,
} from "../task-planning";
import { sqlite } from "./db";
import { HttpError } from "./http";

const exportRangeDays = 366;
const exportEntryLimit = 10_000;
const eventCandidateLimit = 10_000;
const exceptionLimit = 10_000;
const exportDeadlineMs = 5_000;
const encoder = new TextEncoder();

type CalendarExportRange = { from: string; to: string; timezone: string };
type IcsComponent =
  | {
      kind: "event";
      uid: string;
      revision: number;
      summary: string;
      description?: string;
      location?: string;
      startDate: string;
      endDate: string;
    }
  | {
      kind: "timed";
      uid: string;
      revision: number;
      summary: string;
      description?: string;
      location?: string;
      startAt: number;
      endAt: number;
    };
type CalendarEventRow = {
  id: string;
  startDate: string;
  endDate: string;
  data: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
};

function assertExportWithinBudget(startedAt: number) {
  if (performance.now() - startedAt > exportDeadlineMs)
    throw new HttpError(
      422,
      "Calendar export exceeded its processing limit. Narrow the date range and try again.",
    );
}

function exceptionDates(
  statement: Database.Statement<
    [string, string, string, number],
    { occurrence: string }
  >,
  eventId: string,
  from: string,
  to: string,
  durationDays: number,
  startedAt: number,
) {
  const exceptions = new Set<string>();
  const rows = statement.iterate(
    eventId,
    addDays(from, -Math.max(durationDays + 2, 2)),
    addDays(to, 2),
    exceptionLimit + 1,
  );
  for (const row of rows) {
    assertExportWithinBudget(startedAt);
    if (exceptions.size >= exceptionLimit)
      throw new HttpError(
        422,
        "This calendar series has too many exceptions to export safely. Narrow the date range and try again.",
      );
    exceptions.add(row.occurrence);
  }
  return exceptions;
}

function appendCalendarEvents(
  entries: IcsComponent[],
  owner: string,
  range: CalendarExportRange,
  startedAt: number,
) {
  const database = sqlite();
  let scanned = 0;
  const nonRecurring = database.prepare(
    "SELECT id,start_date AS startDate,end_date AS endDate,data,revision,created_at AS createdAt,updated_at AS updatedAt FROM calendar_events INDEXED BY calendar_events_export_active_once_idx WHERE owner_id=? AND trashed_at IS NULL AND recurring=0 AND start_date<? AND end_date>=?",
  ) as Database.Statement<[string, string, string], CalendarEventRow>;
  const recurring = database.prepare(
    "SELECT id,start_date AS startDate,end_date AS endDate,data,revision,created_at AS createdAt,updated_at AS updatedAt FROM calendar_events INDEXED BY calendar_events_export_active_repeat_idx WHERE owner_id=? AND trashed_at IS NULL AND recurring=1 AND start_date<? AND (json_extract(data,'$.recurrence.until') IS NULL OR date(json_extract(data,'$.recurrence.until'),printf('+%d days',CAST(julianday(end_date)-julianday(start_date) AS INTEGER)+2))>=?)",
  ) as Database.Statement<[string, string, string], CalendarEventRow>;
  const exceptionStatement = database.prepare(
    "SELECT occurrence FROM calendar_exceptions WHERE event_id=? AND substr(occurrence,1,10)>=? AND substr(occurrence,1,10)<? ORDER BY occurrence LIMIT ?",
  ) as Database.Statement<
    [string, string, string, number],
    {
      occurrence: string;
    }
  >;

  const appendRows = (rows: Iterable<CalendarEventRow>) => {
    for (const row of rows) {
      assertExportWithinBudget(startedAt);
      if (++scanned > eventCandidateLimit)
        throw new HttpError(
          422,
          "This range matches too many calendar event series to export safely. Narrow the date range and try again.",
        );

      let input: EventInput;
      try {
        input = eventInput.parse(JSON.parse(row.data));
      } catch {
        throw new HttpError(
          422,
          "A calendar event could not be exported because its stored data is invalid.",
        );
      }
      const event: CalendarEvent = {
        ...input,
        id: row.id,
        ownerId: owner,
        revision: row.revision,
        trashedAt: null,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      };
      const durationDays = Temporal.PlainDate.from(
        input.end.slice(0, 10),
      ).since(Temporal.PlainDate.from(input.start.slice(0, 10))).days;
      const exceptions = input.recurrence
        ? exceptionDates(
            exceptionStatement,
            row.id,
            range.from,
            range.to,
            durationDays,
            startedAt,
          )
        : new Set<string>();

      let occurrences;
      try {
        occurrences = eventOccurrences(
          event,
          range.from,
          range.to,
          range.timezone,
        );
      } catch {
        throw new HttpError(
          422,
          "A calendar event could not be expanded safely for this export.",
        );
      }
      assertExportWithinBudget(startedAt);
      for (const item of occurrences) {
        if (item.occurrence && exceptions.has(item.occurrence)) continue;
        if (item.startAt !== undefined && item.endAt !== undefined) {
          addEntry(entries, {
            kind: "timed",
            uid: uid("event", row.id, item.occurrence ?? item.date),
            revision: row.revision,
            summary: input.title,
            description: input.description,
            location: input.location,
            startAt: item.startAt,
            endAt: item.endAt,
          });
        } else if (item.endDate) {
          addEntry(entries, {
            kind: "event",
            uid: uid("event", row.id, item.occurrence ?? item.date),
            revision: row.revision,
            summary: input.title,
            description: input.description,
            location: input.location,
            startDate: item.date,
            endDate: item.endDate,
          });
        }
      }
    }
  };

  appendRows(
    nonRecurring.iterate(owner, addDays(range.to, 2), addDays(range.from, -2)),
  );
  appendRows(recurring.iterate(owner, addDays(range.to, 2), range.from));
}

function normalizeRange(input: CalendarExportRange): CalendarExportRange {
  const from = dateSchema.safeParse(input.from);
  const to = dateSchema.safeParse(input.to);
  const timezone = zoneSchema.safeParse(input.timezone);
  if (!from.success || !to.success || !timezone.success)
    throw new HttpError(422, "Choose valid calendar dates and a timezone.");
  try {
    const days = Temporal.PlainDate.from(to.data).since(
      Temporal.PlainDate.from(from.data),
    ).days;
    if (days < 1 || days > exportRangeDays)
      throw new HttpError(422, "Choose a calendar range of 1 to 366 days.");
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(422, "Choose valid calendar dates and a timezone.");
  }
  return { from: from.data, to: to.data, timezone: timezone.data };
}

function uid(kind: string, sourceId: string, occurrence: string) {
  const digest = createHash("sha256")
    .update(`${kind}\0${sourceId}\0${occurrence}`)
    .digest("hex");
  return `${digest}@nivra`;
}

function escapeText(value: string) {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\r\n|\r|\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

function foldLine(line: string) {
  const parts: string[] = [];
  let part = "";
  let bytes = 0;
  for (const character of line) {
    const length = encoder.encode(character).length;
    if (bytes + length > 75) {
      parts.push(part);
      part = " ";
      bytes = 1;
    }
    part += character;
    bytes += length;
  }
  parts.push(part);
  return parts.join("\r\n");
}

function dateValue(date: string) {
  return date.replace(/-/g, "");
}

function utcValue(timestamp: number) {
  if (!Number.isFinite(timestamp))
    throw new HttpError(422, "A calendar item has an invalid time.");
  return new Date(timestamp)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

function componentLines(component: IcsComponent, stamp: string) {
  const lines = [
    "BEGIN:VEVENT",
    `UID:${component.uid}`,
    `DTSTAMP:${stamp}`,
    `SEQUENCE:${component.revision}`,
    `SUMMARY:${escapeText(component.summary)}`,
  ];
  if (component.kind === "event") {
    lines.push(
      `DTSTART;VALUE=DATE:${dateValue(component.startDate)}`,
      `DTEND;VALUE=DATE:${dateValue(component.endDate)}`,
      "STATUS:CONFIRMED",
    );
    if (component.description)
      lines.push(`DESCRIPTION:${escapeText(component.description)}`);
    if (component.location)
      lines.push(`LOCATION:${escapeText(component.location)}`);
  } else if (component.kind === "timed") {
    lines.push(
      `DTSTART:${utcValue(component.startAt)}`,
      `DTEND:${utcValue(component.endAt)}`,
    );
    if (component.description)
      lines.push(`DESCRIPTION:${escapeText(component.description)}`);
    if (component.location)
      lines.push(`LOCATION:${escapeText(component.location)}`);
    lines.push("STATUS:CONFIRMED");
  }
  lines.push("END:VEVENT");
  return lines;
}

function addEntry(entries: IcsComponent[], entry: IcsComponent) {
  if (entries.length >= exportEntryLimit)
    throw new HttpError(
      422,
      "This range contains more than 10,000 calendar entries. Narrow the date range and try again.",
    );
  entries.push(entry);
}

export function exportCalendarIcs(
  owner: string,
  input: CalendarExportRange,
): Response {
  const range = normalizeRange(input);
  const entries: IcsComponent[] = [];
  const startedAt = performance.now();
  appendCalendarEvents(entries, owner, range, startedAt);

  const scheduledTasks = sqlite()
    .prepare(
      "SELECT id,title,revision,schedule_start_local AS start,schedule_timezone AS timezone,schedule_duration_minutes AS durationMinutes,schedule_disambiguation AS disambiguation,schedule_issue AS scheduleIssue FROM tasks INDEXED BY tasks_owner_schedule_idx WHERE owner_id=? AND trashed_at IS NULL AND schedule_start_local>=? AND schedule_start_local<? ORDER BY schedule_start_local,id",
    )
    .iterate(
      owner,
      `${addDays(range.from, -2)}T00:00`,
      `${addDays(range.to, 2)}T00:00`,
    ) as Iterable<{
    id: string;
    title: string;
    revision: number;
    start: string;
    timezone: string;
    durationMinutes: number;
    disambiguation: "earlier" | "later" | "reject";
    scheduleIssue: "needs-scheduling" | null;
  }>;
  for (const task of scheduledTasks) {
    assertExportWithinBudget(startedAt);
    if (task.scheduleIssue) continue;
    const schedule = storedTaskScheduleSchema.safeParse({
      start: task.start,
      timezone: task.timezone,
      durationMinutes: task.durationMinutes,
      disambiguation: task.disambiguation,
    });
    if (!schedule.success) continue;
    let resolved: ReturnType<typeof resolveTaskSchedule>;
    try {
      resolved = resolveTaskSchedule(schedule.data);
    } catch {
      continue;
    }
    const date = Temporal.Instant.fromEpochMilliseconds(resolved.startAt)
      .toZonedDateTimeISO(range.timezone)
      .toPlainDate()
      .toString();
    if (date < range.from || date >= range.to) continue;
    addEntry(entries, {
      kind: "timed",
      uid: uid("task-schedule", task.id, String(resolved.startAt)),
      revision: task.revision,
      summary: task.title,
      startAt: resolved.startAt,
      endAt: resolved.endAt,
    });
  }

  const dueTasks = sqlite()
    .prepare(
      "SELECT id,title,revision,due_date AS dueDate FROM tasks INDEXED BY tasks_owner_due_idx WHERE owner_id=? AND trashed_at IS NULL AND due_date>=? AND due_date<? ORDER BY due_date,id",
    )
    .iterate(owner, range.from, range.to) as Iterable<{
    id: string;
    title: string;
    revision: number;
    dueDate: string;
  }>;
  for (const task of dueTasks) {
    assertExportWithinBudget(startedAt);
    addEntry(entries, {
      kind: "event",
      uid: uid("task-due", task.id, task.dueDate),
      revision: task.revision,
      summary: `Deadline: ${task.title}`,
      startDate: task.dueDate,
      endDate: Temporal.PlainDate.from(task.dueDate)
        .add({ days: 1 })
        .toString(),
    });
  }

  const timestamp = (entry: IcsComponent) =>
    entry.kind === "event"
      ? Date.parse(`${entry.startDate}T00:00:00Z`)
      : entry.startAt;
  entries.sort(
    (left, right) =>
      timestamp(left) - timestamp(right) || left.uid.localeCompare(right.uid),
  );

  const stamp = utcValue(Date.now());
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Nivra//Calendar//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:Nivra",
    ...entries.flatMap((entry) => componentLines(entry, stamp)),
    "END:VCALENDAR",
  ];
  const body = lines.map(foldLine).join("\r\n") + "\r\n";
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/calendar; charset=utf-8; method=PUBLISH",
      "Content-Disposition": `attachment; filename="nivra-calendar-${range.from}.ics"`,
      "Cache-Control": "private, no-store, max-age=0",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
