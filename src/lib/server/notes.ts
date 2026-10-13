import { randomUUID } from "node:crypto";
import { db, sqlite } from "./db";
import { notes } from "./schema";
import { eq } from "drizzle-orm";
import { emptyDocument, type Note, type NoteSummary, type Tag } from "../types";
import { fuzzyQuery } from "./search";
import { ftsQuery } from "./validation";
import { syncNoteLinks } from "./connections";
import { canonicalizeTaskLinks, writingPlainText } from "../writing";
import { journalPeriodSql, journalStartSql } from "./journal-classification";

const columns = `n.id,n.title,n.revision,n.favorite,n.editor_width AS editorWidth,n.kind,n.daily_date AS dailyDate,${journalPeriodSql("n")} AS journalPeriod,${journalStartSql("n")} AS journalPeriodStart,n.trashed_at AS trashedAt,n.created_at AS createdAt,n.updated_at AS updatedAt`;
export function tagsFor(note: string): Tag[] {
  return sqlite()
    .prepare(
      "SELECT t.id,t.name,t.color,t.aliases FROM tags t JOIN note_tags nt ON nt.tag_id=t.id WHERE nt.note_id=? ORDER BY t.name",
    )
    .all(note)
    .map((row) => {
      const tag = row as Tag & { aliases: string };
      const { aliases, ...rest } = tag;
      const words = JSON.parse(aliases) as string[];
      return { ...rest, ...(words.length ? { aliases: words } : {}) };
    });
}
export function getNote(id: string): Note | undefined {
  const row = db().select().from(notes).where(eq(notes.id, id)).get();
  return row
    ? {
        ...row,
        journalPeriod: row.journalPeriod ?? (row.dailyDate ? "daily" : null),
        journalPeriodStart: row.journalPeriodStart ?? row.dailyDate,
        tags: tagsFor(id),
      }
    : undefined;
}
export function listNotes(
  params: URLSearchParams,
  queryOverride?: string,
  ownerId?: string,
): NoteSummary[] {
  const view = params.get("view");
  const where = [
    view === "trash" ? "1=1" : "n.kind='note'",
    view === "trash" ? "n.trashed_at IS NOT NULL" : "n.trashed_at IS NULL",
  ];
  const values: (string | number)[] = [];
  // Every journal cadence lives in the Journal section, not Notes.
  if (view === "journal") {
    where.push("(n.journal_period IS NOT NULL OR n.daily_date IS NOT NULL)");
    if (params.get("period")) {
      where.push(`${journalPeriodSql("n")}=?`);
      values.push(params.get("period")!);
    }
    if (params.get("from")) {
      where.push(`${journalStartSql("n")}>=?`);
      values.push(params.get("from")!);
    }
    if (params.get("to")) {
      where.push(`${journalStartSql("n")}<=?`);
      values.push(params.get("to")!);
    }
  } else if (view === "all" && !params.get("tag"))
    where.push(`${journalPeriodSql("n")} IS NULL`);
  const owner =
    ownerId ??
    (
      sqlite().prepare("SELECT id FROM user LIMIT 1").get() as
        { id: string } | undefined
    )?.id;
  if (!owner) return [];
  where.push("n.owner_id=?");
  values.push(owner);
  const search = queryOverride ?? ftsQuery(params.get("q") || "");
  if (search) {
    where.push("notes_fts MATCH ?");
    values.push(search);
  }
  if (view === "favorites") where.push("n.favorite=1");
  if (params.get("tag")) {
    where.push(
      "EXISTS (SELECT 1 FROM note_tags WHERE note_id=n.id AND tag_id=?)",
    );
    values.push(params.get("tag")!);
  }
  const order = search
    ? "notes_fts.rank"
    : view === "journal"
      ? `${journalStartSql("n")} DESC`
      : params.get("sort") === "title"
        ? "n.title COLLATE NOCASE"
        : params.get("sort") === "created"
          ? "n.created_at DESC"
          : "n.updated_at DESC";
  const source = search
    ? "notes n JOIN notes_fts ON notes_fts.rowid=n.rowid"
    : "notes n";
  const bounded = params.has("limit");
  const limit = Math.max(
    1,
    Math.min(101, Math.trunc(Number(params.get("limit"))) || 30),
  );
  const offset = Math.max(
    0,
    Math.min(1000000, Math.trunc(Number(params.get("offset"))) || 0),
  );
  const text =
    params.get("preview") === "1"
      ? "substr(replace(n.text,char(10),' '),1,180)"
      : "n.text";
  const database = sqlite();
  const rows = bounded
    ? database.transaction(() => {
        // Stream FTS relevance order, then read previews for the selected page.
        const selected = database
          .prepare(
            search
              ? `SELECT n.rowid AS picked FROM notes_fts CROSS JOIN notes n ON notes_fts.rowid=n.rowid WHERE ${where.join(" AND ")} ORDER BY notes_fts.rank LIMIT ? OFFSET ?`
              : `SELECT n.rowid AS picked FROM notes n${view === "trash" || view === "journal" ? "" : ` INDEXED BY ${params.get("sort") === "title" ? "notes_title_page_idx" : params.get("sort") === "created" ? "notes_activity_idx" : "notes_search_order_idx"}`} WHERE ${where.join(" AND ")} ORDER BY ${order},n.id LIMIT ? OFFSET ?`,
          )
          .all(...values, limit, offset) as { picked: number }[];
        if (!selected.length) return [];
        const hydrated = database
          .prepare(
            `SELECT n.rowid AS picked,${columns},${text} AS text FROM notes n WHERE n.owner_id=? AND n.rowid IN (${selected.map(() => "?").join(",")})`,
          )
          .all(owner, ...selected.map((row) => row.picked)) as (NoteSummary & {
          picked: number;
        })[];
        const byRow = new Map(
          hydrated.map(({ picked, ...row }) => [picked, row]),
        );
        return selected.map((row) => byRow.get(row.picked)!).filter(Boolean);
      })()
    : (database
        .prepare(
          `SELECT ${columns},${text} AS text FROM ${source} WHERE ${where.join(" AND ")} ORDER BY ${order},n.id${bounded ? " LIMIT ? OFFSET ?" : ""}`,
        )
        .all(...values, ...(bounded ? [limit, offset] : [])) as NoteSummary[]);
  if (
    !rows.length &&
    search &&
    queryOverride === undefined &&
    (!offset ||
      !sqlite()
        .prepare(`SELECT 1 FROM ${source} WHERE ${where.join(" AND ")} LIMIT 1`)
        .get(...values))
  ) {
    const fallback = fuzzyQuery(params.get("q") || "");
    if (fallback) return listNotes(params, fallback, owner);
  }
  const tags = new Map<string, Tag[]>();
  for (let start = 0; start < rows.length; start += 500) {
    const ids = rows.slice(start, start + 500).map((row) => row.id);
    const linked = sqlite()
      .prepare(
        `SELECT nt.note_id AS noteId,t.id,t.name,t.color FROM note_tags nt JOIN tags t ON t.id=nt.tag_id WHERE nt.note_id IN (${ids.map(() => "?").join(",")}) ORDER BY t.name`,
      )
      .all(...ids) as (Tag & { noteId: string })[];
    for (const { noteId, ...tag } of linked)
      tags.set(noteId, [...(tags.get(noteId) || []), tag]);
  }
  return rows.map((n) => ({
    ...n,
    favorite: Boolean(n.favorite),
    tags: tags.get(n.id) || [],
  }));
}
export function createNote(
  owner: string,
  title = "",
  document = emptyDocument,
): Note {
  const id = randomUUID();
  const now = Date.now();
  const canonicalDocument = canonicalizeTaskLinks(document);
  db()
    .insert(notes)
    .values({
      id,
      ownerId: owner,
      title,
      document: canonicalDocument,
      text: writingPlainText(canonicalDocument),
      createdAt: now,
      updatedAt: now,
    })
    .run();
  syncNoteLinks(id, canonicalDocument);
  return getNote(id)!;
}
