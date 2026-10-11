import { randomUUID } from "node:crypto";
import path from "node:path";
import { dataDir, sqlite } from "../db";
import { enqueueJob, type JobContext } from "../jobs";
import { EmbeddingWorker } from "./runtime";
import { modelVersion } from "./model";
import {
  fingerprint,
  sourceFor,
  sourceText,
  textChunkCount,
  textChunks,
} from "./content";
import { cosine, policy, tagCandidates, type TagVocabulary } from "./policy";
import { extractAttachment } from "./extract-attachments";
const global = globalThis as unknown as {
  nivraAi?: {
    worker: EmbeddingWorker;
    tail: Promise<void>;
    waiting: number;
    stopped: boolean;
    ready: boolean;
    initializing: boolean;
    retryAt: number;
    planned: boolean;
    stopPromise?: Promise<void>;
  };
};
const state = () =>
  (global.nivraAi ??= {
    worker: new EmbeddingWorker(
      process.cwd(),
      path.join(dataDir, "ai-worker.lock"),
    ),
    tail: Promise.resolve(),
    waiting: 0,
    stopped: false,
    ready: false,
    initializing: false,
    retryAt: 0,
    planned: false,
  });
export function aiEnabled() {
  const enabled = Boolean(
    (
      sqlite()
        .prepare("SELECT enabled FROM ai_configuration WHERE id=1")
        .get() as { enabled: number }
    ).enabled,
  );
  if (!enabled) void stopAi();
  return enabled;
}
export function canIndexLocally() {
  if (!aiEnabled()) return false;
  const current = state();
  if (current.stopped) return false;
  if (current.ready && current.worker.running) return true;
  current.ready = false;
  if (!current.initializing && Date.now() >= current.retryAt) {
    current.initializing = true;
    void current.worker
      .start()
      .then(() => {
        if (global.nivraAi !== current || current.stopped || !aiEnabled()) {
          current.ready = false;
          void stopState(current);
          return;
        }
        current.ready = true;
      })
      .catch(() => {
        if (global.nivraAi === current && !current.stopped)
          current.retryAt = Date.now() + 30_000;
      })
      .finally(() => {
        if (global.nivraAi === current) current.initializing = false;
      });
  }
  return false;
}
export async function aiOperation<T>(
  work: (worker: EmbeddingWorker) => Promise<T>,
  deadline = Date.now() + 30_000,
) {
  if (!aiEnabled()) throw new Error("Local AI is disabled.");
  const current = state();
  if (current.stopped || current.waiting >= 8)
    throw new Error("Local AI queue is busy.");
  current.waiting++;
  const previous = current.tail;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  current.tail = previous.then(() => gate);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      previous,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Local AI queue timed out.")),
          Math.max(1, deadline - Date.now()),
        );
      }),
    ]);
    clearTimeout(timer);
    if (Date.now() >= deadline || !aiEnabled() || current.stopped)
      throw new Error("Local AI is unavailable.");
    return await work(current.worker);
  } finally {
    clearTimeout(timer);
    current.waiting--;
    release();
  }
}
function stopState(current: NonNullable<typeof global.nivraAi>) {
  current.stopped = true;
  current.ready = false;
  current.stopPromise ??= (async () => {
    try {
      await current.worker.stop();
    } finally {
      if (global.nivraAi === current) global.nivraAi = undefined;
    }
  })();
  return current.stopPromise;
}
export async function stopAi() {
  const current = global.nivraAi;
  if (current) await stopState(current);
}
export function queueSemanticWork() {
  if (!aiEnabled()) return;
  const d = sqlite();
  const current = state();
  if (!current.planned) {
    d.prepare(
      "UPDATE ai_content SET pending=1,failures=0,retry_after=0 WHERE model_version IS NOT ?",
    ).run(modelVersion);
    current.planned = true;
  }
  const queued = (
    d
      .prepare(
        "SELECT count(*) AS n FROM background_jobs WHERE kind='semantic' AND state IN('queued','running')",
      )
      .get() as { n: number }
  ).n;
  if (queued >= 32) return;
  const rows = d
    .prepare(
      "SELECT source_key FROM ai_content WHERE pending=1 AND failures<3 AND retry_after<=? ORDER BY retry_after,source_key LIMIT ?",
    )
    .all(Date.now(), Math.min(8, 32 - queued)) as { source_key: string }[];
  for (const row of rows) {
    const source = sourceFor(row.source_key);
    if (source?.active)
      enqueueJob(source.owner_id, "semantic", source.source_key);
    else
      d.prepare("UPDATE ai_content SET pending=0 WHERE source_key=?").run(
        row.source_key,
      );
  }
}
function bytes(vector: Float32Array) {
  const buffer = Buffer.alloc(1536);
  for (let i = 0; i < 384; i++) buffer.writeFloatLE(vector[i], i * 4);
  return buffer;
}
function vector(buffer: Buffer) {
  const result = new Float32Array(384);
  for (let i = 0; i < 384; i++) result[i] = buffer.readFloatLE(i * 4);
  return result;
}
export async function processSemantic({ job, commit, signal }: JobContext) {
  const d = sqlite();
  let source = sourceFor(job.target_id);
  if (
    !source ||
    !source.active ||
    source.owner_id !== job.owner_id ||
    !aiEnabled() ||
    (job.generation != null && source.generation !== job.generation)
  ) {
    commit(() => "cancelled");
    return;
  }
  const generation = source.generation,
    started = Date.now(),
    deadline = started + 60_000;
  let publicReservation = 0;
  if (source.item_kind === "response") {
    publicReservation = started + 1_800_000;
    const reserved = d
      .prepare(
        "UPDATE ai_configuration SET public_next_at=? WHERE id=1 AND public_next_at<=?",
      )
      .run(publicReservation, started);
    if (!reserved.changes) {
      const next = (
        d
          .prepare("SELECT public_next_at FROM ai_configuration WHERE id=1")
          .get() as { public_next_at: number }
      ).public_next_at;
      commit(() => {
        d.prepare(
          "UPDATE ai_content SET retry_after=? WHERE source_key=? AND generation=?",
        ).run(next, source!.source_key, generation);
        return "deferred";
      });
      return;
    }
  }
  try {
    if (job.attempts > 3) {
      commit(() => {
        d.prepare(
          "UPDATE ai_content SET state='failed',failures=3 WHERE source_key=? AND generation=?",
        ).run(job.target_id, generation);
        return "failed";
      });
      return;
    }
    if (
      source.source_kind === "attachment" ||
      source.source_kind === "form-file"
    ) {
      await extractAttachment(source, job, signal);
      source = sourceFor(job.target_id);
      if (!source || source.generation !== generation || !source.active) {
        commit(() => "cancelled");
        return;
      }
    }
    const text = sourceText(source),
      chunkCount = textChunkCount(text, policy.chunkCapacity);
    if (chunkCount > policy.chunkCapacity) {
      commit(() => {
        d.prepare(
          "UPDATE ai_content SET state='capacity',retry_after=? WHERE source_key=? AND generation=?",
        ).run(Date.now() + 60_000, source!.source_key, generation);
        return "capacity";
      });
      return;
    }
    const hash = fingerprint(text);
    const configuration = d
      .prepare("SELECT vocabulary_generation FROM ai_configuration WHERE id=1")
      .get() as { vocabulary_generation: number };
    const previous = d
      .prepare("SELECT * FROM ai_content WHERE source_key=?")
      .get(source.source_key) as {
      fingerprint: string;
      model_version: string;
      indexed_generation: number;
    };
    let vectors: Float32Array[] = [];
    let reused = false;
    if (
      previous.fingerprint === hash &&
      previous.model_version === modelVersion &&
      previous.indexed_generation === generation
    ) {
      vectors = (
        d
          .prepare(
            "SELECT embedding FROM ai_chunks WHERE source_key=? AND model_version=? AND modality='text' AND dimensions=384 ORDER BY ordinal",
          )
          .all(source.source_key, modelVersion) as { embedding: Buffer }[]
      ).map((row) => vector(row.embedding));
    }
    reused = vectors.length === chunkCount && previous.fingerprint === hash;
    if (!reused) {
      const used = (
        d
          .prepare(
            "SELECT chunk_count-(SELECT count(*) FROM ai_chunks WHERE source_key=?) AS n FROM ai_configuration WHERE id=1",
          )
          .get(source.source_key) as { n: number }
      ).n;
      if (used + chunkCount > policy.chunkCapacity) {
        commit(() => {
          d.prepare(
            "UPDATE ai_content SET state='capacity',retry_after=? WHERE source_key=? AND generation=?",
          ).run(Date.now() + 60_000, source!.source_key, generation);
          return "capacity";
        });
        return;
      }
      vectors = [];
      for (const chunk of textChunks(text)) {
        if (signal?.aborted || Date.now() > deadline)
          throw new Error("Indexing deadline exceeded.");
        vectors.push(
          await aiOperation((worker) => worker.encode(chunk), deadline),
        );
      }
    }
    const mean = new Float32Array(384);
    for (const v of vectors)
      for (let i = 0; i < 384; i++) mean[i] += v[i] / vectors.length;
    const norm = Math.hypot(...mean);
    if (norm) for (let i = 0; i < 384; i++) mean[i] /= norm;
    const vocabulary = (
      d.prepare("SELECT id,name,aliases FROM tags ORDER BY name,id").all() as {
        id: string;
        name: string;
        aliases: string;
      }[]
    ).map((tag) => ({ ...tag, aliases: JSON.parse(tag.aliases) as string[] }));
    const scored: { tag: TagVocabulary; score: number; support: number }[] = [];
    for (const candidate of tagCandidates(text, vocabulary)) {
      if (signal?.aborted || Date.now() > deadline)
        throw new Error("Indexing deadline exceeded.");
      const label = await aiOperation(
          (worker) =>
            worker.encode(
              candidate.tag.name + ": " + candidate.tag.aliases.join(" "),
            ),
          deadline,
        ),
        score = cosine(mean, label);
      if (score >= policy.semanticThreshold)
        scored.push({ ...candidate, score });
    }
    scored.sort(
      (a, b) =>
        b.score - a.score ||
        b.support - a.support ||
        a.tag.name.localeCompare(b.tag.name),
    );
    commit(() => {
      const current = sourceFor(job.target_id);
      if (
        !aiEnabled() ||
        !current?.active ||
        current.owner_id !== job.owner_id ||
        current.generation !== generation ||
        fingerprint(sourceText(current)) !== hash
      )
        return "cancelled";
      if (
        (
          d
            .prepare(
              "SELECT vocabulary_generation AS n FROM ai_configuration WHERE id=1",
            )
            .get() as { n: number }
        ).n !== configuration.vocabulary_generation
      )
        return "cancelled";
      const used = (
        d
          .prepare(
            "SELECT chunk_count-(SELECT count(*) FROM ai_chunks WHERE source_key=?) AS n FROM ai_configuration WHERE id=1",
          )
          .get(current.source_key) as { n: number }
      ).n;
      if (used + chunkCount > policy.chunkCapacity) {
        d.prepare(
          "UPDATE ai_content SET state='capacity',retry_after=? WHERE source_key=?",
        ).run(Date.now() + 60_000, current.source_key);
        return "capacity";
      }
      if (!reused) {
        d.prepare("DELETE FROM ai_chunks WHERE source_key=?").run(
          current.source_key,
        );
        const insert = d.prepare(
          "INSERT INTO ai_chunks(source_key,ordinal,generation,model_version,title,text,embedding) VALUES(?,?,?,?,?,?,?)",
        );
        let ordinal = 0;
        for (const chunk of textChunks(text)) {
          insert.run(
            current.source_key,
            ordinal,
            generation,
            modelVersion,
            current.title,
            chunk,
            bytes(vectors[ordinal]),
          );
          ordinal++;
        }
      }
      d.prepare(
        "UPDATE ai_content SET pending=0,state=?,owner_id=?,item_kind=?,item_id=?,fingerprint=?,model_version=?,indexed_generation=?,vocabulary_generation=?,failures=0,retry_after=0 WHERE source_key=?",
      ).run(
        chunkCount ? "indexed" : "empty",
        current.owner_id,
        current.item_kind,
        current.item_id,
        hash,
        modelVersion,
        generation,
        configuration.vocabulary_generation,
        current.source_key,
      );
      d.prepare("DELETE FROM ai_suggestions WHERE source_key=?").run(
        current.source_key,
      );
      const proposal = scored.find(
        (candidate) =>
          !d
            .prepare(
              "SELECT 1 FROM ai_decisions WHERE source_key=? AND fingerprint=? AND tag_id=? AND tag_fingerprint=? AND decision=?",
            )
            .get(
              current.source_key,
              hash,
              candidate.tag.id,
              fingerprint(
                candidate.tag.name.normalize("NFKC").trim().toLowerCase(),
              ),
              "rejected",
            ) &&
          !d
            .prepare(
              `SELECT 1 FROM ${current.item_kind}_tags WHERE ${current.item_kind}_id=? AND tag_id=?`,
            )
            .get(current.item_id, candidate.tag.id),
      );
      if (proposal)
        d.prepare("INSERT INTO ai_suggestions VALUES(?,?,?,?,?,?,?,?,?)").run(
          current.source_key,
          randomUUID(),
          generation,
          hash,
          proposal.score,
          modelVersion,
          configuration.vocabulary_generation,
          proposal.tag.id,
          Date.now(),
        );
      return "indexed";
    });
  } catch {
    commit(() => {
      if (!aiEnabled() || signal?.aborted) return "cancelled";
      d.prepare(
        "UPDATE ai_content SET state='failed',failures=failures+1,retry_after=? WHERE source_key=? AND generation=?",
      ).run(Date.now() + 300_000, job.target_id, generation);
      return "failed";
    });
  } finally {
    if (publicReservation) {
      const now = Date.now();
      d.prepare(
        "UPDATE ai_configuration SET public_next_at=? WHERE id=1 AND public_next_at=?",
      ).run(
        Math.max(started + 1000, now + 9 * (now - started)),
        publicReservation,
      );
    }
  }
}
