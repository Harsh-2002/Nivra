import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import Database from "better-sqlite3";
test("local AI migrations preserve canonical content, active job leases and SSE cursors", async () => {
  const d = new Database(":memory:");
  d.pragma("foreign_keys=ON");
  d.function("nivra_fold", { deterministic: true }, (value) =>
    String(value ?? "").toLocaleLowerCase(),
  );
  try {
    for (const name of (await readdir("migrations"))
      .filter((name) => name.endsWith(".sql") && name < "0043")
      .sort())
      d.exec(await readFile("migrations/" + name, "utf8"));
    d.prepare(
      "INSERT INTO user(id,name,email,username,created_at,updated_at) VALUES('owner','Migration fixture','migration@example.test','migration',1,1)",
    ).run();
    d.prepare(
      "INSERT INTO notes(id,owner_id,title,document,text,revision,created_at,updated_at) VALUES('note','owner','Preserved content','[]','Existing encrypted content',7,1,1)",
    ).run();
    d.prepare(
      "INSERT INTO tags(id,name,color) VALUES('tag','Manual','gray')",
    ).run();
    d.prepare("INSERT INTO note_tags VALUES('note','tag')").run();
    d.prepare(
      "INSERT INTO background_jobs(id,owner_id,kind,target_id,state,attempts,available_at,lease_until,lease_token,created_at) VALUES('queued','owner','artifact','file','queued',0,1,NULL,NULL,1),('running','owner','thumbnail','image','running',2,1,999999,'existing-lease',1),('done','owner','bookmark','link','done',1,1,NULL,NULL,1)",
    ).run();
    d.prepare(
      "INSERT INTO completion_events(id,owner_id,kind,target_id,status,created_at) VALUES(90,'owner','content','note','notes',1)",
    ).run();
    const notes = d.prepare("SELECT * FROM notes").all(),
      jobs = d.prepare("SELECT * FROM background_jobs ORDER BY id").all(),
      events = d.prepare("SELECT * FROM completion_events").all();
    for (const name of ["0043_local_ai_index.sql", "0044_ai_jobs.sql"]) {
      const sql = await readFile("migrations/" + name, "utf8");
      d.transaction(() => d.exec(sql)).immediate();
    }
    assert.deepEqual(d.prepare("SELECT * FROM notes").all(), notes);
    assert.deepEqual(
      d
        .prepare(
          "SELECT id,owner_id,kind,target_id,state,attempts,available_at,lease_until,lease_token,created_at FROM background_jobs ORDER BY id",
        )
        .all(),
      jobs,
    );
    assert.deepEqual(
      d.prepare("SELECT * FROM completion_events").all(),
      events,
    );
    assert.equal(
      (
        d.prepare("SELECT enabled FROM ai_configuration").get() as {
          enabled: number;
        }
      ).enabled,
      0,
    );
    assert.equal(
      (d.prepare("SELECT aliases FROM tags").get() as { aliases: string })
        .aliases,
      "[]",
    );
    assert.deepEqual(d.prepare("SELECT * FROM note_tags").all(), [
      { note_id: "note", tag_id: "tag" },
    ]);
    assert.equal(
      (
        d
          .prepare("SELECT state FROM ai_content WHERE source_key='note:note'")
          .get() as { state: string }
      ).state,
      "pending",
    );
    d.prepare(
      "INSERT INTO completion_events(owner_id,kind,target_id,status,created_at) VALUES('owner','ai','note:note','indexed',2)",
    ).run();
    assert.equal(
      (
        d.prepare("SELECT max(id) AS n FROM completion_events").get() as {
          n: number;
        }
      ).n,
      91,
    );
    assert.equal(d.pragma("integrity_check", { simple: true }), "ok");
  } finally {
    d.close();
  }
});
