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
  noteId?: string | null;
};
function enrich(
  task: Omit<Task, "noteTitle" | "status"> & {
    openStage: "todo" | "in_progress";
  },
): Task {
  const note = task.noteId
    ? db()
        .select({ title: notes.title })
        .from(notes)
        .where(and(eq(notes.id, task.noteId), eq(notes.kind, "note")))
        .get()
    : undefined;
  const { openStage, ...rest } = task;
  return {
    ...rest,
    status: task.completedAt !== null ? "done" : openStage,
    noteTitle: note?.title ?? null,
  };
}
export function listTasks(owner: string, includeTrash = false): Task[] {
  return db()
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
    .map((task) => ({
      ...task,
      status: task.completedAt !== null ? ("done" as const) : task.openStage,
    }));
}
const taskColumns =
  "t.id,t.title,t.board_id AS boardId,t.board_position AS boardPosition,CASE WHEN t.completed_at IS NOT NULL THEN 'done' ELSE t.open_stage END AS status,(SELECT name FROM task_boards WHERE id=t.board_id) AS boardName,t.completed_at AS completedAt,t.revision,t.created_at AS createdAt,t.updated_at AS updatedAt,t.due_date AS dueDate,t.planned_date AS plannedDate,t.recurrence,t.recurrence_day AS recurrenceDay,t.parent_task_id AS parentTaskId,t.note_id AS noteId,n.title AS noteTitle";
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
        "t.rowid IN (SELECT rowid FROM tasks_fts WHERE tasks_fts MATCH ?)",
      );
      values.push(match);
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
    .all(...values, options.limit + 1) as Task[];
  const items = rows.slice(0, options.limit);
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
  if (options.recurrence && !options.dueDate)
    throw new HttpError(400, "Choose a due date before repeating a task.");
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
            plannedDate: options.plannedDate,
            recurrence: options.recurrence,
            recurrenceDay: options.dueDate
              ? Number(options.dueDate.slice(8))
              : null,
            noteId: options.noteId,
          })
          .returning(fields)
          .get(),
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
      const repeat =
        input.recurrence === undefined ? previous.recurrence : input.recurrence;
      if (repeat && !due)
        throw new HttpError(400, "Choose a due date before repeating a task.");
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
          ...(input.plannedDate !== undefined
            ? { plannedDate: input.plannedDate }
            : {}),
          updatedAt: Date.now(),
          ...(input.dueDate !== undefined
            ? { dueDate: input.dueDate, recurrenceDay: anchor }
            : {}),
          ...(input.recurrence !== undefined
            ? { recurrence: input.recurrence }
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
      if (
        completed === true &&
        previous.completedAt === null &&
        repeat &&
        due &&
        !db()
          .select({ id: tasks.id })
          .from(tasks)
          .where(eq(tasks.parentTaskId, id))
          .get()
      ) {
        const following = nextDate(due, repeat, anchor ?? undefined);
        if (!validDate(following))
          throw new HttpError(
            400,
            "The next occurrence is outside the supported date range.",
          );
        const occurrenceId = randomUUID();
        db()
          .insert(tasks)
          .values({
            id: occurrenceId,
            ownerId: owner,
            boardId: task.boardId,
            openStage: "todo",
            boardPosition: insertionPosition(
              owner,
              task.boardId,
              "todo",
              occurrenceId,
            ),
            title: task.title,
            dueDate: following,
            plannedDate:
              task.plannedDate && task.dueDate
                ? new Date(
                    Date.parse(task.plannedDate + "T12:00:00Z") +
                      Date.parse(following + "T12:00:00Z") -
                      Date.parse(task.dueDate + "T12:00:00Z"),
                  )
                    .toISOString()
                    .slice(0, 10)
                : null,
            recurrence: repeat,
            recurrenceDay: anchor,
            parentTaskId: id,
            noteId: task.noteId,
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
      return enrich(current);
    })
    .immediate();
}
export function deleteTask(owner: string, id: string, revision: number) {
  moveToTrash(owner, "task", id, revision);
  invalidateCalendarReminders();
}

export function getTask(owner: string, id: string): Task {
  const row = sqlite()
    .prepare(
      `SELECT ${taskColumns} FROM tasks t LEFT JOIN notes n ON n.id=t.note_id AND n.kind='note' WHERE t.id=? AND t.owner_id=? AND t.trashed_at IS NULL`,
    )
    .get(id, owner) as Task | undefined;
  if (!row) throw new HttpError(404, "This task was not found.");
  row.tags = sqlite()
    .prepare(
      "SELECT t.id,t.name,t.color FROM task_tags tt JOIN tags t ON t.id=tt.tag_id WHERE tt.task_id=? ORDER BY t.name",
    )
    .all(id) as import("../types").Tag[];
  return row;
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
