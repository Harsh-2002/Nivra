import { sqlite } from "../db";
import { storage } from "../storage";
import { storageOperation } from "../storage-operations";
import { extractFile } from "../extract-file";
import { sourceFor, type AiSource } from "./content";
import type { Job } from "../jobs";
export async function extractAttachment(
  source: AiSource,
  job: Job,
  signal?: AbortSignal,
) {
  const d = sqlite(),
    isNote = source.source_kind === "attachment";
  const file = d
    .prepare(
      isNote
        ? "SELECT storage_key,name,mime FROM attachments WHERE id=?"
        : "SELECT storage_key,filename AS name,mime FROM form_files WHERE id=? AND state=?",
    )
    .get(...(isNote ? [source.source_id] : [source.source_id, "attached"])) as
    { storage_key: string; name: string; mime: string } | undefined;
  if (!file) return;
  const existing = d
    .prepare("SELECT storage_key FROM ai_extractions WHERE source_key=?")
    .get(source.source_key) as { storage_key: string } | undefined;
  if (existing?.storage_key === file.storage_key) return;
  const bytes = await storageOperation(() => storage.read(file.storage_key));
  const result = await extractFile(bytes, file.name, file.mime, signal);
  d.transaction(() => {
    const current = sourceFor(source.source_key);
    if (
      !current?.active ||
      current.generation !== source.generation ||
      !d
        .prepare(
          "SELECT 1 FROM background_jobs WHERE id=? AND state='running' AND lease_token=? AND lease_until>?",
        )
        .get(job.id, job.lease_token, Date.now())
    )
      return;
    d.prepare(
      "INSERT INTO ai_extractions(source_key,storage_key,text,status) VALUES(?,?,?,?) ON CONFLICT(source_key) DO UPDATE SET storage_key=excluded.storage_key,text=excluded.text,status=excluded.status",
    ).run(
      source.source_key,
      file.storage_key,
      result.text,
      result.status === "done" ? "done" : "unavailable",
    );
  }).immediate();
}
