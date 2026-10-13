import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { sqlite } from "./db";
import { HttpError } from "./http";
import { completionEvent } from "./jobs";
import { ftsQuery } from "./validation";
import { fingerprint, sourceFor, sourceText } from "./ai/content";
import { journalPeriodSql } from "./journal-classification";
import type { Tag, TaggedItem } from "../types";

export const taggedTypes = [
  "note",
  "task",
  "bookmark",
  "artifact",
  "event",
  "form",
] as const;
export type TaggedType = (typeof taggedTypes)[number] | "response";
const tables = {
  note: "notes",
  task: "tasks",
  bookmark: "bookmarks",
  artifact: "artifacts",
  event: "calendar_events",
  form: "forms",
  response: "form_responses",
} as const;
export function itemTags(type: TaggedType, id: string): Tag[] {
  return sqlite()
    .prepare(
      `SELECT t.id,t.name,t.color,t.aliases FROM tags t JOIN ${type}_tags it ON it.tag_id=t.id WHERE it.${type}_id=? ORDER BY t.name`,
    )
    .all(id)
    .map((row) => {
      const tag = row as Tag & { aliases: string };
      const { aliases, ...rest } = tag;
      const words = JSON.parse(aliases) as string[];
      return { ...rest, ...(words.length ? { aliases: words } : {}) };
    });
}
export function itemTagState(owner: string, type: TaggedType, id: string) {
  const row = sqlite()
    .prepare(
      type === "response"
        ? "SELECT r.revision FROM form_responses r JOIN forms f ON f.id=r.form_id WHERE r.id=? AND f.owner_id=? AND r.trashed_at IS NULL AND f.trashed_at IS NULL"
        : `SELECT revision FROM ${tables[type]} WHERE id=? AND owner_id=? AND trashed_at IS NULL`,
    )
    .get(id, owner) as { revision: number } | undefined;
  if (!row) throw new HttpError(404, "This item was not found.");
  return { revision: row.revision, tags: itemTags(type, id) };
}
export function assignItemTags(
  owner: string,
  type: TaggedType,
  id: string,
  revision: number,
  tags: string[],
) {
  const d = sqlite();
  return d
    .transaction(() => {
      const current = itemTagState(owner, type, id);
      if (current.revision !== revision)
        throw new HttpError(
          409,
          "This item changed. Reload its tags and try again.",
        );
      const unique = [...new Set(tags)];
      for (const tag of unique)
        if (!d.prepare("SELECT 1 FROM tags WHERE id=?").get(tag))
          throw new HttpError(400, "A selected tag no longer exists.");
      const before = new Set(current.tags.map((tag) => tag.id));
      const after = new Set(unique);
      const added = new Set([...after].filter((tag) => !before.has(tag)));
      const removed = new Set([...before].filter((tag) => !after.has(tag)));
      const remove = d.prepare(
        `DELETE FROM ${type}_tags WHERE ${type}_id=? AND tag_id=?`,
      );
      for (const tag of removed) remove.run(id, tag);
      const insert = d.prepare(
        `INSERT INTO ${type}_tags(${type}_id,tag_id) VALUES(?,?)`,
      );
      for (const tag of added) insert.run(id, tag);
      recordAutomationFeedback(d, owner, type, id, added, removed);
      d.prepare(
        type === "response"
          ? "UPDATE form_responses SET revision=revision+1 WHERE id=?"
          : `UPDATE ${tables[type]} SET revision=revision+1,updated_at=? WHERE id=? AND owner_id=?`,
      ).run(...(type === "response" ? [id] : [Date.now(), id, owner]));
      completionEvent(
        owner,
        "content",
        id,
        type === "form" ? "forms" : "changed",
      );
      return itemTagState(owner, type, id);
    })
    .immediate();
}

