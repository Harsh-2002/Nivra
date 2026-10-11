import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

test("task boards preserve canonical tasks, ordering, recurrence, ownership and archive state", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "nivra-boards-"));
  process.env.NIVRA_DATA_DIR = directory;
  const { sqlite } = await import("../src/lib/server/db");
  const { createBoard, getBoard, updateBoard, listBoards } =
    await import("../src/lib/server/boards");
  const {
    createTask,
    updateTask,
    moveTask,
    listTaskPage,
    getTask,
    deleteTask,
  } = await import("../src/lib/server/tasks");
  const { restoreTrash } = await import("../src/lib/server/trash");
  const { authorizeContentPath } =
    await import("../src/lib/server/agent-access");
  const db = sqlite();
  const owner = randomUUID();
  db.prepare(
    "INSERT INTO user(id,name,email,username,created_at,updated_at) VALUES(?,?,?,?,?,?)",
  ).run(owner, "Owner", "owner@example.test", "owner", 1, 1);
  try {
    await t.test(
      "old tasks remain unassigned and board pages/counts exclude unrelated tasks",
      () => {
        const ordinary = createTask(owner, "Ordinary");
        assert.equal(ordinary.boardId, null);
        assert.equal(ordinary.status, "todo");
        const board = createBoard(owner, "Research");
        const older = createTask(owner, "First", { boardId: board.id });
        const newer = createTask(owner, "Second", { boardId: board.id });
        const rows = listTaskPage(owner, {
          filter: "open",
          query: "",
          limit: 50,
          boardId: board.id,
          status: "todo",
          order: "board",
        });
        assert.deepEqual(
          rows.items.map((i) => i.id),
          [newer.id, older.id],
        );
        assert.deepEqual(getBoard(owner, board.id).counts, {
          todo: 2,
          in_progress: 0,
          done: 0,
        });
        const moved = moveTask(owner, older.id, {
          revision: older.revision,
          boardId: board.id,
          status: "in_progress",
        });
        assert.equal(moved.status, "in_progress");
        const done = updateTask(owner, moved.id, {
          revision: moved.revision,
          completed: true,
        });
        assert.equal(done.status, "done");
        const reopen = updateTask(owner, done.id, {
          revision: done.revision,
          completed: false,
        });
        assert.equal(reopen.status, "in_progress");
        assert.throws(
          () =>
            moveTask(owner, older.id, {
              revision: older.revision,
              boardId: board.id,
              status: "todo",
            }),
          /changed/,
        );
        assert.throws(
          () =>
            updateTask(owner, reopen.id, {
              revision: reopen.revision,
              status: "done",
              completed: false,
            }),
          /agree/,
        );
      },
    );
    await t.test(
      "relative ordering survives reload, transfer and pagination",
      () => {
        const a = createBoard(owner, "A"),
          b = createBoard(owner, "B");
        const one = createTask(owner, "Alpha", { boardId: a.id }),
          two = createTask(owner, "Beta", { boardId: a.id });
        const reordered = moveTask(owner, one.id, {
          revision: one.revision,
          boardId: a.id,
          status: "todo",
          beforeId: two.id,
        });
        assert.deepEqual(
          listTaskPage(owner, {
            filter: "open",
            query: "",
            limit: 1,
            boardId: a.id,
            status: "todo",
            order: "board",
          }).items.map((i) => i.id),
          [one.id],
        );
        const first = listTaskPage(owner, {
          filter: "open",
          query: "",
          limit: 1,
          boardId: a.id,
          status: "todo",
          order: "board",
        });
        assert.ok(first.next);
        assert.equal(
          listTaskPage(owner, {
            filter: "open",
            query: "",
            limit: 1,
            boardId: a.id,
            status: "todo",
            order: "board",
            after: first.next,
          }).items[0].id,
          two.id,
        );
        const transferred = moveTask(owner, one.id, {
          revision: reordered.revision,
          boardId: b.id,
          status: "todo",
        });
        assert.equal(getBoard(owner, a.id).counts.todo, 1);
        assert.equal(getBoard(owner, b.id).counts.todo, 1);
        assert.throws(
          () =>
            moveTask(owner, two.id, {
              revision: two.revision,
              boardId: a.id,
              status: "todo",
              beforeId: one.id,
            }),
          /destination task/,
        );
        const unassigned = moveTask(owner, one.id, {
          revision: transferred.revision,
          boardId: null,
          status: "in_progress",
        });
        assert.equal(unassigned.boardId, null);
        assert.equal(unassigned.status, "in_progress");
      },
    );
    await t.test(
      "archive preserves dates and reminders; trash restoration retains stage and board",
      () => {
        const board = createBoard(owner, "Archive");
        const task = createTask(owner, "Keep", {
          boardId: board.id,
          status: "in_progress",
          dueDate: "2026-11-01",
        });
        db.prepare("INSERT INTO calendar_task_reminders VALUES(?,?,?,?)").run(
          task.id,
          "UTC",
          "due",
          "[0]",
        );
        const archived = updateBoard(owner, board.id, {
          revision: board.revision,
          archived: true,
        });
        assert.ok(archived.archivedAt);
        assert.equal(
          listBoards(owner, false, 100, null).items.some(
            (b) => b.id === board.id,
          ),
          false,
        );
        assert.equal(getTask(owner, task.id).dueDate, "2026-11-01");
        assert.equal(
          (
            db
              .prepare(
                "SELECT count(*) AS n FROM calendar_task_reminders WHERE task_id=?",
              )
              .get(task.id) as { n: number }
          ).n,
          1,
        );
        assert.throws(
          () => createTask(owner, "No", { boardId: board.id }),
          /Reopen/,
        );
        deleteTask(owner, task.id, task.revision);
        assert.equal(getBoard(owner, board.id).counts.in_progress, 0);
        restoreTrash(owner, "task", task.id, task.revision + 1);
        assert.equal(getTask(owner, task.id).boardId, board.id);
        assert.equal(getTask(owner, task.id).status, "in_progress");
        updateBoard(owner, board.id, {
          revision: archived.revision,
          archived: false,
        });
        assert.equal(getBoard(owner, board.id).archivedAt, null);
      },
    );
    await t.test(
      "recurring completion creates one successor in the same board with copied metadata",
      () => {
        const board = createBoard(owner, "Repeat");
        const task = createTask(owner, "Weekly", {
          boardId: board.id,
          status: "in_progress",
          dueDate: "2026-11-01",
          recurrence: "weekly",
        });
        db.prepare("INSERT INTO calendar_task_reminders VALUES(?,?,?,?)").run(
          task.id,
          "UTC",
          "due",
          "[5]",
        );
        const tag = randomUUID();
        db.prepare("INSERT INTO tags(id,name,color) VALUES(?,?,?)").run(
          tag,
          "Work",
          "gray",
        );
        db.prepare("INSERT INTO task_tags VALUES(?,?)").run(task.id, tag);
        const done = moveTask(owner, task.id, {
          revision: task.revision,
          boardId: board.id,
          status: "done",
        });
        const successor = db
          .prepare(
            "SELECT id,board_id,open_stage,due_date FROM tasks WHERE parent_task_id=?",
          )
          .get(task.id) as {
          id: string;
          board_id: string;
          open_stage: string;
          due_date: string;
        };
        assert.equal(successor.board_id, board.id);
        assert.equal(successor.open_stage, "todo");
        assert.equal(successor.due_date, "2026-11-08");
        assert.equal(
          (
            db
              .prepare("SELECT count(*) AS n FROM task_tags WHERE task_id=?")
              .get(successor.id) as { n: number }
          ).n,
          1,
        );
        assert.equal(
          (
            db
              .prepare(
                "SELECT count(*) AS n FROM calendar_task_reminders WHERE task_id=?",
              )
              .get(successor.id) as { n: number }
          ).n,
          1,
        );
        updateTask(owner, task.id, {
          revision: done.revision,
          title: "Weekly edit",
        });
        assert.equal(
          (
            db
              .prepare("SELECT count(*) AS n FROM tasks WHERE parent_task_id=?")
              .get(task.id) as { n: number }
          ).n,
          1,
        );
      },
    );
    await t.test(
      "moves retain spelling cache generation and boundaries reject other owners/read-only agents",
      () => {
        const board = createBoard(owner, "Boundaries");
        const task = createTask(owner, "Searchable word", {
          boardId: board.id,
        });
        const version = () =>
          (
            db
              .prepare(
                "SELECT generation FROM search_versions WHERE vocabulary='tasks'",
              )
              .get() as { generation: number }
          ).generation;
        const before = version();
        const moved = moveTask(owner, task.id, {
          revision: task.revision,
          boardId: board.id,
          status: "in_progress",
        });
        assert.equal(version(), before);
        updateTask(owner, task.id, {
          revision: moved.revision,
          title: "New words",
        });
        assert.notEqual(version(), before);
        assert.throws(() => getBoard("other", board.id), /not found/);
        assert.throws(() => getTask("other", task.id), /not found/);
        assert.throws(
          () =>
            authorizeContentPath(
              { ownerId: owner, connectionId: "test", scopes: ["nivra:read"] },
              ["boards", board.id],
              "PATCH",
            ),
          /permission/,
        );
        authorizeContentPath(
          { ownerId: owner, connectionId: "test", scopes: ["nivra:read"] },
          ["boards", board.id],
          "GET",
        );
        assert.equal(
          listTaskPage(owner, {
            filter: "open",
            query: "New wor",
            limit: 50,
            boardId: board.id,
            status: "in_progress",
            order: "board",
          }).items[0].id,
          task.id,
        );
      },
    );
    assert.equal(db.pragma("integrity_check", { simple: true }), "ok");
  } finally {
    const { stopJobWorker } = await import("../src/lib/server/jobs");
    await stopJobWorker();
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
