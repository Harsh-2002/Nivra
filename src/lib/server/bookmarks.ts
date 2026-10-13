import { moveToTrash } from "./trash";
import { itemTags } from "./item-tags";
import { enqueueNewBookmarkArticle } from "./bookmark-reading-service";
import {
  enqueueJob,
  startJobWorker,
  maxAttempts,
  type JobContext,
} from "./jobs";
import { randomUUID } from "node:crypto";
import { db, sqlite } from "./db";
import { bookmarks } from "./schema";
import { and, eq, isNull } from "drizzle-orm";
import { storage } from "./storage";
import { HttpError } from "./http";
import { fuzzyQuery } from "./search";
import { ftsQuery } from "./validation";
import { requireLinkedNote } from "./connections";
import {
  bookmarkUrl,
  fetchPublic,
  imageMime,
  parseMetadata,
} from "./link-metadata";
import type { Bookmark, Page } from "../types";
import { decodeCursor, encodeCursor } from "./pagination";
type Row = {
  id: string;
  trashed_at: number | null;
  owner_id: string;
  url: string;
  title: string;
  description: string;
  site_name: string;
  collection: string;
  favorite: number | boolean;
  read_at: number | null;
  article_status: Bookmark["articleStatus"];
  article_generation: number;
  article_version: number;
  metadata_status: Bookmark["metadataStatus"];
  title_edited: number;
  description_edited: number;
  thumbnail_key: string | null;
  thumbnail_mime: string | null;
  icon_key: string | null;
  icon_mime: string | null;
  revision: number;
  created_at: number;
  updated_at: number;
  note_id: string | null;
};
const fields = {
  id: bookmarks.id,
  trashed_at: bookmarks.trashedAt,
  owner_id: bookmarks.ownerId,
  url: bookmarks.url,
  title: bookmarks.title,
  description: bookmarks.description,
  site_name: bookmarks.siteName,
  collection: bookmarks.collection,
  favorite: bookmarks.favorite,
  read_at: bookmarks.readAt,
  article_status: bookmarks.articleStatus,
  article_generation: bookmarks.articleGeneration,
  article_version: bookmarks.articleVersion,
  metadata_status: bookmarks.metadataStatus,
  title_edited: bookmarks.titleEdited,
  description_edited: bookmarks.descriptionEdited,
  thumbnail_key: bookmarks.thumbnailKey,
  thumbnail_mime: bookmarks.thumbnailMime,
  icon_key: bookmarks.iconKey,
  icon_mime: bookmarks.iconMime,
  revision: bookmarks.revision,
  created_at: bookmarks.createdAt,
  updated_at: bookmarks.updatedAt,
  note_id: bookmarks.noteId,
};
function existing(owner: string, url: string) {
  return db()
    .select({ id: bookmarks.id })
    .from(bookmarks)
    .where(and(eq(bookmarks.ownerId, owner), eq(bookmarks.url, url)))
    .get();
}
function expose(row: Row & { linkedTitle?: string | null }): Bookmark {
  return {
    id: row.id,
    url: row.url,
    title: row.title,
    description: row.description,
    siteName: row.site_name,
    collection: row.collection,
    favorite: !!row.favorite,
    readAt: row.read_at,
    articleStatus: row.article_status,
    articleGeneration: row.article_generation,
    articleVersion: row.article_version,
    metadataStatus: row.metadata_status,
    thumbnail: row.thumbnail_key
      ? `/api/v1/bookmarks/${row.id}/thumbnail`
      : null,
    icon: row.icon_key ? `/api/v1/bookmarks/${row.id}/icon` : null,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    noteId: row.note_id,
    noteTitle:
      row.linkedTitle !== undefined
        ? row.linkedTitle
        : row.note_id
          ? ((
              sqlite()
                .prepare("SELECT title FROM notes WHERE id=?")
                .get(row.note_id) as { title: string } | undefined
            )?.title ?? null)
          : null,
  };
}
function need(owner: string, id: string): Row {
  const row = db()
    .select(fields)
    .from(bookmarks)
    .where(
      and(
        eq(bookmarks.id, id),
        eq(bookmarks.ownerId, owner),
        isNull(bookmarks.trashedAt),
      ),
    )
    .get() as Row | undefined;
  if (!row) throw new HttpError(404, "This bookmark was not found.");
  return row;
}
export type BookmarkQuery = {
  query?: string;
  favorite?: boolean;
  collection?: string;
  unfiled?: boolean;
  readingState?: "all" | "unread" | "read";
};
function bookmarkWhere(owner: string, options: BookmarkQuery, search?: string) {
  const where = ["b.owner_id=?", "b.trashed_at IS NULL"];
  const values: (string | number)[] = [owner];
  if (search !== undefined) {
    const folded = (
      sqlite().prepare("SELECT lower(?) AS term").get(search) as {
        term: string;
      }
    ).term;
    if ([...folded].length >= 3 && !folded.includes("\0")) {
      where.push(
        `(b.rowid IN (SELECT rowid FROM bookmarks_fts WHERE bookmarks_fts MATCH ? UNION SELECT rowid FROM bookmarks_literal_fts WHERE bookmarks_literal_fts MATCH ? AND instr(text,?)>0)
          OR b.id IN (SELECT a.bookmark_id FROM bookmark_articles a WHERE a.owner_id=b.owner_id AND a.rowid IN (SELECT rowid FROM bookmark_articles_fts WHERE bookmark_articles_fts MATCH ?))
          OR b.id IN (SELECT h.bookmark_id FROM bookmark_highlights h WHERE h.owner_id=b.owner_id AND h.rowid IN (SELECT rowid FROM bookmark_highlights_fts WHERE bookmark_highlights_fts MATCH ?)))`,
      );
      values.push(
        ftsQuery(search),
        `"${folded.replaceAll('"', '""')}"`,
        folded,
        ftsQuery(search),
        ftsQuery(search),
      );
    } else {
      where.push(
        `(b.rowid IN (SELECT rowid FROM bookmarks_fts WHERE bookmarks_fts MATCH ?)
          OR instr(lower(b.title || ' ' || b.description || ' ' || b.url || ' ' || b.collection),lower(?))>0
          OR EXISTS(SELECT 1 FROM bookmark_articles a WHERE a.bookmark_id=b.id AND a.owner_id=b.owner_id AND instr(lower(a.title || ' ' || a.plain_text),lower(?))>0)
          OR EXISTS(SELECT 1 FROM bookmark_highlights h WHERE h.bookmark_id=b.id AND h.owner_id=b.owner_id AND instr(lower(h.quote || ' ' || h.annotation),lower(?))>0))`,
      );
      values.push(ftsQuery(search), search, search, search);
    }
  }
  if (options.favorite) where.push("b.favorite=1");
  if (options.readingState === "unread") where.push("b.read_at IS NULL");
  else if (options.readingState === "read") where.push("b.read_at IS NOT NULL");
  if (options.unfiled) where.push("b.collection=''");
  else if (options.collection !== undefined) {
    where.push("b.collection=?");
    values.push(options.collection);
  }
  return { where, values };
}
const bookmarkOrder = "b.created_at DESC,b.id";
function queryBookmarks(
  owner: string,
  options: BookmarkQuery,
  limit?: number,
  after?: (string | number)[],
) {
  const term = (options.query || "").trim().slice(0, 300);
  const run = (match?: string) => {
    const { where, values } = bookmarkWhere(owner, options);
    if (match !== undefined) {
      where.push(
        "b.rowid IN (SELECT rowid FROM bookmarks_fts WHERE bookmarks_fts MATCH ?)",
      );
      values.push(match);
    }
    return { where, values };
  };
  const build = (base: { where: string[]; values: (string | number)[] }) => {
    const where = [...base.where];
    const values = [...base.values];
    if (after) {
      where.push("(b.created_at<? OR (b.created_at=? AND b.id>?))");
      values.push(after[0], after[0], after[1]);
    }
    const database = sqlite();
    const predicate = where.join(" AND ");
    let index = " INDEXED BY bookmarks_page_idx";
    if (term) {
      const candidates = database
        .prepare(
          `SELECT b.rowid FROM bookmarks b NOT INDEXED WHERE ${predicate} LIMIT 513`,
        )
        .all(...values);
      if (candidates.length <= 512) index = " NOT INDEXED";
    }
    if (!limit)
      return database
        .prepare(
          `SELECT b.*,n.title AS linkedTitle FROM bookmarks b${index} LEFT JOIN notes n ON n.id=b.note_id WHERE ${predicate} ORDER BY ${bookmarkOrder}`,
        )
        .all(...values) as Row[];
    return database.transaction(() => {
      const selected = database
        .prepare(
          `SELECT b.id FROM bookmarks b${index} WHERE ${predicate} ORDER BY ${bookmarkOrder} LIMIT ?`,
        )
        .all(...values, limit) as { id: string }[];
      const reader = database.prepare(
        "SELECT b.*,n.title AS linkedTitle FROM bookmarks b LEFT JOIN notes n ON n.id=b.note_id WHERE b.id=? AND b.owner_id=?",
      );
      return selected.map((row) => reader.get(row.id, owner) as Row);
    })();
  };
  const primary = term ? bookmarkWhere(owner, options, term) : run();
  let rows = build(primary);
  if (term && !rows.length && !after) {
    const fallback = fuzzyQuery(term, "bookmarks");
    if (fallback) rows = build(run(fallback));
  }
  return rows;
}
export function getBookmark(owner: string, id: string): Bookmark {
  return expose(need(owner, id));
}
export function listBookmarks(owner: string, query = ""): Bookmark[] {
  return queryBookmarks(owner, { query }).map(expose);
}
export function listBookmarkPage(
  owner: string,
  options: BookmarkQuery & { limit: number; after?: string | null },
): Page<Bookmark> {
  const cursor = decodeCursor(options.after ?? null, ["number", "string"]);
  const rows = queryBookmarks(owner, options, options.limit + 1, cursor);
  const items = rows.slice(0, options.limit);
  const last = items[items.length - 1];
  return {
    items: items.map(expose),
    next:
      rows.length > options.limit && last
        ? encodeCursor([last.created_at, last.id])
        : null,
  };
}
export function bookmarkSummary(owner: string, options: BookmarkQuery) {
  const term = (options.query || "").trim().slice(0, 300);
  const count = (search?: string, match?: string) => {
    const { where, values } = bookmarkWhere(owner, options, search);
    if (match !== undefined) {
      where.push(
        "b.rowid IN (SELECT rowid FROM bookmarks_fts WHERE bookmarks_fts MATCH ?)",
      );
      values.push(match);
    }
    let index = " INDEXED BY bookmarks_active_counts_idx";
    if (search !== undefined || match !== undefined) {
      const candidates = sqlite()
        .prepare(
          `SELECT b.rowid FROM bookmarks b NOT INDEXED WHERE ${where.join(" AND ")} LIMIT 513`,
        )
        .all(...values);
      if (candidates.length <= 512) index = " NOT INDEXED";
    }
    return (
      sqlite()
        .prepare(
          `SELECT COUNT(*) AS n FROM bookmarks b${index} WHERE ${where.join(" AND ")}`,
        )
        .get(...values) as { n: number }
    ).n;
  };
  let total = count(term || undefined);
  if (term && !total) {
    const fallback = fuzzyQuery(term, "bookmarks");
    if (fallback) total = count(undefined, fallback);
  }
  const collections = (
    sqlite()
      .prepare(
        "SELECT DISTINCT collection FROM bookmarks INDEXED BY bookmarks_active_counts_idx WHERE owner_id=? AND trashed_at IS NULL AND collection<>''",
      )
      .all(owner) as { collection: string }[]
  )
    .map((row) => row.collection)
    .sort();
  return { total, collections };
}
async function metadata(url: string) {
  const assets: { key: string; mime: string }[] = [];
  const fallback = {
    title: new URL(url).hostname,
    description: "",
    siteName: new URL(url).hostname,
    metadataStatus: "unavailable" as "ready" | "unavailable",
    thumbnail: null as { key: string; mime: string } | null,
    icon: null as { key: string; mime: string } | null,
  };
  const signal = AbortSignal.timeout(10_000);
  try {
    const page = await fetchPublic(url, 1024 * 1024, signal);
    if (!["text/html", "application/xhtml+xml"].includes(page.type))
      return fallback;
    const info = parseMetadata(page.bytes.toString("utf8"), page.url);
    async function image(value: string) {
      if (!value) return null;
      try {
        const result = await fetchPublic(value, 2 * 1024 * 1024, signal);
        const mime = imageMime(result.bytes);
        if (!mime) return null;
        const key = randomUUID();
        await storage.write(key, result.bytes);
        const asset = { key, mime };
        assets.push(asset);
        return asset;
      } catch {
        return null;
      }
    }
    const [thumbnail, icon] = await Promise.all([
      image(info.thumbnail),
      image(info.icon),
    ]);
    return {
      ...fallback,
      title: info.title,
      description: info.description,
      siteName: info.siteName,
      metadataStatus: "ready" as const,
      thumbnail,
      icon,
    };
  } catch {
    await Promise.all(assets.map((a) => storage.delete(a.key)));
    return fallback;
  }
}
export async function createBookmark(
  owner: string,
  input: { url: string; collection: string },
): Promise<Bookmark> {
  const url = bookmarkUrl(input.url);
  if (existing(owner, url))
    throw new HttpError(
      409,
      "This link is already saved, or is in Trash. Restore it there. Search your bookmarks to find it.",
    );
  const info = {
    title: new URL(url).hostname,
    description: "",
    siteName: new URL(url).hostname,
    metadataStatus: "pending" as const,
  };
  const id = randomUUID();
  const now = Date.now();
  try {
    sqlite()
      .transaction(() => {
        db()
          .insert(bookmarks)
          .values({
            id,
            ownerId: owner,
            url,
            title: info.title,
            description: info.description,
            siteName: info.siteName,
            collection: input.collection,
            metadataStatus: info.metadataStatus,
            titleEdited: 0,
            descriptionEdited: 0,
            createdAt: now,
            updatedAt: now,
          })
          .run();
        enqueueJob(owner, "bookmark", id);
        enqueueNewBookmarkArticle(owner, id);
      })
      .immediate();
  } catch (error) {
    if (existing(owner, url))
      throw new HttpError(
        409,
        "This link is already saved, or is in Trash. Restore it there.",
      );
    throw error;
  }
  startJobWorker();
  return expose(need(owner, id));
}
export function updateBookmark(
  owner: string,
  id: string,
  input: {
    revision: number;
    title?: string;
    description?: string;
    collection?: string;
    favorite?: boolean;
    noteId?: string | null;
  },
): Bookmark {
  need(owner, id);
  requireLinkedNote(owner, input.noteId);
  const { revision, ...changes } = input;
  const result = db()
    .update(bookmarks)
    .set({
      ...changes,
      ...(input.title !== undefined ? { titleEdited: 1 } : {}),
      ...(input.description !== undefined ? { descriptionEdited: 1 } : {}),
      revision: revision + 1,
      updatedAt: Date.now(),
    })
    .where(
      and(
        eq(bookmarks.id, id),
        eq(bookmarks.ownerId, owner),
        eq(bookmarks.revision, revision),
      ),
    )
    .run();
  if (!result.changes)
    throw new HttpError(
      409,
      "This bookmark changed in another tab. Refresh and try again.",
    );
  return expose(need(owner, id));
}
export async function refreshBookmark(
  owner: string,
  id: string,
  revision: number,
): Promise<Bookmark> {
  const before = need(owner, id);
  if (before.revision !== revision)
    throw new HttpError(409, "Refresh bookmarks before trying again.");
  sqlite()
    .transaction(() => {
      const changed = sqlite()
        .prepare(
          "UPDATE bookmarks SET metadata_status='pending',revision=revision+1,updated_at=? WHERE id=? AND owner_id=? AND revision=?",
        )
        .run(Date.now(), id, owner, revision).changes;
      if (!changed)
        throw new HttpError(409, "Refresh bookmarks before trying again.");
      enqueueJob(owner, "bookmark", id);
    })
    .immediate();
  startJobWorker();
  return expose(need(owner, id));
}
export async function processBookmark(
  { job, commit }: JobContext,
  readMetadata = metadata,
) {
  const before = need(job.owner_id, job.target_id);
  const info = await readMetadata(before.url);
  if (info.metadataStatus === "unavailable" && job.attempts < maxAttempts)
    throw new Error("Preview unavailable.");
  let replaced: (string | null)[] = [];
  let used = false;
  try {
    commit(() => {
      const current = need(job.owner_id, job.target_id);
      if (current.metadata_status !== "pending") return "cancelled";
      if (info.metadataStatus === "unavailable") {
        sqlite()
          .prepare(
            "UPDATE bookmarks SET metadata_status='unavailable',updated_at=? WHERE id=? AND owner_id=?",
          )
          .run(Date.now(), job.target_id, job.owner_id);
        return "unavailable";
      }
      db()
        .update(bookmarks)
        .set({
          title: current.title_edited ? current.title : info.title,
          description: current.description_edited
            ? current.description
            : info.description,
          siteName: info.siteName,
          metadataStatus: "ready",
          thumbnailKey: info.thumbnail?.key ?? null,
          thumbnailMime: info.thumbnail?.mime ?? null,
          iconKey: info.icon?.key ?? null,
          iconMime: info.icon?.mime ?? null,
          revision: current.revision + 1,
          updatedAt: Date.now(),
        })
        .where(
          and(
            eq(bookmarks.id, job.target_id),
            eq(bookmarks.ownerId, job.owner_id),
          ),
        )
        .run();
      replaced = [current.thumbnail_key, current.icon_key];
      used = true;
      return "ready";
    });
  } finally {
    const cleanup = used ? replaced : [info.thumbnail?.key, info.icon?.key];
    await Promise.allSettled(
      cleanup
        .filter((key): key is string => !!key)
        .map((key) => storage.delete(key)),
    );
  }
}
export async function deleteBookmark(
  owner: string,
  id: string,
  revision: number,
) {
  moveToTrash(owner, "bookmark", id, revision);
}
export async function bookmarkImage(
  owner: string,
  id: string,
  kind: "thumbnail" | "icon",
) {
  const row = need(owner, id);
  const key = row[`${kind}_key`];
  if (!key) throw new HttpError(404, "This preview image was not found.");
  return new Response(new Uint8Array(await storage.read(key)), {
    headers: {
      "Content-Type": row[`${kind}_mime`] || "application/octet-stream",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    },
  });
}

export async function exportBookmarkBundle(owner: string) {
  const rows = db()
    .select(fields)
    .from(bookmarks)
    .where(eq(bookmarks.ownerId, owner))
    .all() as Row[];
  const files: Record<string, Uint8Array> = {};
  const items = [];
  for (const row of rows) {
    for (const key of [row.thumbnail_key, row.icon_key])
      if (key) files[`files/${key}`] = await storage.read(key);
    items.push({
      id: row.id,
      tags: itemTags("bookmark", row.id),
      url: row.url,
      title: row.title,
      description: row.description,
      siteName: row.site_name,
      collection: row.collection,
      favorite: !!row.favorite,
      metadataStatus: row.metadata_status,
      titleEdited: !!row.title_edited,
      descriptionEdited: !!row.description_edited,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      noteId: row.note_id,
      trashedAt: row.trashed_at,
      thumbnail: row.thumbnail_key
        ? { id: row.thumbnail_key, mime: row.thumbnail_mime }
        : null,
      icon: row.icon_key ? { id: row.icon_key, mime: row.icon_mime } : null,
    });
  }
  return { items, files };
}
