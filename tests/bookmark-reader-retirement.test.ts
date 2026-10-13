import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import test from "node:test";
import { deriveKey, masterKey } from "../src/lib/server/encryption";

test("reader retirement preserves bookmarks, fences article work and invalidates derived text", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "nivra-reader-retirement-"),
  );
  const previousDataDir = process.env.NIVRA_DATA_DIR;
  process.env.NIVRA_DATA_DIR = directory;
  const filename = path.join(directory, "nivra.sqlite");
  const connection = new Database(filename);
  connection.pragma("cipher='chacha20'");
  connection.pragma(
    `key='${deriveKey(masterKey(directory), "sqlite").toString("hex")}'`,
  );
  connection.pragma("foreign_keys=ON");
  connection.function("nivra_fold", { deterministic: true }, (value) =>
    String(value ?? "").toLocaleLowerCase(),
  );
  connection.exec(
    "CREATE TABLE migrations(name TEXT PRIMARY KEY,applied_at INTEGER NOT NULL)",
  );

  let database:
    ReturnType<typeof import("../src/lib/server/db").sqlite> | undefined;
  let stopJobWorker: (() => Promise<void>) | undefined;
  try {
    const migrations = (await readdir("migrations"))
      .filter(
        (name) =>
          name.endsWith(".sql") && name < "0053_remove_bookmark_reader.sql",
      )
      .sort();
    for (const name of migrations) {
      const sql = await readFile(path.join("migrations", name), "utf8");
      connection
        .transaction(() => {
          connection.exec(sql);
          connection
            .prepare("INSERT INTO migrations(name,applied_at) VALUES(?,?)")
            .run(name, Date.now());
        })
        .immediate();
    }

    const now = Date.now();
    const bookmarkId = randomUUID();
    connection
      .prepare(
        "INSERT INTO user(id,name,email,username,created_at,updated_at) VALUES('owner','Fixture','reader-retirement@local.invalid','fixture',?,?)",
      )
      .run(now, now);
    connection
      .prepare(
        "INSERT INTO bookmarks(id,owner_id,url,title,description,site_name,favorite,read_at,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,1,NULL,4,?,?)",
      )
      .run(
        bookmarkId,
        "owner",
        "https://example.test/saved",
        "Saved bookmark",
        "Saved metadata stays available",
        "Example",
        now,
        now,
      );
    connection
      .prepare(
        "INSERT INTO tags(id,name,color) VALUES('tag','Manual tag','gray')",
      )
      .run();
    connection
      .prepare("INSERT INTO bookmark_tags(bookmark_id,tag_id) VALUES(?, 'tag')")
      .run(bookmarkId);
    connection
      .prepare(
        "INSERT INTO bookmark_articles(bookmark_id,owner_id,version,source_url,captured_at,title,content_json,plain_text,fingerprint) VALUES(?,'owner',1,'https://example.test/saved',?,'Archived title','{\"blocks\":[]}','ARCHIVED READER TEXT','archive-fingerprint')",
      )
      .run(bookmarkId, now);
    connection
      .prepare(
        "INSERT INTO bookmark_highlights(id,owner_id,bookmark_id,article_version,quote,start_offset,end_offset,created_at,updated_at) VALUES('highlight','owner',?,1,'ARCHIVED HIGHLIGHT',0,18,?,?)",
      )
      .run(bookmarkId, now, now);

    const sourceKey = `bookmark:${bookmarkId}`;
    const content = connection
      .prepare("SELECT generation FROM ai_content WHERE source_key=?")
      .get(sourceKey) as { generation: number };
    connection
      .prepare(
        "UPDATE ai_content SET owner_id='owner',item_kind='bookmark',item_id=?,pending=0,state='indexed',fingerprint='old-fingerprint',model_version='old-model',indexed_generation=generation WHERE source_key=?",
      )
      .run(bookmarkId, sourceKey);
    const vocabularyGeneration = (
      connection
        .prepare(
          "SELECT vocabulary_generation FROM ai_configuration WHERE id=1",
        )
        .get() as { vocabulary_generation: number }
    ).vocabulary_generation;
    connection
      .prepare(
        "INSERT INTO ai_chunks(source_key,ordinal,generation,model_version,title,text,embedding) VALUES(?,0,?,'old-model','Saved bookmark','ARCHIVED READER TEXT',?)",
      )
      .run(sourceKey, content.generation, Buffer.alloc(384 * 4));
    connection
      .prepare(
        "INSERT INTO ai_suggestions(source_key,id,generation,fingerprint,score,model_version,vocabulary_generation,tag_id,created_at) VALUES(?,'suggestion',?,'old-fingerprint',0.95,'old-model',?,'tag',?)",
      )
      .run(sourceKey, content.generation, vocabularyGeneration, now);
    connection
      .prepare(
        "INSERT INTO ai_decisions(source_key,fingerprint,tag_id,tag_fingerprint,decision,created_at) VALUES(?,'old-fingerprint','tag','old-tag-fingerprint','rejected',?)",
      )
      .run(sourceKey, now);
    connection
      .prepare(
        "INSERT INTO background_jobs(id,owner_id,kind,target_id,state,attempts,available_at,lease_until,lease_token,created_at,generation) VALUES('article-queued','owner','article',?,'queued',0,?,?,NULL,?,1),('article-running','owner','article',?,'running',2,?,?,'held-lease',?,1),('semantic-old','owner','semantic',?,'queued',0,?,NULL,NULL,?,?)",
      )
      .run(
        bookmarkId,
        now,
        now,
        now,
        randomUUID(),
        now,
        now + 60_000,
        now,
        sourceKey,
        now,
        now,
        content.generation,
      );
    const initialIndexGeneration = (
      connection
        .prepare("SELECT index_generation FROM ai_configuration WHERE id=1")
        .get() as { index_generation: number }
    ).index_generation;
    connection.close();

    const { sqlite } = await import("../src/lib/server/db");
    const jobs = await import("../src/lib/server/jobs");
    const { updateBookmarkReadState, getBookmark } =
      await import("../src/lib/server/bookmarks");
    database = sqlite();
    stopJobWorker = jobs.stopJobWorker;

    assert.ok(
      database
        .prepare("SELECT 1 FROM migrations WHERE name=?")
        .get("0053_remove_bookmark_reader.sql"),
      "the ordered retirement migration was applied on startup",
    );

    assert.deepEqual(
      database
        .prepare(
          "SELECT state,lease_token,lease_until FROM background_jobs WHERE kind='article' ORDER BY id",
        )
        .all(),
      [
        { state: "failed", lease_token: null, lease_until: null },
        { state: "failed", lease_token: null, lease_until: null },
      ],
    );
    assert.deepEqual(
      database
        .prepare(
          "SELECT state,lease_token,lease_until FROM background_jobs WHERE id='semantic-old'",
        )
        .get(),
      { state: "failed", lease_token: null, lease_until: null },
      "obsolete bookmark semantic jobs are released for a fresh generation",
    );
    assert.equal(
      (
        database
          .prepare("SELECT count(*) AS n FROM ai_chunks WHERE source_key=?")
          .get(sourceKey) as { n: number }
      ).n,
      0,
    );
    assert.equal(
      (
        database
          .prepare(
            "SELECT count(*) AS n FROM ai_suggestions WHERE source_key=?",
          )
          .get(sourceKey) as { n: number }
      ).n,
      0,
    );
    const refreshed = database
      .prepare(
        "SELECT generation,pending,state,indexed_generation FROM ai_content WHERE source_key=?",
      )
      .get(sourceKey) as {
      generation: number;
      pending: number;
      state: string;
      indexed_generation: number | null;
    };
    assert.equal(refreshed.generation, content.generation + 1);
    assert.equal(refreshed.pending, 1);
    assert.equal(refreshed.state, "pending");
    assert.equal(refreshed.indexed_generation, null);
    assert.ok(
      (
        database
          .prepare("SELECT index_generation FROM ai_configuration WHERE id=1")
          .get() as { index_generation: number }
      ).index_generation > initialIndexGeneration,
      "bookmark invalidation advances the generation observed by the vector cache",
    );
    assert.equal(
      (
        database
          .prepare("SELECT count(*) AS n FROM ai_decisions WHERE source_key=?")
          .get(sourceKey) as { n: number }
      ).n,
      1,
      "tag rejection history remains available",
    );
    assert.equal(
      (
        database
          .prepare(
            "SELECT plain_text FROM bookmark_articles WHERE bookmark_id=?",
          )
          .get(bookmarkId) as { plain_text: string }
      ).plain_text,
      "ARCHIVED READER TEXT",
      "archived article content is preserved rather than deleted",
    );
    assert.deepEqual(
      database
        .prepare("SELECT title,favorite,revision FROM bookmarks WHERE id=?")
        .get(bookmarkId),
      { title: "Saved bookmark", favorite: 1, revision: 4 },
    );
    assert.deepEqual(
      database
        .prepare("SELECT tag_id FROM bookmark_tags WHERE bookmark_id=?")
        .get(bookmarkId),
      { tag_id: "tag" },
    );
    assert.equal(
      database
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name IN ('bookmark_articles_fts','bookmark_highlights_fts') LIMIT 1",
        )
        .get(),
      undefined,
    );

    const read = await updateBookmarkReadState("owner", {
      items: [{ id: bookmarkId, revision: 4, read: true }],
    });
    assert.equal(read[0].status, "updated");
    assert.ok(read[0].bookmark?.readAt);
    assert.equal(getBookmark("owner", bookmarkId).revision, 5);
    assert.equal(
      (
        await updateBookmarkReadState("owner", {
          items: [{ id: bookmarkId, revision: 5, read: true }],
        })
      )[0].status,
      "unchanged",
    );
    assert.equal(
      (
        await updateBookmarkReadState("owner", {
          items: [{ id: bookmarkId, revision: 4, read: false }],
        })
      )[0].status,
      "conflict",
    );
    assert.equal(
      (
        await updateBookmarkReadState("owner", {
          items: [{ id: bookmarkId, revision: 5, read: false }],
        })
      )[0].status,
      "updated",
    );
    assert.equal(getBookmark("owner", bookmarkId).readAt, null);
    assert.deepEqual(
      database
        .prepare(
          "SELECT status FROM completion_events WHERE target_id=? ORDER BY id",
        )
        .all(bookmarkId),
      [{ status: "marked-read" }, { status: "marked-unread" }],
    );

    database
      .prepare(
        "INSERT INTO background_jobs(id,owner_id,kind,target_id,state,attempts,available_at,created_at) VALUES('legacy-article','owner','article',?,'queued',0,?,?)",
      )
      .run(randomUUID(), now, now);
    assert.equal(jobs.claimJob(), undefined);
    await jobs.jobsIdle();
    assert.equal(
      (
        database
          .prepare(
            "SELECT state FROM background_jobs WHERE id='legacy-article'",
          )
          .get() as { state: string }
      ).state,
      "queued",
      "runtime workers leave unsupported legacy article jobs alone",
    );
  } finally {
    if (!connection.open) {
      await stopJobWorker?.();
      database?.close();
    } else connection.close();
    if (previousDataDir === undefined) delete process.env.NIVRA_DATA_DIR;
    else process.env.NIVRA_DATA_DIR = previousDataDir;
    await rm(directory, { recursive: true, force: true });
  }
});
