import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";

test("job migration upgrades existing artifacts without changing content", async () => {
  const db = new Database(":memory:");
  try {
    db.exec(
      "CREATE TABLE user(id TEXT PRIMARY KEY); CREATE TABLE artifacts(id TEXT PRIMARY KEY,owner_id TEXT,extraction TEXT,content TEXT,created_at INTEGER); CREATE TABLE bookmarks(id TEXT PRIMARY KEY,title TEXT);",
    );
    db.prepare("INSERT INTO user VALUES(?)").run("owner");
    db.exec(
      "INSERT INTO artifacts VALUES('pending','owner','pending','existing',1),('done','owner','done','finished',2); INSERT INTO bookmarks VALUES('bookmark','Manual title');",
    );
    db.exec(await readFile("migrations/0015_background_jobs.sql", "utf8"));
    assert.deepEqual(
      db.prepare("SELECT target_id FROM background_jobs").all(),
      [{ target_id: "pending" }],
    );
    assert.equal(
      (
        db
          .prepare("SELECT content FROM artifacts WHERE id='pending'")
          .get() as { content: string }
      ).content,
      "existing",
    );
    assert.equal(
      (
        db.prepare("SELECT title_edited FROM bookmarks").get() as {
          title_edited: number;
        }
      ).title_edited,
      1,
    );
  } finally {
    db.close();
  }
});

