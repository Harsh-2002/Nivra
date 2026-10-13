import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

test("semantic backfill advances a bounded queue window without losing its tail", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "nivra-ai-queue-window-"),
  );
  process.env.NIVRA_DATA_DIR = directory;
  const { sqlite } = await import("../src/lib/server/db");
  const { queueSemanticWork, stopAi } =
    await import("../src/lib/server/ai/indexer");
  const { claimJob, commitJob } = await import("../src/lib/server/jobs");
  const { modelVersion } = await import("../src/lib/server/ai/model");
  const database = sqlite();
  const owner = randomUUID();
  const now = Date.now();
  const count = 40;

  const activeJobCount = () =>
    (
      database
        .prepare(
          "SELECT count(*) AS count FROM background_jobs WHERE kind=? AND state IN(?,?)",
        )
        .get("semantic", "queued", "running") as { count: number }
    ).count;
  const unscheduledPendingCount = () =>
    (
      database
        .prepare(
          `SELECT count(*) AS count FROM ai_content c
           JOIN ai_sources s USING(source_key)
           WHERE s.owner_id=? AND s.active=1 AND c.pending=1
             AND NOT EXISTS(
               SELECT 1 FROM background_jobs j
               WHERE j.kind='semantic' AND j.target_id=c.source_key
                 AND j.state IN('queued','running')
             )`,
        )
        .get(owner) as { count: number }
    ).count;
  const activeTargets = () =>
    new Set(
      (
        database
          .prepare(
            "SELECT target_id FROM background_jobs WHERE kind=? AND state IN(?,?)",
          )
          .all("semantic", "queued", "running") as { target_id: string }[]
      ).map((job) => job.target_id),
    );
  const completeWithoutInference = (
    job: NonNullable<ReturnType<typeof claimJob>>,
  ) =>
    commitJob(job, () => {
      database
        .prepare(
          "UPDATE ai_content SET state=?,model_version=?,indexed_generation=generation,pending=? WHERE source_key=?",
        )
        .run("indexed", modelVersion, 0, job.target_id);
      return "indexed";
    });

  try {
    database
      .prepare(
        "INSERT INTO user(id,name,email,username,created_at,updated_at) VALUES(?,?,?,?,?,?)",
      )
      .run(
        owner,
        "Synthetic queue owner",
        `${owner}@example.test`,
        `queue_${owner.slice(0, 8)}`,
        now,
        now,
      );
    database
      .prepare("UPDATE ai_configuration SET enabled=? WHERE id=?")
      .run(1, 1);
    const insertNote = database.prepare(
      "INSERT INTO notes(id,owner_id,title,document,text,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
    );
    for (let index = 0; index < count; index++) {
      const id = randomUUID();
      insertNote.run(
        id,
        owner,
        `Queue fixture ${String(index).padStart(2, "0")}`,
        "[]",
        "Synthetic content for a bounded semantic indexing queue test.",
        now + index,
        now + index,
      );
    }

    const eligible = (
      database
        .prepare(
          `SELECT s.source_key FROM ai_sources s
           JOIN ai_content c USING(source_key)
           WHERE s.owner_id=? AND s.active=1 AND c.pending=1
           ORDER BY c.retry_after,s.source_key`,
        )
        .all(owner) as { source_key: string }[]
    ).map((row) => row.source_key);
    assert.equal(eligible.length, count);

    queueSemanticWork();
    const initialTargets = activeTargets();
    assert.equal(activeJobCount(), 8);
    assert.equal(unscheduledPendingCount(), count - 8);

    const held = claimJob(Date.now(), "semantic", true);
    assert.ok(held);
    assert.equal(
      (
        database
          .prepare("SELECT state FROM background_jobs WHERE id=?")
          .get(held.id) as { state: string }
      ).state,
      "running",
    );
    queueSemanticWork();
    queueSemanticWork();
    assert.equal(activeJobCount(), 8);
    assert.equal(unscheduledPendingCount(), count - 8);
    assert.deepEqual(activeTargets(), initialTargets);

    assert.equal(
      commitJob(held, () => {
        database
          .prepare(
            "UPDATE ai_content SET state=?,model_version=?,indexed_generation=generation,pending=? WHERE source_key=?",
          )
          .run("indexed", modelVersion, 0, held.target_id);
        return "indexed";
      }),
      true,
    );
    let completed = 1;
    queueSemanticWork();
    const nextTargets = activeTargets();
    assert.equal(activeJobCount(), 8);
    assert.equal(unscheduledPendingCount(), count - completed - 8);
    assert.equal(
      [...nextTargets].filter((target) => !initialTargets.has(target)).length,
      1,
    );

    const checkpoints = new Map([[1, [8, 31]]]);
    while (completed < count) {
      const job = claimJob(Date.now(), "semantic", true);
      assert.ok(job, `Expected a queued job at completion ${completed}`);
      assert.equal(completeWithoutInference(job), true);
      completed++;
      queueSemanticWork();
      if ([8, 16, 24, 32, 40].includes(completed))
        checkpoints.set(completed, [
          activeJobCount(),
          unscheduledPendingCount(),
        ]);
    }

    assert.deepEqual(checkpoints.get(8), [8, 24]);
    assert.deepEqual(checkpoints.get(16), [8, 16]);
    assert.deepEqual(checkpoints.get(24), [8, 8]);
    assert.deepEqual(checkpoints.get(32), [8, 0]);
    assert.deepEqual(checkpoints.get(40), [0, 0]);
    assert.equal(
      (
        database
          .prepare(
            "SELECT count(*) AS count FROM ai_content c JOIN ai_sources s USING(source_key) WHERE s.owner_id=? AND s.active=1 AND c.state=? AND c.model_version=? AND c.indexed_generation=c.generation AND c.pending=0",
          )
          .get(owner, "indexed", modelVersion) as { count: number }
      ).count,
      count,
    );
  } finally {
    await stopAi();
    if (database.open) database.close();
    await rm(directory, { recursive: true, force: true });
  }
});
