import { createHash, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import https from "node:https";
import webpush from "web-push";
import { Temporal } from "@js-temporal/polyfill";
import { sqlite, dataDir } from "./db";
import { masterKey, seal, unseal } from "./encryption";
import { publicAddress } from "./link-metadata";
import { HttpError } from "./http";
import { calendarRange, getEvent } from "./calendar";
import { completionEvent } from "./jobs";
import { addDays, eventInstant, localInstant } from "../calendar";
import {
  resolveTaskSchedule,
  storedTaskScheduleSchema,
} from "../task-planning";
const state = globalThis as unknown as {
  nivraReminderWorker?: {
    timer?: ReturnType<typeof setTimeout>;
    active: boolean;
    last: number;
    origin: string;
  };
};
const worker = (state.nivraReminderWorker ??= {
  active: false,
  last: 0,
  origin: "",
});
export function invalidateCalendarReminders() {
  worker.last = 0;
}
function encrypt(value: unknown, context: string) {
  return seal(Buffer.from(JSON.stringify(value)), masterKey(dataDir), context);
}
function decrypt<T>(bytes: Buffer, context: string): T {
  return JSON.parse(unseal(bytes, masterKey(dataDir), context).toString());
}
export function pushKeys(): { publicKey: string; privateKey: string } {
  const row = sqlite()
    .prepare("SELECT data FROM calendar_secrets WHERE id='vapid'")
    .get() as { data: Buffer } | undefined;
  if (row)
    return decrypt<{ publicKey: string; privateKey: string }>(
      row.data,
      "calendar-vapid",
    );
  const value = webpush.generateVAPIDKeys();
  sqlite()
    .prepare("INSERT OR IGNORE INTO calendar_secrets VALUES('vapid',?)")
    .run(encrypt(value, "calendar-vapid"));
  return pushKeys();
}
export async function validatedPushEndpoint(value: string) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    value.length > 4096
  )
    throw new HttpError(400, "Choose a supported secure push endpoint.");
  const addresses = await Promise.race([
    lookup(url.hostname, { all: true }),
    new Promise<never>((_, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new HttpError(400, "The push provider did not resolve in time."),
          ),
        3000,
      );
      timer.unref();
    }),
  ]);
  if (!addresses.length || addresses.some((v) => !publicAddress(v.address)))
    throw new HttpError(400, "The push endpoint is not public.");
  return addresses[0];
}
export async function saveSubscription(
  owner: string,
  session: string,
  subscription: webpush.PushSubscription,
) {
  await validatedPushEndpoint(subscription.endpoint);
  const id = randomUUID(),
    hash = createHash("sha256").update(subscription.endpoint).digest("hex");
  sqlite()
    .prepare(
      "INSERT INTO push_subscriptions VALUES(?,?,?,?,?,?) ON CONFLICT(endpoint_hash) DO UPDATE SET session_id=excluded.session_id,data=excluded.data,created_at=excluded.created_at WHERE push_subscriptions.owner_id=excluded.owner_id",
    )
    .run(
      id,
      owner,
      session,
      hash,
      encrypt(subscription, "push:" + hash),
      Date.now(),
    );
  invalidateCalendarReminders();
  return { ok: true };
}
export function removeSubscription(owner: string, endpoint: string) {
  sqlite()
    .prepare(
      "DELETE FROM push_subscriptions WHERE owner_id=? AND endpoint_hash=?",
    )
    .run(owner, createHash("sha256").update(endpoint).digest("hex"));
  return { ok: true };
}
function enqueue(
  owner: string,
  type: string,
  id: string,
  occurrence: string,
  revision: number,
  title: string,
  at: number,
  start: number = at,
  now: number = Date.now(),
) {
  const d = sqlite();
  d.transaction(() => {
    const existing = d
      .prepare(
        "SELECT id FROM calendar_reminders WHERE owner_id=? AND source_type=? AND source_id=? AND occurrence=? AND scheduled_at=? ORDER BY revision DESC,id LIMIT 1",
      )
      .get(owner, type, id, occurrence, at) as { id: string } | undefined;
    if (existing) {
      d.prepare(
        "UPDATE calendar_reminders SET revision=?,title=?,starts_at=?,state=CASE WHEN state='cancelled' AND dismissed=0 AND (scheduled_at>? OR (expires_at>? AND EXISTS(SELECT 1 FROM calendar_deliveries WHERE reminder_id=calendar_reminders.id AND state IN ('queued','running') AND attempts<4))) THEN 'queued' ELSE state END WHERE id=?",
      ).run(revision, title, start, now, now, existing.id);
      return;
    }
    const key = createHash("sha256")
      .update([type, id, occurrence, at].join(":"))
      .digest("hex");
    d.prepare(
      "INSERT INTO calendar_reminders(id,owner_id,source_type,source_id,occurrence,revision,title,starts_at,scheduled_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
    ).run(
      key,
      owner,
      type,
      id,
      occurrence,
      revision,
      title,
      start,
      at,
      at + 3600000,
    );
  }).immediate();
}
export function prepareReminders(now = Date.now()) {
  const owners = sqlite().prepare("SELECT id FROM user").all() as {
    id: string;
  }[];
  for (const owner of owners) {
    const day = localInstant(now, "UTC").slice(0, 10);
    const range = calendarRange(
      owner.id,
      addDays(day, -1),
      addDays(day, 9),
      "UTC",
      { limit: 10000, eventsOnly: true },
    );
    if (range.nextOffset !== null)
      throw new HttpError(422, "This reminder range has too many events.");
    const events = new Map<string, ReturnType<typeof getEvent>>();
    for (const item of range.items) {
      if (item.type !== "event") continue;
      let event = events.get(item.sourceId);
      if (!event) {
        event = getEvent(owner.id, item.sourceId);
        events.set(item.sourceId, event);
      }
      for (const offset of event.reminders) {
        const start =
          item.startAt ??
          eventInstant({
            ...event,
            start: item.occurrence! + "T09:00",
            allDay: false,
            disambiguation: "earlier",
          });
        enqueue(
          owner.id,
          "event",
          item.sourceId,
          item.occurrence!,
          item.revision,
          event.title,
          start - offset * 60000,
          start,
          now,
        );
      }
    }
    const tasks = sqlite()
      .prepare(
        "SELECT t.id,t.title,t.revision,t.planned_date AS plannedDate,t.due_date AS dueDate,t.schedule_start_local AS scheduleStartLocal,t.schedule_timezone AS scheduleTimezone,t.schedule_duration_minutes AS scheduleDurationMinutes,t.schedule_disambiguation AS scheduleDisambiguation,t.schedule_issue AS scheduleIssue,r.timezone,r.field,r.offsets FROM tasks t JOIN calendar_task_reminders r ON r.task_id=t.id WHERE t.owner_id=? AND t.trashed_at IS NULL AND t.completed_at IS NULL",
      )
      .all(owner.id) as {
      id: string;
      title: string;
      revision: number;
      plannedDate: string | null;
      dueDate: string | null;
      scheduleStartLocal: string | null;
      scheduleTimezone: string | null;
      scheduleDurationMinutes: number | null;
      scheduleDisambiguation: "earlier" | "later" | "reject" | null;
      scheduleIssue: "needs-scheduling" | null;
      timezone: string;
      field: string;
      offsets: string;
    }[];
    for (const task of tasks) {
      let occurrence: string;
      let start: number;
      if (task.field === "schedule") {
        if (
          !task.scheduleStartLocal ||
          !task.scheduleTimezone ||
          task.scheduleDurationMinutes === null ||
          !task.scheduleDisambiguation ||
          task.scheduleIssue
        )
          continue;
        try {
          const schedule = storedTaskScheduleSchema.parse({
            start: task.scheduleStartLocal,
            timezone: task.scheduleTimezone,
            durationMinutes: task.scheduleDurationMinutes,
            disambiguation: task.scheduleDisambiguation,
          });
          occurrence = schedule.start;
          start = resolveTaskSchedule(schedule).startAt;
        } catch {
          continue;
        }
      } else {
        const date = task.field === "planned" ? task.plannedDate : task.dueDate;
        if (!date) continue;
        occurrence = date;
        start = Number(
          Temporal.PlainDateTime.from(date + "T09:00").toZonedDateTime(
            task.timezone,
          ).epochMilliseconds,
        );
      }
      const occurrenceDate = occurrence.slice(0, 10);
      if (
        occurrenceDate < addDays(day, -1) ||
        occurrenceDate >= addDays(day, 9)
      )
        continue;
      for (const offset of JSON.parse(task.offsets) as number[])
        enqueue(
          owner.id,
          "task",
          task.id,
          occurrence,
          task.revision,
          task.title,
          start - offset * 60000,
          start,
          now,
        );
    }
  }
}
function currentReminder(row: {
  source_type: string;
  source_id: string;
  revision: number;
}) {
  if (row.source_type === "test")
    return !!sqlite()
      .prepare("SELECT 1 FROM session WHERE id=? AND expires_at>?")
      .get(row.source_id, Date.now());
  const table = row.source_type === "task" ? "tasks" : "calendar_events";
  return !!sqlite()
    .prepare(
      "SELECT 1 FROM " +
        table +
        " WHERE id=? AND revision=? AND trashed_at IS NULL" +
        (row.source_type === "task" ? " AND completed_at IS NULL" : ""),
    )
    .get(row.source_id, row.revision);
}
export async function dispatchReminders(
  origin: string,
  now = Date.now(),
  sender = webpush.sendNotification,
  resolveEndpoint = validatedPushEndpoint,
) {
  const d = sqlite();
  d.prepare(
    "UPDATE calendar_reminders SET state='missed' WHERE state='queued' AND expires_at<?",
  ).run(now);
  const due = d
    .prepare(
      "SELECT * FROM calendar_reminders WHERE state IN ('queued','accepted') AND (NOT EXISTS(SELECT 1 FROM calendar_deliveries d WHERE d.reminder_id=calendar_reminders.id) OR EXISTS(SELECT 1 FROM calendar_deliveries d WHERE d.reminder_id=calendar_reminders.id AND d.attempts<4 AND ((d.state='queued' AND d.available_at<=?) OR (d.state='running' AND d.lease_until<?)))) AND scheduled_at<=? AND expires_at>? AND dismissed=0 ORDER BY scheduled_at LIMIT 100",
    )
    .all(now, now, now, now) as {
    id: string;
    owner_id: string;
    source_type: string;
    source_id: string;
    occurrence: string;
    revision: number;
    title: string;
    scheduled_at: number;
    starts_at: number;
    expires_at: number;
  }[];
  const deadline = Date.now() + 20000;
  for (const reminder of due) {
    if (Date.now() >= deadline) break;
    if (!currentReminder(reminder)) {
      d.prepare(
        "UPDATE calendar_reminders SET state='cancelled' WHERE id=?",
      ).run(reminder.id);
      continue;
    }
    const subscriptions = d
      .prepare(
        "SELECT p.* FROM push_subscriptions p JOIN session s ON s.id=p.session_id WHERE p.owner_id=? AND s.expires_at>? AND p.created_at<=?",
      )
      .all(reminder.owner_id, now, reminder.scheduled_at) as {
      id: string;
      endpoint_hash: string;
      data: Buffer;
    }[];
    if (!subscriptions.length) {
      d.prepare("UPDATE calendar_reminders SET state='listed' WHERE id=?").run(
        reminder.id,
      );
      continue;
    }
    for (const sub of subscriptions) {
      if (Date.now() >= deadline) break;
      d.prepare(
        "INSERT OR IGNORE INTO calendar_deliveries(reminder_id,subscription_id,available_at) VALUES(?,?,?)",
      ).run(reminder.id, sub.id, now);
      const accepted = d
        .prepare(
          "SELECT 1 FROM calendar_deliveries delivery JOIN calendar_reminders previous ON previous.id=delivery.reminder_id WHERE previous.owner_id=? AND previous.source_type=? AND previous.source_id=? AND previous.occurrence=? AND previous.scheduled_at=? AND delivery.subscription_id=? AND delivery.state='accepted' LIMIT 1",
        )
        .get(
          reminder.owner_id,
          reminder.source_type,
          reminder.source_id,
          reminder.occurrence,
          reminder.scheduled_at,
          sub.id,
        );
      if (accepted) {
        d.prepare(
          "UPDATE calendar_deliveries SET state='accepted',lease_until=NULL WHERE reminder_id=? AND subscription_id=?",
        ).run(reminder.id, sub.id);
        d.prepare(
          "UPDATE calendar_reminders SET state='accepted' WHERE id=?",
        ).run(reminder.id);
        continue;
      }
      const claimed = d
        .prepare(
          "UPDATE calendar_deliveries SET state='running',lease_until=?,attempts=attempts+1 WHERE reminder_id=? AND subscription_id=? AND available_at<=? AND attempts<4 AND (state='queued' OR (state='running' AND lease_until<?)) RETURNING attempts",
        )
        .get(now + 30000, reminder.id, sub.id, now, now) as
        { attempts: number } | undefined;
      if (!claimed) continue;
      try {
        const subscription = decrypt<webpush.PushSubscription>(
            sub.data,
            "push:" + sub.endpoint_hash,
          ),
          address = await resolveEndpoint(subscription.endpoint);
        if (
          !currentReminder(reminder) ||
          !d
            .prepare(
              "SELECT 1 FROM push_subscriptions p JOIN session s ON s.id=p.session_id WHERE p.id=? AND s.expires_at>?",
            )
            .get(sub.id, Date.now())
        ) {
          d.prepare(
            "UPDATE calendar_deliveries SET state='cancelled',lease_until=NULL WHERE reminder_id=? AND subscription_id=?",
          ).run(reminder.id, sub.id);
          continue;
        }
        const keys = pushKeys(),
          agent = new https.Agent({
            lookup: (_host, options, callback) => {
              if (typeof options === "object" && options.all)
                (
                  callback as unknown as (
                    error: null,
                    addresses: { address: string; family: number }[],
                  ) => void
                )(null, [address]);
              else callback(null, address.address, address.family);
            },
          });
        try {
          await sender(
            subscription,
            JSON.stringify({
              id: reminder.id,
              title: reminder.title,
              time: reminder.starts_at,
              path:
                "/calendar?date=" +
                reminder.occurrence.slice(0, 10) +
                (reminder.source_type === "event"
                  ? "&event=" + reminder.source_id
                  : "&task=" + reminder.source_id),
            }),
            {
              vapidDetails: { ...keys, subject: new URL(origin).origin },
              TTL: Math.max(0, Math.floor((reminder.expires_at - now) / 1000)),
              topic: reminder.id.slice(0, 32),
              timeout: 10000,
              agent,
            },
          );
        } finally {
          agent.destroy();
        }
        d.prepare(
          "UPDATE calendar_deliveries SET state='accepted',lease_until=NULL WHERE reminder_id=? AND subscription_id=?",
        ).run(reminder.id, sub.id);
        d.prepare(
          "UPDATE calendar_reminders SET state='accepted' WHERE id=?",
        ).run(reminder.id);
      } catch (e) {
        const code = (e as { statusCode?: number }).statusCode;
        if (code === 404 || code === 410)
          d.prepare("DELETE FROM push_subscriptions WHERE id=?").run(sub.id);
        else
          d.prepare(
            "UPDATE calendar_deliveries SET state=?,available_at=?,lease_until=NULL WHERE reminder_id=? AND subscription_id=?",
          ).run(
            claimed.attempts >= 4 ? "failed" : "queued",
            now + [60000, 300000, 900000][Math.min(claimed.attempts - 1, 2)],
            reminder.id,
            sub.id,
          );
      }
    }
  }
}
export function reminderList(owner: string, offset = 0, limit = 50) {
  const items = sqlite()
    .prepare(
      "SELECT id,title,scheduled_at AS scheduledAt,state,source_type AS sourceType,source_id AS sourceId,occurrence FROM calendar_reminders WHERE owner_id=? AND scheduled_at<=? AND scheduled_at>? AND dismissed=0 AND state<>'cancelled' ORDER BY scheduled_at DESC,id DESC LIMIT ? OFFSET ?",
    )
    .all(owner, Date.now(), Date.now() - 30 * 86400000, limit + 1, offset);
  return {
    items: items.slice(0, limit),
    nextOffset: items.length > limit ? offset + limit : null,
  };
}
export function startReminderWorker(origin: string) {
  worker.origin = origin;
  if (worker.timer) return;
  const tick = async () => {
    if (worker.active) return;
    worker.active = true;
    try {
      if (Date.now() - worker.last > 900000) {
        prepareReminders();
        worker.last = Date.now();
      }
      const changes = () =>
        (
          sqlite().prepare("SELECT total_changes() AS count").get() as {
            count: number;
          }
        ).count;
      const before = changes();
      await dispatchReminders(worker.origin);
      if (changes() !== before) {
        const owners = sqlite().prepare("SELECT id FROM user").all() as {
          id: string;
        }[];
        for (const owner of owners)
          completionEvent(owner.id, "content", "calendar-reminders", "updated");
      }
    } catch {
    } finally {
      worker.active = false;
      worker.timer = setTimeout(() => void tick(), 15000);
      worker.timer.unref();
    }
  };
  worker.timer = setTimeout(() => void tick(), 15000);
  worker.timer.unref();
}

export function testDeviceReminder(owner: string, session: string) {
  const now = Date.now();
  enqueue(
    owner,
    "test",
    session,
    localInstant(now, "UTC").slice(0, 10),
    now,
    "Nivra notifications are ready",
    now,
  );
  return { ok: true };
}