function recordAutomationFeedback(
  d: ReturnType<typeof sqlite>,
  owner: string,
  type: TaggedType,
  id: string,
  added: Set<string>,
  removed: Set<string>,
) {
  if (!added.size && !removed.size) return false;
  let changed = false;
  if (added.size) {
    const promote = d.prepare(
      `UPDATE ai_auto_assignments SET approved=1
       WHERE approved=0 AND tag_id IN (${[...added].map(() => "?").join(",")})
         AND source_key IN (
           SELECT source_key FROM ai_sources
           WHERE owner_id=? AND item_kind=? AND item_id=? AND active=1
         )`,
    );
    changed = promote.run(...added, owner, type, id).changes > 0 || changed;
  }

  const write = d.prepare(
    "INSERT OR IGNORE INTO ai_decisions(source_key,fingerprint,tag_id,tag_fingerprint,decision,created_at) VALUES(?,?,?,?,?,?)",
  );
  const now = Date.now();
  const tagName = d.prepare("SELECT name FROM tags WHERE id=?");
  const sources = currentIndexedSources(d, owner, type, id);
  for (const [ids, decision] of [
    [added, "accepted"],
    [removed, "rejected"],
  ] as const) {
    for (const tagId of ids) {
      const tag = tagName.get(tagId) as { name: string } | undefined;
      if (!tag) continue;
      const tagFingerprint = fingerprintTagName(tag.name);
      for (const source of sources) {
        d.prepare(
          "DELETE FROM ai_decisions WHERE source_key=? AND fingerprint=? AND tag_id=? AND tag_fingerprint=? AND decision=?",
        ).run(
          source.source_key,
          source.fingerprint,
          tagId,
          tagFingerprint,
          decision === "accepted" ? "rejected" : "accepted",
        );
        write.run(
          source.source_key,
          source.fingerprint,
          tagId,
          tagFingerprint,
          decision,
          now,
        );
      }
    }
  }
  return changed;
}

function currentIndexedSources(
  d: ReturnType<typeof sqlite>,
  owner: string,
  type: TaggedType,
  id: string,
) {
  const rows = d
    .prepare(
      "SELECT s.source_key,c.fingerprint FROM ai_sources s JOIN ai_content c USING(source_key) WHERE s.owner_id=? AND s.item_kind=? AND s.item_id=? AND s.active=1 AND c.state='indexed' AND c.indexed_generation=c.generation AND c.fingerprint IS NOT NULL",
    )
    .all(owner, type, id) as { source_key: string; fingerprint: string }[];
  return rows.filter((row) => {
    const source = sourceFor(row.source_key);
    return Boolean(
      source &&
      source.owner_id === owner &&
      source.item_kind === type &&
      source.item_id === id &&
      source.active &&
      fingerprint(sourceText(source)) === row.fingerprint,
    );
  });
}

export function recordExplicitNoteTagSet(
  owner: string,
  noteId: string,
  desiredTagIds: string[],
) {
  const d = sqlite();
  return d
    .transaction(() => {
      if (
        !d
          .prepare("SELECT 1 FROM notes WHERE id=? AND owner_id=?")
          .get(noteId, owner)
      )
        throw new HttpError(404, "This note was not found.");
      const desired = [...new Set(desiredTagIds)];
      for (const tagId of desired)
        if (!d.prepare("SELECT 1 FROM tags WHERE id=?").get(tagId))
          throw new HttpError(400, "A selected tag no longer exists.");
      const before = new Set(
        (
          d
            .prepare("SELECT tag_id FROM note_tags WHERE note_id=?")
            .all(noteId) as { tag_id: string }[]
        ).map(({ tag_id }) => tag_id),
      );
      const after = new Set(desired);
      const added = new Set([...after].filter((tag) => !before.has(tag)));
      const removed = new Set([...before].filter((tag) => !after.has(tag)));
      recordAutomationFeedback(d, owner, "note", noteId, added, removed);
      return [...added];
    })
    .immediate();
}

function fingerprintTagName(name: string) {
  return fingerprint(name.normalize("NFKC").trim().toLowerCase());
}

