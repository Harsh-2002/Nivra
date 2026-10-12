import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

test("adaptive tag proposals stay private, fence stale data, and keep automatic feedback separate", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "nivra-ai-tagging-"));
  process.env.NIVRA_DATA_DIR = directory;
  const { sqlite } = await import("../src/lib/server/db");
  const { fingerprint, sourceFor, sourceText } =
    await import("../src/lib/server/ai/content");
  const { modelVersion } = await import("../src/lib/server/ai/model");
  const {
    processIndexedTagging,
    listTagProposals,
    decideTagProposal,
    recordTagDeletion,
  } = await import("../src/lib/server/ai/tagging");
  const { aiStatus, configureAi } =
    await import("../src/lib/server/ai/service");
  const { assignItemTags, itemTagState } =
    await import("../src/lib/server/item-tags");
  const { executeContent } = await import("../src/lib/server/content-service");
  const { createTask, updateTask } = await import("../src/lib/server/tasks");
  const { HttpError } = await import("../src/lib/server/http");
  const d = sqlite();
  const owner = randomUUID();
  const now = Date.now();

  const vector = (angle: number, axis = 0) => {
    const result = new Float32Array(384);
    result[axis] = Math.cos(angle);
    result[axis + 1] = Math.sin(angle);
    return result;
  };
  const indexSource = (sourceKey: string) => {
    const source = sourceFor(sourceKey);
    assert.ok(source, `missing synthetic source ${sourceKey}`);
    const text = sourceText(source);
    const hash = fingerprint(text);
    d.prepare(
      "UPDATE ai_content SET owner_id=?,item_kind=?,item_id=?,state='indexed',indexed_generation=generation,model_version=?,fingerprint=?,pending=0 WHERE source_key=?",
    ).run(
      source.owner_id,
      source.item_kind,
      source.item_id,
      modelVersion,
      hash,
      sourceKey,
    );
    const current = sourceFor(sourceKey);
    assert.ok(current);
    return {
      sourceKey,
      generation: current.generation,
      fingerprint: hash,
      text,
      itemKind: current.item_kind as
        | "note"
        | "task"
        | "bookmark"
        | "artifact"
        | "event"
        | "form"
        | "response",
      itemId: current.item_id,
    };
  };
  const tagSource = (
    source: ReturnType<typeof indexSource>,
    meanVector: Float32Array,
    matches: {
      tagId: string;
      score: number;
      support: number;
      automaticEligible: boolean;
    }[] = [],
    learnedRevision?: number,
  ) =>
    processIndexedTagging({
      ownerId: owner,
      sourceKey: source.sourceKey,
      generation: source.generation,
      fingerprint: source.fingerprint,
      itemKind: source.itemKind,
      itemId: source.itemId,
      text: source.text,
      meanVector,
      matches,
      learnedRevision:
        learnedRevision ??
        (
          d
            .prepare(
              "SELECT learned_tag_revision FROM ai_configuration WHERE id=1",
            )
            .get() as {
            learned_tag_revision: number;
          }
        ).learned_tag_revision,
    });

  try {
    d.prepare(
      "INSERT INTO user(id,name,email,username,created_at,updated_at) VALUES(?,?,?,?,?,?)",
    ).run(
      owner,
      "Synthetic AI owner",
      `${owner}@example.test`,
      owner,
      now,
      now,
    );
    d.prepare("UPDATE ai_configuration SET enabled=1").run();
    assert.equal(aiStatus(owner).taggingMode, "manual");

    const patchNote = async (
      id: string,
      revision: number,
      text: string,
      tags: string[],
    ) => {
      const response = await executeContent({
        ownerId: owner,
        origin: "http://localhost:3000",
        path: ["notes", id],
        method: "PATCH",
        input: {
          revision,
          document: {
            schemaVersion: 1,
            blocks: [
              {
                type: "paragraph",
                content: [{ type: "text", text }],
              },
            ],
          },
          tags,
        },
      });
      assert.ok("data" in response);
      return response.data;
    };

    const diverseNotes = [
      [
        "Fermentation — kombucha jar",
        "The fermentation culture stays steady while kombucha develops a tart aroma.",
      ],
      [
        "Fermentation — sourdough starter",
        "A fermentation schedule keeps sourdough starter active through cool nights.",
      ],
      [
        "Fermentation — cabbage crock",
        "Slow fermentation gives cabbage a crisp texture and a bright flavor.",
      ],
    ];
    const noteIds: string[] = [];
    for (const [index, [title, text]] of diverseNotes.entries()) {
      const id = randomUUID();
      noteIds.push(id);
      d.prepare(
        "INSERT INTO notes(id,owner_id,title,document,text,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
      ).run(
        id,
        owner,
        title,
        '{"schemaVersion":1,"blocks":[]}',
        text,
        now,
        now,
      );

      const source = indexSource(`note:${id}`);
      assert.equal(tagSource(source, vector(index * 0.03)), "processed");
      assert.equal(itemTagState(owner, "note", id).tags.length, 0);
    }
    const initialProposals = listTagProposals(owner).items;
    assert.equal(initialProposals.length, 1);
    assert.match(initialProposals[0].name, /fermentation/u);
    assert.equal(initialProposals[0].itemCount, 3);
    assert.equal(initialProposals[0].items.length, 3);
    assert.ok(!JSON.stringify(initialProposals).includes("embedding"));
    const proposalId = initialProposals[0].id;
    assert.deepEqual(listTagProposals(randomUUID()).items, []);
    assert.throws(
      () => decideTagProposal(randomUUID(), proposalId, "accepted"),
      (error: unknown) => error instanceof HttpError && error.status === 409,
    );

    const correctionTagId = randomUUID();
    d.prepare("INSERT INTO tags(id,name,color) VALUES(?,?,'gray')").run(
      correctionTagId,
      "Manual correction",
    );
    const correctedSource = indexSource(`note:${noteIds[0]}`);
    d.prepare(
      "INSERT INTO ai_decisions(source_key,fingerprint,tag_id,tag_fingerprint,decision,created_at) VALUES(?,?,?,?,?,?)",
    ).run(
      correctedSource.sourceKey,
      correctedSource.fingerprint,
      correctionTagId,
      fingerprint("manual correction"),
      "rejected",
      now,
    );
    assert.deepEqual(
      listTagProposals(owner).items,
      [],
      "same-fingerprint owner corrections remove that source from proposal evidence",
    );
    assert.throws(
      () => decideTagProposal(owner, proposalId, "accepted"),
      (error: unknown) => error instanceof HttpError && error.status === 409,
    );
    d.prepare(
      "DELETE FROM ai_decisions WHERE source_key=? AND fingerprint=? AND tag_id=? AND decision='rejected'",
    ).run(
      correctedSource.sourceKey,
      correctedSource.fingerprint,
      correctionTagId,
    );
    assert.equal(listTagProposals(owner).items[0]?.itemCount, 3);

    const taggedNote = itemTagState(owner, "note", noteIds[1]);
    assignItemTags(owner, "note", noteIds[1], taggedNote.revision, [
      correctionTagId,
    ]);
    assert.deepEqual(
      listTagProposals(owner).items,
      [],
      "a source currently assigned an existing tag is excluded from new-tag evidence",
    );
    assert.throws(
      () => decideTagProposal(owner, proposalId, "accepted"),
      (error: unknown) => error instanceof HttpError && error.status === 409,
    );
    const untaggedNote = itemTagState(owner, "note", noteIds[1]);
    assignItemTags(owner, "note", noteIds[1], untaggedNote.revision, []);
    const taggedSource = indexSource(`note:${noteIds[1]}`);
    d.prepare(
      "DELETE FROM ai_decisions WHERE source_key=? AND fingerprint=? AND tag_id=? AND decision='rejected'",
    ).run(taggedSource.sourceKey, taggedSource.fingerprint, correctionTagId);
    assert.equal(
      listTagProposals(owner).items[0]?.itemCount,
      3,
      "removing the correction restores only current, eligible evidence",
    );

    const staleInput = indexSource(`note:${noteIds[0]}`);
    const currentLearnedRevision = (
      d
        .prepare("SELECT learned_tag_revision FROM ai_configuration WHERE id=1")
        .get() as { learned_tag_revision: number }
    ).learned_tag_revision;
    assert.equal(
      tagSource(staleInput, vector(0), [], currentLearnedRevision - 1),
      "stale",
    );
    assert.deepEqual(decideTagProposal(owner, proposalId, "rejected"), {
      ok: true,
    });
    const rejection = d
      .prepare(
        "SELECT status,cooldown_until FROM ai_tag_proposals WHERE id=? AND owner_id=?",
      )
      .get(proposalId, owner) as {
      status: string;
      cooldown_until: number;
    };
    assert.equal(rejection.status, "rejected");
    assert.ok(rejection.cooldown_until > Date.now());
    d.prepare("DELETE FROM ai_tag_proposal_evidence WHERE proposal_id=?").run(
      proposalId,
    );
    d.prepare("UPDATE ai_tag_proposals SET cooldown_until=0 WHERE id=?").run(
      proposalId,
    );
    for (let index = 0; index < 3; index++) {
      const id = randomUUID();
      d.prepare(
        "INSERT INTO notes(id,owner_id,title,document,text,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
      ).run(
        id,
        owner,
        `Fermentation — fresh starter ${index}`,
        '{"schemaVersion":1,"blocks":[]}',
        `The fermentation plan describes a fresh sourdough starter with patient feeding and a steady culture. Batch ${index} uses local flour.`,
        now + 10 + index,
        now + 10 + index,
      );
      assert.equal(
        tagSource(indexSource(`note:${id}`), vector(index * 0.01)),
        "processed",
      );
    }
    const reused = listTagProposals(owner).items.find(
      (item) => item.id === proposalId,
    );
    assert.ok(reused, "an expired rejection reuses its proposal row");
    assert.equal(reused.itemCount, 3);

    const reviewedResponseIds: string[] = [];
    for (let index = 0; index < 4; index++) {
      const formId = randomUUID();
      const versionId = randomUUID();
      const responseId = randomUUID();
      d.prepare(
        "INSERT INTO forms(id,owner_id,title,description,definition,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
      ).run(
        formId,
        owner,
        `Private apiary intake ${index}`,
        "",
        '{"title":"","description":"","confirmation":"Received","fields":[]}',
        now + index,
        now + index,
      );
      d.prepare(
        "INSERT INTO form_versions(id,form_id,revision,definition,created_at) VALUES(?,?,?,?,?)",
      ).run(
        versionId,
        formId,
        1,
        '{"title":"","description":"","confirmation":"Received","fields":[]}',
        now + index,
      );
      d.prepare(
        "INSERT INTO form_responses(id,form_id,version_id,answers,search_text,retry_key,request_hash,reviewed,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
      ).run(
        responseId,
        formId,
        versionId,
        "{}",
        `Apiary intake describes pollen handling and hive care for private response ${index}.`,
        `retry-${responseId}`,
        `hash-${responseId}`,
        Number(index > 0),
        now + index,
      );
      const indexed = indexSource(`response:${responseId}`);
      if (index === 0) {
        assert.equal(tagSource(indexed, vector(0, 2)), "stale");
        assert.equal(
          (
            d
              .prepare(
                "SELECT count(*) AS n FROM ai_tag_proposal_evidence WHERE source_key=?",
              )
              .get(indexed.sourceKey) as { n: number }
          ).n,
          0,
        );
      } else {
        reviewedResponseIds.push(responseId);
        assert.equal(
          tagSource(indexed, vector(Math.PI / 2 + index * 0.02, 2)),
          "processed",
        );
      }
    }
    const responseProposal = listTagProposals(owner).items.find((item) =>
      item.items.some((source) => source.type === "response"),
    );
    assert.ok(responseProposal);
    assert.equal(responseProposal.itemCount, 3);
    assert.ok(responseProposal.items.every((item) => item.formId));
    assert.ok(
      responseProposal.items.every((item) =>
        reviewedResponseIds.includes(item.itemId),
      ),
    );
    const responseProposalId = responseProposal.id;
    d.prepare("UPDATE form_responses SET reviewed=0 WHERE id=?").run(
      reviewedResponseIds[0],
    );
    assert.equal(
      listTagProposals(owner).items.some(
        (item) => item.id === responseProposalId,
      ),
      false,
    );
    assert.throws(
      () => decideTagProposal(owner, responseProposalId, "accepted"),
      (error: unknown) => error instanceof HttpError && error.status === 409,
    );
    d.prepare("UPDATE form_responses SET reviewed=1 WHERE id=?").run(
      reviewedResponseIds[0],
    );
    assert.ok(
      listTagProposals(owner).items.some(
        (item) => item.id === responseProposalId,
      ),
    );
    d.prepare("UPDATE form_responses SET trashed_at=? WHERE id=?").run(
      now + 100,
      reviewedResponseIds[1],
    );
    assert.equal(
      listTagProposals(owner).items.some(
        (item) => item.id === responseProposalId,
      ),
      false,
    );
    assert.throws(
      () => decideTagProposal(owner, responseProposalId, "accepted"),
      (error: unknown) => error instanceof HttpError && error.status === 409,
    );

    const indexedBeforeModeChange = (
      d
        .prepare(
          "SELECT count(*) AS n FROM ai_content c JOIN ai_sources s USING(source_key) WHERE s.owner_id=? AND s.active=1 AND c.state='indexed'",
        )
        .get(owner) as { n: number }
    ).n;
    const chunksBeforeModeChange = (
      d.prepare("SELECT count(*) AS n FROM ai_chunks").get() as { n: number }
    ).n;
    const automaticStatus = await configureAi(
      owner,
      false,
      aiStatus(owner).revision,
      "automatic",
    );
    assert.equal(automaticStatus.taggingMode, "automatic");
    assert.equal(automaticStatus.enabled, false);
    assert.equal(
      (
        d
          .prepare(
            "SELECT count(*) AS n FROM ai_content c JOIN ai_sources s USING(source_key) WHERE s.owner_id=? AND s.active=1 AND c.state='indexed' AND c.pending=1",
          )
          .get(owner) as { n: number }
      ).n,
      indexedBeforeModeChange,
    );
    assert.equal(
      (d.prepare("SELECT count(*) AS n FROM ai_chunks").get() as { n: number })
        .n,
      chunksBeforeModeChange,
      "changing mode queues existing indexes without discarding stored vectors",
    );
    d.prepare("UPDATE ai_configuration SET enabled=1").run();
    const existingTagId = randomUUID();
    const automaticItemId = randomUUID();
    d.prepare(
      "INSERT INTO tags(id,name,color,aliases) VALUES(?,?,'gray','[]')",
    ).run(existingTagId, "Gardening");
    const snapshotDocument = {
      schemaVersion: 1,
      blocks: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Content before the ordinary save." },
          ],
        },
      ],
    };
    d.prepare(
      "INSERT INTO notes(id,owner_id,title,document,text,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
    ).run(
      automaticItemId,
      owner,
      "Garden beds",
      JSON.stringify(snapshotDocument),
      "Garden beds need compost and careful watering.",
      now + 20,
      123,
    );
    const automaticSource = indexSource(`note:${automaticItemId}`);
    const beforeAutoEpoch = (
      d
        .prepare("SELECT learned_tag_revision FROM ai_configuration WHERE id=1")
        .get() as { learned_tag_revision: number }
    ).learned_tag_revision;
    assert.equal(
      tagSource(automaticSource, vector(0), [
        {
          tagId: existingTagId,
          score: 0.95,
          support: 2,
          automaticEligible: true,
        },
      ]),
      "processed",
    );
    assert.deepEqual(
      itemTagState(owner, "note", automaticItemId).tags.map((tag) => tag.id),
      [existingTagId],
    );
    assert.deepEqual(
      d
        .prepare(
          "SELECT approved FROM ai_auto_assignments WHERE source_key=? AND tag_id=?",
        )
        .get(automaticSource.sourceKey, existingTagId),
      { approved: 0 },
    );
    assert.equal(
      tagSource(automaticSource, vector(0), []),
      "processed",
      "an assigned item does not fall back to new-tag evidence after its match is filtered",
    );
    assert.equal(
      (
        d
          .prepare(
            "SELECT count(*) AS n FROM ai_tag_proposal_evidence WHERE source_key=?",
          )
          .get(automaticSource.sourceKey) as { n: number }
      ).n,
      0,
    );
    assert.equal(
      (
        d
          .prepare("SELECT updated_at FROM notes WHERE id=?")
          .get(automaticItemId) as {
          updated_at: number;
        }
      ).updated_at,
      123,
    );
    assert.equal(
      (
        d
          .prepare(
            "SELECT learned_tag_revision FROM ai_configuration WHERE id=1",
          )
          .get() as { learned_tag_revision: number }
      ).learned_tag_revision,
      beforeAutoEpoch,
    );
    const automaticRevision = itemTagState(
      owner,
      "note",
      automaticItemId,
    ).revision;
    assignItemTags(owner, "note", automaticItemId, automaticRevision, []);
    assert.ok(
      d
        .prepare(
          "SELECT 1 FROM ai_decisions WHERE source_key=? AND tag_id=? AND decision='rejected'",
        )
        .get(automaticSource.sourceKey, existingTagId),
    );
    const fallbackTagId = randomUUID();
    d.prepare("INSERT INTO tags(id,name,color) VALUES(?,?,'gray')").run(
      fallbackTagId,
      "Rejected-source alternate",
    );
    const rejectedSource = indexSource(`note:${automaticItemId}`);
    assert.equal(
      tagSource(rejectedSource, vector(0), [
        {
          tagId: fallbackTagId,
          score: 0.99,
          support: 3,
          automaticEligible: true,
        },
      ]),
      "processed",
    );
    assert.equal(
      d
        .prepare("SELECT 1 FROM note_tags WHERE note_id=? AND tag_id=?")
        .get(automaticItemId, fallbackTagId),
      undefined,
      "a same-fingerprint rejection suppresses a raced alternate auto-assignment",
    );
    const rejectedRevision = itemTagState(
      owner,
      "note",
      automaticItemId,
    ).revision;
    assignItemTags(owner, "note", automaticItemId, rejectedRevision, [
      existingTagId,
    ]);
    assert.deepEqual(
      d
        .prepare(
          "SELECT approved FROM ai_auto_assignments WHERE source_key=? AND tag_id=?",
        )
        .get(automaticSource.sourceKey, existingTagId),
      { approved: 1 },
    );
    assert.ok(
      d
        .prepare(
          "SELECT 1 FROM ai_decisions WHERE source_key=? AND tag_id=? AND decision='accepted'",
        )
        .get(automaticSource.sourceKey, existingTagId),
    );
    assert.equal(
      d
        .prepare(
          "SELECT 1 FROM ai_decisions WHERE source_key=? AND tag_id=? AND decision='rejected'",
        )
        .get(automaticSource.sourceKey, existingTagId),
      undefined,
    );
    assert.ok(
      (
        d
          .prepare(
            "SELECT learned_tag_revision FROM ai_configuration WHERE id=1",
          )
          .get() as { learned_tag_revision: number }
      ).learned_tag_revision > beforeAutoEpoch,
    );

    const addAutomaticNoteTag = (
      source: ReturnType<typeof indexSource>,
      tagId: string,
      approved = 0,
    ) => {
      d.prepare(
        "INSERT INTO ai_auto_assignments(source_key,tag_id,generation,fingerprint,approved,created_at) VALUES(?,?,?,?,?,?)",
      ).run(
        source.sourceKey,
        tagId,
        source.generation,
        source.fingerprint,
        approved,
        Date.now(),
      );
      d.prepare("INSERT INTO note_tags(note_id,tag_id) VALUES(?,?)").run(
        source.itemId,
        tagId,
      );
    };
    const noteRevision = (id: string) =>
      (
        d.prepare("SELECT revision FROM notes WHERE id=?").get(id) as {
          revision: number;
        }
      ).revision;
    const contentEvents = (id: string) =>
      (
        d
          .prepare(
            "SELECT count(*) AS n FROM completion_events WHERE owner_id=? AND kind='content' AND target_id=?",
          )
          .get(owner, id) as { n: number }
      ).n;

    const snapshotItem = randomUUID();
    const snapshotTag = randomUUID();
    d.prepare("INSERT INTO tags(id,name,color) VALUES(?,?,'gray')").run(
      snapshotTag,
      "Unchanged automatic snapshot tag",
    );
    d.prepare(
      "INSERT INTO notes(id,owner_id,title,document,text,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
    ).run(
      snapshotItem,
      owner,
      "Ordinary snapshot save",
      '{"schemaVersion":1,"blocks":[]}',
      "Content before the ordinary save.",
      now + 20,
      now + 20,
    );
    const snapshotSource = indexSource(`note:${snapshotItem}`);
    addAutomaticNoteTag(snapshotSource, snapshotTag);
    d.prepare(
      "UPDATE ai_content SET state='pending',pending=1 WHERE source_key=?",
    ).run(snapshotSource.sourceKey);
    const snapshotTags = [snapshotTag];
    assert.deepEqual(
      d
        .prepare(
          "SELECT approved FROM ai_auto_assignments WHERE source_key=? AND tag_id=?",
        )
        .get(snapshotSource.sourceKey, snapshotTag),
      { approved: 0 },
      "an unchanged tag snapshot does not approve automatic provenance",
    );
    await patchNote(
      snapshotItem,
      noteRevision(snapshotItem),
      "Updated content after the ordinary save.",
      snapshotTags,
    );
    assert.deepEqual(
      d
        .prepare("SELECT tag_id FROM note_tags WHERE note_id=?")
        .all(snapshotItem),
      [],
      "post-update tag reconciliation does not reinsert a stale automatic tag removed by generation cleanup",
    );

    const readdedItem = randomUUID();
    const readdedTag = randomUUID();
    d.prepare("INSERT INTO tags(id,name,color) VALUES(?,?,'gray')").run(
      readdedTag,
      "Readded automatic tag",
    );
    d.prepare(
      "INSERT INTO notes(id,owner_id,title,document,text,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
    ).run(
      readdedItem,
      owner,
      "Explicitly readded automatic tag",
      '{"schemaVersion":1,"blocks":[]}',
      "Content before readding the tag.",
      now + 20,
      now + 20,
    );
    const readdedSource = indexSource(`note:${readdedItem}`);
    addAutomaticNoteTag(readdedSource, readdedTag);
    d.prepare(
      "UPDATE ai_content SET state='pending',pending=1 WHERE source_key=?",
    ).run(readdedSource.sourceKey);
    d.prepare("DELETE FROM note_tags WHERE note_id=? AND tag_id=?").run(
      readdedItem,
      readdedTag,
    );
    await patchNote(
      readdedItem,
      noteRevision(readdedItem),
      "Updated content with an explicit tag addition.",
      [readdedTag],
    );
    assert.deepEqual(
      d
        .prepare(
          "SELECT approved FROM ai_auto_assignments WHERE source_key=? AND tag_id=?",
        )
        .get(readdedSource.sourceKey, readdedTag),
      { approved: 1 },
      "an explicit readdition approves stale provenance even while indexing is pending",
    );
    assert.deepEqual(
      d
        .prepare("SELECT tag_id FROM note_tags WHERE note_id=?")
        .all(readdedItem),
      [{ tag_id: readdedTag }],
    );

    const removedItem = randomUUID();
    const removedTag = randomUUID();
    d.prepare("INSERT INTO tags(id,name,color) VALUES(?,?,'gray')").run(
      removedTag,
      "Explicitly removed tag",
    );
    d.prepare(
      "INSERT INTO notes(id,owner_id,title,document,text,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
    ).run(
      removedItem,
      owner,
      "Explicitly removed tag source",
      '{"schemaVersion":1,"blocks":[]}',
      "Current content for recording the removal decision.",
      now + 20,
      now + 20,
    );
    const removedSource = indexSource(`note:${removedItem}`);
    d.prepare("INSERT INTO note_tags(note_id,tag_id) VALUES(?,?)").run(
      removedItem,
      removedTag,
    );
    await patchNote(
      removedItem,
      noteRevision(removedItem),
      "Content after explicit tag removal.",
      [],
    );
    assert.ok(
      d
        .prepare(
          "SELECT 1 FROM ai_decisions WHERE source_key=? AND fingerprint=? AND tag_id=? AND decision='rejected'",
        )
        .get(removedSource.sourceKey, removedSource.fingerprint, removedTag),
      "an explicit tag removal is recorded against a valid current fingerprint",
    );

    const invalidatedTag = randomUUID();
    const editedItem = randomUUID();
    d.prepare("INSERT INTO tags(id,name,color) VALUES(?,?,'gray')").run(
      invalidatedTag,
      "Edited automatic tag",
    );
    d.prepare(
      "INSERT INTO notes(id,owner_id,title,document,text,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
    ).run(
      editedItem,
      owner,
      "Original automatic source",
      '{"schemaVersion":1,"blocks":[]}',
      "Original source text.",
      now + 21,
      now + 21,
    );
    const editedSource = indexSource(`note:${editedItem}`);
    addAutomaticNoteTag(editedSource, invalidatedTag);
    const editedRevision = noteRevision(editedItem);
    const editEvents = contentEvents(editedItem);
    d.prepare("UPDATE notes SET text=? WHERE id=?").run(
      "Changed source text.",
      editedItem,
    );
    assert.equal(
      (
        d
          .prepare(
            "SELECT count(*) AS n FROM note_tags WHERE note_id=? AND tag_id=?",
          )
          .get(editedItem, invalidatedTag) as { n: number }
      ).n,
      0,
      "editing the source removes its unapproved automatic membership",
    );
    assert.equal(
      (
        d
          .prepare(
            "SELECT count(*) AS n FROM ai_auto_assignments WHERE source_key=?",
          )
          .get(editedSource.sourceKey) as { n: number }
      ).n,
      0,
    );
    assert.equal(noteRevision(editedItem), editedRevision + 1);
    assert.equal(contentEvents(editedItem), editEvents + 1);

    const trackedTask = createTask(owner, "Task before AI cleanup");
    const trackedTaskSource = indexSource(`task:${trackedTask.id}`);
    const taskAutoTagId = randomUUID();
    d.prepare("INSERT INTO tags(id,name,color) VALUES(?,?,'gray')").run(
      taskAutoTagId,
      "Task source automatic tag",
    );
    d.prepare(
      "INSERT INTO ai_auto_assignments(source_key,tag_id,generation,fingerprint,approved,created_at) VALUES(?,?,?,?,0,?)",
    ).run(
      trackedTaskSource.sourceKey,
      taskAutoTagId,
      trackedTaskSource.generation,
      trackedTaskSource.fingerprint,
      Date.now(),
    );
    d.prepare("INSERT INTO task_tags(task_id,tag_id) VALUES(?,?)").run(
      trackedTask.id,
      taskAutoTagId,
    );
    const trackedUpdate = updateTask(owner, trackedTask.id, {
      revision: trackedTask.revision,
      title: "Task after AI cleanup",
    });
    const storedTaskRevision = (
      d
        .prepare("SELECT revision FROM tasks WHERE id=?")
        .get(trackedTask.id) as {
        revision: number;
      }
    ).revision;
    assert.equal(trackedUpdate.revision, storedTaskRevision);
    assert.ok(
      storedTaskRevision > trackedTask.revision + 1,
      "trigger cleanup may advance the task revision after its title update",
    );
    assert.deepEqual(itemTagState(owner, "task", trackedTask.id).tags, []);

    const siblingTag = randomUUID();
    const siblingItem = randomUUID();
    const attachmentId = randomUUID();
    d.prepare("INSERT INTO tags(id,name,color) VALUES(?,?,'gray')").run(
      siblingTag,
      "Sibling source tag",
    );
    d.prepare(
      "INSERT INTO notes(id,owner_id,title,document,text,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
    ).run(
      siblingItem,
      owner,
      "Parent and attachment",
      JSON.stringify({ schemaVersion: 1, blocks: [], attachmentId }),
      "Parent source remains unchanged.",
      now + 22,
      now + 22,
    );
    d.prepare(
      "INSERT INTO attachments(id,note_id,name,mime,size,storage_key,created_at) VALUES(?,?,?,'text/plain',0,?,?)",
    ).run(
      attachmentId,
      siblingItem,
      "source.txt",
      `attachment-${attachmentId}`,
      now + 22,
    );
    const parentSource = indexSource(`note:${siblingItem}`);
    const attachmentSource = indexSource(`attachment:${attachmentId}`);
    addAutomaticNoteTag(parentSource, siblingTag);
    d.prepare(
      "INSERT INTO ai_auto_assignments(source_key,tag_id,generation,fingerprint,approved,created_at) VALUES(?,?,?,?,0,?)",
    ).run(
      attachmentSource.sourceKey,
      siblingTag,
      attachmentSource.generation,
      attachmentSource.fingerprint,
      Date.now(),
    );
    const siblingRevision = noteRevision(siblingItem);
    const siblingEvents = contentEvents(siblingItem);
    d.prepare("UPDATE attachments SET name=? WHERE id=?").run(
      "renamed source.txt",
      attachmentId,
    );
    assert.equal(
      (
        d
          .prepare(
            "SELECT count(*) AS n FROM ai_auto_assignments WHERE source_key=?",
          )
          .get(attachmentSource.sourceKey) as { n: number }
      ).n,
      0,
    );
    assert.equal(
      (
        d
          .prepare(
            "SELECT count(*) AS n FROM note_tags WHERE note_id=? AND tag_id=?",
          )
          .get(siblingItem, siblingTag) as { n: number }
      ).n,
      1,
      "an attachment edit preserves its parent tag while the parent source remains current",
    );
    assert.equal(noteRevision(siblingItem), siblingRevision);
    assert.equal(contentEvents(siblingItem), siblingEvents);
    d.prepare("UPDATE notes SET document=? WHERE id=?").run(
      '{"schemaVersion":1,"blocks":[]}',
      siblingItem,
    );
    assert.equal(
      (
        d
          .prepare(
            "SELECT count(*) AS n FROM note_tags WHERE note_id=? AND tag_id=?",
          )
          .get(siblingItem, siblingTag) as { n: number }
      ).n,
      0,
      "removing the attachment and invalidating its parent source removes the last unapproved assignment",
    );
    assert.equal(contentEvents(siblingItem), siblingEvents + 1);

    const trashedTag = randomUUID();
    const trashedItem = randomUUID();
    d.prepare("INSERT INTO tags(id,name,color) VALUES(?,?,'gray')").run(
      trashedTag,
      "Trashed automatic tag",
    );
    d.prepare(
      "INSERT INTO notes(id,owner_id,title,document,text,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
    ).run(
      trashedItem,
      owner,
      "Trashed automatic source",
      '{"schemaVersion":1,"blocks":[]}',
      "Source slated for trash.",
      now + 23,
      now + 23,
    );
    const trashedSource = indexSource(`note:${trashedItem}`);
    addAutomaticNoteTag(trashedSource, trashedTag);
    const trashedRevision = noteRevision(trashedItem);
    const trashEvents = contentEvents(trashedItem);
    d.prepare("UPDATE notes SET trashed_at=? WHERE id=?").run(
      now + 24,
      trashedItem,
    );
    assert.equal(
      (
        d
          .prepare(
            "SELECT count(*) AS n FROM note_tags WHERE note_id=? AND tag_id=?",
          )
          .get(trashedItem, trashedTag) as { n: number }
      ).n,
      0,
    );
    assert.equal(noteRevision(trashedItem), trashedRevision + 1);
    assert.equal(contentEvents(trashedItem), trashEvents + 1);
    d.prepare("UPDATE notes SET trashed_at=NULL WHERE id=?").run(trashedItem);
    assert.equal(
      (
        d
          .prepare(
            "SELECT count(*) AS n FROM note_tags WHERE note_id=? AND tag_id=?",
          )
          .get(trashedItem, trashedTag) as { n: number }
      ).n,
      0,
      "restoring a source does not restore a stale automatic membership",
    );

    const approvedTag = randomUUID();
    const approvedItem = randomUUID();
    d.prepare("INSERT INTO tags(id,name,color) VALUES(?,?,'gray')").run(
      approvedTag,
      "Approved automatic tag",
    );
    d.prepare(
      "INSERT INTO notes(id,owner_id,title,document,text,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
    ).run(
      approvedItem,
      owner,
      "Approved source",
      '{"schemaVersion":1,"blocks":[]}',
      "A source with an approved tag.",
      now + 25,
      now + 25,
    );
    const approvedSource = indexSource(`note:${approvedItem}`);
    addAutomaticNoteTag(approvedSource, approvedTag, 1);
    d.prepare("UPDATE notes SET text=? WHERE id=?").run(
      "Edited approved source.",
      approvedItem,
    );
    assert.equal(
      (
        d
          .prepare(
            "SELECT count(*) AS n FROM note_tags WHERE note_id=? AND tag_id=?",
          )
          .get(approvedItem, approvedTag) as { n: number }
      ).n,
      1,
      "approved automatic memberships survive source-generation changes",
    );

    const createCluster = (name: string, axis: number, baseTime: number) => {
      const ids: string[] = [];
      for (let index = 0; index < 3; index++) {
        const id = randomUUID();
        ids.push(id);
        d.prepare(
          "INSERT INTO notes(id,owner_id,title,document,text,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
        ).run(
          id,
          owner,
          `${name} field notes ${index}`,
          '{"schemaVersion":1,"blocks":[]}',
          `${name} field notes ${index} record careful ${name} practice, useful materials, and repeatable observations.`,
          baseTime + index,
          baseTime + index,
        );
        assert.equal(
          tagSource(indexSource(`note:${id}`), vector(index * 0.02, axis)),
          "processed",
        );
      }
      return ids;
    };
    const autoNewItemIds = createCluster("Mycology", 8, now + 40);
    const created = d
      .prepare(
        "SELECT t.id,t.name,t.color,p.status,p.created_tag_id FROM ai_tag_proposals p JOIN tags t ON t.id=p.created_tag_id WHERE p.owner_id=? AND p.status='automatic'",
      )
      .all(owner) as {
      id: string;
      name: string;
      color: string;
      status: string;
      created_tag_id: string;
    }[];
    assert.equal(created.length, 1);
    assert.match(created[0].name, /mycology/u);
    assert.equal(created[0].color, "gray");
    assert.equal(
      (
        d
          .prepare(
            "SELECT count(*) AS n FROM ai_auto_assignments WHERE tag_id=? AND approved=0",
          )
          .get(created[0].id) as { n: number }
      ).n,
      3,
    );
    assert.ok(
      autoNewItemIds.every((id) =>
        itemTagState(owner, "note", id).tags.some(
          (tag) => tag.id === created[0].id,
        ),
      ),
    );

    const botanyIds = createCluster("Botany", 9, now + 50);
    createCluster("Astronomy", 10, now + 60);
    const automaticBeforeDelete = d
      .prepare(
        "SELECT count(*) AS n FROM ai_tag_proposals WHERE owner_id=? AND status='automatic' AND reviewed_at>=?",
      )
      .get(owner, new Date(new Date().setUTCHours(0, 0, 0, 0)).getTime()) as {
      n: number;
    };
    assert.equal(automaticBeforeDelete.n, 3);

    const deletedAutoTag = created[0];
    d.prepare("UPDATE tags SET name=?,aliases=? WHERE id=?").run(
      "Fungal research",
      '["basidiomycetes"]',
      deletedAutoTag.id,
    );
    const deletion = d.transaction(() => {
      const result = recordTagDeletion(owner, deletedAutoTag.id);
      d.prepare("DELETE FROM tags WHERE id=?").run(deletedAutoTag.id);
      return result;
    })();
    assert.ok(deletion.tombstones >= 2);
    const deletedAutoProposal = d
      .prepare(
        "SELECT status,created_tag_id FROM ai_tag_proposals WHERE owner_id=? AND name_fingerprint=?",
      )
      .get(owner, fingerprint(created[0].name)) as {
      status: string;
      created_tag_id: string | null;
    };
    assert.equal(deletedAutoProposal.status, "automatic");
    assert.equal(deletedAutoProposal.created_tag_id, null);
    for (const name of ["fungal research", "basidiomycetes"]) {
      const tombstone = d
        .prepare(
          "SELECT status,cooldown_until FROM ai_tag_proposals WHERE owner_id=? AND name=?",
        )
        .get(owner, name) as {
        status: string;
        cooldown_until: number;
      };
      assert.equal(tombstone.status, "rejected");
      assert.ok(tombstone.cooldown_until > Date.now());
    }

    const lichenIds = createCluster("Lichenology", 11, now + 70);
    assert.ok(
      lichenIds.every((id) =>
        itemTagState(owner, "note", id).tags.every(
          (tag) => !/lichenology/iu.test(tag.name),
        ),
      ),
    );
    assert.equal(
      (
        d
          .prepare(
            "SELECT count(*) AS n FROM ai_tag_proposals WHERE owner_id=? AND status='automatic' AND reviewed_at>=?",
          )
          .get(
            owner,
            new Date(new Date().setUTCHours(0, 0, 0, 0)).getTime(),
          ) as { n: number }
      ).n,
      3,
      "deleting a new automatic tag does not free its daily creation slot",
    );
    assert.ok(
      listTagProposals(owner).items.some((item) =>
        /lichenology/iu.test(item.name),
      ),
    );

    const botanyTag = itemTagState(owner, "note", botanyIds[0]).tags[0];
    assert.ok(botanyTag);
    const manualStatus = await configureAi(
      owner,
      false,
      aiStatus(owner).revision,
      "manual",
    );
    assert.equal(manualStatus.taggingMode, "manual");
    assert.ok(
      itemTagState(owner, "note", botanyIds[0]).tags.some(
        (tag) => tag.id === botanyTag.id,
      ),
      "switching back to manual leaves already assigned tags in place",
    );

    const decisionSourceId = randomUUID();
    d.prepare(
      "INSERT INTO notes(id,owner_id,title,document,text,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
    ).run(
      decisionSourceId,
      owner,
      "Decision retention source",
      '{"schemaVersion":1,"blocks":[]}',
      "Current decision retention content.",
      Date.now(),
      Date.now(),
    );
    const decisionSource = indexSource(`note:${decisionSourceId}`);
    const addDecision = d.prepare(
      "INSERT INTO ai_decisions(source_key,fingerprint,tag_id,tag_fingerprint,decision,created_at) VALUES(?,?,?,?,?,?)",
    );
    const decisionTagId = randomUUID();
    const obsoleteFingerprint = fingerprint("superseded decision source");
    for (let index = 0; index < 140; index++)
      addDecision.run(
        decisionSource.sourceKey,
        obsoleteFingerprint,
        decisionTagId,
        `old-tag-${index}`,
        "accepted",
        Date.now(),
      );
    const decisionCount = (sourceFingerprint: string) =>
      (
        d
          .prepare(
            "SELECT count(*) AS n FROM ai_decisions WHERE source_key=? AND fingerprint=?",
          )
          .get(decisionSource.sourceKey, sourceFingerprint) as { n: number }
      ).n;
    assert.equal(
      decisionCount(obsoleteFingerprint),
      128,
      "obsolete source feedback is capped per source",
    );
    for (let index = 0; index < 140; index++)
      addDecision.run(
        decisionSource.sourceKey,
        decisionSource.fingerprint,
        decisionTagId,
        `current-tag-${index}`,
        "accepted",
        Date.now(),
      );
    assert.equal(
      decisionCount(decisionSource.fingerprint),
      140,
      "all current-fingerprint corrections survive the obsolete-history cap",
    );
    const deletedCorrectionTag = randomUUID();
    d.prepare("INSERT INTO tags(id,name,color) VALUES(?,?,'gray')").run(
      deletedCorrectionTag,
      "Deleted correction tag",
    );
    addDecision.run(
      decisionSource.sourceKey,
      decisionSource.fingerprint,
      deletedCorrectionTag,
      fingerprint("deleted correction tag"),
      "rejected",
      Date.now(),
    );
    d.prepare("DELETE FROM tags WHERE id=?").run(deletedCorrectionTag);
    assert.ok(
      d
        .prepare(
          "SELECT 1 FROM ai_decisions WHERE source_key=? AND fingerprint=? AND tag_id=? AND decision='rejected'",
        )
        .get(
          decisionSource.sourceKey,
          decisionSource.fingerprint,
          deletedCorrectionTag,
        ),
      "a current-fingerprint rejection remains after its tag is deleted",
    );
    const oldDecisionId = randomUUID();
    const veryOldFingerprint = fingerprint("very old source version");
    addDecision.run(
      decisionSource.sourceKey,
      veryOldFingerprint,
      oldDecisionId,
      "old-tag-over-180-days",
      "rejected",
      Date.now() - 181 * 24 * 60 * 60 * 1000,
    );
    assert.equal(
      decisionCount(veryOldFingerprint),
      0,
      "obsolete decisions older than 180 days are removed on write",
    );
    d.prepare("UPDATE notes SET text=? WHERE id=?").run(
      "The source has changed and now has a new fingerprint.",
      decisionSourceId,
    );
    const refreshedDecisionSource = indexSource(decisionSource.sourceKey);
    assert.notEqual(
      refreshedDecisionSource.fingerprint,
      decisionSource.fingerprint,
    );
    const obsoleteDecisionCount = (
      d
        .prepare(
          "SELECT count(*) AS n FROM ai_decisions WHERE source_key=? AND fingerprint IS NOT ?",
        )
        .get(decisionSource.sourceKey, refreshedDecisionSource.fingerprint) as {
        n: number;
      }
    ).n;
    assert.ok(
      obsoleteDecisionCount <= 128,
      "a newly obsolete fingerprint is pruned to the per-source history limit",
    );
    addDecision.run(
      decisionSource.sourceKey,
      refreshedDecisionSource.fingerprint,
      decisionTagId,
      "new-current-tag",
      "accepted",
      Date.now(),
    );
    assert.equal(decisionCount(refreshedDecisionSource.fingerprint), 1);

    d.prepare(
      "UPDATE ai_configuration SET enabled=1,tagging_mode='manual'",
    ).run();
    d.prepare(
      "DELETE FROM ai_tag_proposals WHERE owner_id=? AND status='pending'",
    ).run(owner);
    const makeIndexedNote = (title: string, text: string) => {
      const id = randomUUID();
      d.prepare(
        "INSERT INTO notes(id,owner_id,title,document,text,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
      ).run(
        id,
        owner,
        title,
        '{"schemaVersion":1,"blocks":[]}',
        text,
        Date.now(),
        Date.now(),
      );
      return indexSource(`note:${id}`);
    };
    const partialSources = [
      makeIndexedNote(
        "Partial evidence one",
        "Cavitation studies describe acoustic measurements and careful analysis.",
      ),
      makeIndexedNote(
        "Partial evidence two",
        "Cavitation observations compare acoustic measurements across samples.",
      ),
    ];
    const mixedEvidenceSources = [
      makeIndexedNote(
        "Valid retained evidence",
        "Quartz annealing follows a measured temperature cycle.",
      ),
      makeIndexedNote(
        "Stale retained evidence",
        "Quartz annealing notes describe an outdated measurement.",
      ),
    ];
    const invalidOnlySource = makeIndexedNote(
      "Invalid-only evidence",
      "Quartz annealing records include a stale fingerprint example.",
    );
    const sweepSource = makeIndexedNote(
      "Queue slot reclamation",
      "Lithography alignment measurements compare quartz annealing steps across several calibration runs.",
    );
    const addPendingProposal = (name: string) => {
      const id = randomUUID();
      d.prepare(
        "INSERT INTO ai_tag_proposals(id,owner_id,normalized_name,name_fingerprint,name,status,cohesion,created_at) VALUES(?,?,?,?,?,'pending',0,?)",
      ).run(id, owner, name.toLowerCase(), fingerprint(name), name, Date.now());
      return id;
    };
    const insertEvidence = (
      proposalId: string,
      source: ReturnType<typeof makeIndexedNote>,
      sourceFingerprint = source.fingerprint,
      axis = 50,
    ) =>
      d
        .prepare(
          "INSERT INTO ai_tag_proposal_evidence(proposal_id,source_key,canonical_item_key,generation,fingerprint,model_version,cohesion,embedding,terms,created_at) VALUES(?,?,?,?,?,?,0,?,?,?)",
        )
        .run(
          proposalId,
          source.sourceKey,
          `note:${source.itemId}`,
          source.generation,
          sourceFingerprint,
          modelVersion,
          Buffer.from(new Uint8Array(vector(0, axis).buffer)),
          '["quartz annealing"]',
          Date.now(),
        );
    const partialProposalId = addPendingProposal("partial legitimate examples");
    for (const source of partialSources)
      insertEvidence(partialProposalId, source);
    const oneValidProposalId = addPendingProposal("one legitimate example");
    insertEvidence(oneValidProposalId, mixedEvidenceSources[0]);
    insertEvidence(
      oneValidProposalId,
      mixedEvidenceSources[1],
      fingerprint("obsolete source text"),
    );
    const invalidOnlyProposalId = addPendingProposal("no current examples");
    insertEvidence(
      invalidOnlyProposalId,
      invalidOnlySource,
      fingerprint("obsolete-only source text"),
    );
    const emptyProposalIds: string[] = [];
    for (let index = 0; index < 27; index++)
      emptyProposalIds.push(addPendingProposal(`empty stale slot ${index}`));

    assert.equal(tagSource(sweepSource, vector(0, 70)), "processed");
    assert.equal(
      (
        d
          .prepare(
            "SELECT count(*) AS n FROM ai_tag_proposal_evidence WHERE proposal_id=?",
          )
          .get(partialProposalId) as { n: number }
      ).n,
      2,
      "one and two current examples remain while suggestions are still gathering evidence",
    );
    assert.equal(
      (
        d
          .prepare(
            "SELECT count(*) AS n FROM ai_tag_proposal_evidence WHERE proposal_id=?",
          )
          .get(oneValidProposalId) as { n: number }
      ).n,
      1,
      "stale evidence is removed without discarding a still-valid example",
    );
    assert.equal(
      d
        .prepare("SELECT 1 FROM ai_tag_proposals WHERE id=?")
        .get(invalidOnlyProposalId),
      undefined,
      "a pending proposal with zero current evidence is retired",
    );
    assert.equal(
      (
        d
          .prepare(
            `SELECT count(*) AS n FROM ai_tag_proposals WHERE id IN (${emptyProposalIds.map(() => "?").join(",")})`,
          )
          .get(...emptyProposalIds) as { n: number }
      ).n,
      0,
      "empty pending proposals are reclaimed before checking the admission cap",
    );
    assert.ok(
      (
        d
          .prepare(
            "SELECT count(*) AS n FROM ai_tag_proposal_evidence WHERE source_key=?",
          )
          .get(sweepSource.sourceKey) as { n: number }
      ).n > 0,
      "a new proposal can use the slots reclaimed from invalid history",
    );
  } finally {
    d.close();
    await rm(directory, { recursive: true, force: true });
  }
});
