import { requireBoard, insertionPosition, stagePredicate } from "./boards";
import type { TaskStage } from "../boards";
import { invalidateCalendarReminders } from "./calendar-reminders";
import { moveToTrash } from "./trash";
import { randomUUID } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db, sqlite } from "./db";
import { tasks, notes } from "./schema";
import { HttpError } from "./http";
import type { Page, Task, TaskFilter } from "../types";
import { decodeCursor, encodeCursor } from "./pagination";
import { nextDate, validDate, type Recurrence } from "../dates";
import { requireLinkedNote } from "./connections";
import {
  nextRuleDate,
  resolveTaskSchedule,
  shiftTaskScheduleDate,
  storedTaskScheduleSchema,
  taskRecurrenceRuleSchema,
  taskScheduleSchema,
  type TaskRecurrenceRule,
  type TaskSchedule,
} from "../task-planning";
import { Temporal } from "@js-temporal/polyfill";
const fields = {
  id: tasks.id,
  boardId: tasks.boardId,
  openStage: tasks.openStage,
  boardPosition: tasks.boardPosition,
  trashedAt: tasks.trashedAt,
  title: tasks.title,
  completedAt: tasks.completedAt,
  revision: tasks.revision,
  createdAt: tasks.createdAt,
  updatedAt: tasks.updatedAt,
  dueDate: tasks.dueDate,
  plannedDate: tasks.plannedDate,
  recurrence: tasks.recurrence,
  recurrenceDay: tasks.recurrenceDay,
  scheduleStartLocal: tasks.scheduleStartLocal,
  scheduleTimezone: tasks.scheduleTimezone,
  scheduleDurationMinutes: tasks.scheduleDurationMinutes,
  scheduleDisambiguation: tasks.scheduleDisambiguation,
  scheduleIssue: tasks.scheduleIssue,
  recurrenceRule: tasks.recurrenceRule,
  parentTaskId: tasks.parentTaskId,
  noteId: tasks.noteId,
};
export type TaskChanges = {
  boardId?: string | null;
  status?: TaskStage;
  title?: string;
  completed?: boolean;
  dueDate?: string | null;
  plannedDate?: string | null;
  recurrence?: Recurrence | null;
  recurrenceRule?: TaskRecurrenceRule | null;
  schedule?: TaskSchedule | null;
  noteId?: string | null;
};
type TaskStorageRow = Record<string, unknown> & {
  scheduleStartLocal: string | null;
  scheduleTimezone: string | null;
  scheduleDurationMinutes: number | null;
  scheduleDisambiguation: TaskSchedule["disambiguation"] | null;
  scheduleIssue: Task["scheduleIssue"] | null;
  recurrenceRule: TaskRecurrenceRule | string | null;
};
const rawScheduleFields = new Set([
  "scheduleStartLocal",
  "scheduleTimezone",
  "scheduleDurationMinutes",
  "scheduleDisambiguation",
]);
function fromStorage(row: TaskStorageRow): Task {
  const {
    scheduleStartLocal,
    scheduleTimezone,
    scheduleDurationMinutes,
    scheduleDisambiguation,
    scheduleIssue,
    recurrenceRule,
    openStage,
    ...rest
  } = row;
  const present = [
    scheduleStartLocal,
    scheduleTimezone,
    scheduleDurationMinutes,
    scheduleDisambiguation,
  ].filter((value) => value !== null && value !== undefined).length;
  if (present !== 0 && present !== rawScheduleFields.size)
    throw new Error("Task schedule fields are incomplete.");
  const schedule =
    present === 0
      ? null
      : (scheduleIssue ? storedTaskScheduleSchema : taskScheduleSchema).parse({
          start: scheduleStartLocal,
          timezone: scheduleTimezone,
          durationMinutes: scheduleDurationMinutes,
          disambiguation: scheduleDisambiguation,
        });
  let rule: TaskRecurrenceRule | null = null;
  if (typeof recurrenceRule === "string") {
    try {
      rule = taskRecurrenceRuleSchema.parse(JSON.parse(recurrenceRule));
    } catch {
      throw new Error("Task recurrence data is invalid.");
    }
  } else if (recurrenceRule) {
    rule = taskRecurrenceRuleSchema.parse(recurrenceRule);
  }
  const task = {
    ...rest,
    status:
      "completedAt" in rest && rest.completedAt !== null
        ? "done"
        : (openStage ?? rest.status),
    schedule,
    scheduleIssue: scheduleIssue ?? null,
    recurrenceRule: rule,
  } as Task;
  return task;
}
function attachStepProgress(items: Task[], owner: string) {
  if (!items.length) return items;
  const progress = new Map<string, { completed: number; total: number }>();
  for (let index = 0; index < items.length; index += 400) {
    const ids = items.slice(index, index + 400).map((item) => item.id);
    const rows = sqlite()
      .prepare(
        `SELECT task_id AS taskId,count(*) AS total,sum(completed) AS completed FROM task_steps WHERE owner_id=? AND task_id IN (${ids.map(() => "?").join(",")}) GROUP BY task_id`,
      )
      .all(owner, ...ids) as {
      taskId: string;
      total: number;
      completed: number;
    }[];
    for (const row of rows)
      progress.set(row.taskId, { completed: row.completed, total: row.total });
  }
  for (const item of items) {
    const value = progress.get(item.id) ?? { completed: 0, total: 0 };
    item.stepProgress = value;
  }
  return items;
}
function enrich(task: TaskStorageRow, owner: string): Task {
  const stored = fromStorage(task);
  const note = stored.noteId
    ? db()
        .select({ title: notes.title })
        .from(notes)
        .where(and(eq(notes.id, stored.noteId), eq(notes.kind, "note")))
        .get()
    : undefined;
  stored.noteTitle = note?.title ?? null;
  return attachStepProgress([stored], owner)[0];
}
export function listTasks(owner: string, includeTrash = false): Task[] {
  return attachStepProgress(
    db()
      .select({ ...fields, noteTitle: notes.title })
      .from(tasks)
      .leftJoin(notes, and(eq(notes.id, tasks.noteId), eq(notes.kind, "note")))
      .where(
        and(
          eq(tasks.ownerId, owner),
          ...(includeTrash ? [] : [isNull(tasks.trashedAt)]),
        ),
      )
      .orderBy(desc(tasks.createdAt), desc(tasks.id))
      .all()
      .map((task) => fromStorage(task as unknown as TaskStorageRow)),
    owner,
  );
}
const taskColumns =
  "t.id,t.title,t.board_id AS boardId,t.board_position AS boardPosition,CASE WHEN t.completed_at IS NOT NULL THEN 'done' ELSE t.open_stage END AS status,(SELECT name FROM task_boards WHERE id=t.board_id) AS boardName,t.completed_at AS completedAt,t.revision,t.created_at AS createdAt,t.updated_at AS updatedAt,t.due_date AS dueDate,t.planned_date AS plannedDate,t.recurrence,t.recurrence_day AS recurrenceDay,t.schedule_start_local AS scheduleStartLocal,t.schedule_timezone AS scheduleTimezone,t.schedule_duration_minutes AS scheduleDurationMinutes,t.schedule_disambiguation AS scheduleDisambiguation,t.schedule_issue AS scheduleIssue,t.recurrence_rule_json AS recurrenceRule,t.parent_task_id AS parentTaskId,t.note_id AS noteId,n.title AS noteTitle";
