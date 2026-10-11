import { extractFile } from "./extract-file";
import { storageOperation } from "./storage-operations";
import { sqlite } from "./db";
import { storage } from "./storage";
import type { JobContext } from "./jobs";
export async function processArtifact({ job, commit, signal }: JobContext) {
  const row = sqlite()
    .prepare(
      "SELECT storage_key,name,mime FROM artifacts WHERE id=? AND owner_id=? AND extraction='pending' AND trashed_at IS NULL",
    )
    .get(job.target_id, job.owner_id) as
    { storage_key: string; name: string; mime: string } | undefined;
  if (!row) {
    commit(() => "cancelled");
    return;
  }
  const bytes = await storageOperation(() => storage.read(row.storage_key));
  const result = await extractFile(bytes, row.name, row.mime, signal);
  commit(() => {
    sqlite()
      .prepare(
        "UPDATE artifacts SET content=?,extraction=?,updated_at=? WHERE id=? AND owner_id=? AND extraction='pending' AND trashed_at IS NULL",
      )
      .run(result.text, result.status, Date.now(), job.target_id, job.owner_id);
    return result.status;
  });
}
