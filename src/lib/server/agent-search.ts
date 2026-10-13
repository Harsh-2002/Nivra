import type Database from "better-sqlite3";
import { sqlite } from "./db";
import { parseSearch } from "./unified-search";
import { ftsQuery } from "./validation";
import { matchingRows } from "./search-plan";
import { HttpError } from "./http";
import { journalKindSql, journalPeriodSql } from "./journal-classification";
export function agentSearch(
  owner: string,
  input: { query: string; limit: number; offset: number },
) {
  const { type, tag, text } = parseSearch(input.query);
  if (text.split(/\s+/).filter(Boolean).length > 20)
    throw new HttpError(400, "Use at most 20 search terms.");
  const search = ftsQuery(text),
    database = sqlite();
  if (text && !search) return { items: [], total: 0, nextOffset: null };
  return database.transaction(() => {
    const values: (string | number)[] = [];
    const branches: string[] = [];
    const readers = new Map<string, Database.Statement>();
    let total = 0;
    for (const [area, table, tagTable, tagColumn] of [
      ["note", "notes", "note_tags", "note_id"],
      ["task", "tasks", "task_tags", "task_id"],
      ["bookmark", "bookmarks", "bookmark_tags", "bookmark_id"],
      ["artifact", "artifacts", "artifact_tags", "artifact_id"],
      ["event", "calendar_events", "event_tags", "event_id"],
      ["form", "forms", "form_tags", "form_id"],
    ] as const) {
      if (type && type !== area && !(type === "journal" && area === "note"))
        continue;
      const where = ["i.owner_id=?", "i.trashed_at IS NULL"];
      const params: (string | number)[] = [owner];
      if (area === "note") {
        where.push("i.kind='note'");
        if (type === "note") where.push(`${journalPeriodSql("i")} IS NULL`);
        if (type === "journal")
          where.push(`${journalPeriodSql("i")} IS NOT NULL`);
      }
      if (tag) {
        where.push(
          `i.id IN(SELECT a.${tagColumn} FROM ${tagTable} a JOIN tags t ON t.id=a.tag_id WHERE t.name=? COLLATE NOCASE)`,
        );
        params.push(tag);
      }
      const fts = area === "event" ? "events_fts" : `${table}_fts`;
      const plan = search
        ? matchingRows(fts, search, "i", `${table}_search_order_idx`)
        : undefined;
      if (plan) {
        where.push(plan.condition);
        params.push(...plan.values);
      }
      const predicate = where.join(" AND ");
      const countIndex =
        plan?.index === " NOT INDEXED"
          ? plan.index
          : ` INDEXED BY ${area === "event" ? "events" : table}_active_counts_idx`;
      total += (
        database
          .prepare(
            `SELECT count(*) AS total FROM ${table} i${countIndex} WHERE ${predicate}`,
          )
          .get(...params) as { total: number }
      ).total;
      const kind = area === "note" ? journalKindSql("i") : `'${area}'`;
      branches.push(
        `SELECT i.id,${kind} AS type,i.updated_at AS updatedAt FROM ${table} i${plan?.index ?? ` INDEXED BY ${table}_search_order_idx`} WHERE ${predicate}`,
      );
      values.push(...params);
      const excerpt =
        area === "note"
          ? "text"
          : area === "task"
            ? "title"
            : area === "artifact"
              ? "content"
              : "description";
      const reader = database.prepare(
        `SELECT id,${kind} AS type,title,substr(replace(${excerpt},char(10),' '),1,180) AS excerpt,revision,updated_at AS updatedAt,${area === "note" ? "daily_date" : "NULL"} AS dailyDate,${area === "note" ? "journal_period" : "NULL"} AS journalPeriod,${area === "note" ? "journal_period_start" : "NULL"} AS journalPeriodStart FROM ${table} i WHERE id=? AND owner_id=? AND trashed_at IS NULL`,
      );
      readers.set(area, reader);
      if (area === "note") readers.set("journal", reader);
    }
    const selected = database
      .prepare(
        `SELECT * FROM (${branches.join(" UNION ALL ")}) ORDER BY updatedAt DESC,type,id LIMIT ? OFFSET ?`,
      )
      .all(...values, input.limit, input.offset) as {
      id: string;
      type: string;
    }[];
    const items = selected.map((row) =>
      readers.get(row.type)!.get(row.id, owner),
    );
    return {
      items,
      total,
      nextOffset:
        input.offset + items.length < total
          ? input.offset + items.length
          : null,
    };
  })();
}
