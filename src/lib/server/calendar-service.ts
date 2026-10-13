import { z } from "zod";
import { dateSchema } from "../calendar";
import { offsetPagination } from "./api-pagination";
import { apiInputs, apiQueries } from "./api-schemas";
import {
  calendarRange,
  createEvent,
  eventLinks,
  getEvent,
  trashEvent,
  updateEvent,
} from "./calendar";
import {
  invalidateCalendarReminders,
  pushKeys,
  reminderList,
  removeSubscription,
  saveSubscription,
  testDeviceReminder,
} from "./calendar-reminders";
import type { ContentCommand, ContentResult } from "./content-service";
import { sqlite } from "./db";
import { HttpError } from "./http";
import { storedTaskScheduleSchema } from "../task-planning";
import { exportCalendarIcs } from "./calendar-ics";
const response = (data: unknown, status = 200): ContentResult => ({
  data,
  status,
});
export async function executeCalendar(
  command: ContentCommand,
): Promise<ContentResult> {
  const {
    ownerId: owner,
    sessionId: session,
    method,
    input: payload,
  } = command;
  const [, area, id] = command.path;
  const query = command.query ?? new URLSearchParams();
  if (area === "export" && method === "GET") {
    const range = apiQueries.calendarExport.parse(Object.fromEntries(query));
    return { response: exportCalendarIcs(owner, range) };
  }
  if (area === "range" && method === "GET") {
    const value = apiQueries.calendar.parse(Object.fromEntries(query));
    const v = {
      ...value,
      offset: offsetPagination(query, "/calendar/range", 10000).offset,
      includeCompleted: value.includeCompleted === "1",
    };
    return response(calendarRange(owner, v.from, v.to, v.timezone, v));
  }
  if (area === "events") {
    if (method === "GET" && id)
      return response({
        ...getEvent(owner, id),
        linkedItems: eventLinks(owner, id),
      });
    if (method === "POST" && !id) {
      const value = createEvent(owner, payload);
      invalidateCalendarReminders();
      return response(value, 201);
    }
    if (id && method === "PATCH") {
      const body = apiInputs.eventUpdate.parse(payload);
      const value = updateEvent(
        owner,
        id,
        body.revision,
        body.input,
        body.scope,
        body.occurrence,
      );
      invalidateCalendarReminders();
      return response(value);
    }
    if (id && method === "DELETE") {
      const body = apiInputs.eventDelete.parse(payload);
      const value = trashEvent(
        owner,
        id,
        body.revision,
        body.scope,
        body.occurrence,
      );
      invalidateCalendarReminders();
      return response(value);
    }
  }
  if (area === "task-reminders" && id && method === "GET") {
    if (
      !sqlite()
        .prepare(
          "SELECT 1 FROM tasks WHERE id=? AND owner_id=? AND trashed_at IS NULL",
        )
        .get(id, owner)
    )
      throw new HttpError(404, "This task was not found.");
    return response(
      (
        sqlite()
          .prepare(
            "SELECT field,timezone,offsets FROM calendar_task_reminders WHERE task_id=?",
          )
          .all(id) as { field: string; timezone: string; offsets: string }[]
      ).map((row) => ({ ...row, offsets: JSON.parse(row.offsets) })),
    );
  }
  if (area === "task-reminders" && id && method === "PUT") {
    const body = apiInputs.taskReminders.parse(payload);
    const task = sqlite()
      .prepare(
        "SELECT schedule_start_local AS start,schedule_timezone AS timezone,schedule_duration_minutes AS durationMinutes,schedule_disambiguation AS disambiguation,schedule_issue AS scheduleIssue FROM tasks WHERE id=? AND owner_id=? AND revision=? AND trashed_at IS NULL",
      )
      .get(id, owner, body.revision) as
      | {
          start: string | null;
          timezone: string | null;
          durationMinutes: number | null;
          disambiguation: "earlier" | "later" | "reject" | null;
          scheduleIssue: "needs-scheduling" | null;
        }
      | undefined;
    if (!task)
      throw new HttpError(
        409,
        "This task changed. Reload it before setting reminders.",
      );
    if (body.field === "schedule") {
      if (
        task.scheduleIssue ||
        !task.start ||
        !task.timezone ||
        task.durationMinutes === null ||
        !task.disambiguation
      )
        throw new HttpError(
          400,
          "Add a valid scheduled time before setting a schedule reminder.",
        );
      const schedule = storedTaskScheduleSchema.parse({
        start: task.start,
        timezone: task.timezone,
        durationMinutes: task.durationMinutes,
        disambiguation: task.disambiguation,
      });
      if (body.timezone !== schedule.timezone)
        throw new HttpError(
          400,
          "Use the timezone saved with the task schedule.",
        );
    }
    sqlite()
      .prepare(
        "INSERT INTO calendar_task_reminders VALUES(?,?,?,?) ON CONFLICT(task_id,field) DO UPDATE SET timezone=excluded.timezone,field=excluded.field,offsets=excluded.offsets",
      )
      .run(id, body.timezone, body.field, JSON.stringify(body.offsets));
    sqlite()
      .prepare(
        "UPDATE calendar_reminders SET state='cancelled' WHERE source_type='task' AND source_id=? AND state='queued'",
      )
      .run(id);
    invalidateCalendarReminders();
    return response({ ok: true });
  }
  if (area === "reminders") {
    if (method === "GET") {
      const page = offsetPagination(query, "/calendar/reminders");
      const reminders = reminderList(owner, page.offset, page.limit);
      return response({
        ...reminders,
        next:
          reminders.nextOffset === null
            ? null
            : page.cursor(reminders.nextOffset),
      });
    }
    if (method === "PATCH" && id) {
      sqlite()
        .prepare(
          "UPDATE calendar_reminders SET dismissed=1 WHERE id=? AND owner_id=?",
        )
        .run(
          z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .parse(id),
          owner,
        );
      return response({ ok: true });
    }
  }
  if (area === "subscriptions") {
    if (!session)
      throw new HttpError(403, "Enable device notifications in the app.");
    if (method === "GET")
      return response({
        publicKey: pushKeys().publicKey,
        hashes: sqlite()
          .prepare(
            "SELECT endpoint_hash AS hash FROM push_subscriptions WHERE owner_id=? AND session_id=?",
          )
          .all(owner, session),
      });
    if (id === "test" && method === "POST")
      return response(testDeviceReminder(owner, session));
    if (method === "POST") {
      const body = apiInputs.subscription.parse(payload);
      return response(await saveSubscription(owner, session, body));
    }
    if (method === "DELETE") {
      const body = apiInputs.unsubscribe.parse(payload);
      return response(removeSubscription(owner, body.endpoint));
    }
  }
  if (area === "tasks" && method === "GET") {
    const mode = z.enum(["unscheduled", "overdue"]).parse(query.get("mode")),
      date = dateSchema.parse(query.get("date")),
      page = offsetPagination(query, "/calendar/tasks"),
      offset = page.offset;
    const condition =
      "owner_id=? AND trashed_at IS NULL AND completed_at IS NULL AND " +
      (mode === "unscheduled"
        ? "due_date IS NULL AND planned_date IS NULL"
        : "due_date<?");
    const parameters = [owner, ...(mode === "overdue" ? [date] : [])];
    const total = (
      sqlite()
        .prepare(`SELECT count(*) AS total FROM tasks WHERE ${condition}`)
        .get(...parameters) as { total: number }
    ).total;
    const rows = sqlite()
      .prepare(
        "SELECT id,title,revision,due_date AS dueDate,planned_date AS plannedDate FROM tasks WHERE " +
          condition +
          " ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?",
      )
      .all(...parameters, page.limit + 1, offset);
    return response({
      ...page.page(rows, total),
    });
  }
  throw new HttpError(404, "This calendar endpoint was not found.");
}
