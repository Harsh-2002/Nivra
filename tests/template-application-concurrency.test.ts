import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

test("concurrent template applies replay once and remove losing staged attachments", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "nivra-template-apply-race-"),
  );
  const previousDirectory = process.env.NIVRA_DATA_DIR;
  process.env.NIVRA_DATA_DIR = directory;
  const { sqlite } = await import("../src/lib/server/db");
  const { createNote } = await import("../src/lib/server/notes");
  const { storage } = await import("../src/lib/server/storage");
  const { executeWriting } = await import("../src/lib/server/writing-service");
  const database = sqlite();
  const owner = randomUUID();
  const now = Date.now();
  const sourceFileId = randomUUID();
  try {
    database
      .prepare(
        "INSERT INTO user(id,name,email,username,created_at,updated_at) VALUES(?,?,?,?,?,?)",
      )
      .run(owner, "Template Race", `${owner}@local.invalid`, owner, now, now);
    const source = createNote(owner, "Source with file", {
      schemaVersion: 1,
      blocks: [
        {
          id: "source-file",
          type: "file",
          props: {
            url: `/api/v1/files/${sourceFileId}`,
            name: "maintenance.txt",
          },
        },
      ],
    });
    await storage.write(sourceFileId, Buffer.from("synthetic attachment"));
    database
      .prepare(
        "INSERT INTO attachments(id,note_id,name,mime,size,storage_key,created_at) VALUES(?,?,?,'text/plain',?,?,?)",
      )
      .run(
        sourceFileId,
        source.id,
        "maintenance.txt",
        Buffer.byteLength("synthetic attachment"),
        sourceFileId,
        now,
      );

    const command = async (
      method: string,
      pathParts: string[],
      input?: unknown,
    ) => {
      const result = await executeWriting({
        ownerId: owner,
        origin: "http://localhost",
        path: pathParts,
        method,
        input,
      });
      assert.ok(result && "data" in result);
      return result;
    };
    const createdTemplate = await command("POST", ["templates"], {
      name: "Maintenance reference",
      kind: "note",
      sourceNoteId: source.id,
      sourceRevision: source.revision,
    });
    assert.ok(createdTemplate);
    const template = createdTemplate.data as { id: string; revision: number };
    const input = {
      revision: template.revision,
      idempotencyKey: "concurrent-apply-01",
      title: "Copied maintenance reference",
      timezone: "UTC",
    };

    const results = await Promise.all([
      command("POST", ["templates", template.id, "apply"], input),
      command("POST", ["templates", template.id, "apply"], input),
    ]);
    assert.deepEqual(results.map((result) => result.status).sort(), [200, 201]);
    const appliedNotes = results.map(
      (result) => (result.data as { note: { id: string } }).note.id,
    );
    assert.equal(appliedNotes[0], appliedNotes[1]);
    const [appliedId] = appliedNotes;
    assert.deepEqual(
      database
        .prepare("SELECT count(*) AS total FROM writing_template_applications")
        .get(),
      { total: 1 },
    );
    assert.deepEqual(
      database
        .prepare("SELECT count(*) AS total FROM attachments WHERE note_id=?")
        .get(appliedId),
      { total: 1 },
    );

    const storedObjects = await readdir(path.join(directory, "uploads"));
    assert.equal(
      storedObjects.length,
      3,
      "source, template copy, and one applied copy should remain",
    );
  } finally {
    database.close();
    if (previousDirectory === undefined) delete process.env.NIVRA_DATA_DIR;
    else process.env.NIVRA_DATA_DIR = previousDirectory;
    await rm(directory, { recursive: true, force: true });
  }
});