test("jobs fence stale leases, deduplicate, cancel deletion and stream only owner invalidations", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "nivra-jobs-"));
  process.env.NIVRA_DATA_DIR = dir;
  const { sqlite } = await import("../src/lib/server/db");
  const jobs = await import("../src/lib/server/jobs");
  const { completionStream } =
    await import("../src/lib/server/completion-stream");
  const { createTextArtifact, deleteArtifact } =
    await import("../src/lib/server/artifacts");
  const db = sqlite();
  const owner = randomUUID();
  db.prepare(
    "INSERT INTO user(id,name,email,email_verified,username,created_at,updated_at) VALUES(?,?,?,0,?,?,?)",
  ).run(
    owner,
    "Fixture",
    "jobs@local.invalid",
    "fixture",
    Date.now(),
    Date.now(),
  );
  try {
    const artifact = createTextArtifact(owner, "Synthetic preserved draft");
    jobs.enqueueJob(owner, "artifact", artifact.id);
    jobs.enqueueJob(owner, "artifact", artifact.id);
    assert.equal(
      (
        db.prepare("SELECT count(*) AS n FROM background_jobs").get() as {
          n: number;
        }
      ).n,
      1,
    );
    const first = jobs.claimJob()!;
    assert.equal(jobs.claimJob(), undefined);
    db.prepare("UPDATE background_jobs SET lease_until=0 WHERE id=?").run(
      first.id,
    );
    const recovered = jobs.claimJob()!;
    assert.equal(recovered.attempts, 2);
    assert.notEqual(first.lease_token, recovered.lease_token);
    let overwritten = false;
    assert.equal(
      jobs.commitJob(first, () => {
        overwritten = true;
        return "done";
      }),
      false,
    );
    assert.equal(overwritten, false);
    assert.equal(
      jobs.commitJob(recovered, () => "done"),
      true,
    );
    assert.equal(
      jobs.commitJob(recovered, () => "done"),
      false,
    );
    assert.equal(
      (
        db.prepare("SELECT count(*) AS n FROM completion_events").get() as {
          n: number;
        }
      ).n,
      1,
    );
    jobs.enqueueJob(owner, "artifact", artifact.id);
    const deleted = jobs.claimJob()!;
    await deleteArtifact(owner, artifact.id, artifact.revision);
    assert.equal(
      jobs.commitJob(deleted, () => "done"),
      false,
    );
    assert.equal(
      db
        .prepare("SELECT 1 FROM artifacts WHERE id=? AND trashed_at IS NULL")
        .get(artifact.id),
      undefined,
    );

    const routes = await import("../src/app/api/v1/[...path]/route");
    const denied = await routes.GET(
      new Request("http://localhost/api/v1/completions"),
      { params: Promise.resolve({ path: ["completions"] }) },
    );
    assert.equal(denied.status, 401);
    const bookmarks = await import("../src/lib/server/bookmarks");
    const { storage } = await import("../src/lib/server/storage");
    const bookmarkId = randomUUID();
    db.prepare(
      "INSERT INTO bookmarks(id,owner_id,url,title,metadata_status,created_at,updated_at) VALUES(?,?,?,'original','pending',?,?)",
    ).run(bookmarkId, owner, "https://example.com/", Date.now(), Date.now());
    jobs.enqueueJob(owner, "bookmark", bookmarkId);
    const metadataJob = jobs.claimJob()!;
    let release!: () => void;
    const delayed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const asset = randomUUID();
    await storage.write(asset, Buffer.from("Synthetic preview"));
    const processing = bookmarks.processBookmark(
      {
        job: metadataJob,
        commit: (write) => jobs.commitJob(metadataJob, write),
      },
      async () => {
        await delayed;
        return {
          title: "Fetched title",
          description: "Fetched description",
          siteName: "Example",
          metadataStatus: "ready",
          thumbnail: { key: asset, mime: "image/png" },
          icon: null,
        };
      },
    );
    const edited = bookmarks.updateBookmark(owner, bookmarkId, {
      revision: 1,
      title: "Manual title",
      description: "Manual description",
      collection: "References",
    });
    release();
    await processing;
    const finished = bookmarks.listBookmarks(owner)[0];
    assert.equal(finished.title, edited.title);
    assert.equal(finished.description, edited.description);
    assert.equal(finished.collection, "References");
    assert.equal(finished.metadataStatus, "ready");
    assert.ok(finished.revision > edited.revision);
    assert.equal(bookmarks.listBookmarks(owner, "Manual").length, 1);
    assert.throws(
      () =>
        bookmarks.updateBookmark(owner, bookmarkId, {
          revision: edited.revision,
          title: "Stale draft",
        }),
      /changed/,
    );
    db.prepare("UPDATE bookmarks SET metadata_status='pending' WHERE id=?").run(
      bookmarkId,
    );
    jobs.enqueueJob(owner, "bookmark", bookmarkId);
    const cancelled = jobs.claimJob()!;
    const orphan = randomUUID();
    await storage.write(orphan, Buffer.from("Generated orphan"));
    let releaseDeleted!: () => void;
    const deletedWait = new Promise<void>((resolve) => {
      releaseDeleted = resolve;
    });
    const late = bookmarks.processBookmark(
      { job: cancelled, commit: (write) => jobs.commitJob(cancelled, write) },
      async () => {
        await deletedWait;
        return {
          title: "Late",
          description: "Late",
          siteName: "Example",
          metadataStatus: "ready",
          thumbnail: { key: orphan, mime: "image/png" },
          icon: null,
        };
      },
    );
    await bookmarks.deleteBookmark(owner, bookmarkId, finished.revision);
    releaseDeleted();
    await late;
    assert.equal(bookmarks.listBookmarks(owner).length, 0);
    await assert.rejects(storage.read(orphan));

    const session = randomUUID();
    db.prepare(
      "INSERT INTO session(id,expires_at,token,created_at,updated_at,user_id) VALUES(?,?,?,?,?,?)",
    ).run(
      session,
      Date.now() + 60000,
      randomUUID(),
      Date.now(),
      Date.now(),
      owner,
    );
    const request = new Request("http://localhost/api/v1/completions", {
      headers: { "Last-Event-ID": "1" },
    });
    const response = completionStream(request, owner, session);
    assert.equal(
      response.headers.get("Cache-Control"),
      "private, no-store, no-transform",
    );
    assert.equal(response.headers.get("X-Accel-Buffering"), "no");
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    assert.match(decoder.decode((await reader.read()).value), /event: resync/);
    const unauthorized = completionStream(
      new Request(request.url),
      randomUUID(),
      session,
    );
    const unauthorizedReader = unauthorized.body!.getReader();
    assert.match(
      decoder.decode((await unauthorizedReader.read()).value),
      /event: resync/,
    );
    jobs.completionEvent(owner, "ai", "synthetic-id", "available");
    const event = decoder.decode((await reader.read()).value);
    assert.match(event, /event: completion/);
    assert.match(event, /synthetic-id/);
    const eventData = JSON.parse(event.split("data: ")[1]!.trim()) as {
      id: number;
      kind: string;
      target: string;
      status: string;
    };
    assert.deepEqual(Object.keys(eventData).sort(), [
      "id",
      "kind",
      "status",
      "target",
    ]);
    assert.equal(eventData.kind, "ai");
    assert.equal(eventData.status, "available");
    assert.doesNotMatch(
      event,
      /private proposal sentinel|excerpt|embedding|vector|preserved draft|jobs@local/i,
    );
    const unauthorizedEvent = decoder.decode(
      (await unauthorizedReader.read()).value,
    );
    assert.match(unauthorizedEvent, /event: revoked/);
    assert.doesNotMatch(
      unauthorizedEvent,
      /synthetic-id|excerpt|embedding|vector/i,
    );
    db.prepare("DELETE FROM session WHERE id=?").run(session);
    assert.match(decoder.decode((await reader.read()).value), /event: revoked/);
    assert.equal((await reader.read()).done, true);
    const reconnect = completionStream(
      new Request(request.url),
      owner,
      session,
    );
    const nextReader = reconnect.body!.getReader();
    assert.match(
      decoder.decode((await nextReader.read()).value),
      /event: resync/,
    );
    await nextReader.cancel();
    for (const signal of ["SIGTERM", "SIGINT"] as const) {
      const before = process.listenerCount(signal);
      const readers = [0, 1].map(() =>
        completionStream(
          new Request(request.url),
          owner,
          session,
        ).body!.getReader(),
      );
      for (const stream of readers) {
        assert.match(
          decoder.decode((await stream.read()).value),
          /event: resync/,
        );
      }
      assert.equal(process.listenerCount(signal), before + 1);
      process.emit(signal, signal);
      for (const stream of readers)
        assert.equal((await stream.read()).done, true);
      assert.equal(process.listenerCount(signal), before);
    }
    await t.test(
      "ready bookmark work bypasses an extraction backlog without starving artifacts",
      async () => {
        await jobs.stopJobWorker();
        for (let index = 0; index < 5; index++)
          jobs.enqueueJob(owner, "artifact", `backlog-${index}`);
        jobs.enqueueJob(owner, "bookmark", "interactive-bookmark");
        const bookmark = jobs.claimJob(Date.now(), "bookmark")!;
        assert.equal(bookmark.kind, "bookmark");
        assert.equal(bookmark.target_id, "interactive-bookmark");
        assert.equal(
          jobs.commitJob(bookmark, () => "done"),
          true,
        );
        const artifact = jobs.claimJob(Date.now(), "artifact")!;
        assert.equal(artifact.kind, "artifact");
        assert.equal(
          jobs.commitJob(artifact, () => "done"),
          true,
        );
        assert.equal(jobs.claimJob(Date.now(), "bookmark")!.kind, "artifact");
      },
    );
  } finally {
    await jobs.stopJobWorker();
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
