import { randomUUID } from "node:crypto";
import { sqlite } from "./db";
import { queueSemanticWork, canIndexLocally, stopAi } from "./ai/indexer";

export type JobKind = "artifact" | "bookmark" | "thumbnail" | "semantic";
export type Job = {
  id: string;
  owner_id: string;
  kind: JobKind;
  target_id: string;
  attempts: number;
  lease_token: string;
  generation?: number | null;
};
export type JobContext = {
  job: Job;
  commit: (write: () => string) => boolean;
  signal?: AbortSignal;
};
export const maxAttempts = 3;
const leaseMs = 120_000;
const state = globalThis as unknown as {
  nivraJobs?: {
    timer?: ReturnType<typeof setInterval>;
    active: Set<Promise<void>>;
    activeKinds?: Map<Promise<void>, JobKind>;
    activeJobs?: Map<Promise<void>, { job: Job; controller: AbortController }>;
    stopped: boolean;
  };
};
const runner = (state.nivraJobs ||= { active: new Set(), stopped: false });
const activeJobs = (runner.activeJobs ||= new Map<
  Promise<void>,
  { job: Job; controller: AbortController }
>());
const activeKinds = (runner.activeKinds ||= new Map());

export function enqueueJob(owner: string, kind: JobKind, target: string) {
  const now = Date.now();
  sqlite()
    .prepare(
      `INSERT INTO background_jobs(id,owner_id,kind,target_id,available_at,created_at,generation) VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(kind,target_id) DO UPDATE SET state='queued',attempts=0,available_at=excluded.available_at,lease_token=NULL,lease_until=NULL,generation=excluded.generation
    WHERE background_jobs.state IN ('done','failed')`,
    )
    .run(
      randomUUID(),
      owner,
      kind,
      target,
      now,
      now,
      kind === "semantic"
        ? ((
            sqlite()
              .prepare("SELECT generation FROM ai_content WHERE source_key=?")
              .get(target) as { generation: number } | undefined
          )?.generation ?? null)
        : null,
    );
}
export function completionEvent(
  owner: string,
  kind:
    Exclude<JobKind, "thumbnail" | "semantic"> | "backup" | "content" | "ai",
  target: string,
  status: string,
) {
  sqlite()
    .prepare(
      "INSERT INTO completion_events(owner_id,kind,target_id,status,created_at) VALUES(?,?,?,?,?)",
    )
    .run(owner, kind, target, status, Date.now());
  sqlite()
    .prepare(
      "DELETE FROM completion_events WHERE id <= (SELECT coalesce(max(id),0)-1000 FROM completion_events)",
    )
    .run();
}
export function claimJob(
  now = Date.now(),
  preferredKind?: JobKind,
  allowSemantic = true,
): Job | undefined {
  const database = sqlite();
  const next = database.prepare(
    `SELECT * FROM background_jobs
     WHERE (? OR kind<>'semantic')
       AND kind<>'article'
       AND ((state='queued' AND available_at<=?) OR (state='running' AND lease_until<=?))
     ORDER BY CASE WHEN kind='thumbnail' THEN 0 WHEN kind=? THEN 1 ELSE 2 END,available_at,created_at LIMIT 1`,
  );
  const args = [Number(allowSemantic), now, now, preferredKind ?? null];
  // The worker polls every second; an idle poll must not take the write lock.
  if (!next.get(...args)) return;
  return database
    .transaction(() => {
      const row = next.get(...args) as Job | undefined;
      if (!row) return;
      const token = randomUUID();
      sqlite()
        .prepare(
          "UPDATE background_jobs SET state='running',attempts=attempts+1,lease_token=?,lease_until=? WHERE id=?",
        )
        .run(token, now + leaseMs, row.id);
      return { ...row, attempts: row.attempts + 1, lease_token: token };
    })
    .immediate();
}
export function commitJob(job: Job, write: () => string) {
  return sqlite()
    .transaction(() => {
      if (
        !sqlite()
          .prepare(
            "SELECT 1 FROM background_jobs WHERE id=? AND state='running' AND lease_token=? AND lease_until>?",
          )
          .get(job.id, job.lease_token, Date.now())
      )
        return false;
      const status = write();
      sqlite()
        .prepare(
          "UPDATE background_jobs SET state=?,lease_token=NULL,lease_until=NULL WHERE id=?",
        )
        .run(
          status === "failed" || status === "unavailable" ? "failed" : "done",
          job.id,
        );
      const formFile =
        job.kind === "thumbnail"
          ? (sqlite()
              .prepare(
                "SELECT ff.form_id AS formId FROM form_files ff JOIN forms f ON f.id=ff.form_id WHERE ff.id=? AND f.owner_id=?",
              )
              .get(job.target_id, job.owner_id) as
              { formId: string } | undefined)
          : undefined;
      completionEvent(
        job.owner_id,
        formFile
          ? "content"
          : job.kind === "semantic"
            ? "ai"
            : job.kind === "thumbnail"
              ? "artifact"
              : job.kind,
        formFile ? formFile.formId : job.target_id,
        formFile ? "forms" : status,
      );
      return true;
    })
    .immediate();
}
async function execute(job: Job, signal: AbortSignal) {
  const heartbeat = setInterval(() => {
    sqlite()
      .prepare(
        "UPDATE background_jobs SET lease_until=? WHERE id=? AND state='running' AND lease_token=? AND lease_until>?",
      )
      .run(Date.now() + leaseMs, job.id, job.lease_token, Date.now());
  }, 30_000);
  heartbeat.unref();
  try {
    if (job.kind !== "semantic" && job.attempts > maxAttempts)
      throw new Error("Job retry limit reached.");
    const context = {
      job,
      signal,
      commit: (write: () => string) => commitJob(job, write),
    };
    if (job.kind === "semantic")
      await (await import("./ai/indexer")).processSemantic(context);
    else if (job.kind === "artifact")
      await (await import("./artifact-processing")).processArtifact(context);
    else
      await (
        await import("./storage-operations")
      ).storageOperation(async () => {
        if (job.kind === "thumbnail")
          await (
            await import("./artifact-thumbnails")
          ).processThumbnail(context);
        else await (await import("./bookmarks")).processBookmark(context);
      });
  } catch {
    if (signal.aborted) {
      sqlite()
        .prepare(
          "UPDATE background_jobs SET state='queued',available_at=?,lease_token=NULL,lease_until=NULL WHERE id=? AND lease_token=?",
        )
        .run(Date.now(), job.id, job.lease_token);
      return;
    }
    if (job.attempts >= maxAttempts) {
      commitJob(job, () => {
        if (job.kind === "semantic") return "failed";
        if (job.kind === "artifact")
          sqlite()
            .prepare(
              "UPDATE artifacts SET extraction='failed',updated_at=? WHERE id=? AND owner_id=? AND extraction='pending' AND trashed_at IS NULL",
            )
            .run(Date.now(), job.target_id, job.owner_id);
        else if (job.kind === "thumbnail")
          sqlite()
            .prepare(
              "UPDATE artifacts SET thumbnail_status='failed',updated_at=? WHERE id=? AND owner_id=? AND thumbnail_status='pending' AND trashed_at IS NULL",
            )
            .run(Date.now(), job.target_id, job.owner_id);
        else
          sqlite()
            .prepare(
              "UPDATE bookmarks SET metadata_status='unavailable',updated_at=? WHERE id=? AND owner_id=? AND metadata_status='pending' AND trashed_at IS NULL",
            )
            .run(Date.now(), job.target_id, job.owner_id);
        if (job.kind === "thumbnail")
          sqlite()
            .prepare(
              "UPDATE form_files SET thumbnail_status='failed' WHERE id=? AND thumbnail_status='pending' AND EXISTS(SELECT 1 FROM forms WHERE id=form_files.form_id AND owner_id=?)",
            )
            .run(job.target_id, job.owner_id);
        return "failed";
      });
    } else
      sqlite()
        .prepare(
          "UPDATE background_jobs SET state='queued',available_at=?,lease_token=NULL,lease_until=NULL WHERE id=? AND lease_token=?",
        )
        .run(Date.now() + job.attempts * 1000, job.id, job.lease_token);
  } finally {
    clearInterval(heartbeat);
  }
}
export function wakeJobs() {
  if (runner.stopped) return;
  queueSemanticWork();
  while (runner.active.size < 2) {
    const preferred = [...activeKinds.values()].includes("bookmark")
      ? "artifact"
      : "bookmark";
    const job = claimJob(Date.now(), preferred, canIndexLocally());
    if (!job) break;
    const controller = new AbortController();
    const work = execute(job, controller.signal).finally(() => {
      runner.active.delete(work);
      activeKinds.delete(work);
      activeJobs.delete(work);
    });
    runner.active.add(work);
    activeKinds.set(work, job.kind);
    activeJobs.set(work, { job, controller });
  }
}
export function startJobWorker() {
  runner.stopped = false;
  runner.timer ||= setInterval(wakeJobs, 1000);
  runner.timer.unref();
}
export async function jobsIdle() {
  startJobWorker();
  while (
    runner.active.size ||
    sqlite()
      .prepare(
        "SELECT 1 FROM background_jobs WHERE state IN ('queued','running') AND kind<>'article' LIMIT 1",
      )
      .get()
  ) {
    wakeJobs();
    if (runner.active.size) await Promise.all([...runner.active]);
    else await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
export async function stopJobWorker() {
  runner.stopped = true;
  clearInterval(runner.timer);
  runner.timer = undefined;
  for (const entry of activeJobs.values()) entry.controller.abort();
  await stopAi();
  await Promise.race([
    Promise.allSettled([...runner.active]),
    new Promise((resolve) => {
      const timer = setTimeout(resolve, 5000);
      timer.unref();
    }),
  ]);
  for (const { job } of activeJobs.values())
    sqlite()
      .prepare(
        "UPDATE background_jobs SET state='queued',lease_token=NULL,lease_until=NULL,available_at=? WHERE id=? AND state='running' AND lease_token=?",
      )
      .run(Date.now(), job.id, job.lease_token);
}
