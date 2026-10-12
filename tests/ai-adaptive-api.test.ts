import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

test("adaptive tagging preferences and proposal reviews remain owner-only and revision checked", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "nivra-adaptive-api-"));
  process.env.NIVRA_DATA_DIR = directory;
  const routes = await import("../src/app/api/v1/[...path]/route");
  const { sqlite } = await import("../src/lib/server/db");
  const { fingerprint, sourceFor, sourceText } =
    await import("../src/lib/server/ai/content");
  const { modelVersion } = await import("../src/lib/server/ai/model");
  const { stopJobWorker } = await import("../src/lib/server/jobs");
  const { stopAi } = await import("../src/lib/server/ai/indexer");
  const { operationFor } = await import("../src/lib/server/api-contract");
  let cookie = "";
  const call = (route: string, method = "GET", body?: unknown, auth = true) =>
    routes.GET(
      new Request(`http://localhost:3000/api/v1/${route}`, {
        method,
        headers: {
          origin: "http://localhost:3000",
          host: "localhost:3000",
          "content-type": "application/json",
          ...(auth ? { cookie } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      { params: Promise.resolve({ path: route.split("/") }) },
    );
  const value = async (route: string, method = "GET", body?: unknown) => {
    const response = await call(route, method, body);
    assert.ok(response.ok, await response.clone().text());
    return response.json();
  };
  try {
    const setup = await call(
      "setup",
      "POST",
      {
        name: "Adaptive API Test",
        username: "adaptive_api_test",
        password: `Test-${randomUUID()}`,
      },
      false,
    );
    assert.equal(setup.status, 200);
    cookie = setup.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    const initial = await value("ai");
    assert.equal(initial.enabled, false);
    assert.equal(initial.taggingMode, "manual");
    assert.equal(initial.vocabularyPending, 0);
    const automatic = await value("ai", "PATCH", {
      enabled: false,
      revision: initial.revision,
      taggingMode: "automatic",
    });
    assert.equal(automatic.taggingMode, "automatic");
    assert.equal(
      automatic.enabled,
      false,
      "Selecting a mode does not turn on the master feature flag",
    );
    assert.equal(
      (
        await call("ai", "PATCH", {
          enabled: false,
          revision: initial.revision,
          taggingMode: "manual",
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await call("ai", "PATCH", {
          enabled: false,
          revision: automatic.revision,
          taggingMode: "invalid",
        })
      ).status,
      400,
    );
    const preserved = await value("ai", "PATCH", {
      enabled: false,
      revision: automatic.revision,
    });
    assert.equal(
      preserved.taggingMode,
      "automatic",
      "Old callers omitting the mode preserve the current preference",
    );
    const manual = await value("ai", "PATCH", {
      enabled: false,
      revision: preserved.revision,
      taggingMode: "manual",
    });
    assert.equal(manual.taggingMode, "manual");
    assert.deepEqual(await value("ai/tag-proposals"), { items: [] });
    assert.equal(
      (await call("ai/tag-proposals", "GET", undefined, false)).status,
      401,
    );
    assert.equal(
      (await call("ai/tag-proposals/not-a-uuid/accept", "POST", {})).status,
      400,
    );
    for (const action of ["accept", "reject"]) {
      const missing = await call(
        `ai/tag-proposals/${randomUUID()}/${action}`,
        "POST",
        {},
      );
      assert.ok([404, 409].includes(missing.status));
    }

    const database = sqlite();
    database.prepare("UPDATE ai_configuration SET enabled=1").run();
    const ownerId = (
      database.prepare("SELECT id FROM user LIMIT 1").get() as { id: string }
    ).id;
    const proposalId = randomUUID();
    const proposalName = "Disposable proposal preview";
    const nameFingerprint = fingerprint(proposalName);
    const now = Date.now();
    const vector = new Float32Array(384);
    vector[0] = 1;
    const embedding = Buffer.from(vector.buffer);
    database
      .prepare(
        "INSERT INTO ai_tag_proposals(id,owner_id,normalized_name,name_fingerprint,name,status,cohesion,created_at) VALUES(?,?,?,?,?,'pending',1,?)",
      )
      .run(
        proposalId,
        ownerId,
        proposalName.toLowerCase(),
        nameFingerprint,
        proposalName,
        now,
      );
    const previewNoteIds: string[] = [];
    for (let index = 0; index < 4; index++) {
      const id = randomUUID();
      previewNoteIds.push(id);
      database
        .prepare(
          "INSERT INTO notes(id,owner_id,title,document,text,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
        )
        .run(
          id,
          ownerId,
          `Preview source ${index + 1}`,
          '{"schemaVersion":1,"blocks":[]}',
          "Disposable evidence for proposal preview contract testing.",
          now,
          now,
        );
      const sourceKey = `note:${id}`;
      const source = sourceFor(sourceKey);
      assert.ok(source, "synthetic note is visible through the AI source view");
      const sourceFingerprint = fingerprint(sourceText(source));
      database
        .prepare(
          "UPDATE ai_content SET owner_id=?,item_kind='note',item_id=?,state='indexed',indexed_generation=generation,model_version=?,fingerprint=?,pending=0 WHERE source_key=?",
        )
        .run(ownerId, id, modelVersion, sourceFingerprint, sourceKey);
      const generation = (
        database
          .prepare("SELECT generation FROM ai_content WHERE source_key=?")
          .get(sourceKey) as { generation: number }
      ).generation;
      database
        .prepare(
          "INSERT INTO ai_tag_proposal_evidence(proposal_id,source_key,canonical_item_key,generation,fingerprint,model_version,terms,cohesion,embedding,created_at) VALUES(?,?,?,?,?,?,?,1,?,?)",
        )
        .run(
          proposalId,
          sourceKey,
          sourceKey,
          generation,
          sourceFingerprint,
          modelVersion,
          "[]",
          embedding,
          now,
        );
    }

    const proposalResponse = await value("ai/tag-proposals");
    const proposal = proposalResponse.items[0];
    assert.equal(proposal.id, proposalId);
    assert.equal(proposal.itemCount, 4);
    assert.equal(proposal.items.length, 3);
    assert.deepEqual(
      proposal.items.map((item: { itemId: string }) => item.itemId),
      [...previewNoteIds].sort().slice(0, 3),
      "the endpoint returns only the first three source previews",
    );
    const proposalOperation = operationFor("/api/v1/ai/tag-proposals", "GET");
    assert.ok(proposalOperation);
    assert.ok(
      proposalOperation.output.safeParse(proposalResponse).success,
      "the four-source response conforms to the public API contract",
    );

    assert.deepEqual(
      await value(`ai/tag-proposals/${proposalId}/accept`, "POST", {}),
      { ok: true },
    );
    assert.equal(
      (
        database
          .prepare(
            "SELECT count(*) AS n FROM note_tags WHERE tag_id=(SELECT created_tag_id FROM ai_tag_proposals WHERE id=?)",
          )
          .get(proposalId) as { n: number }
      ).n,
      4,
      "acceptance still uses every eligible evidence item beyond the preview",
    );
    const rebuild = await value("ai");
    assert.equal(
      rebuild.vocabularyPending,
      4,
      "adding an approved tag reports the old indexed vocabulary while suggestions are being rebuilt",
    );
    const vocabularyGeneration = (
      database
        .prepare("SELECT vocabulary_generation AS value FROM ai_configuration")
        .get() as { value: number }
    ).value;
    database
      .prepare(
        "UPDATE ai_content SET vocabulary_generation=?,pending=0 WHERE owner_id=? AND state='indexed'",
      )
      .run(vocabularyGeneration, ownerId);
    assert.equal(
      (await value("ai")).vocabularyPending,
      0,
      "fully processed or terminal failed content does not leave the vocabulary rebuild pending",
    );
    database
      .prepare("UPDATE ai_content SET pending=1 WHERE source_key=?")
      .run(`note:${previewNoteIds[0]}`);
    assert.equal(
      (await value("ai")).vocabularyPending,
      1,
      "a current indexed item awaiting adaptive preparation is pending even when its vocabulary generation already matches",
    );
    database
      .prepare("UPDATE ai_content SET pending=0 WHERE source_key=?")
      .run(`note:${previewNoteIds[0]}`);
    assert.equal(
      (await value("ai")).vocabularyPending,
      0,
      "clearing the adaptive processing marker clears the pending count when vocabulary is current",
    );
    const ordinaryPendingNote = randomUUID();
    database
      .prepare(
        "INSERT INTO notes(id,owner_id,title,document,text,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
      )
      .run(
        ordinaryPendingNote,
        ownerId,
        "Disposable ordinary pending content",
        '{"schemaVersion":1,"blocks":[]}',
        "Unrelated content ingestion must not block tag review.",
        now,
        now,
      );
    assert.equal(
      (await value("ai")).vocabularyPending,
      0,
      "ordinary new content is not a vocabulary rebuild and must not lock tag review",
    );
    database
      .prepare(
        "UPDATE ai_content SET state='failed',vocabulary_generation=? WHERE source_key=?",
      )
      .run(vocabularyGeneration - 1, `note:${previewNoteIds[0]}`);
    database
      .prepare(
        "UPDATE ai_content SET state='capacity',vocabulary_generation=? WHERE source_key=?",
      )
      .run(vocabularyGeneration - 1, `note:${previewNoteIds[1]}`);
    assert.equal(
      (await value("ai")).vocabularyPending,
      0,
      "terminal failures and capacity deferrals must not keep vocabulary refresh blocked",
    );

    const key = await value("ai-connections", "POST", {
      name: "Adaptive API test",
      action: "create-key",
      access: "full",
    });
    const token = key.token ?? key.key;
    assert.ok(
      typeof token === "string",
      "API key response includes the one-time token",
    );
    for (const route of ["ai", "ai/tag-proposals"]) {
      const denied = await routes.GET(
        new Request(`http://localhost:3000/api/v1/${route}`, {
          headers: { authorization: `Bearer ${token}` },
        }),
        { params: Promise.resolve({ path: route.split("/") }) },
      );
      assert.equal(
        denied.status,
        403,
        "Agent keys cannot configure or review owner learning state",
      );
    }
    for (const route of ["ai", "ai/tag-proposals"]) {
      const op = operationFor(`/api/v1/${route}`, "GET");
      assert.ok(op);
      assert.ok(
        op.output.safeParse(await value(route)).success,
        "Actual owner responses match the OpenAPI executable schema",
      );
    }
  } finally {
    await stopJobWorker();
    await stopAi();
    sqlite().close();
    delete (globalThis as { nivraSqlite?: unknown }).nivraSqlite;
    await rm(directory, { recursive: true, force: true });
  }
});