export function approveAutomaticItemTag(
  owner: string,
  type: TaggedType,
  id: string,
  tagId: string,
) {
  const d = sqlite();
  return d
    .transaction(() => {
      itemTagState(owner, type, id);
      const rows = d
        .prepare(
          "SELECT aa.source_key,aa.tag_id,c.fingerprint,t.name FROM ai_auto_assignments aa JOIN ai_sources s USING(source_key) JOIN ai_content c USING(source_key) JOIN tags t ON t.id=aa.tag_id WHERE s.owner_id=? AND s.item_kind=? AND s.item_id=? AND s.active=1 AND aa.tag_id=? AND c.state='indexed' AND c.indexed_generation=c.generation AND aa.generation=c.generation AND aa.fingerprint=c.fingerprint",
        )
        .all(owner, type, id, tagId) as {
        source_key: string;
        tag_id: string;
        fingerprint: string;
        name: string;
      }[];
      const now = Date.now();
      for (const row of rows) {
        const tagFingerprint = fingerprintTagName(row.name);
        d.prepare(
          "UPDATE ai_auto_assignments SET approved=1 WHERE source_key=? AND tag_id=? AND approved=0",
        ).run(row.source_key, row.tag_id);
        d.prepare(
          "DELETE FROM ai_decisions WHERE source_key=? AND fingerprint=? AND tag_id=? AND tag_fingerprint=? AND decision='rejected'",
        ).run(row.source_key, row.fingerprint, row.tag_id, tagFingerprint);
        d.prepare(
          "INSERT OR IGNORE INTO ai_decisions(source_key,fingerprint,tag_id,tag_fingerprint,decision,created_at) VALUES(?,?,?,?,?,?)",
        ).run(
          row.source_key,
          row.fingerprint,
          row.tag_id,
          tagFingerprint,
          "accepted",
          now,
        );
      }
      return { ok: true };
    })
    .immediate();
}
export function importItemTags(
  type: TaggedType,
  id: string,
  tags: Pick<Tag, "name" | "color" | "aliases">[],
) {
  const d = sqlite();
  for (const tag of tags) {
    d.prepare(
      "INSERT OR IGNORE INTO tags(id,name,color,aliases) VALUES(?,?,?,?)",
    ).run(randomUUID(), tag.name, tag.color, JSON.stringify(tag.aliases ?? []));
    const stored = d
      .prepare("SELECT id FROM tags WHERE name=? COLLATE NOCASE")
      .get(tag.name) as { id: string };
    d.prepare(
      `INSERT OR IGNORE INTO ${type}_tags(${type}_id,tag_id) VALUES(?,?)`,
    ).run(id, stored.id);
  }
}
export function taggedItems(
  owner: string,
  tag: string,
  query: string,
  limit: number,
  offset: number,
) {
  return collectionItems(owner, query, limit, offset, tag);
}
export function favoriteItems(
  owner: string,
  query: string,
  limit: number,
  offset: number,
) {
  return collectionItems(owner, query, limit, offset);
}
function collectionItems(
  owner: string,
  query: string,
  limit: number,
  offset: number,
  tag?: string,
) {
  const d = sqlite();
  return d.transaction(() => {
    if (tag && !d.prepare("SELECT 1 FROM tags WHERE id=?").get(tag))
      throw new HttpError(404, "This tag was not found.");
    const search = ftsQuery(query);
    if (query.trim() && !search) return { items: [], next: null };
    const values: (string | number)[] = [];
    const types: (TaggedType | "journal")[] = tag
      ? [...taggedTypes, "journal", "response"]
      : ["note", "journal", "bookmark", "form"];
    const readers = new Map<string, Database.Statement>();
    const unions = types.map((type) => {
      const storageType = type === "journal" ? "note" : type;
      const table = tables[storageType];
      const timestamp = type === "response" ? "i.created_at" : "i.updated_at";
      const authorization =
        type === "response"
          ? "EXISTS(SELECT 1 FROM forms f WHERE f.id=i.form_id AND f.owner_id=? AND f.trashed_at IS NULL)"
          : "i.owner_id=?";
      const fts = storageType === "event" ? "events_fts" : `${table}_fts`;
      const excerpt =
        storageType === "note"
          ? "substr(i.text,1,180)"
          : storageType === "bookmark" || storageType === "form"
            ? "substr(i.description,1,180)"
            : storageType === "response"
              ? "substr(i.search_text,1,180)"
              : "''";
      const title =
        storageType === "artifact"
          ? "coalesce(nullif(i.name,''),nullif(i.title,''),'Untitled')"
          : storageType === "response"
            ? "(SELECT title FROM forms WHERE id=i.form_id)||' — response'"
            : "i.title";
      const assignmentType = storageType;
      if (tag) values.push(tag);
      values.push(owner);
      if (search) values.push(search);
      const periodFilter =
        storageType === "note"
          ? ` AND i.kind='note' AND ${journalPeriodSql("i")} IS ${type === "journal" ? "NOT " : ""}NULL`
          : "";
      const predicate = `${tag ? `i.id IN(SELECT ${assignmentType}_id FROM ${assignmentType}_tags WHERE tag_id=?) AND` : storageType === "note" || storageType === "bookmark" || storageType === "form" ? "i.favorite=1 AND" : "0=1 AND"} ${authorization} AND i.trashed_at IS NULL${periodFilter} ${search ? `AND i.rowid IN (SELECT rowid FROM ${fts} WHERE ${fts} MATCH ?)` : ""}`;
      const dailyDate = storageType === "note" ? "i.daily_date" : "NULL";
      const period = storageType === "note" ? "i.journal_period" : "NULL";
      const periodStart =
        storageType === "note" ? "i.journal_period_start" : "NULL";
      readers.set(
        type,
        d.prepare(
          `SELECT '${type}' AS type,i.id,${title} AS title,${excerpt} AS excerpt,${timestamp} AS updatedAt,${dailyDate} AS dailyDate,${period} AS journalPeriod,${periodStart} AS journalPeriodStart,${storageType === "note" || storageType === "bookmark" || storageType === "form" ? "i.favorite" : "0"} AS favorite,${storageType === "task" ? "i.completed_at IS NOT NULL" : "0"} AS completed,${storageType === "response" ? "i.form_id" : "NULL"} AS formId FROM ${table} i WHERE i.id=? AND ${authorization} AND i.trashed_at IS NULL${periodFilter}`,
        ),
      );
      return `SELECT '${type}' AS type,i.id,${timestamp} AS updatedAt FROM ${table} i ${storageType === "response" ? "" : `INDEXED BY ${tag ? `${table}_search_order_idx` : `${table}_favorites_order_idx`}`} WHERE ${predicate}`;
    });
    const candidates = d
      .prepare(
        `${unions.join(" UNION ALL ")} ORDER BY updatedAt DESC,type,id LIMIT ? OFFSET ?`,
      )
      .all(...values, limit + 1, offset) as { id: string; type: string }[];
    const rows = candidates.map(
      (row) =>
        readers.get(row.type)!.get(row.id, owner) as Omit<TaggedItem, "tags">,
    );
    const selected = rows.slice(0, limit);
    const linked = new Map<string, Tag[]>();
    for (const type of [
      ...taggedTypes,
      "journal" as const,
      "response" as const,
    ]) {
      const storageType = type === "journal" ? "note" : type;
      const ids = selected
        .filter((row) => row.type === type)
        .map((row) => row.id);
      if (!ids.length) continue;
      const tags = d
        .prepare(
          `SELECT it.${storageType}_id AS itemId,t.id,t.name,t.color FROM ${storageType}_tags it JOIN tags t ON t.id=it.tag_id WHERE it.${storageType}_id IN (${ids.map(() => "?").join(",")}) ORDER BY t.name`,
        )
        .all(...ids) as (Tag & { itemId: string })[];
      for (const { itemId, ...tag } of tags) {
        const key = `${type}:${itemId}`;
        linked.set(key, [...(linked.get(key) || []), tag]);
      }
    }
    return {
      items: selected.map((row) => ({
        ...row,
        ...(row.type !== "response" ? { formId: undefined } : {}),
        favorite: Boolean(row.favorite),
        completed: Boolean(row.completed),
        tags: linked.get(`${row.type}:${row.id}`) || [],
      })),
      next: rows.length > limit ? offset + limit : null,
    };
  })();
}
