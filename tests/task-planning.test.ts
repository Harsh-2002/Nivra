import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  nextRuleDate,
  resolveTaskSchedule,
  taskRecurrenceRuleSchema,
  taskScheduleSchema,
} from "../src/lib/task-planning";

test("task planning validates local times, recurrence and schedule resolution", () => {
  const gap = {
    start: "2026-03-08T02:30",
    timezone: "America/New_York",
    durationMinutes: 30,
    disambiguation: "reject",
  } as const;
  assert.equal(taskScheduleSchema.safeParse(gap).success, false);
  const overlap = taskScheduleSchema.parse({
    start: "2026-11-01T01:30",
    timezone: "America/New_York",
    durationMinutes: 30,
    disambiguation: "earlier",
  });
  const later = resolveTaskSchedule({ ...overlap, disambiguation: "later" });
  assert.equal(later.startAt - resolveTaskSchedule(overlap).startAt, 3_600_000);
  const weekly = taskRecurrenceRuleSchema.parse({
    frequency: "weekly",
    interval: 2,
    weekdays: [1, 3],
    anchor: "scheduled",
    until: null,
  });
  assert.equal(nextRuleDate("2026-10-05", "2026-10-06", weekly), "2026-10-07");
  const daily = taskRecurrenceRuleSchema.parse({
    frequency: "daily",
    interval: 1,
    anchor: "scheduled",
  });
  assert.equal(nextRuleDate("2026-10-01", "2026-10-04", daily), "2026-10-05");
  assert.equal(
    nextRuleDate("2026-10-05", "2026-10-08", {
      ...weekly,
      until: "2026-10-07",
    }),
    null,
  );
});

