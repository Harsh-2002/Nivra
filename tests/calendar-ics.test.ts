import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import { eventInput, eventPayload } from "../src/lib/calendar";

test("calendar ICS export is bounded, private, and RFC 5545-safe", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "nivra-calendar-ics-"));
  const previousDirectory = process.env.NIVRA_DATA_DIR;
  process.env.NIVRA_DATA_DIR = directory;
  const { sqlite } = await import("../src/lib/server/db");
  const { createEvent, trashEvent, updateEvent } =
    await import("../src/lib/server/calendar");
  const { createTask, deleteTask } = await import("../src/lib/server/tasks");
  const { exportCalendarIcs } = await import("../src/lib/server/calendar-ics");
  const database = sqlite();
  const owner = randomUUID();
  const createOwner = (id: string, username: string) =>
    database
      .prepare(
        "INSERT INTO user(id,name,email,username,created_at,updated_at) VALUES(?,?,?,?,1,1)",
      )
      .run(id, "Owner", `${username}@example.test`, username);
  createOwner(owner, "ics-owner");

  try {
    const linkedNoteId = randomUUID();
    database
      .prepare(
        "INSERT INTO notes(id,owner_id,title,document,text,kind,created_at,updated_at) VALUES(?,?,?,?,?,'note',1,1)",
      )
      .run(
        linkedNoteId,
        owner,
        "Private linked title",
        "{}",
        "PRIVATE_LINKED_BODY_SENTINEL",
      );
    database
      .prepare(
        "INSERT INTO notes(id,owner_id,title,document,text,kind,daily_date,created_at,updated_at) VALUES(?,?,?,?,?,'note',?,1,1)",
      )
      .run(
        randomUUID(),
        owner,
        "Private journal sentinel",
        "{}",
        "PRIVATE_JOURNAL_BODY_SENTINEL",
        "2026-05-11",
      );

    createEvent(owner, {
      title: "Plan, review; \\release",
      description: "First line\r\nSecond line",
      location: "Room, 2",
      start: "2026-05-10",
      end: "2026-05-12",
      timezone: "America/Los_Angeles",
      links: [{ type: "note", id: linkedNoteId }],
    });
    createEvent(owner, {
      title: `Long meeting ${"ñ".repeat(80)}`,
      allDay: false,
      start: "2026-05-11T09:30",
      end: "2026-05-11T10:15",
      timezone: "America/New_York",
    });
    const series = createEvent(owner, {
      title: "Recurring check-in",
      start: "2026-05-12",
      end: "2026-05-13",
      timezone: "UTC",
      recurrence: { frequency: "daily", count: 3 },
    });
    const movedOccurrence = updateEvent(
      owner,
      series.id,
      series.revision,
      {
        ...eventPayload(series),
        title: "Rescheduled check-in",
        start: "2026-05-13",
        end: "2026-05-14",
        recurrence: null,
      },
      "occurrence",
      "2026-05-13",
    );
    assert.equal(movedOccurrence.title, "Rescheduled check-in");

    const deletedEvent = createEvent(owner, {
      title: "Trashed event sentinel",
      start: "2026-05-11",
      end: "2026-05-12",
      timezone: "UTC",
    });
    trashEvent(owner, deletedEvent.id, deletedEvent.revision);
    createEvent(owner, {
      title: "Exclusive range boundary sentinel",
      start: "2026-05-16",
      end: "2026-05-17",
      timezone: "UTC",
    });

    createTask(owner, "Scheduled task", {
      dueDate: "2026-05-11",
      schedule: {
        start: "2026-05-11T09:00",
        timezone: "America/New_York",
        durationMinutes: 45,
        disambiguation: "reject",
      },
    });
    createTask(owner, "Deadline only", {
      dueDate: "2026-05-14",
    });
    createTask(owner, "Planned-only task must not export", {
      plannedDate: "2026-05-12",
    });
    createTask(owner, "Exclusive deadline boundary sentinel", {
      dueDate: "2026-05-16",
    });
    const deletedTask = createTask(owner, "Deleted task sentinel", {
      dueDate: "2026-05-15",
    });
    deleteTask(owner, deletedTask.id, deletedTask.revision);

    const insertIrrelevantEvent = database.prepare(
      "INSERT INTO calendar_events(id,owner_id,title,description,start_date,end_date,recurring,data,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,1,1,1)",
    );
    const pastEvent = eventInput.parse({
      title: "Old irrelevant event",
      start: "2000-01-01",
      end: "2000-01-02",
      timezone: "UTC",
    });
    const futureEvent = eventInput.parse({
      title: "Future irrelevant event",
      start: "2040-01-01",
      end: "2040-01-02",
      timezone: "UTC",
    });
    const expiredSeries = eventInput.parse({
      title: "Expired irrelevant series",
      start: "2000-01-01",
      end: "2000-01-02",
      timezone: "UTC",
      recurrence: { frequency: "daily", until: "2001-01-01" },
    });
    const futureSeries = eventInput.parse({
      title: "Future irrelevant series",
      start: "2040-01-01",
      end: "2040-01-02",
      timezone: "UTC",
      recurrence: { frequency: "daily", until: "2041-01-01" },
    });
    database.transaction(() => {
      for (let index = 0; index < 3_000; index++) {
        for (const payload of [
          pastEvent,
          futureEvent,
          expiredSeries,
          futureSeries,
        ])
          insertIrrelevantEvent.run(
            randomUUID(),
            owner,
            payload.title,
            payload.description,
            payload.start.slice(0, 10),
            payload.end.slice(0, 10),
            payload.recurrence ? 1 : 0,
            JSON.stringify(payload),
          );
      }
    })();

    const oneOffPlan = database
      .prepare(
        "EXPLAIN QUERY PLAN SELECT id FROM calendar_events INDEXED BY calendar_events_export_active_once_idx WHERE owner_id=? AND trashed_at IS NULL AND recurring=0 AND start_date<? AND end_date>=?",
      )
      .all(owner, "2026-05-18", "2026-05-08") as { detail: string }[];
    assert.ok(
      oneOffPlan.some((row) =>
        row.detail.includes("calendar_events_export_active_once_idx"),
      ),
    );
    const recurringPlan = database
      .prepare(
        "EXPLAIN QUERY PLAN SELECT id FROM calendar_events INDEXED BY calendar_events_export_active_repeat_idx WHERE owner_id=? AND trashed_at IS NULL AND recurring=1 AND start_date<? AND (json_extract(data,'$.recurrence.until') IS NULL OR date(json_extract(data,'$.recurrence.until'),printf('+%d days',CAST(julianday(end_date)-julianday(start_date) AS INTEGER)+2))>=?)",
      )
      .all(owner, "2026-05-18", "2026-05-10") as { detail: string }[];
    assert.ok(
      recurringPlan.some((row) =>
        row.detail.includes("calendar_events_export_active_repeat_idx"),
      ),
    );

    const response = exportCalendarIcs(owner, {
      from: "2026-05-10",
      to: "2026-05-16",
      timezone: "America/New_York",
    });
    assert.equal(response.status, 200);
    assert.equal(
      response.headers.get("content-type"),
      "text/calendar; charset=utf-8; method=PUBLISH",
    );
    assert.equal(
      response.headers.get("cache-control"),
      "private, no-store, max-age=0",
    );
    assert.match(
      response.headers.get("content-disposition") ?? "",
      /attachment; filename=/,
    );
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");

    const body = await response.text();
    assert.ok(body.endsWith("END:VCALENDAR\r\n"));
    assert.ok(!/(^|[^\r])\n/.test(body));
    assert.match(body, /SUMMARY:Plan\\, review\\; \\\\release/);
    assert.match(body, /DESCRIPTION:First line\\nSecond line/);
    assert.match(body, /LOCATION:Room\\, 2/);
    assert.match(body, /DTEND;VALUE=DATE:20260512/);
    assert.match(body, /DTSTART:20260511T133000Z\r\nDTEND:20260511T141500Z/);
    assert.match(body, /BEGIN:VEVENT\r\nUID:[0-9a-f]{64}@nivra\r\nDTSTAMP:/);
    assert.match(
      body,
      /SUMMARY:Deadline: Deadline only\r\nDTSTART;VALUE=DATE:20260514\r\nDTEND;VALUE=DATE:20260515/,
    );
    assert.ok(!body.includes("BEGIN:VTODO"));
    assert.equal((body.match(/SUMMARY:Recurring check-in/g) ?? []).length, 2);
    assert.equal((body.match(/SUMMARY:Rescheduled check-in/g) ?? []).length, 1);
    assert.ok(body.includes(`SUMMARY:Scheduled task`));
    assert.ok(body.includes(`SUMMARY:Deadline: Scheduled task`));
    assert.ok(
      body.includes(`DTSTART;VALUE=DATE:20260511\r\nDTEND;VALUE=DATE:20260512`),
    );
    assert.ok(!body.includes("Planned-only task"));
    assert.ok(!body.includes("PRIVATE_LINKED_BODY_SENTINEL"));
    assert.ok(!body.includes("Private linked title"));
    assert.ok(!body.includes("PRIVATE_JOURNAL_BODY_SENTINEL"));
    assert.ok(!body.includes("Private journal sentinel"));
    assert.ok(!body.includes("Trashed event sentinel"));
    assert.ok(!body.includes("Deleted task sentinel"));
    assert.ok(!body.includes("Exclusive range boundary sentinel"));
    assert.ok(!body.includes("Exclusive deadline boundary sentinel"));
    assert.ok(!body.includes("irrelevant event"));
    assert.ok(!body.includes("irrelevant series"));
    const wrongOwner = await exportCalendarIcs(randomUUID(), {
      from: "2026-05-10",
      to: "2026-05-16",
      timezone: "UTC",
    }).text();
    assert.ok(!wrongOwner.includes("Plan"));

    const physicalLines = body.slice(0, -2).split("\r\n");
    assert.ok(physicalLines.every((line) => Buffer.byteLength(line) <= 75));
    const logicalLines: string[] = [];
    for (const line of physicalLines) {
      if (line.startsWith(" ")) {
        assert.ok(logicalLines.length > 0);
        logicalLines[logicalLines.length - 1] += line.slice(1);
      } else logicalLines.push(line);
    }
    assert.ok(
      logicalLines.some((line) =>
        line.includes(`SUMMARY:Long meeting ${"ñ".repeat(80)}`),
      ),
    );

    const invalidRanges = [
      { from: "2026-05-10", to: "2026-05-10", timezone: "UTC" },
      { from: "2026-05-10", to: "2027-05-12", timezone: "UTC" },
      { from: "2026-02-30", to: "2026-03-01", timezone: "UTC" },
      { from: "2026-05-10", to: "2026-05-11", timezone: "Invalid/Zone" },
    ];
    for (const range of invalidRanges) {
      assert.throws(
        () => exportCalendarIcs(owner, range),
        (error: unknown) =>
          error instanceof Error && "status" in error && error.status === 422,
      );
    }
    assert.equal(
      exportCalendarIcs(owner, {
        from: "2026-05-10",
        to: "2027-05-11",
        timezone: "UTC",
      }).status,
      200,
    );

    await t.test(
      "rejects exports that exceed the processing deadline and releases database cursors",
      (deadlineTest) => {
        let calls = 0;
        deadlineTest.mock.method(performance, "now", () =>
          calls++ === 0 ? 0 : 5_001,
        );
        assert.throws(
          () =>
            exportCalendarIcs(owner, {
              from: "2026-05-10",
              to: "2026-05-12",
              timezone: "UTC",
            }),
          (error: unknown) =>
            error instanceof Error &&
            "status" in error &&
            error.status === 422 &&
            /processing limit/.test(error.message),
        );

        deadlineTest.mock.restoreAll();
        const rolledBackTaskId = randomUUID();
        assert.throws(
          () =>
            database.transaction(() => {
              database
                .prepare(
                  "INSERT INTO tasks(id,owner_id,title,created_at,updated_at,due_date) VALUES(?,?,?,?,?,?)",
                )
                .run(
                  rolledBackTaskId,
                  owner,
                  "Rolled back export cleanup probe",
                  1,
                  1,
                  "2026-05-11",
                );
              throw new Error("rollback probe");
            })(),
          /rollback probe/,
        );
        assert.equal(
          database
            .prepare("SELECT 1 FROM tasks WHERE id=?")
            .get(rolledBackTaskId),
          undefined,
        );
        assert.equal(
          exportCalendarIcs(owner, {
            from: "2026-05-10",
            to: "2026-05-12",
            timezone: "UTC",
          }).status,
          200,
        );
      },
    );

    await t.test(
      "rejects rather than truncates exports over 10,000 entries",
      (entryLimitTest) => {
        entryLimitTest.mock.method(performance, "now", () => 0);
        const insert = database.prepare(
          "INSERT INTO tasks(id,owner_id,title,created_at,updated_at,due_date) VALUES(?,?,?,?,?,?)",
        );
        database.transaction(() => {
          for (let index = 0; index < 10_001; index++)
            insert.run(
              randomUUID(),
              owner,
              `Deadline ${index}`,
              1,
              1,
              "2026-05-11",
            );
        })();
        assert.throws(
          () =>
            exportCalendarIcs(owner, {
              from: "2026-05-10",
              to: "2026-05-12",
              timezone: "UTC",
            }),
          (error: unknown) =>
            error instanceof Error &&
            "status" in error &&
            error.status === 422 &&
            /10,000/.test(error.message),
        );
      },
    );
    await t.test(
      "rejects event-series expansion that exceeds export budgets",
      () => {
        const payload = eventInput.parse({
          title: "Expired before this export range",
          start: "2026-05-01",
          end: "2026-05-02",
          timezone: "UTC",
          recurrence: { frequency: "daily", count: 1 },
        });
        const insert = database.prepare(
          "INSERT INTO calendar_events(id,owner_id,title,description,start_date,end_date,recurring,data,created_at,updated_at) VALUES(?,?,?,?,?,?,1,?,1,1)",
        );
        database.transaction(() => {
          for (let index = 0; index < 10_001; index++)
            insert.run(
              randomUUID(),
              owner,
              payload.title,
              payload.description,
              payload.start.slice(0, 10),
              payload.end.slice(0, 10),
              JSON.stringify(payload),
            );
        })();
        assert.throws(
          () =>
            exportCalendarIcs(owner, {
              from: "2026-05-10",
              to: "2026-05-12",
              timezone: "UTC",
            }),
          (error: unknown) =>
            error instanceof Error &&
            "status" in error &&
            error.status === 422 &&
            /too many calendar event series|processing limit/.test(
              error.message,
            ),
        );
      },
    );
  } finally {
    try {
      await rm(directory, { recursive: true, force: true });
    } finally {
      if (previousDirectory === undefined) delete process.env.NIVRA_DATA_DIR;
      else process.env.NIVRA_DATA_DIR = previousDirectory;
    }
  }
});
