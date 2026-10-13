import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { readFile, readdir } from "node:fs/promises";

test("query index upgrade preserves content and indexed literal bookmark matching", async () => {
  const d = new Database(":memory:");
  d.pragma("foreign_keys=ON");
  d.function("nivra_fold", { deterministic: true }, (value) =>
    String(value ?? "").toLocaleLowerCase(),
  );
  const globalDb = globalThis as unknown as { nivraSqlite?: Database.Database };
  try {
    for (const name of (await readdir("migrations"))
      .filter((name) => name.endsWith(".sql") && name < "0038")
      .sort())
      d.exec(await readFile(`migrations/${name}`, "utf8"));
    d.prepare(
      "INSERT INTO user(id,name,email,username,created_at,updated_at) VALUES('owner','Test','test@example.invalid','owner',1,1)",
    ).run();
    d.prepare(
      "INSERT INTO tags(id,name,color) VALUES('tag','Research','gray')",
    ).run();
    const examples = [
      "https://example.invalid/path/AbC?foo=Bar",
      "Café ÉCOLE 東京大学",
      "two words",
      'literal "quotes"',
      "100%_done",
      "foo.bar/baz",
      "AB",
      "résumé",
      "ZZ ",
      "line\nbreak",
      "abc\0def",
    ];
    const insert = d.prepare(
      "INSERT INTO bookmarks(id,owner_id,url,title,description,collection,favorite,trashed_at,created_at,updated_at) VALUES(?,'owner',?,?,?,'Research',1,?,1,?)",
    );
    d.transaction(() => {
      for (let i = 0; i < examples.length; i++) {
        insert.run(
          `b${i}`,
          `https://example.invalid/${i}`,
          examples[i],
          "Synthetic description",
          i === 3 ? 1 : null,
          i,
        );
        d.prepare(
          "INSERT INTO notes(id,owner_id,title,document,text,favorite,created_at,updated_at) VALUES(?,'owner',?,'{}',?,1,1,?)",
        ).run(`n${i}`, examples[i], "Synthetic description", i);
        d.prepare(
          "INSERT INTO artifacts(id,owner_id,kind,title,content,created_at,updated_at) VALUES(?,'owner','text',?,?,1,?)",
        ).run(`a${i}`, examples[i], "Synthetic description", i);
        d.prepare("INSERT INTO note_tags VALUES(?,'tag')").run(`n${i}`);
      }
    })();
    d.transaction(() => {
      for (let i = 0; i < 650; i++) {
        const body = "Synthetic long body. ".repeat(60);
        d.prepare(
          "INSERT INTO notes(id,owner_id,title,document,text,favorite,created_at,updated_at) VALUES(?,'owner','Synthetic note','{}',?,1,1,?)",
        ).run(`scale-n${i}`, body, i);
        insert.run(
          `scale-b${i}`,
          `https://example.invalid/scale/${i}`,
          "Synthetic link",
          body,
          null,
          i,
        );
        d.prepare(
          "INSERT INTO artifacts(id,owner_id,kind,title,content,created_at,updated_at) VALUES(?,'owner','text','Synthetic artifact',?,1,?)",
        ).run(`scale-a${i}`, body, i);
        if (i % 2 === 0)
          d.prepare("INSERT INTO note_tags VALUES(?,'tag')").run(`scale-n${i}`);
      }
    })();
    const snapshots = new Map(
      ["user", "notes", "bookmarks", "artifacts", "tags", "note_tags"].map(
        (table) => [
          table,
          d.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
        ],
      ),
    );
    for (const name of (await readdir("migrations"))
      .filter((name) => name.endsWith(".sql") && name >= "0038")
      .sort())
      d.exec(await readFile(`migrations/${name}`, "utf8"));
    for (const [table, rows] of snapshots)
      assert.deepEqual(
        d.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
        (rows as Record<string, unknown>[]).map((row) => ({
          ...row,
          ...(table === "tags" ? { aliases: "[]" } : {}),
          ...(table === "notes"
            ? { journal_period: null, journal_period_start: null }
            : {}),
          ...(table === "bookmarks"
            ? {
                read_at: null,
                article_status: "unavailable",
                article_generation: 0,
                article_version: 0,
              }
            : {}),
        })),
        table,
      );
    globalDb.nivraSqlite = d;
    const { listBookmarkPage, bookmarkSummary, updateBookmark } =
      await import("../src/lib/server/bookmarks");
    const { ftsQuery } = await import("../src/lib/server/validation");
    const { agentSearch } = await import("../src/lib/server/agent-search");
    const { agentCounts } = await import("../src/lib/server/agent-counts");
    const { listNotes } = await import("../src/lib/server/notes");
    const { listArtifactPage } = await import("../src/lib/server/artifacts");
    const { favoriteItems, taggedItems } =
      await import("../src/lib/server/item-tags");
    for (const query of [
      "path/AbC?foo=Bar",
      "abc",
      "fé É",
      "東京大",
      "two words",
      '"quotes"',
      "%_done",
      "bar/baz",
      "AB",
      "ésum",
      "ZZ ",
      "line\nbreak",
    ]) {
      const expected = d
        .prepare(
          "SELECT id FROM bookmarks WHERE owner_id='owner' AND trashed_at IS NULL AND (rowid IN(SELECT rowid FROM bookmarks_fts WHERE bookmarks_fts MATCH ?) OR instr(lower(title||' '||description||' '||url||' '||collection),lower(?))>0) ORDER BY created_at DESC,id",
        )
        .all(ftsQuery(query.trim()), query.trim()) as { id: string }[];
      assert.deepEqual(
        listBookmarkPage("owner", { query, limit: 100 }).items.map(
          (row) => row.id,
        ),
        expected.map((row) => row.id),
        query,
      );
      assert.equal(
        bookmarkSummary("owner", { query }).total,
        expected.length,
        query,
      );
    }
    const expectedSearch = d
      .prepare(
        "SELECT * FROM (SELECT id,'note' AS type,title,substr(replace(text,char(10),' '),1,180) AS excerpt,revision,updated_at AS updatedAt,daily_date AS dailyDate,journal_period AS journalPeriod,journal_period_start AS journalPeriodStart FROM notes WHERE kind='note' AND trashed_at IS NULL AND owner_id='owner' UNION ALL SELECT id,'bookmark' AS type,title,substr(replace(description,char(10),' '),1,180) AS excerpt,revision,updated_at AS updatedAt,NULL AS dailyDate,NULL AS journalPeriod,NULL AS journalPeriodStart FROM bookmarks WHERE trashed_at IS NULL AND owner_id='owner' UNION ALL SELECT id,'artifact' AS type,title,substr(replace(content,char(10),' '),1,180) AS excerpt,revision,updated_at AS updatedAt,NULL AS dailyDate,NULL AS journalPeriod,NULL AS journalPeriodStart FROM artifacts WHERE trashed_at IS NULL AND owner_id='owner') ORDER BY updatedAt DESC,type,id LIMIT 60 OFFSET 500",
      )
      .all();
    assert.deepEqual(
      agentSearch("owner", { query: "Synthetic", limit: 60, offset: 500 })
        .items,
      expectedSearch,
    );
    const originalPrepare = d.prepare.bind(d);
    let snippetQueries = 0;
    d.prepare = ((sql: string) => {
      if (sql.includes("snippet(artifacts_fts")) snippetQueries++;
      return originalPrepare(sql);
    }) as typeof d.prepare;
    try {
      const page = listArtifactPage("owner", { query: "Synthetic", limit: 60 });
      assert.equal(page.items.length, 60);
      assert.ok(page.items.every((item) => item.excerptMatches?.length));
      assert.equal(snippetQueries, 1);
    } finally {
      d.prepare = originalPrepare;
    }
    const before = {
      counts: agentCounts("owner", { state: "active", favoritesOnly: false }),
      search: agentSearch("owner", { query: "Synthetic", limit: 7, offset: 4 }),
      notes: listNotes(
        new URLSearchParams({
          view: "all",
          limit: "7",
          offset: "4",
          preview: "1",
        }),
        undefined,
        "owner",
      ),
      artifacts: listArtifactPage("owner", { query: "Synthetic", limit: 7 }),
      favorites: favoriteItems("owner", "", 7, 4),
      tags: taggedItems("owner", "tag", "", 7, 4),
    };
    d.exec("ANALYZE");
    assert.deepEqual(
      {
        counts: agentCounts("owner", { state: "active", favoritesOnly: false }),
        search: agentSearch("owner", {
          query: "Synthetic",
          limit: 7,
          offset: 4,
        }),
        notes: listNotes(
          new URLSearchParams({
            view: "all",
            limit: "7",
            offset: "4",
            preview: "1",
          }),
          undefined,
          "owner",
        ),
        artifacts: listArtifactPage("owner", { query: "Synthetic", limit: 7 }),
        favorites: favoriteItems("owner", "", 7, 4),
        tags: taggedItems("owner", "tag", "", 7, 4),
      },
      before,
    );
    assert.deepEqual(
      listBookmarkPage("other-owner", { query: "abc", limit: 100 }).items,
      [],
    );
    updateBookmark("owner", "b0", {
      revision: 1,
      title: "replacementword",
      description: "",
      collection: "",
    });
    assert.equal(
      listBookmarkPage("owner", { query: "placement", limit: 100 }).items[0]
        ?.id,
      "b0",
    );
    assert.ok(
      !listBookmarkPage("owner", {
        query: "path/AbC?foo=Bar",
        limit: 100,
      }).items.some((row) => row.id === "b0"),
    );
    const generation = (
      d
        .prepare(
          "SELECT generation FROM search_versions WHERE vocabulary='bookmarks'",
        )
        .get() as { generation: number }
    ).generation;
    d.prepare(
      "UPDATE bookmarks SET favorite=0,updated_at=999 WHERE id='b0'",
    ).run();
    assert.equal(
      (
        d
          .prepare(
            "SELECT generation FROM search_versions WHERE vocabulary='bookmarks'",
          )
          .get() as { generation: number }
      ).generation,
      generation,
    );
    d.prepare("DELETE FROM bookmarks WHERE id='b0'").run();
    assert.equal(
      listBookmarkPage("owner", { query: "placement", limit: 100 }).items
        .length,
      0,
    );
    d.exec(
      "INSERT INTO bookmarks_literal_fts(bookmarks_literal_fts,rank) VALUES('integrity-check',1)",
    );
    d.exec(
      "INSERT INTO bookmarks_fts(bookmarks_fts,rank) VALUES('integrity-check',1)",
    );
    d.exec(
      "INSERT INTO artifacts_fts(artifacts_fts,rank) VALUES('integrity-check',1)",
    );
    const deletionPlan = d
      .prepare("EXPLAIN QUERY PLAN DELETE FROM notes WHERE id=?")
      .all("n0") as { detail: string }[];
    for (const table of ["tasks", "bookmarks", "attachments"])
      assert.ok(
        !deletionPlan.some((row) => row.detail === `SCAN ${table}`),
        table,
      );
    d.prepare(
      "INSERT INTO tasks(id,owner_id,title,note_id,created_at,updated_at) VALUES('linked-task','owner','Linked task','n0',1,1)",
    ).run();
    d.prepare("UPDATE bookmarks SET note_id='n0' WHERE id='b1'").run();
    d.prepare("DELETE FROM notes WHERE id='n0'").run();
    assert.equal(
      (
        d.prepare("SELECT note_id FROM tasks WHERE id='linked-task'").get() as {
          note_id: null;
        }
      ).note_id,
      null,
    );
    assert.equal(
      (
        d.prepare("SELECT note_id FROM bookmarks WHERE id='b1'").get() as {
          note_id: null;
        }
      ).note_id,
      null,
    );
    assert.equal(d.pragma("integrity_check", { simple: true }), "ok");
    assert.deepEqual(d.pragma("foreign_key_check"), []);
  } finally {
    delete globalDb.nivraSqlite;
    d.close();
  }
});
