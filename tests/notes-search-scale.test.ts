import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

test("ranked note search pages 1,000 matches without duplicates or journal leakage", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "nivra-note-search-"));
  process.env.NIVRA_DATA_DIR = directory;
  const { GET } = await import("../src/app/api/v1/[...path]/route");
  const { sqlite } = await import("../src/lib/server/db");
  const { createNote, listNotes } = await import("../src/lib/server/notes");
  try {
    const setup = await GET(
      new Request("http://localhost:3000/api/v1/setup", {
        method: "POST",
        headers: {
          host: "localhost:3000",
          origin: "http://localhost:3000",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          name: "Search Owner",
          username: "searchowner",
          password: `Test-${randomUUID()}`,
        }),
      }),
      { params: Promise.resolve({ path: ["setup"] }) },
    );
    assert.equal(setup.status, 200);
    const owner = sqlite().prepare("SELECT id FROM user").get() as {
      id: string;
    };
    const expected = new Set<string>();
    sqlite()
      .transaction(() => {
        for (let index = 0; index < 1000; index++) {
          expected.add(
            createNote(owner.id, `Searchable reference ${index}`, {
              schemaVersion: 1,
              blocks: [
                {
                  type: "paragraph",
                  content: [
                    {
                      type: "text",
                      text: "Retrieval reference ".repeat((index % 10) + 1),
                      styles: {},
                    },
                  ],
                },
              ],
            }).id,
          );
        }
        const journal = createNote(owner.id, "Searchable reference journal");
        sqlite()
          .prepare(
            "UPDATE notes SET daily_date=?,journal_period='daily',journal_period_start=? WHERE id=?",
          )
          .run("2026-10-06", "2026-10-06", journal.id);
      })
      .immediate();
    const found = new Set<string>();
    for (let offset = 0; offset < 1000; offset += 60) {
      const params = new URLSearchParams({
        view: "all",
        q: "searchable reference",
        limit: "60",
        preview: "1",
        offset: String(offset),
      });
      const first = listNotes(params);
      assert.deepEqual(
        first.map((note) => note.id),
        listNotes(params).map((note) => note.id),
      );
      for (const note of first) {
        assert.ok(expected.has(note.id));
        assert.ok(!found.has(note.id));
        found.add(note.id);
      }
    }
    assert.equal(found.size, 1000);
    assert.deepEqual(
      listNotes(
        new URLSearchParams({
          view: "all",
          q: "searchable reference",
          limit: "60",
          offset: "1000",
        }),
      ),
      [],
    );
    assert.equal(
      listNotes(
        new URLSearchParams({
          view: "journal",
          q: "searchable reference",
          limit: "60",
        }),
      ).length,
      1,
    );
    assert.ok(
      listNotes(
        new URLSearchParams({
          view: "all",
          q: "searchabl reference",
          limit: "60",
        }),
      ).length > 0,
    );
  } finally {
    sqlite().close();
    await rm(directory, { recursive: true, force: true });
  }
});