const taskOrder = "t.created_at DESC,t.id DESC";
export function listTaskPage(
  owner: string,
  options: {
    filter: TaskFilter;
    boardId?: string | null;
    status?: TaskStage;
    order?: "recent" | "board";
    query: string;
    limit: number;
    after?: string | null;
  },
): Page<Task> {
  const where = ["t.owner_id=?", "t.trashed_at IS NULL"];
  const values: (string | number)[] = [owner];
  if (options.boardId) {
    requireBoard(owner, options.boardId, true);
    where.push("t.board_id=?");
    values.push(options.boardId);
  } else if (options.boardId === null) where.push("t.board_id IS NULL");
  if (options.status) where.push(stagePredicate(options.status));
  else if (options.filter === "completed")
    where.push("t.completed_at IS NOT NULL");
  else {
    where.push("t.completed_at IS NULL");
  }
  const term = options.query.trim().slice(0, 300);
  if (term) {
    const match = term
      .match(/[\p{L}\p{N}_]+/gu)
      ?.slice(0, 8)
      .map((word) => `"${word}"*`)
      .join(" AND ");
    if (match) {
      where.push(
        "(t.rowid IN (SELECT rowid FROM tasks_fts WHERE tasks_fts MATCH ?) OR EXISTS(SELECT 1 FROM task_steps s WHERE s.task_id=t.id AND s.owner_id=t.owner_id AND s.rowid IN (SELECT rowid FROM task_steps_fts WHERE task_steps_fts MATCH ?)))",
      );
      values.push(match, match);
    } else where.push("0=1");
  }
  const cursor = decodeCursor(options.after ?? null, ["number", "string"]);
  const boardOrder = options.order === "board" && !!options.boardId;
  if (cursor) {
    where.push(
      boardOrder
        ? "(t.board_position,t.id)>(?,?)"
        : "(t.created_at,t.id)<(?,?)",
    );
    values.push(...cursor);
  }
  const rows = sqlite()
    .prepare(
      `SELECT ${taskColumns} FROM tasks t LEFT JOIN notes n ON n.id=t.note_id AND n.kind='note' WHERE ${where.join(" AND ")} ORDER BY ${boardOrder ? "t.board_position,t.id" : taskOrder} LIMIT ?`,
    )
    .all(...values, options.limit + 1) as TaskStorageRow[];
  const items = attachStepProgress(
    rows.slice(0, options.limit).map((task) => fromStorage(task)),
    owner,
  );
  if (items.length) {
    const tagRows = sqlite()
      .prepare(
        `SELECT tt.task_id AS taskId,t.id,t.name,t.color FROM task_tags tt JOIN tags t ON t.id=tt.tag_id WHERE tt.task_id IN (${items.map(() => "?").join(",")}) ORDER BY t.name`,
      )
      .all(...items.map((t) => t.id)) as (import("../types").Tag & {
      taskId: string;
    })[];
    for (const task of items)
      task.tags = tagRows
        .filter((t) => t.taskId === task.id)
        .map((tag) => ({ id: tag.id, name: tag.name, color: tag.color }));
  }
  const last = items[items.length - 1];
  return {
    items,
    next:
      rows.length > options.limit && last
        ? encodeCursor([
            boardOrder ? last.boardPosition : last.createdAt,
            last.id,
          ])
        : null,
  };
}
export function taskCounts(owner: string, boardId?: string | null) {
  if (boardId) requireBoard(owner, boardId, true);
  return sqlite()
    .prepare(
      "SELECT COUNT(*) FILTER (WHERE completed_at IS NULL) AS open,COUNT(*) FILTER (WHERE completed_at IS NOT NULL) AS completed FROM tasks" +
        (boardId === undefined ? " INDEXED BY tasks_active_counts_idx" : "") +
        " WHERE owner_id=? AND trashed_at IS NULL" +
        (boardId
          ? " AND board_id=?"
          : boardId === null
            ? " AND board_id IS NULL"
            : ""),
    )
    .get(owner, ...(boardId ? [boardId] : [])) as {
    open: number;
    completed: number;
  };
}
export function createTask(
  owner: string,
  title: string,
  options: Omit<TaskChanges, "title" | "completed"> = {},
): Task {
  invalidateCalendarReminders();
  const now = Date.now();
  if (options.boardId) requireBoard(owner, options.boardId);
  if (options.status === "done")
    throw new HttpError(400, "Create an open task, then complete it.");
  requireLinkedNote(owner, options.noteId);
  const recurrenceRule = options.recurrenceRule
    ? taskRecurrenceRuleSchema.parse(options.recurrenceRule)
    : null;
  if (options.recurrence && recurrenceRule)
    throw new HttpError(400, "Choose one task recurrence rule.");
  if ((options.recurrence || recurrenceRule) && !options.dueDate)
    throw new HttpError(400, "Choose a due date before repeating a task.");
  if (
    recurrenceRule?.until &&
    options.dueDate &&
    recurrenceRule.until < options.dueDate
  )
    throw new HttpError(
      400,
      "The recurrence end date must be on or after its due date.",
    );
  const schedule = options.schedule
    ? taskScheduleSchema.parse(options.schedule)
    : null;
  const plannedDate =
    options.plannedDate === undefined
      ? (schedule?.start.slice(0, 10) ?? null)
      : options.plannedDate;
  if (schedule && plannedDate !== schedule.start.slice(0, 10))
    throw new HttpError(
      400,
      "The planned date must match the scheduled time's date.",
    );
  if (schedule) resolveTaskSchedule(schedule);
  return sqlite()
    .transaction(() =>
      enrich(
        db()
          .insert(tasks)
          .values({
            id: randomUUID(),
            ownerId: owner,
            boardId: options.boardId,
            openStage:
              options.status === "in_progress" ? "in_progress" : "todo",
            boardPosition: insertionPosition(
              owner,
              options.boardId ?? null,
              options.status ?? "todo",
              "",
            ),
            title,
            createdAt: now,
            updatedAt: now,
            dueDate: options.dueDate,
            plannedDate,
            recurrence: options.recurrence,
            recurrenceRule,
            recurrenceDay: options.dueDate
              ? Number(options.dueDate.slice(8))
              : null,
            scheduleStartLocal: schedule?.start ?? null,
            scheduleTimezone: schedule?.timezone ?? null,
            scheduleDurationMinutes: schedule?.durationMinutes ?? null,
            scheduleDisambiguation: schedule?.disambiguation ?? null,
            scheduleIssue: null,
            noteId: options.noteId,
          })
          .returning(fields)
          .get(),
        owner,
      ),
    )
    .immediate();
}
export function updateTask(
  owner: string,
  id: string,
  input: TaskChanges & {
    revision: number;
    beforeId?: string | null;
    move?: boolean;
  },
): Task {
  return sqlite()
    .transaction(() => {
      const previous = db()
        .select(fields)
        .from(tasks)
        .where(
          and(
            eq(tasks.id, id),
            eq(tasks.ownerId, owner),
            isNull(tasks.trashedAt),
          ),
        )
        .get();
      if (!previous) throw new HttpError(404, "This task was not found.");
      if (previous.revision !== input.revision)
        throw new HttpError(
          409,
          "This task changed in another tab. Refresh tasks and try again.",
        );
      const previousTask = fromStorage(previous as unknown as TaskStorageRow);
      if (
        input.status !== undefined &&
        input.completed !== undefined &&
        (input.status === "done") !== input.completed
      )
        throw new HttpError(400, "Task status and completion must agree.");
      const boardId =
        input.boardId === undefined ? previous.boardId : input.boardId;
      if (boardId && boardId !== previous.boardId) requireBoard(owner, boardId);
      const completed =
        input.status !== undefined ? input.status === "done" : input.completed;
      const stage: TaskStage =
        input.status ??
        (completed === true
          ? "done"
          : completed === false
            ? previous.openStage
            : previous.completedAt !== null
              ? "done"
              : previous.openStage);
      if (
        input.title !== undefined ||
        input.dueDate !== undefined ||
        input.plannedDate !== undefined ||
        input.recurrence !== undefined ||
        input.recurrenceRule !== undefined ||
        input.schedule !== undefined ||
        (completed !== undefined &&
          completed !== (previous.completedAt !== null))
      )
        invalidateCalendarReminders();
      const previousStage =
        previous.completedAt !== null ? "done" : previous.openStage;
      const moved =
        input.move || boardId !== previous.boardId || stage !== previousStage;
      const position = moved
        ? insertionPosition(owner, boardId, stage, id, input.beforeId)
        : previous.boardPosition;
      requireLinkedNote(owner, input.noteId);
      const due =
        input.dueDate === undefined ? previous.dueDate : input.dueDate;
      const recurrenceRule =
        input.recurrenceRule === undefined
          ? input.recurrence
            ? null
            : previousTask.recurrenceRule
          : input.recurrenceRule
            ? taskRecurrenceRuleSchema.parse(input.recurrenceRule)
            : null;
      const repeat =
        input.recurrence === undefined
          ? input.recurrenceRule && recurrenceRule
            ? null
            : previous.recurrence
          : input.recurrence;
      if (repeat && recurrenceRule)
        throw new HttpError(400, "Choose one task recurrence rule.");
      if ((repeat || recurrenceRule) && !due)
        throw new HttpError(400, "Choose a due date before repeating a task.");
      if (recurrenceRule?.until && due && recurrenceRule.until < due)
        throw new HttpError(
          400,
          "The recurrence end date must be on or after its due date.",
        );
      let plannedDate =
        input.plannedDate === undefined
          ? previousTask.plannedDate
          : input.plannedDate;
      let schedule = previousTask.schedule;
      let scheduleIssue = previousTask.scheduleIssue;
      if (input.schedule !== undefined) {
        schedule = input.schedule
          ? taskScheduleSchema.parse(input.schedule)
          : null;
        scheduleIssue = null;
        if (schedule) {
          const scheduleDate = schedule.start.slice(0, 10);
          if (input.plannedDate === undefined) plannedDate = scheduleDate;
          else if (plannedDate !== scheduleDate)
            throw new HttpError(
              400,
              "The planned date must match the scheduled time's date.",
            );
          resolveTaskSchedule(schedule);
        }
      } else if (input.plannedDate !== undefined) {
        if (plannedDate === null) {
          schedule = null;
          scheduleIssue = null;
        } else if (schedule && plannedDate !== previousTask.plannedDate) {
          schedule = shiftTaskScheduleDate(schedule, plannedDate);
          scheduleIssue = null;
        }
      }
      if (schedule && plannedDate !== schedule.start.slice(0, 10))
        throw new HttpError(
          400,
          "The planned date must match the scheduled time's date.",
        );
      const anchor =
        input.dueDate !== undefined && due !== previous.dueDate
          ? due
            ? Number(due.slice(8))
            : null
          : previous.recurrenceDay;
      const task = db()
        .update(tasks)
        .set({
          ...(input.title !== undefined ? { title: input.title } : {}),
          boardId,
          boardPosition: position,
          ...(input.status && input.status !== "done"
            ? { openStage: input.status }
            : {}),
          ...(completed !== undefined
            ? {
                completedAt: completed
                  ? (previous.completedAt ?? Date.now())
                  : null,
              }
            : {}),
          revision: input.revision + 1,
          ...(input.plannedDate !== undefined || input.schedule !== undefined
            ? { plannedDate }
            : {}),
          updatedAt: Date.now(),
          ...(input.dueDate !== undefined
            ? { dueDate: input.dueDate, recurrenceDay: anchor }
            : {}),
          ...(input.recurrence !== undefined ||
          input.recurrenceRule !== undefined
            ? { recurrence: repeat }
            : {}),
          ...(input.recurrenceRule !== undefined ||
          input.recurrence !== undefined
            ? { recurrenceRule }
            : {}),
          ...(input.plannedDate !== undefined || input.schedule !== undefined
            ? {
                scheduleStartLocal: schedule?.start ?? null,
                scheduleTimezone: schedule?.timezone ?? null,
                scheduleDurationMinutes: schedule?.durationMinutes ?? null,
                scheduleDisambiguation: schedule?.disambiguation ?? null,
                scheduleIssue,
              }
            : {}),
          ...(input.noteId !== undefined ? { noteId: input.noteId } : {}),
        })
        .where(
          and(
            eq(tasks.id, id),
            eq(tasks.ownerId, owner),
            eq(tasks.revision, input.revision),
          ),
        )
        .returning(fields)
        .get();
      if (!task) {
        if (
          !db()
            .select({ id: tasks.id })
            .from(tasks)
            .where(
              and(
                eq(tasks.id, id),
                eq(tasks.ownerId, owner),
                isNull(tasks.trashedAt),
              ),
            )
            .get()
        )
          throw new HttpError(404, "This task was not found.");
        throw new HttpError(
          409,
          "This task changed in another tab. Refresh tasks and try again.",
        );
      }
      const canonicalTask = fromStorage(task as unknown as TaskStorageRow);
      if (
        input.title !== undefined ||
        input.dueDate !== undefined ||
        input.plannedDate !== undefined ||
        input.recurrence !== undefined ||
        input.recurrenceRule !== undefined ||
        input.schedule !== undefined ||
        (completed !== undefined &&
          completed !== (previous.completedAt !== null))
      )
        sqlite()
          .prepare(
            "UPDATE calendar_reminders SET state='cancelled' WHERE source_type='task' AND source_id=? AND state='queued'",
          )
          .run(id);
      if (
        completed === true &&
        previous.completedAt === null &&
        (repeat || recurrenceRule) &&
        due &&
        !db()
          .select({ id: tasks.id })
          .from(tasks)
          .where(eq(tasks.parentTaskId, id))
          .get()
      ) {
        const completionDate = previousTask.schedule
          ? Temporal.Instant.fromEpochMilliseconds(Date.now())
              .toZonedDateTimeISO(previousTask.schedule.timezone)
              .toPlainDate()
              .toString()
          : Temporal.Instant.fromEpochMilliseconds(Date.now())
              .toZonedDateTimeISO("UTC")
              .toPlainDate()
              .toString();
        const following = recurrenceRule
          ? nextRuleDate(
              recurrenceRule.anchor === "scheduled" ? due : completionDate,
              recurrenceRule.anchor === "scheduled" && completionDate < due
                ? due
                : completionDate,
              recurrenceRule,
            )
          : nextDate(due, repeat!, anchor ?? undefined);
        if (following && !validDate(following))
          throw new HttpError(
            400,
            "The next occurrence is outside the supported date range.",
          );
        if (following) {
          const occurrenceId = randomUUID();
          const plannedFollowing =
            canonicalTask.plannedDate && canonicalTask.dueDate
              ? Temporal.PlainDate.from(canonicalTask.plannedDate)
                  .add({
                    days: Temporal.PlainDate.from(canonicalTask.dueDate).until(
                      Temporal.PlainDate.from(following),
                    ).days,
                  })
                  .toString()
              : null;
          let occurrenceSchedule = canonicalTask.schedule;
          let occurrenceScheduleIssue: Task["scheduleIssue"] = null;
          if (occurrenceSchedule && canonicalTask.dueDate && plannedFollowing) {
            const shifted = {
              ...occurrenceSchedule,
              start: `${plannedFollowing}T${occurrenceSchedule.start.slice(11)}`,
            };
            const validSchedule = taskScheduleSchema.safeParse(shifted);
            if (validSchedule.success) occurrenceSchedule = validSchedule.data;
            else {
              occurrenceSchedule = storedTaskScheduleSchema.parse(shifted);
              occurrenceScheduleIssue = "needs-scheduling";
            }
          }
          const nextDueAnchor =
            recurrenceRule?.anchor === "scheduled"
              ? Number(following.slice(8))
              : anchor;
          db()
            .insert(tasks)
            .values({
              id: occurrenceId,
              ownerId: owner,
              boardId: canonicalTask.boardId,
              openStage: "todo",
              boardPosition: insertionPosition(
                owner,
                canonicalTask.boardId,
                "todo",
                occurrenceId,
              ),
              title: canonicalTask.title,
              dueDate: following,
              plannedDate: plannedFollowing,
              recurrence: repeat,
              recurrenceRule,
              recurrenceDay: nextDueAnchor,
              scheduleStartLocal: occurrenceSchedule?.start ?? null,
              scheduleTimezone: occurrenceSchedule?.timezone ?? null,
              scheduleDurationMinutes:
                occurrenceSchedule?.durationMinutes ?? null,
              scheduleDisambiguation:
                occurrenceSchedule?.disambiguation ?? null,
              scheduleIssue: occurrenceScheduleIssue,
              parentTaskId: id,
              noteId: canonicalTask.noteId,
              createdAt: Date.now(),
              updatedAt: Date.now(),
            })
            .run();
          sqlite()
            .prepare(
              "INSERT INTO task_tags(task_id,tag_id) SELECT ?,tag_id FROM task_tags WHERE task_id=?",
            )
            .run(occurrenceId, id);
          sqlite()
            .prepare(
              "INSERT INTO calendar_task_reminders(task_id,timezone,field,offsets) SELECT ?,timezone,field,offsets FROM calendar_task_reminders WHERE task_id=?",
            )
            .run(occurrenceId, id);
        }
      }
      const current = db()
        .select(fields)
        .from(tasks)
        .where(
          and(
            eq(tasks.id, id),
            eq(tasks.ownerId, owner),
            isNull(tasks.trashedAt),
          ),
        )
        .get();
      if (!current) throw new HttpError(404, "This task was not found.");
      return enrich(current as unknown as TaskStorageRow, owner);
    })
    .immediate();
}
export function deleteTask(owner: string, id: string, revision: number) {
  moveToTrash(owner, "task", id, revision);
  sqlite()
    .prepare(
      "UPDATE calendar_reminders SET state='cancelled' WHERE source_type='task' AND source_id=? AND state='queued'",
    )
    .run(id);
  invalidateCalendarReminders();
}

export function getTask(owner: string, id: string): Task {
  const row = sqlite()
    .prepare(
      `SELECT ${taskColumns} FROM tasks t LEFT JOIN notes n ON n.id=t.note_id AND n.kind='note' WHERE t.id=? AND t.owner_id=? AND t.trashed_at IS NULL`,
    )
    .get(id, owner) as TaskStorageRow | undefined;
  if (!row) throw new HttpError(404, "This task was not found.");
  const task = enrich(row, owner);
  task.tags = sqlite()
    .prepare(
      "SELECT t.id,t.name,t.color FROM task_tags tt JOIN tags t ON t.id=tt.tag_id WHERE tt.task_id=? ORDER BY t.name",
    )
    .all(id) as import("../types").Tag[];
  return task;
}
export function moveTask(
  owner: string,
  id: string,
  input: {
    revision: number;
    boardId: string | null;
    status: TaskStage;
    beforeId?: string | null;
  },
): Task {
  return updateTask(owner, id, { ...input, move: true });
}
