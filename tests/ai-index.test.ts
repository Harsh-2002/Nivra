import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  tagCandidates,
  hybridRank,
  literalProtection,
} from "../src/lib/server/ai/policy";
let testDirectory: string | undefined;
let contentPromise:
  Promise<typeof import("../src/lib/server/ai/content")> | undefined;
function loadContent() {
  return (contentPromise ??= mkdtemp(
    path.join(tmpdir(), "nivra-ai-index-"),
  ).then(async (directory) => {
    testDirectory = directory;
    process.env.NIVRA_DATA_DIR = directory;
    return import("../src/lib/server/ai/content");
  }));
}
test("AI chunks keep 160-word boundaries and count without materializing words", async () => {
  const { textChunkCount, textChunks } = await loadContent();
  const words = Array.from({ length: 321 }, (_, index) => `word${index}`),
    text = words.join("\u00a0\n\t");
  const chunks = [...textChunks(text)];
  assert.deepEqual(chunks, [
    words.slice(0, 160).join(" "),
    words.slice(160, 320).join(" "),
    words.slice(320).join(" "),
  ]);
  assert.equal(textChunkCount(text), 3);
  assert.equal(textChunkCount("word ".repeat(160 * 3), 2), 3);
  const large = textChunks("x ".repeat(100_000));
  assert.equal(large.next().value, Array(160).fill("x").join(" "));
});
test("conservative literal checks abstain and frozen protected ranking preserves identifiers", () => {
  const tags = [
    { id: "db", name: "Databases", aliases: ["sqlite queries indexes"] },
    {
      id: "sec",
      name: "Security",
      aliases: ["credentials privacy encryption"],
    },
  ];
  assert.equal(
    tagCandidates("sqlite queries need indexes", tags)[0].tag.id,
    "db",
  );
  for (const text of ["", "sqlite", "maybe tomorrow", "buy apples today"])
    assert.equal(tagCandidates(text, tags).length, 0);
  assert.equal(
    literalProtection(
      "Find ERR_AUTH_FAILED in report-42.pdf",
      "ERR_AUTH_FAILED was recorded in report-42.pdf.",
    ),
    true,
  );
  assert.equal(
    literalProtection("ERR_AUTH_FAILED", "OTHER_ERR_AUTH_FAILED"),
    false,
  );
  const rank = hybridRank(
    "report-42.pdf",
    [
      { key: "unrelated", score: 0.9 },
      { key: "exact", score: 0.2 },
    ],
    [{ key: "exact", score: 1 }],
    new Map([
      ["exact", "report-42.pdf"],
      ["unrelated", "related reports"],
    ]),
  );
  assert.equal(rank[0].key, "exact");
});
test("encrypted derived indexing fences edits, OCR changes and deletion without changing canonical revisions", async () => {
  await loadContent();
  const directory = testDirectory!;
  const { sqlite } = await import("../src/lib/server/db");
  const { enqueueJob, claimJob, commitJob, stopJobWorker } =
    await import("../src/lib/server/jobs");
  const { processSemantic, aiOperation, stopAi } =
    await import("../src/lib/server/ai/indexer");
  const { sourceFor } = await import("../src/lib/server/ai/content");
  const { modelVersion } = await import("../src/lib/server/ai/model");
  const d = sqlite(),
    owner = randomUUID(),
    id = randomUUID(),
    tag = randomUUID(),
    key = "note:" + id;
  const processOne = async (sourceKey: string) => {
    enqueueJob(owner, "semantic", sourceKey);
    const job = claimJob();
    assert.ok(job);
    await processSemantic({ job, commit: (write) => commitJob(job, write) });
  };
  try {
    d.prepare(
      "INSERT INTO user(id,name,email,username,created_at,updated_at) VALUES(?,?,?,?,?,?)",
    ).run(
      owner,
      "Synthetic owner",
      "ai@example.test",
      "ai_owner",
      Date.now(),
      Date.now(),
    );
    d.prepare(
      "INSERT INTO notes(id,owner_id,title,document,text,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
    ).run(
      id,
      owner,
      "SQLite backup verification",
      "[]",
      "SQLite database queries check encrypted backup indexes.",
      Date.now(),
      Date.now(),
    );
    assert.equal(sourceFor(key)?.generation, 1);
    const unindexed = randomUUID();
    const epoch = () =>
      (
        d
          .prepare("SELECT index_generation AS n FROM ai_configuration")
          .get() as { n: number }
      ).n;
    const beforeInsert = epoch();
    d.prepare(
      "INSERT INTO tasks(id,owner_id,title,created_at,updated_at) VALUES(?,?,'Pending lexical content',1,1)",
    ).run(unindexed, owner);
    assert.ok(epoch() > beforeInsert);
    const beforeEdit = epoch();
    d.prepare(
      "UPDATE tasks SET title='Changed before first indexing' WHERE id=?",
    ).run(unindexed);
    assert.ok(epoch() > beforeEdit);
    d.prepare("DELETE FROM tasks WHERE id=?").run(unindexed);

    d.prepare("INSERT INTO tags(id,name,color,aliases) VALUES(?,?,?,?)").run(
      tag,
      "Databases",
      "gray",
      JSON.stringify(["database sqlite queries indexes"]),
    );
    assert.equal(
      (
        d.prepare("SELECT enabled FROM ai_configuration").get() as {
          enabled: number;
        }
      ).enabled,
      0,
    );
    d.prepare("UPDATE ai_configuration SET enabled=1").run();
    const { policy } = await import("../src/lib/server/ai/policy"),
      mutablePolicy = policy as unknown as { chunkCapacity: number },
      originalCapacity = policy.chunkCapacity,
      capacityId = randomUUID();
    try {
      mutablePolicy.chunkCapacity = 1;
      d.prepare(
        "INSERT INTO notes(id,owner_id,title,document,text,created_at,updated_at) VALUES(?,?,'Capacity fixture','[]',?,?,?)",
      ).run(
        capacityId,
        owner,
        Array(321).fill("imported").join(" "),
        Date.now(),
        Date.now(),
      );
      await processOne("note:" + capacityId);
      assert.equal(
        (
          d
            .prepare("SELECT state FROM ai_content WHERE source_key=?")
            .get("note:" + capacityId) as { state: string }
        ).state,
        "capacity",
      );
      assert.equal(
        (
          d
            .prepare("SELECT count(*) AS n FROM ai_chunks WHERE source_key=?")
            .get("note:" + capacityId) as { n: number }
        ).n,
        0,
      );
    } finally {
      mutablePolicy.chunkCapacity = originalCapacity;
    }
    await processOne(key);
    assert.equal(
      (
        d
          .prepare("SELECT state FROM ai_content WHERE source_key=?")
          .get(key) as { state: string }
      ).state,
      "indexed",
    );
    assert.equal(
      (
        d.prepare("SELECT revision FROM notes WHERE id=?").get(id) as {
          revision: number;
        }
      ).revision,
      1,
    );
    assert.equal(
      (
        d
          .prepare("SELECT count(*) AS n FROM note_tags WHERE note_id=?")
          .get(id) as { n: number }
      ).n,
      0,
    );
    assert.ok(
      (
        d
          .prepare("SELECT count(*) AS n FROM ai_chunks WHERE source_key=?")
          .get(key) as { n: number }
      ).n > 0,
    );
    const results = await aiOperation((worker) =>
      worker.search(owner, "restore a database backup", Date.now() + 3000),
    );
    assert.ok(results.some((row) => row.key === key));
    const denied = await aiOperation((worker) =>
      worker.search(
        randomUUID(),
        "restore a database backup",
        Date.now() + 3000,
      ),
    );
    assert.equal(denied.length, 0);
    d.prepare("UPDATE notes SET text=? WHERE id=?").run(
      "A new unrelated grocery list.",
      id,
    );
    assert.equal(sourceFor(key)?.generation, 2);
    const afterEdit = await aiOperation((worker) =>
      worker.search(owner, "restore a database backup", Date.now() + 3000),
    );
    assert.equal(afterEdit.length, 0);

    assert.equal(
      (
        d
          .prepare("SELECT count(*) AS n FROM ai_chunks WHERE source_key=?")
          .get(key) as { n: number }
      ).n,
      0,
    );
    assert.equal(
      (
        d
          .prepare(
            "SELECT count(*) AS n FROM ai_suggestions WHERE source_key=?",
          )
          .get(key) as { n: number }
      ).n,
      0,
    );
    enqueueJob(owner, "semantic", key);
    const stale = claimJob();
    assert.ok(stale);
    d.prepare("UPDATE notes SET text=? WHERE id=?").run(
      "A later edit wins over the inference snapshot.",
      id,
    );
    await processSemantic({
      job: stale,
      commit: (write) => commitJob(stale, write),
    });
    assert.equal(
      (
        d
          .prepare("SELECT count(*) AS n FROM ai_chunks WHERE source_key=?")
          .get(key) as { n: number }
      ).n,
      0,
    );
    await processOne(key);
    assert.equal(
      (
        d
          .prepare("SELECT model_version FROM ai_chunks WHERE source_key=?")
          .get(key) as { model_version: string }
      ).model_version,
      modelVersion,
    );
    d.prepare(
      "UPDATE notes SET text=text||' Concurrent edit test' WHERE id=?",
    ).run(id);
    const holder = globalThis as unknown as {
      nivraAi: {
        worker: {
          encode: (
            text: string,
            query?: boolean,
            timeout?: number,
          ) => Promise<Float32Array>;
        };
      };
    };
    const original = holder.nivraAi.worker.encode.bind(holder.nivraAi.worker);
    let changed = false;
    holder.nivraAi.worker.encode = async (text, query, timeout) => {
      const result = await original(text, query, timeout);
      if (!changed) {
        changed = true;
        d.prepare(
          "UPDATE notes SET text=text||' Newer edit during inference' WHERE id=?",
        ).run(id);
      }
      return result;
    };
    await processOne(key);
    holder.nivraAi.worker.encode = original;
    assert.ok(changed);
    assert.equal(
      (
        d
          .prepare("SELECT count(*) AS n FROM ai_chunks WHERE source_key=?")
          .get(key) as { n: number }
      ).n,
      0,
    );
    assert.equal(
      (
        d
          .prepare("SELECT state FROM ai_content WHERE source_key=?")
          .get(key) as { state: string }
      ).state,
      "pending",
    );
    await processOne(key);
    const artifact = randomUUID();
    d.prepare(
      "INSERT INTO artifacts(id,owner_id,kind,title,content,created_at,updated_at) VALUES(?,?,'image','Receipt','',1,1)",
    ).run(artifact, owner);
    const artifactKey = "artifact:" + artifact,
      before = sourceFor(artifactKey)!.generation;
    d.prepare(
      "UPDATE artifacts SET content='OCR_SENTINEL Receipt total 24.00',extraction='done' WHERE id=?",
    ).run(artifact);
    assert.equal(sourceFor(artifactKey)!.generation, before + 1);
    assert.equal(
      (
        d
          .prepare("SELECT revision FROM artifacts WHERE id=?")
          .get(artifact) as { revision: number }
      ).revision,
      1,
    );
    await processOne(artifactKey);
    assert.ok(
      (
        d
          .prepare("SELECT text FROM ai_chunks WHERE source_key=?")
          .get(artifactKey) as { text: string }
      ).text.includes("OCR_SENTINEL"),
    );
    const journal = randomUUID(),
      task = randomUUID(),
      bookmark = randomUUID(),
      event = randomUUID(),
      form = randomUUID();
    d.prepare(
      "INSERT INTO notes(id,owner_id,title,document,text,daily_date,created_at,updated_at) VALUES(?,?,'Daily recovery','[]','SQLite backup journal','2026-10-11',1,1)",
    ).run(journal, owner);
    d.prepare(
      "INSERT INTO tasks(id,owner_id,title,created_at,updated_at) VALUES(?,?,'Verify backup restore',1,1)",
    ).run(task, owner);
    d.prepare(
      "INSERT INTO bookmarks(id,owner_id,url,title,description,created_at,updated_at) VALUES(?,?,'https://example.test/restore','Backup guide','Database recovery instructions',1,1)",
    ).run(bookmark, owner);
    d.prepare(
      "INSERT INTO calendar_events(id,owner_id,title,description,start_date,end_date,data,created_at,updated_at) VALUES(?,?,'Recovery review','Review SQLite backup','2026-10-11','2026-10-11','{}',1,1)",
    ).run(event, owner);
    d.prepare(
      "INSERT INTO forms(id,owner_id,title,description,definition,created_at,updated_at) VALUES(?,?,'Recovery feedback','Database backup comments','{}',1,1)",
    ).run(form, owner);
    const formGeneration = sourceFor("form:" + form)!.generation;
    d.prepare(
      "UPDATE forms SET closing_date='2026-12-31',closing_timezone='UTC' WHERE id=?",
    ).run(form);
    assert.equal(sourceFor("form:" + form)!.generation, formGeneration + 1);
    for (const [kind, item, table] of [
      ["note", journal, "notes"],
      ["task", task, "tasks"],
      ["bookmark", bookmark, "bookmarks"],
      ["event", event, "calendar_events"],
      ["form", form, "forms"],
    ]) {
      const sourceKey = kind + ":" + item;
      await processOne(sourceKey);
      assert.ok(
        (
          d
            .prepare("SELECT text FROM ai_chunks WHERE source_key=?")
            .get(sourceKey) as { text: string }
        ).text.length > 0,
      );
      assert.equal(
        (
          d.prepare(`SELECT revision FROM ${table} WHERE id=?`).get(item) as {
            revision: number;
          }
        ).revision,
        1,
      );
      const generation = sourceFor(sourceKey)!.generation;
      d.prepare(`UPDATE ${table} SET title=title||' Revised' WHERE id=?`).run(
        item,
      );
      assert.equal(sourceFor(sourceKey)!.generation, generation + 1);
      assert.equal(
        (
          d
            .prepare("SELECT count(*) AS n FROM ai_chunks WHERE source_key=?")
            .get(sourceKey) as { n: number }
        ).n,
        0,
      );
    }
    d.prepare("UPDATE notes SET trashed_at=? WHERE id=?").run(Date.now(), id);
    assert.equal(sourceFor(key)?.active, 0);
    assert.equal(
      (
        d
          .prepare("SELECT count(*) AS n FROM ai_chunks WHERE source_key=?")
          .get(key) as { n: number }
      ).n,
      0,
    );
    d.prepare("DELETE FROM notes WHERE id=?").run(id);
    assert.equal(sourceFor(key), undefined);
    assert.equal(
      (
        d
          .prepare("SELECT count(*) AS n FROM ai_content WHERE source_key=?")
          .get(key) as { n: number }
      ).n,
      0,
    );
    const header = await readFile(path.join(directory, "nivra.sqlite"));
    assert.notEqual(header.subarray(0, 16).toString(), "SQLite format 3\0");
  } finally {
    await stopAi();
    await stopJobWorker();
    d.close();
    await rm(directory, { recursive: true, force: true });
  }
});
