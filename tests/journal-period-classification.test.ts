import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { journalPeriodSchema } from "../src/lib/writing";

test("weekly and monthly journals stay journals across search, counts, Trash, overview and collections", async () => {
  const directory = await mkdtemp(`${tmpdir()}/nivra-journal-periods-`);
  process.env.NIVRA_DATA_DIR = directory;
  const { sqlite } = await import("../src/lib/server/db");
  const { searchWorkspace } = await import("../src/lib/server/unified-search");
  const { agentSearch } = await import("../src/lib/server/agent-search");
  const { agentCounts } = await import("../src/lib/server/agent-counts");
  const { listTrash } = await import("../src/lib/server/trash");
  const { workspaceOverview } = await import("../src/lib/server/overview");
  const { taggedItems, favoriteItems } =
    await import("../src/lib/server/item-tags");
  const { calendarRange } = await import("../src/lib/server/calendar");
  const d = sqlite();
  const owner = randomUUID();
  const now = Date.now();
  const ids = {
    note: randomUUID(),
    weekly: randomUUID(),
    monthly: randomUUID(),
    legacyDaily: randomUUID(),
    trashedWeekly: randomUUID(),
    trashedMonthly: randomUUID(),
  };
  const tag = randomUUID();
  try {
    d.prepare(
      "INSERT INTO user(id,name,email,username,created_at,updated_at) VALUES(?,?,?,?,?,?)",
    ).run(
      owner,
      "Journal test",
      `journal-${owner}@local.invalid`,
      owner,
      now,
      now,
    );
    d.prepare("INSERT INTO tags(id,name,color) VALUES(?,?,?)").run(
      tag,
      "Field notes",
      "gray",
    );
    const insert = d.prepare(
      "INSERT INTO notes(id,owner_id,title,document,text,revision,favorite,kind,daily_date,journal_period,journal_period_start,trashed_at,created_at,updated_at) VALUES(?,?,?,'{}',?,1,?,'note',?,?,?,?,?,?)",
    );
    d.transaction(() => {
      insert.run(
        ids.note,
        owner,
        "Reference note",
        "ordinary note marker",
        0,
        null,
        null,
        null,
        null,
        now,
        now,
      );
      insert.run(
        ids.weekly,
        owner,
        "Weekly trail report",
        "trailmarker weekly journal",
        1,
        null,
        "weekly",
        "2026-10-12",
        null,
        now + 5,
        now + 5,
      );
      insert.run(
        ids.monthly,
        owner,
        "Monthly garden review",
        "gardenmarker monthly journal",
        1,
        null,
        "monthly",
        "2026-10-01",
        null,
        now + 4,
        now + 4,
      );
      insert.run(
        ids.legacyDaily,
        owner,
        "Legacy daily entry",
        "dailymarker daily journal",
        1,
        "2026-10-06",
        null,
        null,
        null,
        now + 3,
        now + 3,
      );
      insert.run(
        ids.trashedWeekly,
        owner,
        "Trashed weekly entry",
        "trashweeklymarker",
        0,
        null,
        "weekly",
        "2026-10-05",
        now,
        now + 2,
        now + 2,
      );
      insert.run(
        ids.trashedMonthly,
        owner,
        "Trashed monthly entry",
        "trashmonthlymarker",
        0,
        null,
        "monthly",
        "2026-09-01",
        now,
        now + 1,
        now + 1,
      );
      for (const id of [ids.weekly, ids.monthly, ids.legacyDaily])
        d.prepare("INSERT INTO note_tags(note_id,tag_id) VALUES(?,?)").run(
          id,
          tag,
        );
    }).immediate();

    const journalIds = [ids.weekly, ids.monthly, ids.legacyDaily];
    assert.deepEqual(
      agentCounts(owner, { state: "active", favoritesOnly: false }).counts,
      {
        notes: 1,
        journals: 3,
        tasks: 0,
        bookmarks: 0,
        artifacts: 0,
        events: 0,
        forms: 0,
      },
    );
    assert.deepEqual(
      agentCounts(owner, { state: "trash", favoritesOnly: false }).counts,
      {
        notes: 0,
        journals: 2,
        tasks: 0,
        bookmarks: 0,
        artifacts: 0,
        events: 0,
        forms: 0,
      },
    );

    const lexical = searchWorkspace(owner, "type:journal journal");
    assert.deepEqual(
      new Set(lexical.map((row) => row.id)),
      new Set(journalIds),
    );
    assert.ok(lexical.every((row) => row.type === "journal"));
    assert.equal(searchWorkspace(owner, "type:note journal").length, 0);
    const agent = agentSearch(owner, {
      query: "type:journal journal",
      limit: 20,
      offset: 0,
    });
    const agentItems = z
      .array(
        z.object({
          id: z.string().uuid(),
          type: z.enum(["note", "journal"]),
          journalPeriod: journalPeriodSchema.nullable(),
        }),
      )
      .parse(agent.items);
    assert.deepEqual(
      new Set(agentItems.map((row) => row.id)),
      new Set(journalIds),
    );
    assert.ok(agentItems.every((row) => row.type === "journal"));
    assert.ok(
      agentItems.some(
        (row) => row.id === ids.weekly && row.journalPeriod === "weekly",
      ),
    );
    assert.ok(
      agentItems.some(
        (row) => row.id === ids.monthly && row.journalPeriod === "monthly",
      ),
    );

    assert.deepEqual(
      new Set(listTrash(owner, "", "journal").items.map((row) => row.id)),
      new Set([ids.trashedWeekly, ids.trashedMonthly]),
    );
    assert.ok(
      listTrash(owner, "", "journal").items.every(
        (row) => row.kind === "journal",
      ),
    );

    const tagged = taggedItems(owner, tag, "", 20, 0).items;
    assert.deepEqual(new Set(tagged.map((row) => row.id)), new Set(journalIds));
    assert.ok(tagged.every((row) => row.type === "journal"));
    const favorites = favoriteItems(owner, "", 20, 0).items;
    assert.deepEqual(
      new Set(favorites.map((row) => row.id)),
      new Set(journalIds),
    );
    assert.ok(favorites.every((row) => row.type === "journal"));

    const overview = workspaceOverview(owner, "2026-10-13");
    const recentJournals = overview.recentItems.filter(
      (row) => row.type === "journal",
    );
    assert.deepEqual(
      new Set(recentJournals.map((row) => row.id)),
      new Set(journalIds),
    );
    assert.ok(
      recentJournals.some(
        (row) => row.type === "journal" && row.date === "2026-10-12",
      ),
    );
    assert.ok(
      recentJournals.some(
        (row) => row.type === "journal" && row.date === "2026-10-01",
      ),
    );

    const calendar = calendarRange(
      owner,
      "2026-10-01",
      "2026-10-20",
      "UTC",
    ).items;
    assert.ok(
      calendar.some(
        (row) => row.sourceId === ids.weekly && row.date === "2026-10-12",
      ),
    );
    assert.ok(
      calendar.some(
        (row) => row.sourceId === ids.monthly && row.date === "2026-10-01",
      ),
    );
    assert.ok(
      calendar.some(
        (row) => row.sourceId === ids.legacyDaily && row.date === "2026-10-06",
      ),
    );
  } finally {
    d.close();
    await rm(directory, { recursive: true, force: true });
  }
});
