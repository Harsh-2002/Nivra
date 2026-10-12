import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
test("private suggestions require approval, merge live tags, preserve rejection and protect semantic retrieval", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "nivra-ai-service-"));
  process.env.NIVRA_DATA_DIR = directory;
  const { sqlite } = await import("../src/lib/server/db");
  const { enqueueJob, claimJob, commitJob, stopJobWorker } =
    await import("../src/lib/server/jobs");
  const { processSemantic, refreshIndexedTaggingQueue, stopAi } =
    await import("../src/lib/server/ai/indexer");
  const { listSuggestions, decideSuggestion, aiStatus } =
    await import("../src/lib/server/ai/service");
  const { relatedSearch } = await import("../src/lib/server/ai/search");
  const { executeContent } = await import("../src/lib/server/content-service");
  const { itemTagState, assignItemTags } =
    await import("../src/lib/server/item-tags");
  const { authorizeContentPath } =
    await import("../src/lib/server/agent-access");
  const { HttpError } = await import("../src/lib/server/http");
  const { operationFor } = await import("../src/lib/server/api-contract");
  const d = sqlite(),
    owner = randomUUID(),
    id = randomUUID(),
    tag = randomUUID(),
    manual = randomUUID(),
    key = "note:" + id;
  const index = async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      refreshIndexedTaggingQueue(d);
      enqueueJob(owner, "semantic", key);
      const job = claimJob();
      assert.ok(job);
      await processSemantic({ job, commit: (write) => commitJob(job, write) });
      const row = d
        .prepare("SELECT pending FROM ai_content WHERE source_key=?")
        .get(key) as { pending: number };
      if (!row.pending) return;
    }
    assert.equal(
      (
        d
          .prepare("SELECT pending FROM ai_content WHERE source_key=?")
          .get(key) as { pending: number }
      ).pending,
      0,
      "semantic work must settle after a bounded retry",
    );
  };
  const content = async (route: string, method: string, input?: unknown) => {
    const [p, q] = route.split("?");
    const result = await executeContent({
      ownerId: owner,
      origin: "http://localhost:3000",
      path: p.split("/"),
      method,
      input,
      query: new URLSearchParams(q),
    });
    assert.ok("data" in result);
    return result.data as Record<string, unknown>;
  };
  try {
    d.prepare(
      "INSERT INTO user(id,name,email,username,created_at,updated_at) VALUES(?,'Synthetic','ai-service@example.test','ai_service',1,1)",
    ).run(owner);
    d.prepare(
      "INSERT INTO notes(id,owner_id,title,document,text,created_at,updated_at) VALUES(?,?,'report-42.pdf SQLite restore','{\"schemaVersion\":1,\"blocks\":[]}','SQLite database queries and indexes verify database backup restore. ERR_AUTH_FAILED recorded on 2026-10-11.',1,1)",
    ).run(id, owner);
    d.prepare(
      "INSERT INTO tags(id,name,color,aliases) VALUES(?,'Databases','gray',?), (?,'Manual','gray','[]')",
    ).run(tag, JSON.stringify(["database sqlite queries indexes"]), manual);
    assert.equal(aiStatus(owner).enabled, false);
    assert.equal(listSuggestions(owner).items.length, 0);
    assert.equal(
      (await relatedSearch(owner, "SQLite")).strategyUsed,
      "keyword",
    );
    d.prepare("UPDATE ai_configuration SET enabled=1").run();
    await index();
    assert.equal(
      (
        d
          .prepare("SELECT state FROM ai_content WHERE source_key=?")
          .get(key) as { state: string }
      ).state,
      "indexed",
    );
    d.prepare(
      "INSERT INTO ai_extractions(source_key,storage_key,text,status) VALUES(?,?,'UNAPPROVED_AI_SENTINEL','done')",
    ).run(key, randomUUID());
    const noteDto = await content(`notes/${id}`, "GET");
    assert.ok(!JSON.stringify(noteDto).includes("UNAPPROVED_AI_SENTINEL"));
    assert.ok(!JSON.stringify(noteDto).includes("embedding"));
    const { executeTransfer } =
      await import("../src/lib/server/transfer-service");
    const { unzipSync, strFromU8 } = await import("fflate");
    const portable = await executeTransfer({
      ownerId: owner,
      origin: "http://localhost:3000",
      path: ["export", "bundle"],
      method: "GET",
      query: new URLSearchParams(),
    });
    assert.ok("response" in portable);
    const zip = unzipSync(
      new Uint8Array(await portable.response.arrayBuffer()),
    );
    assert.ok(
      !strFromU8(zip["manifest.json"]).includes("UNAPPROVED_AI_SENTINEL"),
    );
    assert.ok(!strFromU8(zip["manifest.json"]).includes("ai_suggestions"));
    const { publishedNote, publishNote } =
      await import("../src/lib/server/publications");
    const { getNote } = await import("../src/lib/server/notes");
    const publication = await publishNote(getNote(id)!, 1);
    assert.ok(
      !JSON.stringify(publishedNote(publication.token)).includes(
        "UNAPPROVED_AI_SENTINEL",
      ),
    );
    const proposals = listSuggestions(owner).items;
    assert.equal(proposals.length, 1);
    assert.equal(proposals[0].tag.id, tag);
    assert.ok(proposals[0].excerpt.includes("SQLite"));
    assert.ok(proposals[0].excerpt.length <= 240);
    assert.equal(proposals[0].formId, undefined);
    assert.equal(listSuggestions(randomUUID()).items.length, 0);
    assignItemTags(owner, "note", id, 1, [manual]);
    assert.ok(
      listSuggestions(owner).items.some(
        (proposal) => proposal.id === proposals[0].id,
      ),
      "an unrelated manual tag must not invalidate this source's pending suggestion",
    );
    decideSuggestion(owner, proposals[0].id, "accepted");
    decideSuggestion(owner, proposals[0].id, "accepted");
    assert.deepEqual(
      new Set(itemTagState(owner, "note", id).tags.map((t) => t.id)),
      new Set([tag, manual]),
    );
    assert.equal(itemTagState(owner, "note", id).revision, 3);
    const related = await relatedSearch(
      owner,
      "find report-42.pdf ERR_AUTH_FAILED",
    );
    assert.equal(related.strategyUsed, "semantic");
    assert.equal(related.items[0].id, id);
    assert.equal(
      (await relatedSearch(owner, "tag:Manual report-42.pdf")).items[0]?.id,
      id,
    );
    assert.equal(
      (await relatedSearch(owner, "tag:Absent report-42.pdf")).items.length,
      0,
    );

    assert.ok(!JSON.stringify(related).includes("embedding"));
    assert.equal(
      (await relatedSearch(randomUUID(), "database restore")).items.length,
      0,
    );
    const principal = {
      ownerId: owner,
      connectionId: "fixture",
      scopes: ["nivra:read"],
    };
    for (const route of [["ai"], ["ai", "suggestions"]])
      assert.throws(
        () => authorizeContentPath(principal, route, "GET"),
        (e: unknown) => e instanceof HttpError && e.status === 403,
      );
    const readonly = await executeContent({
      ownerId: owner,
      principal,
      origin: "http://localhost:3000",
      path: ["search"],
      method: "GET",
      query: new URLSearchParams(
        "mode=suggest&strategy=semantic&q=report-42.pdf",
      ),
    });
    assert.ok("data" in readonly);
    assert.equal(
      operationFor("/api/v1/ai/suggestions", "GET")?.access,
      "owner",
    );
    assert.equal(
      (
        await content(`tags/${tag}`, "PATCH", {
          name: "Databases",
          color: "gray",
        })
      ).aliases instanceof Array,
      true,
    );
    assert.deepEqual((await content(`tags/${tag}`, "GET")).aliases, [
      "database sqlite queries indexes",
    ]);
    await assert.rejects(
      content(`tags/${tag}`, "PATCH", {
        name: "Databases",
        color: "gray",
        aliases: Array(11).fill("x"),
      }),
    );
    assignItemTags(owner, "note", id, 3, [manual]);
    d.prepare("UPDATE notes SET text=text||' SQLite queries' WHERE id=?").run(
      id,
    );
    await index();
    const dismissed = listSuggestions(owner).items[0];
    assert.ok(dismissed);
    const revision = itemTagState(owner, "note", id).revision;
    decideSuggestion(owner, dismissed.id, "rejected");
    assert.equal(itemTagState(owner, "note", id).revision, revision);
    const correctedReplacement = randomUUID();
    d.prepare(
      "INSERT INTO ai_suggestions(source_key,id,generation,fingerprint,score,model_version,vocabulary_generation,tag_id,created_at) SELECT c.source_key,?,c.generation,c.fingerprint,0.9,c.model_version,a.vocabulary_generation,?,? FROM ai_content c JOIN ai_configuration a ON a.id=1 WHERE c.source_key=?",
    ).run(correctedReplacement, tag, Date.now(), key);
    assert.equal(
      listSuggestions(owner).items.length,
      0,
      "Owner correction immediately hides replacement guesses before the next index pass",
    );
    assert.throws(
      () => decideSuggestion(owner, correctedReplacement, "accepted"),
      (e: unknown) => e instanceof HttpError && e.status === 409,
    );
    d.prepare("UPDATE tags SET aliases=? WHERE id=?").run(
      JSON.stringify(["database sqlite queries indexes backup"]),
      tag,
    );
    await index();
    assert.equal(listSuggestions(owner).items.length, 0);
    d.prepare("UPDATE notes SET text=text||' Changed content' WHERE id=?").run(
      id,
    );
    await index();
    const outdated = listSuggestions(owner).items[0];
    assert.ok(outdated);
    d.prepare("UPDATE notes SET trashed_at=2 WHERE id=?").run(id);
    assert.equal(listSuggestions(owner).items.length, 0);
    assert.equal((await relatedSearch(owner, "report-42.pdf")).items.length, 0);
    assert.throws(
      () => decideSuggestion(owner, outdated.id, "accepted"),
      (e: unknown) => e instanceof HttpError && e.status === 409,
    );
  } finally {
    await stopJobWorker();
    await stopAi();
    d.close();
    delete (globalThis as { nivraSqlite?: unknown }).nivraSqlite;
    await rm(directory, { recursive: true, force: true });
  }
});
