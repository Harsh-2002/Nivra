import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

test("journal FTS search is scoped, cursor-paginated, and typo tolerant", async () => {
  const directory = await mkdtemp(`${tmpdir()}/nivra-journal-search-`);
  const previousDirectory = process.env.NIVRA_DATA_DIR;
  process.env.NIVRA_DATA_DIR = directory;
  const { sqlite } = await import("../src/lib/server/db");
  const { listJournalPage } = await import("../src/lib/server/journal");
  const database = sqlite();
  const owner = randomUUID();
  const now = Date.now();
  const ids = {
    daily: randomUUID(),
    secondDaily: randomUUID(),
    weekly: randomUUID(),
    priorWeekly: randomUUID(),
    monthly: randomUUID(),
    trashed: randomUUID(),
    ordinary: randomUUID(),
  };

  try {
    database
      .prepare(
        "INSERT INTO user(id,name,email,username,created_at,updated_at) VALUES(?,?,?,?,?,?)",
      )
      .run(owner, "Journal Search", `${owner}@local.invalid`, owner, now, now);
    const insert = database.prepare(
      "INSERT INTO notes(id,owner_id,title,document,text,revision,kind,daily_date,journal_period,journal_period_start,trashed_at,created_at,updated_at) VALUES(?,?,?,'{}',?,1,'note',?,?,?,?,?,?)",
    );
    database
      .transaction(() => {
        insert.run(
          ids.daily,
          owner,
          "Battery inspection",
          "Quarterlyreview battery voltage after a cold night.",
          "2026-10-10",
          "daily",
          "2026-10-10",
          null,
          now + 3,
          now + 3,
        );
        insert.run(
          ids.secondDaily,
          owner,
          "Battery readings",
          "Battery reserve remained stable after the cold night.",
          "2026-10-09",
          "daily",
          "2026-10-09",
          null,
          now + 4,
          now + 4,
        );
        insert.run(
          ids.weekly,
          owner,
          "Workshop maintenance",
          "Quarterlyreview alternator output and battery reserve.",
          null,
          "weekly",
          "2026-10-05",
          null,
          now + 2,
          now + 2,
        );
        insert.run(
          ids.priorWeekly,
          owner,
          "Earlier workshop maintenance",
          "Quarterlyreview battery readings before winter storage.",
          null,
          "weekly",
          "2026-09-28",
          null,
          now + 1,
          now + 1,
        );
        insert.run(
          ids.monthly,
          owner,
          "Monthly notes",
          "Quarterlyreview battery checks and workshop records.",
          null,
          "monthly",
          "2026-10-01",
          null,
          now + 1,
          now + 1,
        );
        insert.run(
          ids.trashed,
          owner,
          "Old battery record",
          "Quarterlyreview battery reserve.",
          null,
          "weekly",
          "2026-09-21",
          now,
          now,
          now,
        );
        insert.run(
          ids.ordinary,
          owner,
          "Ordinary note",
          "Quarterlyreview battery reserve.",
          null,
          null,
          null,
          null,
          now,
          now,
        );
      })
      .immediate();

    const first = listJournalPage(owner, {
      period: "weekly",
      q: "quarterlyreview",
      limit: 1,
    });
    assert.equal(first.items.length, 1);
    assert.ok(
      [ids.weekly, ids.priorWeekly].some((id) => id === first.items[0]!.id),
    );
    assert.ok(first.next);
    const second = listJournalPage(owner, {
      period: "weekly",
      q: "quarterlyreview",
      limit: 1,
      after: first.next,
    });
    assert.equal(second.items.length, 1);
    assert.notEqual(second.items[0]?.id, first.items[0]?.id);
    assert.equal(second.next, null);

    const daily = listJournalPage(owner, {
      period: "daily",
      q: "quarterlyreview",
      limit: 10,
    });
    assert.deepEqual(
      daily.items.map((item) => item.id),
      [ids.daily],
    );

    const allWeekly = listJournalPage(owner, {
      period: "weekly",
      q: "battery",
      limit: 10,
    });
    assert.deepEqual(
      new Set(allWeekly.items.map((item) => item.id)),
      new Set([ids.weekly, ids.priorWeekly]),
    );

    const fuzzy = listJournalPage(owner, {
      period: "daily",
      q: "batteri",
      limit: 1,
    });
    assert.equal(fuzzy.items.length, 1);
    assert.ok(fuzzy.next);
    const fuzzySecond = listJournalPage(owner, {
      period: "daily",
      q: "batteri",
      limit: 1,
      after: fuzzy.next,
    });
    assert.equal(fuzzySecond.items.length, 1);
    assert.notEqual(fuzzySecond.items[0]?.id, fuzzy.items[0]?.id);
    assert.equal(fuzzySecond.next, null);

    const noQuery = listJournalPage(owner, {
      period: "monthly",
      limit: 10,
    });
    assert.deepEqual(
      noQuery.items.map((item) => item.id),
      [ids.monthly],
    );
  } finally {
    database.close();
    if (previousDirectory === undefined) delete process.env.NIVRA_DATA_DIR;
    else process.env.NIVRA_DATA_DIR = previousDirectory;
    await rm(directory, { recursive: true, force: true });
  }
});
