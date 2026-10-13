import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

test("journal pagination uses ordered indexes for all and period-filtered pages", async () => {
  const directory = await mkdtemp(`${tmpdir()}/nivra-journal-page-plan-`);
  process.env.NIVRA_DATA_DIR = directory;
  const { sqlite } = await import("../src/lib/server/db");
  const { listNotes } = await import("../src/lib/server/notes");
  const d = sqlite();
  const owner = randomUUID();
  const now = Date.now();
  try {
    d.prepare(
      "INSERT INTO user(id,name,email,username,created_at,updated_at) VALUES(?,?,?,?,?,?)",
    ).run(
      owner,
      "Journal page test",
      `${owner}@local.invalid`,
      owner,
      now,
      now,
    );
    const insert = d.prepare(
      "INSERT INTO notes(id,owner_id,title,document,text,revision,kind,daily_date,journal_period,journal_period_start,created_at,updated_at) VALUES(?,?,?,'{}',?,1,'note',?,?,?,?,?)",
    );
    d.transaction(() => {
      for (const period of ["daily", "weekly", "monthly"] as const) {
        for (let index = 0; index < 120; index++) {
          const day = String((index % 28) + 1).padStart(2, "0");
          const month = String((Math.floor(index / 28) % 12) + 1).padStart(
            2,
            "0",
          );
          const start = `2025-${month}-${day}`;
          insert.run(
            randomUUID(),
            owner,
            `${period} entry ${index}`,
            `${period} body ${index}`,
            period === "daily" ? start : null,
            period,
            start,
            now + index,
            now + index,
          );
        }
      }
      insert.run(
        randomUUID(),
        owner,
        "Legacy daily entry",
        "legacy daily body",
        "2026-01-01",
        null,
        null,
        now + 1000,
        now + 1000,
      );
    }).immediate();
    const periodExpression =
      "coalesce(n.journal_period,CASE WHEN n.daily_date IS NOT NULL THEN 'daily' END)";
    const startExpression = "coalesce(n.journal_period_start,n.daily_date)";
    const common =
      "n.kind='note' AND n.trashed_at IS NULL AND (n.journal_period IS NOT NULL OR n.daily_date IS NOT NULL) AND n.owner_id=?";
    const allCadencePlan = d
      .prepare(
        `EXPLAIN QUERY PLAN SELECT n.rowid AS picked FROM notes n WHERE ${common} ORDER BY ${startExpression} DESC,n.id LIMIT ? OFFSET ?`,
      )
      .all(owner, 10, 0) as { detail: string }[];
    assert.ok(
      allCadencePlan.some((row) =>
        row.detail.includes("notes_journal_date_page_idx"),
      ),
      allCadencePlan.map((row) => row.detail).join("\n"),
    );
    assert.ok(
      allCadencePlan.every((row) => !row.detail.includes("TEMP B-TREE")),
      allCadencePlan.map((row) => row.detail).join("\n"),
    );

    const periodPlan = d
      .prepare(
        `EXPLAIN QUERY PLAN SELECT n.rowid AS picked FROM notes n WHERE n.kind='note' AND n.trashed_at IS NULL AND (n.journal_period IS NOT NULL OR n.daily_date IS NOT NULL) AND ${periodExpression}=? AND n.owner_id=? ORDER BY ${startExpression} DESC,n.id LIMIT ? OFFSET ?`,
      )
      .all("weekly", owner, 10, 0) as { detail: string }[];
    assert.ok(
      periodPlan.some((row) =>
        row.detail.includes("notes_journal_period_page_idx"),
      ),
      periodPlan.map((row) => row.detail).join("\n"),
    );
    assert.ok(
      periodPlan.every((row) => !row.detail.includes("TEMP B-TREE")),
      periodPlan.map((row) => row.detail).join("\n"),
    );

    const periodRangePlan = d
      .prepare(
        `EXPLAIN QUERY PLAN SELECT n.rowid AS picked FROM notes n WHERE n.kind='note' AND n.trashed_at IS NULL AND (n.journal_period IS NOT NULL OR n.daily_date IS NOT NULL) AND ${periodExpression}=? AND ${startExpression}>=? AND ${startExpression}<=? AND n.owner_id=? ORDER BY ${startExpression} DESC,n.id LIMIT ? OFFSET ?`,
      )
      .all("weekly", "2025-02-01", "2025-11-01", owner, 10, 0) as {
      detail: string;
    }[];
    assert.ok(
      periodRangePlan.some((row) =>
        /notes_journal_(date|period)_page_idx/.test(row.detail),
      ),
      periodRangePlan.map((row) => row.detail).join("\n"),
    );
    assert.ok(
      periodRangePlan.every((row) => !row.detail.includes("TEMP B-TREE")),
      periodRangePlan.map((row) => row.detail).join("\n"),
    );

    const firstPage = listNotes(
      new URLSearchParams({ view: "journal", limit: "10", offset: "0" }),
      undefined,
      owner,
    );
    const secondPage = listNotes(
      new URLSearchParams({ view: "journal", limit: "10", offset: "10" }),
      undefined,
      owner,
    );
    assert.equal(firstPage.length, 10);
    assert.equal(secondPage.length, 10);
    assert.equal(
      new Set([...firstPage, ...secondPage].map((note) => note.id)).size,
      20,
    );
    const weeklyPage = listNotes(
      new URLSearchParams({
        view: "journal",
        period: "weekly",
        limit: "101",
      }),
      undefined,
      owner,
    );
    const weeklyNextPage = listNotes(
      new URLSearchParams({
        view: "journal",
        period: "weekly",
        limit: "101",
        offset: "101",
      }),
      undefined,
      owner,
    );
    assert.equal(weeklyPage.length, 101);
    assert.equal(weeklyNextPage.length, 19);
    assert.ok(
      [...weeklyPage, ...weeklyNextPage].every(
        (note) => note.journalPeriod === "weekly",
      ),
    );
    assert.equal(
      new Set([...weeklyPage, ...weeklyNextPage].map((note) => note.id)).size,
      120,
    );
    const dailyPage = listNotes(
      new URLSearchParams({
        view: "journal",
        period: "daily",
        limit: "500",
      }),
      undefined,
      owner,
    );
    assert.equal(dailyPage.length, 101);
    assert.ok(dailyPage.every((note) => note.journalPeriod === "daily"));
    assert.ok(dailyPage.some((note) => note.title === "Legacy daily entry"));
    const dailyNextPage = listNotes(
      new URLSearchParams({
        view: "journal",
        period: "daily",
        limit: "101",
        offset: "101",
      }),
      undefined,
      owner,
    );
    assert.equal(dailyNextPage.length, 20);
    assert.equal(
      new Set([...dailyPage, ...dailyNextPage].map((note) => note.id)).size,
      121,
    );
  } finally {
    d.close();
    await rm(directory, { recursive: true, force: true });
  }
});