test("task schedules, recurrence, steps and step search persist transactionally", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "nivra-task-planning-"));
  const previousDirectory = process.env.NIVRA_DATA_DIR;
  process.env.NIVRA_DATA_DIR = directory;
  const { sqlite } = await import("../src/lib/server/db");
  const { createTask, getTask, listTaskPage, listTasks, updateTask } =
    await import("../src/lib/server/tasks");
  const { executeTaskPlanning } =
    await import("../src/lib/server/task-planning-service");
  const { calendarRange } = await import("../src/lib/server/calendar");
  const { prepareReminders } =
    await import("../src/lib/server/calendar-reminders");
  const database = sqlite();
  const owner = randomUUID();
  database
    .prepare(
      "INSERT INTO user(id,name,email,username,created_at,updated_at) VALUES(?,?,?,?,?,?)",
    )
    .run(owner, "Owner", "owner@example.test", "owner", 1, 1);

  const command = (method: string, pathParts: string[], input?: unknown) =>
    executeTaskPlanning({
      ownerId: owner,
      origin: "http://localhost",
      path: pathParts,
      method,
      input,
    });

  try {
    await t.test(
      "steps use parent revision checks and stable ordering",
      async () => {
        const task = createTask(owner, "Replace water filter");
        const first = await command("POST", ["tasks", task.id, "steps"], {
          revision: task.revision,
          text: "Check the filter housing",
        });
        assert.ok(first && "data" in first);
        const firstValue = first.data as {
          task: typeof task;
          step: { id: string; revision: number };
        };
        assert.equal(firstValue.task.revision, task.revision + 1);
        const second = await command("POST", ["tasks", task.id, "steps"], {
          revision: firstValue.task.revision,
          text: "Order a replacement cartridge",
        });
        assert.ok(second && "data" in second);
        const secondValue = second.data as {
          task: typeof task;
          step: { id: string };
        };
        assert.notEqual(firstValue.step.id, secondValue.step.id);
        const source = database
          .prepare("SELECT text FROM ai_sources WHERE source_key=?")
          .get(`task:${task.id}`) as { text: string };
        const aiState = database
          .prepare("SELECT generation,state FROM ai_content WHERE source_key=?")
          .get(`task:${task.id}`) as { generation: number; state: string };
        assert.match(source.text, /Check the filter housing/);
        assert.match(source.text, /Order a replacement cartridge/);
        assert.ok(aiState.generation >= 3);
        assert.equal(aiState.state, "pending");
        assert.deepEqual(
          listTaskPage(owner, {
            filter: "open",
            query: "replacement cartridge",
            limit: 10,
          }).items.map((item) => item.id),
          [task.id],
        );

        const update = await command(
          "PATCH",
          ["tasks", task.id, "steps", firstValue.step.id],
          {
            revision: secondValue.task.revision,
            completed: true,
            text: "Confirm the replacement cartridge fits",
            position: 1,
          },
        );
        assert.ok(update && "data" in update);
        const updated = update.data as {
          task: typeof task;
          step: { id: string; completed: boolean; position: number };
        };
        assert.deepEqual(updated.task.stepProgress, { completed: 1, total: 2 });
        assert.equal(updated.step.completed, true);
        assert.equal(updated.step.position, 1);
        assert.deepEqual(
          listTaskPage(owner, {
            filter: "open",
            query: "cartridge fits",
            limit: 10,
          }).items.map((item) => item.id),
          [task.id],
        );
        const updatedSource = database
          .prepare("SELECT text FROM ai_sources WHERE source_key=?")
          .get(`task:${task.id}`) as { text: string };
        assert.match(
          updatedSource.text,
          /Confirm the replacement cartridge fits/,
        );
        await assert.rejects(
          command("DELETE", ["tasks", task.id, "steps", firstValue.step.id], {
            revision: secondValue.task.revision,
          }),
          /changed/,
        );

        const deleteResult = await command(
          "DELETE",
          ["tasks", task.id, "steps", secondValue.step.id],
          { revision: updated.task.revision },
        );
        assert.ok(deleteResult && "data" in deleteResult);
        const finalTask = (deleteResult.data as { task: typeof task }).task;
        assert.deepEqual(finalTask.stepProgress, { completed: 1, total: 1 });
        assert.equal(getTask(owner, task.id).revision, finalTask.revision);
      },
    );

    await t.test(
      "completion advances custom recurrence and preserves DST gaps as issues",
      () => {
        const originalNow = Date.now;
        try {
          Date.now = () => Date.parse("2026-03-07T01:00:00Z");
          const task = createTask(owner, "Water garden", {
            dueDate: "2026-03-07",
            plannedDate: "2026-03-07",
            schedule: {
              start: "2026-03-07T02:30",
              timezone: "America/New_York",
              durationMinutes: 45,
              disambiguation: "reject",
            },
            recurrenceRule: {
              frequency: "daily",
              interval: 1,
              weekdays: [],
              anchor: "scheduled",
              until: null,
            },
          });
          database
            .prepare(
              "INSERT INTO calendar_task_reminders(task_id,timezone,field,offsets) VALUES(?,?,?,?)",
            )
            .run(
              task.id,
              task.schedule!.timezone,
              "schedule",
              JSON.stringify([30]),
            );
          prepareReminders(Date.now());
          const scheduledReminder = database
            .prepare(
              "SELECT starts_at AS startsAt,scheduled_at AS scheduledAt FROM calendar_reminders WHERE source_type='task' AND source_id=? AND occurrence=?",
            )
            .get(task.id, task.schedule!.start) as
            { startsAt: number; scheduledAt: number } | undefined;
          const startAt = resolveTaskSchedule(task.schedule!).startAt;
          assert.deepEqual(scheduledReminder, {
            startsAt: startAt,
            scheduledAt: startAt - 30 * 60_000,
          });
          const completed = updateTask(owner, task.id, {
            revision: task.revision,
            completed: true,
          });
          const next = listTasks(owner).find(
            (item) => item.parentTaskId === task.id,
          );
          assert.equal(completed.status, "done");
          assert.ok(next);
          assert.equal(next.dueDate, "2026-03-08");
          assert.equal(next.plannedDate, "2026-03-08");
          assert.equal(next.schedule?.start, "2026-03-08T02:30");
          assert.equal(next.scheduleIssue, "needs-scheduling");
          const calendar = calendarRange(
            owner,
            "2026-03-07",
            "2026-03-09",
            "America/New_York",
          );
          const scheduledBlock = calendar.items.find(
            (item) =>
              item.sourceId === task.id && item.label === "Scheduled · Due",
          );
          assert.equal(scheduledBlock?.startAt, startAt);
          const eveningTask = createTask(owner, "Close greenhouse", {
            schedule: {
              start: "2026-03-07T23:30",
              timezone: "America/New_York",
              durationMinutes: 30,
              disambiguation: "reject",
            },
          });
          const utcCalendar = calendarRange(
            owner,
            "2026-03-08",
            "2026-03-09",
            "UTC",
          );
          const crossZoneItem = utcCalendar.items.find(
            (item) => item.sourceId === eveningTask.id,
          );
          assert.equal(crossZoneItem?.date, "2026-03-08");
          assert.ok(crossZoneItem?.startAt);
          const schedulingIssue = calendar.items.find(
            (item) => item.sourceId === next.id && item.scheduleIssue,
          );
          assert.equal(schedulingIssue?.date, "2026-03-08");
          assert.equal(schedulingIssue?.startAt, undefined);

          const missed = createTask(owner, "Review the garden", {
            dueDate: "2026-03-01",
            recurrenceRule: {
              frequency: "daily",
              interval: 1,
              weekdays: [],
              anchor: "scheduled",
              until: null,
            },
          });
          const missedCompleted = updateTask(owner, missed.id, {
            revision: missed.revision,
            completed: true,
          });
          const missedNext = listTasks(owner).find(
            (item) => item.parentTaskId === missed.id,
          );
          assert.equal(missedCompleted.status, "done");
          assert.equal(missedNext?.dueDate, "2026-03-08");
        } finally {
          Date.now = originalNow;
        }
      },
    );
  } finally {
    database.close();
    process.env.NIVRA_DATA_DIR = previousDirectory;
    await rm(directory, { recursive: true, force: true });
  }
});
