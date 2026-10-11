import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
test("private note and form-response attachments follow parent visibility and use existing extraction", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "nivra-ai-files-"));
  process.env.NIVRA_DATA_DIR = directory;
  const { sqlite } = await import("../src/lib/server/db"),
    { storage } = await import("../src/lib/server/storage");
  const { enqueueJob, claimJob, commitJob, stopJobWorker } =
    await import("../src/lib/server/jobs");
  const { processSemantic, aiOperation } =
    await import("../src/lib/server/ai/indexer");
  const { sourceFor } = await import("../src/lib/server/ai/content");
  const d = sqlite(),
    owner = randomUUID(),
    note = randomUUID(),
    attachment = randomUUID(),
    form = randomUUID(),
    version = randomUUID(),
    response = randomUUID(),
    file = randomUUID(),
    field = randomUUID();
  const body = JSON.stringify([
    {
      id: randomUUID(),
      type: "file",
      props: { name: "evidence.txt", url: "/api/v1/files/" + attachment },
    },
  ]);
  const index = async (key: string) => {
    d.prepare("UPDATE ai_configuration SET public_next_at=0").run();
    enqueueJob(owner, "semantic", key);
    const job = claimJob();
    assert.ok(job);
    await processSemantic({ job, commit: (write) => commitJob(job, write) });
    assert.equal(
      (
        d
          .prepare("SELECT state FROM ai_content WHERE source_key=?")
          .get(key) as { state: string }
      ).state,
      "indexed",
    );
  };
  try {
    d.prepare(
      "INSERT INTO user(id,name,email,username,created_at,updated_at) VALUES(?,?,?,?,?,?)",
    ).run(
      owner,
      "Synthetic files owner",
      "files@example.test",
      "files",
      Date.now(),
      Date.now(),
    );
    d.prepare(
      "INSERT INTO notes(id,owner_id,title,document,text,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
    ).run(
      note,
      owner,
      "Attachment checks",
      body,
      "Supporting evidence.",
      Date.now(),
      Date.now(),
    );
    d.prepare(
      "INSERT INTO attachments(id,note_id,name,mime,size,storage_key,created_at) VALUES(?,?,?,?,?,?,?)",
    ).run(
      attachment,
      note,
      "evidence.txt",
      "text/plain",
      35,
      attachment,
      Date.now(),
    );
    await storage.write(
      attachment,
      Buffer.from("SENTINEL_ATTACHMENT sqlite backup evidence."),
    );
    const definition = JSON.stringify({
      title: "Supporting document",
      description: "",
      confirmation: "Received",
      fields: [
        {
          id: field,
          type: "file",
          label: "Evidence",
          description: "",
          required: false,
          choices: [],
        },
      ],
    });
    d.prepare(
      "INSERT INTO forms(id,owner_id,title,description,definition,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
    ).run(
      form,
      owner,
      "Private response checks",
      "Supporting evidence",
      definition,
      Date.now(),
      Date.now(),
    );
    d.prepare(
      "INSERT INTO form_versions(id,form_id,revision,definition,created_at) VALUES(?,?,?,?,?)",
    ).run(version, form, 1, definition, Date.now());
    d.prepare(
      "INSERT INTO form_responses(id,form_id,version_id,answers,search_text,retry_key,request_hash,created_at) VALUES(?,?,?,?,?,?,?,?)",
    ).run(
      response,
      form,
      version,
      "{}",
      "A routing incident needs investigation.",
      "retry-" + response,
      "hash-" + response,
      Date.now(),
    );
    d.prepare(
      "INSERT INTO form_files(id,form_id,response_id,field_id,filename,mime,size,storage_key,state,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
    ).run(
      file,
      form,
      response,
      field,
      "incident.txt",
      "text/plain",
      40,
      file,
      "attached",
      Date.now(),
    );
    await storage.write(
      file,
      Buffer.from("SENTINEL_PRIVATE_RESPONSE network firewall incident."),
    );
    d.prepare("UPDATE ai_configuration SET enabled=1").run();
    await index("attachment:" + attachment);
    await index("form-file:" + file);
    await index("response:" + response);
    const attachmentKey = "attachment:" + attachment,
      oldAttachmentGeneration = sourceFor(attachmentKey)!.generation;
    d.prepare(
      "UPDATE attachments SET mime='application/octet-stream' WHERE id=?",
    ).run(attachment);
    assert.equal(
      sourceFor(attachmentKey)!.generation,
      oldAttachmentGeneration + 1,
    );
    assert.equal(
      d
        .prepare("SELECT 1 FROM ai_extractions WHERE source_key=?")
        .get(attachmentKey),
      undefined,
    );
    await index(attachmentKey);
    const formFileKey = "form-file:" + file,
      oldFormFileGeneration = sourceFor(formFileKey)!.generation;
    d.prepare(
      "UPDATE form_files SET filename='incident-renamed.txt' WHERE id=?",
    ).run(file);
    assert.equal(sourceFor(formFileKey)!.generation, oldFormFileGeneration + 1);
    assert.equal(
      d
        .prepare("SELECT 1 FROM ai_extractions WHERE source_key=?")
        .get(formFileKey),
      undefined,
    );
    await index(formFileKey);
    const budgetUntil = (
      d
        .prepare("SELECT public_next_at FROM ai_configuration WHERE id=1")
        .get() as { public_next_at: number }
    ).public_next_at;
    assert.ok(budgetUntil > Date.now());
    d.prepare("UPDATE form_responses SET trashed_at=1 WHERE id=?").run(
      response,
    );
    d.prepare("UPDATE form_responses SET trashed_at=NULL WHERE id=?").run(
      response,
    );
    enqueueJob(owner, "semantic", "response:" + response);
    const deferred = claimJob();
    assert.ok(deferred);
    await processSemantic({
      job: deferred,
      commit: (write) => commitJob(deferred, write),
    });
    assert.equal(
      (
        d
          .prepare("SELECT retry_after FROM ai_content WHERE source_key=?")
          .get("response:" + response) as { retry_after: number }
      ).retry_after,
      budgetUntil,
    );
    assert.equal(
      (
        d
          .prepare("SELECT revision FROM form_responses WHERE id=?")
          .get(response) as { revision: number }
      ).revision,
      1,
    );
    await index("form-file:" + file);
    await index("response:" + response);
    assert.match(
      (
        d
          .prepare("SELECT text FROM ai_extractions WHERE source_key=?")
          .get("attachment:" + attachment) as { text: string }
      ).text,
      /SENTINEL_ATTACHMENT/,
    );
    const results = await aiOperation((w) =>
      w.search(owner, "SENTINEL_PRIVATE_RESPONSE", Date.now() + 3000),
    );
    assert.ok(results.some((row) => row.key === "response:" + response));
    const { relatedSearch } = await import("../src/lib/server/ai/search");
    const { assignItemTags } = await import("../src/lib/server/item-tags");
    const { taggedItems } = await import("../src/lib/server/item-tags");
    const responseTag = randomUUID();
    d.prepare(
      "INSERT INTO tags(id,name,color) VALUES(?,'Evidence','gray')",
    ).run(responseTag);
    assignItemTags(owner, "response", response, 1, [responseTag]);
    const canonical = await relatedSearch(owner, "SENTINEL_PRIVATE_RESPONSE");
    const match = canonical.items.find((item) => item.id === response);
    assert.equal(match?.type, "response");
    assert.equal(match?.formId, form);
    assert.ok(!JSON.stringify(canonical).includes("embedding"));
    assert.ok(
      taggedItems(owner, responseTag, "", 50, 0).items.some(
        (item) => item.id === response,
      ),
    );
    assert.equal(
      (await relatedSearch(randomUUID(), "SENTINEL_PRIVATE_RESPONSE")).items
        .length,
      0,
    );
    d.prepare("UPDATE forms SET trashed_at=? WHERE id=?").run(Date.now(), form);
    assert.ok(
      !(await relatedSearch(owner, "SENTINEL_PRIVATE_RESPONSE")).items.some(
        (item) => item.id === response,
      ),
    );
    assert.ok(
      !taggedItems(owner, responseTag, "", 50, 0).items.some(
        (item) => item.id === response,
      ),
    );
    assert.equal(sourceFor("form-file:" + file)?.active, 0);
    assert.equal(
      (
        d
          .prepare(
            "SELECT count(*) AS n FROM ai_chunks WHERE source_key IN(?,?)",
          )
          .get("form-file:" + file, "response:" + response) as { n: number }
      ).n,
      0,
    );
    d.prepare("UPDATE forms SET trashed_at=NULL WHERE id=?").run(form);
    assert.equal(sourceFor("form-file:" + file)?.active, 1);
    await index("form-file:" + file);
    d.prepare("UPDATE notes SET document=? WHERE id=?").run("[]", note);
    assert.equal(sourceFor("attachment:" + attachment)?.active, 0);
    assert.equal(
      (
        d
          .prepare("SELECT count(*) AS n FROM ai_chunks WHERE source_key=?")
          .get("attachment:" + attachment) as { n: number }
      ).n,
      0,
    );
    d.prepare("UPDATE notes SET document=? WHERE id=?").run(body, note);
    await index("attachment:" + attachment);
    d.prepare("DELETE FROM attachments WHERE id=?").run(attachment);
    assert.equal(sourceFor("attachment:" + attachment), undefined);
    assert.equal(
      (
        d
          .prepare(
            "SELECT count(*) AS n FROM ai_extractions WHERE source_key=?",
          )
          .get("attachment:" + attachment) as { n: number }
      ).n,
      0,
    );
  } finally {
    await stopJobWorker();
    d.close();
    await rm(directory, { recursive: true, force: true });
  }
});
