import { randomUUID } from "node:crypto";
import path from "node:path";
import type Database from "better-sqlite3";
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
import { hasOwnerTagCorrection, prepareAdaptiveTagMatch } from "./matching";
import { policy } from "./policy";
import { processIndexedTagging } from "./tagging";
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

export function refreshIndexedTaggingQueue(database: Database.Database) {
  return database
    .transaction(() => {
      const revisions = database
        .prepare(
          "SELECT learned_tag_revision,matcher_queue_revision FROM ai_configuration WHERE id=1",
        )
        .get() as {
        learned_tag_revision: number;
        matcher_queue_revision: number;
      };
      if (revisions.learned_tag_revision === revisions.matcher_queue_revision)
        return false;
      database
        .prepare(
          "UPDATE ai_content SET pending=1,failures=0,retry_after=0 WHERE state='indexed' AND pending=0",
        )
        .run();
      database
        .prepare(
          "UPDATE ai_configuration SET matcher_queue_revision=learned_tag_revision WHERE id=1 AND learned_tag_revision=?",
        )
        .run(revisions.learned_tag_revision);
      return true;
    })
    .immediate();
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
  refreshIndexedTaggingQueue(d);
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
  const reviewedResponse =
    source.item_kind === "response" &&
    Boolean(
      d
        .prepare(
          "SELECT 1 FROM form_responses r JOIN forms f ON f.id=r.form_id WHERE r.id=? AND r.reviewed=1 AND r.trashed_at IS NULL AND f.owner_id=? AND f.trashed_at IS NULL",
        )
        .get(source.item_id, source.owner_id),
    );
  if (source.item_kind === "response" && !reviewedResponse) {
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
    const preparation =
      chunkCount &&
      norm &&
      (source.item_kind !== "response" || reviewedResponse)
        ? await prepareAdaptiveTagMatch({
            ownerId: job.owner_id,
            sourceKey: source.source_key,
            sourceFingerprint: hash,
            itemKind: source.item_kind,
            itemId: source.item_id,
            text,
            meanVector: mean,
            deadline,
            signal,
            encode: (label, labelDeadline) =>
              aiOperation(
                (worker) =>
                  worker.encode(
                    label,
                    false,
                    Math.max(1, labelDeadline - Date.now()),
                  ),
                labelDeadline,
              ),
          })
        : {
            ready: true as const,
            learnedRevision: (
              d
                .prepare(
                  "SELECT learned_tag_revision FROM ai_configuration WHERE id=1",
                )
                .get() as { learned_tag_revision: number }
            ).learned_tag_revision,
          };
    const committed = commit(() => {
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
        "UPDATE ai_content SET pending=1,state=?,owner_id=?,item_kind=?,item_id=?,fingerprint=?,model_version=?,indexed_generation=?,vocabulary_generation=?,failures=0,retry_after=0 WHERE source_key=?",
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
      const revision = (
        d
          .prepare(
            "SELECT learned_tag_revision FROM ai_configuration WHERE id=1",
          )
          .get() as { learned_tag_revision: number }
      ).learned_tag_revision;
      const reviewedNow =
        current.item_kind !== "response" ||
        Boolean(
          d
            .prepare(
              "SELECT 1 FROM form_responses r JOIN forms f ON f.id=r.form_id WHERE r.id=? AND r.reviewed=1 AND r.trashed_at IS NULL AND f.owner_id=? AND f.trashed_at IS NULL",
            )
            .get(current.item_id, current.owner_id),
        );
      const reviewStable =
        current.item_kind !== "response" || reviewedResponse === reviewedNow;
      const ownerCorrection = hasOwnerTagCorrection(current.source_key, hash);
      if (
        reviewStable &&
        reviewedNow &&
        !ownerCorrection &&
        preparation.ready &&
        revision === preparation.learnedRevision &&
        preparation.match
      ) {
        const tag = preparation.match.tag;
        const tagFingerprint = fingerprint(
          tag.name.normalize("NFKC").trim().toLowerCase(),
        );
        const rejected = d
          .prepare(
            "SELECT 1 FROM ai_decisions WHERE source_key=? AND fingerprint=? AND tag_id=? AND tag_fingerprint=? AND decision='rejected'",
          )
          .get(current.source_key, hash, tag.id, tagFingerprint);
        const assigned = d
          .prepare(
            `SELECT 1 FROM ${current.item_kind}_tags WHERE ${current.item_kind}_id=? AND tag_id=?`,
          )
          .get(current.item_id, tag.id);
        if (!rejected && !assigned) {
          d.prepare("INSERT INTO ai_suggestions VALUES(?,?,?,?,?,?,?,?,?)").run(
            current.source_key,
            randomUUID(),
            generation,
            hash,
            preparation.match.score,
            modelVersion,
            configuration.vocabulary_generation,
            tag.id,
            Date.now(),
          );
        }
      }
      d.prepare("UPDATE ai_content SET pending=? WHERE source_key=?").run(
        reviewStable &&
          preparation.ready &&
          revision === preparation.learnedRevision
          ? 0
          : 1,
        current.source_key,
      );
      return "indexed";
    });
    if (!committed) return;
    if (
      preparation.ready &&
      !preparation.ownerCorrection &&
      !hasOwnerTagCorrection(source.source_key, hash) &&
      (source.item_kind !== "response" || reviewedResponse) &&
      (
        d
          .prepare(
            "SELECT learned_tag_revision FROM ai_configuration WHERE id=1",
          )
          .get() as { learned_tag_revision: number }
      ).learned_tag_revision === preparation.learnedRevision &&
      chunkCount > 0
    ) {
      let result: "processed" | "stale" = "stale";
      try {
        result = processIndexedTagging({
          ownerId: job.owner_id,
          sourceKey: source.source_key,
          generation,
          fingerprint: hash,
          itemKind: source.item_kind as
            | "note"
            | "task"
            | "bookmark"
            | "artifact"
            | "event"
            | "form"
            | "response",
          itemId: source.item_id,
          text,
          meanVector: mean,
          matches: preparation.match
            ? [
                {
                  tagId: preparation.match.tag.id,
                  score: preparation.match.score,
                  support: preparation.match.support,
                  automaticEligible: preparation.match.automaticEligible,
                  origin: preparation.match.origin,
                },
              ]
            : [],
          learnedRevision: preparation.learnedRevision,
        });
      } catch {
        result = "stale";
      }
      if (result === "stale")
        d.prepare(
          "UPDATE ai_content SET pending=1 WHERE source_key=? AND state='indexed' AND generation=? AND indexed_generation=? AND fingerprint=?",
        ).run(source.source_key, generation, generation, hash);
    }
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
