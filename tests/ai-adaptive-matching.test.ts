import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir } from "node:fs/promises";
import Database from "better-sqlite3";
import {
  prepareAdaptiveTagMatch,
  selectAdaptiveTag,
} from "../src/lib/server/ai/matching";
import { modelVersion } from "../src/lib/server/ai/model";
import { literalTagEvidence } from "../src/lib/server/ai/policy";

test("adaptive matching ranks examples independently of opaque tag labels", () => {
  const match = selectAdaptiveTag([
    {
      tag: { id: "project", name: "Project Atlas", aliases: [] },
      labelScore: 0.16,
      exampleScore: 0.81,
      support: 4,
    },
  ]);
  assert.equal(match?.tag.id, "project");
  assert.equal(match?.origin, "examples");
  assert.equal(match?.automaticEligible, true);
});

test("adaptive matching abstains below admission and on close contenders", () => {
  assert.equal(
    selectAdaptiveTag([
      {
        tag: { id: "health", name: "Health", aliases: [] },
        labelScore: 0.33,
        support: 0,
      },
    ]),
    undefined,
  );
  assert.equal(
    selectAdaptiveTag([
      {
        tag: { id: "battery", name: "Battery", aliases: [] },
        labelScore: 0.72,
        support: 1,
      },
      {
        tag: { id: "energy", name: "Energy", aliases: [] },
        labelScore: 0.69,
        support: 1,
      },
    ]),
    undefined,
  );
});

test("label-only automation needs literal evidence; supported examples can match semantically", () => {
  const manual = selectAdaptiveTag([
    {
      tag: { id: "health", name: "Health", aliases: [] },
      labelScore: 0.55,
      support: 0,
    },
  ]);
  assert.equal(manual?.tag.id, "health");
  assert.equal(manual?.automaticEligible, false);

  const strong = selectAdaptiveTag([
    {
      tag: { id: "health", name: "Health", aliases: [] },
      labelScore: 0.82,
      support: 0,
    },
  ]);
  assert.equal(strong?.automaticEligible, false);

  const tags = [{ id: "health", name: "Health", aliases: ["wellbeing"] }];
  assert.equal(
    literalTagEvidence("A WELLBEING note", tags).has("health"),
    true,
  );
  const literal = selectAdaptiveTag([
    {
      tag: tags[0],
      labelScore: 0.82,
      support: 0,
      literalEvidence: true,
    },
  ]);
  assert.equal(literal?.automaticEligible, true);

  const learned = selectAdaptiveTag([
    {
      tag: { id: "opaque", name: "Project Atlas", aliases: [] },
      labelScore: 0.12,
      exampleScore: 0.65,
      support: 2,
    },
  ]);
  assert.equal(learned?.automaticEligible, true);
  assert.equal(
    literalTagEvidence("A quiet evening at home", [
      { id: "opaque", name: "Project Atlas", aliases: [] },
    ]).has("opaque"),
    false,
    "label evidence stays literal while semantic examples remain eligible",
  );
});

test("literal tag evidence requires complete meaningful name or alias phrases", () => {
  const research = [
    { id: "research", name: "Research and Development", aliases: [] },
  ];
  assert.equal(
    literalTagEvidence("I can and will sort this later", research).has(
      "research",
    ),
    false,
  );
  assert.equal(
    literalTagEvidence("Research and Development planning", research).has(
      "research",
    ),
    true,
  );

  const battery = [
    { id: "battery-storage", name: "Battery storage", aliases: [] },
  ];
  assert.equal(
    literalTagEvidence("The battery needs charging", battery).has(
      "battery-storage",
    ),
    false,
  );
  assert.equal(
    literalTagEvidence("Battery storage planning", battery).has(
      "battery-storage",
    ),
    true,
  );
  assert.equal(
    literalTagEvidence("The and of it", [
      { id: "common", name: "The and of", aliases: [] },
    ]).has("common"),
    false,
  );
});

