import { invalidateCalendarReminders } from "./calendar-reminders";
import { restoreFormTrash, deleteFormTrash } from "./form-trash";
import { sqlite } from "./db";
import { HttpError } from "./http";
import { storage } from "./storage";
import { revokePublication } from "./publications";
import { completionEvent, enqueueJob, startJobWorker } from "./jobs";
import { decodeCursor, encodeCursor } from "./pagination";
import { journalKindSql } from "./journal-classification";
import type { Page, TrashItem, TrashKind } from "../types";

const tables = {
  note: "notes",
  journal: "notes",
  task: "tasks",
  bookmark: "bookmarks",
  artifact: "artifacts",
  event: "calendar_events",
} as const;
const union = `SELECT id,${journalKindSql("notes")} AS kind,title,substr(text,1,180) AS excerpt,revision,trashed_at AS trashedAt FROM notes WHERE owner_id=? AND trashed_at IS NOT NULL AND kind='note'
UNION ALL SELECT id,'task',title,title,revision,trashed_at FROM tasks WHERE owner_id=? AND trashed_at IS NOT NULL
UNION ALL SELECT id,'bookmark',title,url,revision,trashed_at FROM bookmarks WHERE owner_id=? AND trashed_at IS NOT NULL
UNION ALL SELECT id,'artifact',coalesce(nullif(title,''),nullif(name,''),'Untitled artifact'),substr(content,1,180),revision,trashed_at FROM artifacts WHERE owner_id=? AND trashed_at IS NOT NULL
UNION ALL SELECT id,'event',title,substr(description,1,180),revision,trashed_at FROM calendar_events WHERE owner_id=? AND trashed_at IS NOT NULL
UNION ALL SELECT id,'form',title,substr(description,1,180),revision,trashed_at FROM forms WHERE owner_id=? AND trashed_at IS NOT NULL
UNION ALL SELECT r.id,'form_response',f.title,substr(r.search_text,1,180),r.revision,r.trashed_at FROM form_responses r JOIN forms f ON f.id=r.form_id WHERE f.owner_id=? AND r.trashed_at IS NOT NULL`;
export function listTrash(
  owner: string,
  query: string,
  kind?: TrashKind,
  after?: string | null,
  pageSize = 60,
): Page<TrashItem> {
  const where = ["1=1"];
  const values: (string | number)[] = [
    owner,
    owner,
    owner,
    owner,
    owner,
    owner,
    owner,
  ];
  if (query.trim()) {
    where.push("instr(nivra_fold(title || ' ' || excerpt),nivra_fold(?))>0");
    values.push(query.trim().slice(0, 300));
  }
  if (kind) {
    where.push("kind=?");
    values.push(kind);
  }
  const cursor = decodeCursor(after ?? null, ["number", "string", "string"]);
  if (cursor) {
    where.push("(trashedAt<? OR (trashedAt=? AND (id,kind)>(?,?)))");
    values.push(cursor[0], cursor[0], cursor[1], cursor[2]);
  }
  const limit = Math.max(1, Math.min(100, Math.trunc(pageSize) || 60));
  const rows = sqlite()
    .prepare(
      `SELECT * FROM (${union}) WHERE ${where.join(" AND ")} ORDER BY trashedAt DESC,id,kind LIMIT ?`,
    )
    .all(...values, limit + 1) as TrashItem[];
  const items = rows.slice(0, limit),
    last = items.at(-1);
  return {
    items,
    next:
      rows.length > limit && last
        ? encodeCursor([last.trashedAt, last.id, last.kind])
        : null,
  };
}
export function moveToTrash(
  owner: string,
  kind: "task" | "bookmark" | "artifact",
  id: string,
  revision: number,
) {
  sqlite()
    .transaction(() => {
      const changed = sqlite()
        .prepare(
          `UPDATE ${tables[kind]} SET trashed_at=?,updated_at=?,revision=revision+1 WHERE id=? AND owner_id=? AND revision=? AND trashed_at IS NULL`,
        )
        .run(Date.now(), Date.now(), id, owner, revision).changes;
      if (!changed)
        throw new HttpError(
          409,
          "This item changed or was removed. Reload its section and try again.",
        );
      if (kind !== "task") {
        sqlite()
          .prepare(
            "UPDATE background_jobs SET state='failed',lease_token=NULL,lease_until=NULL WHERE kind=? AND target_id=? AND owner_id=?",
          )
          .run(kind, id, owner);
        if (kind === "artifact")
          sqlite()
            .prepare(
              "UPDATE background_jobs SET state='failed',lease_token=NULL,lease_until=NULL WHERE kind='thumbnail' AND target_id=? AND owner_id=?",
            )
            .run(id, owner);
      }
      completionEvent(owner, kind === "task" ? "content" : kind, id, "trashed");
    })
    .immediate();
}
export function restoreTrash(
  owner: string,
  kind: TrashKind,
  id: string,
  revision: number,
) {
  if (kind === "form" || kind === "form_response")
    return restoreFormTrash(owner, kind, id, revision);
  sqlite()
    .transaction(() => {
      if (
        kind === "event" &&
        sqlite()
          .prepare(
            "SELECT 1 FROM calendar_exceptions x JOIN calendar_events e ON e.id=x.event_id WHERE x.override_id=? AND e.trashed_at IS NOT NULL",
          )
          .get(id)
      )
        throw new HttpError(
          409,
          "Restore the parent series before this occurrence.",
        );
      const previous =
        kind === "event"
          ? (sqlite()
              .prepare(
                "SELECT trashed_at FROM calendar_events WHERE id=? AND owner_id=? AND revision=?",
              )
              .get(id, owner, revision) as { trashed_at: number } | undefined)
          : undefined;
      const changed = sqlite()
        .prepare(
          `UPDATE ${tables[kind]} SET trashed_at=NULL,updated_at=?,revision=revision+1 WHERE id=? AND owner_id=? AND revision=? AND trashed_at IS NOT NULL`,
        )
        .run(Date.now(), id, owner, revision).changes;
      if (!changed)
        throw new HttpError(
          409,
          "This item changed or is no longer in Trash. Reload Trash and try again.",
        );
      if (kind === "event" && previous)
        sqlite()
          .prepare(
            "UPDATE calendar_events SET trashed_at=NULL,updated_at=?,revision=revision+1 WHERE owner_id=? AND trashed_at=? AND id IN (SELECT override_id FROM calendar_exceptions WHERE event_id=?)",
          )
          .run(Date.now(), owner, previous.trashed_at, id);
      if (kind === "artifact" || kind === "bookmark") {
        const field = kind === "artifact" ? "extraction" : "metadata_status";
        if (
          sqlite()
            .prepare(
              `SELECT 1 FROM ${tables[kind]} WHERE id=? AND ${field}='pending'`,
            )
            .get(id)
        )
          enqueueJob(owner, kind, id);
        if (
          kind === "artifact" &&
          sqlite()
            .prepare(
              "SELECT 1 FROM artifacts WHERE id=? AND thumbnail_status='pending'",
            )
            .get(id)
        )
          enqueueJob(owner, "thumbnail", id);
        completionEvent(owner, kind, id, "restored");
      }
    })
    .immediate();
  if (kind === "event" || kind === "task") {
    invalidateCalendarReminders();
    completionEvent(owner, "content", id, "restored");
  }
  startJobWorker();
}
export async function deleteTrash(
  owner: string,
  kind: TrashKind,
  id: string,
  revision: number,
) {
  if (kind === "form" || kind === "form_response")
    return deleteFormTrash(owner, kind, id, revision);
  if (kind === "note" || kind === "journal") {
    const note = sqlite()
      .prepare(
        "SELECT 1 FROM notes WHERE id=? AND owner_id=? AND revision=? AND trashed_at IS NOT NULL",
      )
      .get(id, owner, revision);
    if (!note)
      throw new HttpError(
        409,
        "This item changed or is no longer in Trash. Reload Trash and try again.",
      );
    await revokePublication(id);
  }
  const keys = sqlite()
    .transaction(() => {
      const row = sqlite()
        .prepare(
          `SELECT * FROM ${tables[kind]} WHERE id=? AND owner_id=? AND revision=? AND trashed_at IS NOT NULL`,
        )
        .get(id, owner, revision) as Record<string, unknown> | undefined;
      if (!row)
        throw new HttpError(
          409,
          "This item changed or is no longer in Trash. Reload Trash and try again.",
        );
      const keys =
        kind === "note" || kind === "journal"
          ? (
              sqlite()
                .prepare("SELECT storage_key FROM attachments WHERE note_id=?")
                .all(id) as { storage_key: string }[]
            ).map((r) => r.storage_key)
          : [
              row.storage_key,
              row.thumb_key,
              row.thumbnail_key,
              row.icon_key,
            ].filter((k): k is string => typeof k === "string");
      if (kind === "task")
        sqlite()
          .prepare(
            "UPDATE tasks SET parent_task_id=NULL,revision=revision+1,updated_at=? WHERE owner_id=? AND parent_task_id=?",
          )
          .run(Date.now(), owner, id);
      sqlite()
        .prepare(
          `DELETE FROM ${tables[kind]} WHERE id=? AND owner_id=? AND revision=? AND trashed_at IS NOT NULL`,
        )
        .run(id, owner, revision);
      if (kind === "artifact" || kind === "bookmark") {
        sqlite()
          .prepare(
            "DELETE FROM background_jobs WHERE kind=? AND target_id=? AND owner_id=?",
          )
          .run(kind, id, owner);
        completionEvent(owner, kind, id, "deleted");
      }
      return keys;
    })
    .immediate();
  if (kind === "event" || kind === "task") {
    invalidateCalendarReminders();
    completionEvent(owner, "content", id, "deleted");
  }
  await Promise.allSettled(keys.map((key) => storage.delete(key)));
}
