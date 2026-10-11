import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
test("encrypted vector snapshots reopen, reject wrong keys and preserve private derived rows through rekey and VACUUM", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "nivra-ai-recovery-"));
  process.env.NIVRA_DATA_DIR = directory;
  const { sqlite } = await import("../src/lib/server/db");
  const { modelVersion } = await import("../src/lib/server/ai/model");
  const { masterKey, deriveKey } = await import("../src/lib/server/encryption");
  const d = sqlite(),
    owner = randomUUID(),
    id = randomUUID(),
    key = "note:" + id,
    backup = path.join(directory, "vector-snapshot.sqlite");
  let snapshot: Database.Database | undefined;
  try {
    d.prepare(
      "INSERT INTO user(id,name,email,username,created_at,updated_at) VALUES(?,'Synthetic','restore-ai@example.test','restore_ai',1,1)",
    ).run(owner);
    d.prepare(
      "INSERT INTO notes(id,owner_id,title,document,text,created_at,updated_at) VALUES(?,?,'Private sentinel','[]','DERIVED_BACKUP_SENTINEL',1,1)",
    ).run(id, owner);
    const embedding = Buffer.alloc(1536);
    embedding.writeFloatLE(1, 0);
    d.prepare(
      "INSERT INTO ai_chunks(source_key,ordinal,generation,model_version,title,text,embedding) VALUES(?,0,1,?,'Private sentinel','DERIVED_BACKUP_SENTINEL',?)",
    ).run(key, modelVersion, embedding);
    d.prepare("VACUUM INTO ?").run(backup);
    const bytes = await readFile(backup);
    assert.ok(!bytes.includes(Buffer.from("DERIVED_BACKUP_SENTINEL")));
    const open = (password: string) => {
      const next = new Database(backup);
      next.pragma("cipher='chacha20'");
      next.pragma(`key='${password}'`);
      return next;
    };
    const wrong = open("incorrect synthetic key");
    assert.throws(() => wrong.prepare("SELECT count(*) FROM ai_chunks").get());
    wrong.close();
    snapshot = open(deriveKey(masterKey(directory), "sqlite").toString("hex"));
    const row = snapshot
      .prepare("SELECT embedding,model_version FROM ai_chunks")
      .get() as { embedding: Buffer; model_version: string };
    assert.deepEqual(row.embedding, embedding);
    assert.equal(row.model_version, modelVersion);
    assert.equal(snapshot.pragma("integrity_check", { simple: true }), "ok");
    snapshot.pragma("rekey='disposable-test-rekey'");
    snapshot.close();
    snapshot = undefined;
    snapshot = open("disposable-test-rekey");
    assert.deepEqual(
      (
        snapshot.prepare("SELECT embedding FROM ai_chunks").get() as {
          embedding: Buffer;
        }
      ).embedding,
      embedding,
    );
    assert.equal(
      (
        snapshot.prepare("SELECT chunk_count FROM ai_configuration").get() as {
          chunk_count: number;
        }
      ).chunk_count,
      1,
    );
  } finally {
    snapshot?.close();
    d.close();
    delete (globalThis as { nivraSqlite?: unknown }).nivraSqlite;
    await rm(directory, { recursive: true, force: true });
  }
});
