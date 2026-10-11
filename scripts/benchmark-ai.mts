import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir, cpus } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
const root = process.cwd();
const chunksPerItem = Number(process.argv[3] ?? 100);
if (![1, 100].includes(chunksPerItem))
  throw new Error("Use 1 or 100 chunks per item.");
const counts = (process.argv[2] ?? "1000,10000").split(",").map(Number);
if (
  counts.some(
    (n, i) =>
      !Number.isSafeInteger(n) ||
      n < 100 ||
      n > 100000 ||
      n % 100 ||
      (i > 0 && n <= counts[i - 1]),
  )
)
  throw new Error("Use ascending multiples of 100, up to 100000 vectors.");
const directory = await mkdtemp(path.join(tmpdir(), "nivra-ai-capacity-"));
process.env.NIVRA_DATA_DIR = directory;
process.env.NIVRA_ENCRYPTION_ENABLED = "true";
const { sqlite } = await import("../src/lib/server/db");
const { EmbeddingWorker } = await import("../src/lib/server/ai/runtime");
const { modelVersion } = await import("../src/lib/server/ai/model");
const d = sqlite(),
  worker = new EmbeddingWorker(root),
  owner = randomUUID();
const output: Record<string, unknown> = {
  purpose:
    chunksPerItem === 100
      ? "integration resource limits only; replicated vectors, 100 chunks per canonical item"
      : "integration resource limits only; replicated vectors, one chunk per canonical item",
  node: process.version,
  cpu: cpus()[0].model,
  platform: process.platform,
  arch: process.arch,
  cpuAffinity: process.env.BENCH_CPU,
};
try {
  const encryptionMode = JSON.parse(
    await readFile(path.join(directory, "encryption-mode.json"), "utf8"),
  ) as { version?: unknown; encrypted?: unknown };
  if (encryptionMode.version !== 1 || encryptionMode.encrypted !== true)
    throw new Error("AI resource benchmark requires encrypted storage.");
  d.prepare(
    "INSERT INTO user(id,name,email,username,created_at,updated_at) VALUES(?,'Synthetic capacity','capacity@example.test','capacity',1,1)",
  ).run(owner);
  const start = performance.now();
  const embedding = await worker.encode(
    "SQLite database backup restore verification and security.",
  );
  output.coldInitializationAndInferenceMs = performance.now() - start;
  const blob = Buffer.alloc(384 * 4);
  for (let i = 0; i < 384; i++) blob.writeFloatLE(embedding[i], i * 4);
  const insertNote = d.prepare(
    "INSERT INTO notes(id,owner_id,title,document,text,created_at,updated_at) VALUES(?,?,'Synthetic resource item','[]','SQLite database backup restore.',1,1)",
  );
  const indexed = d.prepare(
    "UPDATE ai_content SET state='indexed',pending=0,owner_id=?,item_kind='note',item_id=?,model_version=?,indexed_generation=generation WHERE source_key=?",
  );
  const insertChunk = d.prepare(
    "INSERT INTO ai_chunks(source_key,ordinal,generation,model_version,title,text,embedding) VALUES(?,?,1,?,'Synthetic resource item','SQLite database backup restore.',?)",
  );
  const measures = [];
  for (const count of counts) {
    const insertStart = performance.now();
    const present = (
      d.prepare("SELECT chunk_count AS n FROM ai_configuration").get() as {
        n: number;
      }
    ).n;
    d.transaction(() => {
      let id = "",
        key = "";
      for (let i = present; i < count; i++) {
        if (i % chunksPerItem === 0) {
          id = randomUUID();
          key = "note:" + id;
          insertNote.run(id, owner);
          indexed.run(owner, id, modelVersion, key);
        }
        insertChunk.run(key, i % chunksPerItem, modelVersion, blob);
      }
    }).immediate();
    d.pragma("wal_checkpoint(TRUNCATE)");
    const ingestionMs = performance.now() - insertStart;
    const coldStart = performance.now();
    let coldFailure: string | undefined;
    try {
      await worker.search(
        owner,
        "recover a database backup",
        Date.now() + 3000,
      );
    } catch (e) {
      coldFailure = (e as Error).message;
    }
    const coldQueryMs = performance.now() - coldStart;
    const primeStart = performance.now();
    let primeFailure: string | undefined;
    try {
      await worker.search(
        owner,
        "recover a database backup",
        Date.now() + 30000,
      );
    } catch (e) {
      primeFailure = (e as Error).message;
    }
    const cachePreparationMs = performance.now() - primeStart;
    await new Promise((resolve) => setTimeout(resolve, 350));
    const cpuStart = { ...worker.resources };
    const timings: number[] = [],
      failures: string[] = [];
    for (let i = 0; i < 5; i++) {
      const t = performance.now();
      try {
        const found = await worker.search(
          owner,
          "recover a database backup",
          Date.now() + 3000,
        );
        if (found.length !== Math.min(30, count / chunksPerItem))
          throw new Error("Unexpected result count");
      } catch (e) {
        failures.push((e as Error).message);
      }
      timings.push(performance.now() - t);
    }
    timings.sort((a, b) => a - b);
    await new Promise((resolve) => setTimeout(resolve, 350));
    const cpuAfter = { ...worker.resources };
    const before = worker.resources.rss;
    await new Promise((resolve) => setTimeout(resolve, 1000));
    measures.push({
      vectors: count,
      ingestionMs,
      coldQueryMs,
      coldFailure,
      cachePreparationMs,
      primeFailure,
      warmP50Ms: timings[2],
      warmP95Ms: timings[4],
      sampleCount: 5,
      failures,
      workerRssMiB: before / 1048576,
      workerPeakRssMiB: worker.resources.peakRss / 1048576,
      idleWorkerRssMiB: worker.resources.rss / 1048576,
      workerQueryCpuUs: {
        user: (cpuAfter.cpuUserUs ?? 0) - (cpuStart.cpuUserUs ?? 0),
        system: (cpuAfter.cpuSystemUs ?? 0) - (cpuStart.cpuSystemUs ?? 0),
      },
      idleWorkerCpuUs: {
        user: (worker.resources.cpuUserUs ?? 0) - (cpuAfter.cpuUserUs ?? 0),
        system:
          (worker.resources.cpuSystemUs ?? 0) - (cpuAfter.cpuSystemUs ?? 0),
      },
      encryptedDatabaseBytes: (await stat(path.join(directory, "nivra.sqlite")))
        .size,
    });
  }
  if (process.env.NIVRA_AI_BENCH_RESOURCE_ONLY !== "1") {
    if (counts.includes(100000)) {
      const capacityId = randomUUID();
      insertNote.run(capacityId, owner);
      d.prepare("UPDATE ai_configuration SET enabled=1").run();
      const { enqueueJob, claimJob, commitJob } =
        await import("../src/lib/server/jobs");
      const { processSemantic } = await import("../src/lib/server/ai/indexer");
      enqueueJob(owner, "semantic", "note:" + capacityId);
      const job = claimJob();
      if (!job) throw new Error("Capacity job missing");
      await processSemantic({ job, commit: (write) => commitJob(job, write) });
      output.capacityState = d
        .prepare("SELECT state FROM ai_content WHERE source_key=?")
        .get("note:" + capacityId);
      if ((output.capacityState as { state: string }).state !== "capacity")
        throw new Error("Capacity overflow did not defer");
    }
  }
  output.measurements = measures;
  output.integrity = d.pragma("integrity_check", { simple: true });
  output.dirtyPlan = d
    .prepare(
      "EXPLAIN QUERY PLAN SELECT source_key FROM ai_content WHERE pending=1 AND failures<3 AND retry_after<=? ORDER BY retry_after,source_key LIMIT 8",
    )
    .all(Date.now());
  output.sourcePlan = d
    .prepare(
      "EXPLAIN QUERY PLAN SELECT s.*,c.generation FROM ai_sources s JOIN ai_content c USING(source_key) WHERE source_key=? AND source_kind=? AND source_id=?",
    )
    .all("note:missing", "note", "missing");

  console.log(JSON.stringify(output, null, 2));
  if (
    measures.some(
      (m) => m.failures.length || m.primeFailure || m.workerPeakRssMiB > 512,
    )
  )
    throw new Error(
      "AI resource benchmark exceeded warm retrieval or worker memory limits.",
    );
} finally {
  await worker.stop();
  d.close();
  await rm(directory, { recursive: true, force: true });
}