test("same-fingerprint owner rejection suppresses replacement matches", () => {
  const rejectedFallback = selectAdaptiveTag([
    {
      tag: { id: "personal", name: "Personal", aliases: [] },
      labelScore: 0.84,
      support: 0,
      literalEvidence: true,
      ownerCorrection: true,
    },
  ]);
  assert.equal(rejectedFallback, undefined);

  const rejectedExampleFallback = selectAdaptiveTag([
    {
      tag: { id: "work", name: "Work", aliases: [] },
      labelScore: 0.15,
      exampleScore: 0.78,
      support: 3,
      ownerCorrection: true,
    },
  ]);
  assert.equal(rejectedExampleFallback, undefined);
});

test("0046 queues prior indexed content while preserving stored vectors and canonical data", async () => {
  const d = new Database(":memory:");
  d.pragma("foreign_keys=ON");
  d.function("nivra_fold", { deterministic: true }, (value) =>
    String(value ?? "").toLocaleLowerCase(),
  );
  try {
    const migrations = (await readdir("migrations"))
      .filter((name) => name.endsWith(".sql") && name < "0043")
      .sort();
    for (const name of migrations)
      d.exec(await readFile(`migrations/${name}`, "utf8"));
    d.prepare(
      "INSERT INTO user(id,name,email,username,created_at,updated_at) VALUES('owner','Fixture','fixture@example.test','fixture',1,1)",
    ).run();
    d.prepare(
      "INSERT INTO notes(id,owner_id,title,document,text,revision,created_at,updated_at) VALUES('note','owner','Canonical title','[]','Encrypted source fixture',7,1,1)",
    ).run();
    d.prepare(
      "INSERT INTO tags(id,name,color) VALUES('tag','Manual','gray')",
    ).run();
    d.prepare("INSERT INTO note_tags VALUES('note','tag')").run();
    d.prepare(
      "INSERT INTO forms(id,owner_id,title,definition,created_at,updated_at) VALUES('form','owner','Review form','{}',1,1)",
    ).run();
    d.prepare(
      "INSERT INTO form_versions(id,form_id,revision,definition,created_at) VALUES('version','form',1,'{}',1)",
    ).run();
    d.prepare(
      "INSERT INTO form_responses(id,form_id,version_id,answers,search_text,retry_key,request_hash,reviewed,created_at) VALUES('response','form','version','{}','Owner response','retry','hash',0,1)",
    ).run();
    d.prepare(
      "INSERT INTO form_files(id,form_id,response_id,field_id,filename,mime,size,storage_key,state,created_at) VALUES('file','form','response','field','answer.txt','text/plain',0,'fixture-key','attached',1)",
    ).run();
    for (const name of [
      "0043_local_ai_index.sql",
      "0044_ai_jobs.sql",
      "0045_onboarding_step.sql",
    ]) {
      const sql = await readFile(`migrations/${name}`, "utf8");
      d.transaction(() => d.exec(sql)).immediate();
    }

    const existingEmbedding = Buffer.alloc(1536);
    existingEmbedding.writeFloatLE(0.25, 0);
    d.prepare(
      "UPDATE ai_content SET pending=0,owner_id='owner',item_kind='note',item_id='note',state='indexed',fingerprint='source-fingerprint',model_version='frozen-model',indexed_generation=generation WHERE source_key='note:note'",
    ).run();
    d.prepare(
      "INSERT INTO ai_chunks(source_key,ordinal,generation,model_version,title,text,embedding) VALUES('note:note',0,1,'frozen-model','Canonical title','preserved derived vector',?)",
    ).run(existingEmbedding);

    const adaptiveMigration = await readFile(
      "migrations/0046_adaptive_tagging.sql",
      "utf8",
    );
    d.transaction(() => d.exec(adaptiveMigration)).immediate();

    assert.equal(
      (
        d
          .prepare("SELECT tagging_mode FROM ai_configuration WHERE id=1")
          .get() as { tagging_mode: string }
      ).tagging_mode,
      "manual",
    );
    assert.equal(
      (
        d.prepare("SELECT revision FROM notes WHERE id='note'").get() as {
          revision: number;
        }
      ).revision,
      7,
    );
    const migrated = d
      .prepare(
        "SELECT state,pending,generation,indexed_generation,fingerprint,model_version FROM ai_content WHERE source_key='note:note'",
      )
      .get() as {
      state: string;
      pending: number;
      generation: number;
      indexed_generation: number;
      fingerprint: string;
      model_version: string;
    };
    assert.deepEqual(migrated, {
      state: "indexed",
      pending: 1,
      generation: 1,
      indexed_generation: 1,
      fingerprint: "source-fingerprint",
      model_version: "frozen-model",
    });
    assert.deepEqual(
      (
        d
          .prepare(
            "SELECT embedding FROM ai_chunks WHERE source_key='note:note'",
          )
          .get() as { embedding: Buffer }
      ).embedding,
      existingEmbedding,
    );
    assert.equal(
      (
        d
          .prepare("SELECT count(*) AS n FROM note_tags WHERE note_id='note'")
          .get() as { n: number }
      ).n,
      1,
    );

    const revisions = () =>
      d
        .prepare("SELECT learned_tag_revision FROM ai_configuration WHERE id=1")
        .get() as { learned_tag_revision: number };
    const beforeTagInsert = revisions().learned_tag_revision;
    d.prepare(
      "INSERT INTO tags(id,name,color) VALUES('cache-test','Cache test','gray')",
    ).run();
    assert.equal(revisions().learned_tag_revision, beforeTagInsert + 1);
    const beforeTagRename = revisions().learned_tag_revision;
    d.prepare(
      "UPDATE tags SET name='Renamed cache test',aliases='[\"cache alias\"]' WHERE id='cache-test'",
    ).run();
    assert.equal(revisions().learned_tag_revision, beforeTagRename + 1);
    const beforeTagDelete = revisions().learned_tag_revision;
    d.prepare("DELETE FROM tags WHERE id='cache-test'").run();
    assert.equal(revisions().learned_tag_revision, beforeTagDelete + 1);
    const beforeReview = revisions().learned_tag_revision;
    d.prepare(
      "INSERT INTO response_tags(response_id,tag_id) VALUES('response','tag')",
    ).run();
    assert.equal(revisions().learned_tag_revision, beforeReview);
    d.prepare(
      "UPDATE ai_content SET pending=0 WHERE source_key IN('response:response','form-file:file')",
    ).run();
    d.prepare("UPDATE form_responses SET reviewed=1 WHERE id='response'").run();
    assert.equal(revisions().learned_tag_revision, beforeReview + 1);
    assert.deepEqual(
      d
        .prepare(
          "SELECT source_key,pending FROM ai_content WHERE source_key IN('response:response','form-file:file') ORDER BY source_key",
        )
        .all(),
      [
        { source_key: "form-file:file", pending: 1 },
        { source_key: "response:response", pending: 1 },
      ],
    );
    d.prepare(
      "UPDATE ai_content SET pending=0 WHERE source_key='note:note'",
    ).run();
    const { refreshIndexedTaggingQueue } =
      await import("../src/lib/server/ai/indexer");
    assert.equal(refreshIndexedTaggingQueue(d), true);
    assert.equal(
      (
        d
          .prepare(
            "SELECT pending FROM ai_content WHERE source_key='note:note'",
          )
          .get() as {
          pending: number;
        }
      ).pending,
      1,
    );
    assert.equal(refreshIndexedTaggingQueue(d), false);
    assert.deepEqual(
      d
        .prepare("SELECT embedding FROM ai_chunks WHERE source_key='note:note'")
        .get(),
      { embedding: existingEmbedding },
    );

    d.prepare(
      "INSERT INTO tags(id,name,color) VALUES('auto-tag','Automatic','gray')",
    ).run();
    const beforeAutomatic = revisions().learned_tag_revision;
    d.prepare(
      "INSERT INTO ai_auto_assignments(source_key,tag_id,generation,fingerprint,approved,created_at) VALUES('note:note','auto-tag',1,'source-fingerprint',0,1)",
    ).run();
    d.prepare(
      "INSERT INTO note_tags(note_id,tag_id) VALUES('note','auto-tag')",
    ).run();
    assert.equal(revisions().learned_tag_revision, beforeAutomatic);
    d.prepare(
      "UPDATE ai_auto_assignments SET approved=1 WHERE source_key='note:note' AND tag_id='auto-tag'",
    ).run();
    assert.equal(revisions().learned_tag_revision, beforeAutomatic + 1);

    d.prepare(
      "INSERT INTO notes(id,owner_id,title,document,text,revision,created_at,updated_at) VALUES('moved-to','owner','Moved attachment parent','[]','Second parent',1,2,2)",
    ).run();
    d.prepare(
      "INSERT INTO tags(id,name,color) VALUES('move-tag','Move cleanup','gray')",
    ).run();
    d.prepare(
      "INSERT INTO attachments(id,note_id,name,mime,size,storage_key,created_at) VALUES('move-file','note','move.txt','text/plain',0,'move-storage',2)",
    ).run();
    const attachmentSource = "attachment:move-file";
    const attachmentGeneration = (
      d
        .prepare("SELECT generation FROM ai_content WHERE source_key=?")
        .get(attachmentSource) as { generation: number }
    ).generation;
    d.prepare(
      "UPDATE ai_content SET owner_id='owner',item_kind='note',item_id='note',state='indexed',indexed_generation=generation,fingerprint='move-fingerprint' WHERE source_key=?",
    ).run(attachmentSource);
    d.prepare(
      "INSERT INTO ai_auto_assignments(source_key,tag_id,generation,fingerprint,approved,created_at) VALUES(?,?,?,?,0,1)",
    ).run(
      attachmentSource,
      "move-tag",
      attachmentGeneration,
      "move-fingerprint",
    );
    d.prepare(
      "INSERT INTO note_tags(note_id,tag_id) VALUES('note','move-tag')",
    ).run();
    const sourcePlan = JSON.stringify(
      d
        .prepare(
          "EXPLAIN QUERY PLAN SELECT owner_id,item_kind,item_id FROM ai_content WHERE source_key=?",
        )
        .all(attachmentSource),
    );
    assert.match(sourcePlan, /SEARCH ai_content .*source_key/);
    assert.doesNotMatch(sourcePlan, /SCAN ai_content/);
    const examplePlan = JSON.stringify(
      d
        .prepare(
          "EXPLAIN QUERY PLAN SELECT tag_id FROM ai_source_tag_examples WHERE source_key=?",
        )
        .all(attachmentSource),
    );
    assert.match(examplePlan, /SEARCH c .*source_key/);
    assert.doesNotMatch(examplePlan, /SCAN c\b/);
    d.prepare(
      "UPDATE attachments SET note_id='moved-to' WHERE id='move-file'",
    ).run();
    assert.equal(
      (
        d
          .prepare(
            "SELECT count(*) AS n FROM note_tags WHERE note_id='note' AND tag_id='move-tag'",
          )
          .get() as { n: number }
      ).n,
      0,
      "reparenting removes auto membership from the cached old parent",
    );
    assert.equal(
      (
        d
          .prepare(
            "SELECT count(*) AS n FROM note_tags WHERE note_id='moved-to' AND tag_id='move-tag'",
          )
          .get() as { n: number }
      ).n,
      0,
      "reparenting never copies the old automatic membership to the new parent",
    );
    assert.equal(
      (
        d
          .prepare(
            "SELECT count(*) AS n FROM ai_auto_assignments WHERE source_key=?",
          )
          .get(attachmentSource) as { n: number }
      ).n,
      0,
    );

    d.prepare(
      "INSERT INTO tags(id,name,color) VALUES('delete-auto-tag','Delete automatic','gray'),('delete-approved-tag','Delete approved','gray'),('delete-manual-tag','Delete manual','gray'),('delete-sibling-tag','Delete sibling','gray')",
    ).run();
    const indexAttachment = (
      id: string,
      assignments: { tagId: string; approved: 0 | 1 }[],
    ) => {
      d.prepare(
        "INSERT INTO attachments(id,note_id,name,mime,size,storage_key,created_at) VALUES(?, 'note', ?, 'text/plain', 0, ?, 3)",
      ).run(id, `${id}.txt`, `${id}-storage`);
      const sourceKey = `attachment:${id}`;
      const sourceGeneration = (
        d
          .prepare("SELECT generation FROM ai_content WHERE source_key=?")
          .get(sourceKey) as { generation: number }
      ).generation;
      const fingerprint = `${id}-fingerprint`;
      d.prepare(
        "UPDATE ai_content SET owner_id='owner',item_kind='note',item_id='note',state='indexed',indexed_generation=generation,fingerprint=? WHERE source_key=?",
      ).run(fingerprint, sourceKey);
      for (const assignment of assignments) {
        d.prepare(
          "INSERT INTO ai_auto_assignments(source_key,tag_id,generation,fingerprint,approved,created_at) VALUES(?,?,?,?,?,3)",
        ).run(
          sourceKey,
          assignment.tagId,
          sourceGeneration,
          fingerprint,
          assignment.approved,
        );
      }
      return sourceKey;
    };
    const deletedSource = indexAttachment("delete-file", [
      { tagId: "delete-auto-tag", approved: 0 },
      { tagId: "delete-approved-tag", approved: 1 },
    ]);
    for (const tagId of [
      "delete-auto-tag",
      "delete-approved-tag",
      "delete-manual-tag",
    ])
      d.prepare("INSERT INTO note_tags(note_id,tag_id) VALUES('note',?)").run(
        tagId,
      );

    d.prepare("DELETE FROM attachments WHERE id='delete-file'").run();
    assert.deepEqual(
      d
        .prepare(
          "SELECT tag_id FROM note_tags WHERE note_id='note' AND tag_id LIKE 'delete-%' ORDER BY tag_id",
        )
        .all(),
      [{ tag_id: "delete-approved-tag" }, { tag_id: "delete-manual-tag" }],
      "permanent deletion removes a sole-origin unapproved tag and keeps approved and manual tags",
    );
    assert.equal(
      (
        d
          .prepare(
            "SELECT count(*) AS n FROM ai_auto_assignments WHERE source_key=?",
          )
          .get(deletedSource) as { n: number }
      ).n,
      0,
      "both unapproved provenance and approved provenance cascade after cleanup",
    );

    const siblingTag = "delete-sibling-tag";
    const firstSibling = indexAttachment("sibling-one", [
      { tagId: siblingTag, approved: 0 },
    ]);
    const secondSibling = indexAttachment("sibling-two", [
      { tagId: siblingTag, approved: 0 },
    ]);
    d.prepare("INSERT INTO note_tags(note_id,tag_id) VALUES('note',?)").run(
      siblingTag,
    );
    d.prepare("DELETE FROM attachments WHERE id='sibling-one'").run();
    assert.equal(
      (
        d
          .prepare(
            "SELECT count(*) AS n FROM note_tags WHERE note_id='note' AND tag_id=?",
          )
          .get(siblingTag) as { n: number }
      ).n,
      1,
      "deleting one source preserves a tag still supported by a sibling source",
    );
    assert.equal(
      (
        d
          .prepare(
            "SELECT count(*) AS n FROM ai_auto_assignments WHERE source_key=?",
          )
          .get(firstSibling) as { n: number }
      ).n,
      0,
    );
    assert.equal(
      (
        d
          .prepare(
            "SELECT count(*) AS n FROM ai_auto_assignments WHERE source_key=?",
          )
          .get(secondSibling) as { n: number }
      ).n,
      1,
    );
    d.prepare("DELETE FROM attachments WHERE id='sibling-two'").run();
    assert.equal(
      (
        d
          .prepare(
            "SELECT count(*) AS n FROM note_tags WHERE note_id='note' AND tag_id=?",
          )
          .get(siblingTag) as { n: number }
      ).n,
      0,
      "deleting the final source removes its unapproved canonical tag",
    );

    const prototypeRevision = (
      d
        .prepare("SELECT revision FROM ai_tag_revisions WHERE tag_id='tag'")
        .get() as { revision: number }
    ).revision;
    d.prepare("UPDATE notes SET trashed_at=9 WHERE id='note'").run();
    assert.equal(
      (
        d
          .prepare("SELECT revision FROM ai_tag_revisions WHERE tag_id='tag'")
          .get() as { revision: number }
      ).revision,
      prototypeRevision + 1,
      "trashing a manually tagged source invalidates its example prototype",
    );

    (globalThis as { nivraSqlite?: Database.Database }).nivraSqlite = d;
    const tagId = "prototype-lifecycle";
    d.prepare(
      "INSERT INTO tags(id,name,color) VALUES(?,'Prototype lifecycle','gray')",
    ).run(tagId);
    const vectorBuffer = (axis: 0 | 1) => {
      const vector = Buffer.alloc(1536);
      vector.writeFloatLE(1, axis * 4);
      return vector;
    };
    const labelVector = new Float32Array(384);
    labelVector[0] = 1;
    const exampleVector = new Float32Array(384);
    exampleVector[1] = 1;
    const exampleBuffer = vectorBuffer(1);
    const seedTaggedNote = (noteId: string) => {
      d.prepare(
        "INSERT INTO notes(id,owner_id,title,document,text,revision,created_at,updated_at) VALUES(?,'owner',?,'[]','Prototype source fixture',1,20,20)",
      ).run(noteId, noteId);
      d.prepare("INSERT INTO note_tags(note_id,tag_id) VALUES(?,?)").run(
        noteId,
        tagId,
      );
      const sourceKey = `note:${noteId}`;
      const generation = (
        d
          .prepare("SELECT generation FROM ai_content WHERE source_key=?")
          .get(sourceKey) as { generation: number }
      ).generation;
      d.prepare(
        "UPDATE ai_content SET owner_id='owner',item_kind='note',item_id=?,state='indexed',indexed_generation=generation,model_version=?,fingerprint=? WHERE source_key=?",
      ).run(noteId, modelVersion, `${noteId}-fingerprint`, sourceKey);
      d.prepare(
        "INSERT INTO ai_chunks(source_key,ordinal,generation,model_version,title,text,embedding) VALUES(?,0,?,?,?,'Prototype fixture',?)",
      ).run(sourceKey, generation, modelVersion, noteId, exampleBuffer);
    };
    for (const noteId of [
      "prototype-one",
      "prototype-two",
      "prototype-three",
      "prototype-four",
    ])
      seedTaggedNote(noteId);
    const tagName = "Prototype lifecycle";
    d.prepare(
      "INSERT INTO ai_tag_embeddings(tag_id,model_version,tag_fingerprint,tag_name,aliases,dimensions,embedding,example_owner_id,learned_revision,example_count,example_embedding,updated_at) VALUES(?,?,? ,?,'[]',384,?,'owner',?,4,?,20)",
    ).run(
      tagId,
      modelVersion,
      "prototype-lifecycle-fingerprint",
      tagName,
      vectorBuffer(0),
      (
        d
          .prepare("SELECT revision FROM ai_tag_revisions WHERE tag_id=?")
          .get(tagId) as { revision: number }
      ).revision,
      exampleBuffer,
    );
    const prepareMatch = (ownerId = "owner") =>
      prepareAdaptiveTagMatch({
        ownerId,
        sourceKey: "task:prototype-query",
        sourceFingerprint: "prototype-query-fingerprint",
        itemKind: "task",
        itemId: "prototype-query",
        text: "unrelated query text",
        meanVector: exampleVector,
        deadline: Date.now() + 30_000,
        encode: async () => labelVector,
      });
    const readyMatch = async (ownerId = "owner") => {
      const result = await prepareMatch(ownerId);
      if (!result.ready) throw new Error("Tag matching was not ready.");
      return result;
    };
    const cachedProfile = () =>
      d
        .prepare(
          "SELECT e.embedding,e.example_owner_id,e.learned_revision,e.example_count,e.example_embedding,r.revision AS tag_revision FROM ai_tag_embeddings e JOIN ai_tag_revisions r ON r.tag_id=e.tag_id WHERE e.tag_id=?",
        )
        .get(tagId) as {
        embedding: Buffer;
        example_owner_id: string | null;
        learned_revision: number;
        example_count: number;
        example_embedding: Buffer | null;
        tag_revision: number;
      };
    assert.equal((await readyMatch()).match?.tag.id, tagId);

    d.prepare("UPDATE notes SET trashed_at=30 WHERE id='prototype-one'").run();
    assert.equal((await readyMatch()).match?.tag.id, tagId);
    assert.equal(cachedProfile().example_owner_id, "owner");
    assert.equal(cachedProfile().example_count, 3);
    assert.deepEqual(
      cachedProfile().example_embedding,
      exampleBuffer,
      "trashing one example rebuilds the profile from remaining eligible items",
    );

    d.prepare("DELETE FROM notes WHERE id='prototype-two'").run();
    assert.equal((await readyMatch()).match?.tag.id, tagId);
    assert.equal(cachedProfile().example_count, 2);

    d.prepare(
      "DELETE FROM note_tags WHERE note_id='prototype-three' AND tag_id=?",
    ).run(tagId);
    assert.equal((await readyMatch()).match?.tag.id, tagId);
    assert.equal(cachedProfile().example_count, 1);

    d.prepare("UPDATE notes SET trashed_at=31 WHERE id='prototype-four'").run();
    const afterLastExample = await readyMatch();
    assert.equal(afterLastExample.ready, true);
    assert.equal(afterLastExample.match, undefined);
    assert.equal(cachedProfile().example_owner_id, null);
    assert.equal(cachedProfile().learned_revision, 0);
    assert.equal(cachedProfile().example_count, 0);
    assert.equal(cachedProfile().example_embedding, null);
    assert.deepEqual(
      cachedProfile().embedding,
      vectorBuffer(0),
      "clearing the orphaned owner profile preserves the tag label embedding",
    );

    const currentTagRevision = cachedProfile().tag_revision;
    d.prepare(
      "UPDATE ai_tag_embeddings SET model_version=?,example_owner_id='owner',learned_revision=?,example_count=1,example_embedding=? WHERE tag_id=?",
    ).run(`${modelVersion}:previous`, currentTagRevision, exampleBuffer, tagId);
    const afterModelUpgrade = await readyMatch();
    assert.equal(
      afterModelUpgrade.match,
      undefined,
      "a model upgrade cannot reuse examples encoded in the previous model space",
    );
    assert.equal(cachedProfile().example_owner_id, null);
    assert.equal(cachedProfile().learned_revision, 0);
    assert.equal(cachedProfile().example_count, 0);
    assert.equal(cachedProfile().example_embedding, null);
    assert.deepEqual(
      cachedProfile().embedding,
      vectorBuffer(0),
      "model upgrade keeps the newly encoded label vector",
    );

    const revision = cachedProfile().tag_revision;
    d.prepare(
      "UPDATE ai_tag_embeddings SET example_owner_id='owner',learned_revision=?,example_count=1,example_embedding=? WHERE tag_id=?",
    ).run(revision, exampleBuffer, tagId);
    const otherOwnerMatch = await readyMatch("another-owner");
    assert.equal(otherOwnerMatch.match, undefined);
    assert.equal(
      cachedProfile().example_owner_id,
      null,
      "a cached vector from another owner is cleared before it can be considered",
    );
    assert.deepEqual(cachedProfile().embedding, vectorBuffer(0));
  } finally {
    delete (globalThis as { nivraSqlite?: unknown }).nivraSqlite;
    d.close();
  }
});
