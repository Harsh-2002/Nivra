import { randomUUID } from "node:crypto";
import { decodeMatches } from "../search-context";
import { sqlite } from "./db";
import { ftsQuery } from "./validation";
import { fuzzyQuery } from "./search";
import type { SearchResult } from "../types";
export function parseSearch(input: string) {
  let type = "";
  let tag = "";
  const text = input
    .replace(
      /\b(type|tag):(?:"([^"]+)"|([^\s]+))/gi,
      (match, key: string, quoted: string, plain: string) => {
        const value = quoted || plain;
        if (
          key.toLowerCase() === "type" &&
          /^(notes?|journals?|tasks?|bookmarks?|artifacts?|events?|forms?|responses?)$/i.test(
            value,
          )
        ) {
          type = value.toLowerCase().replace(/s$/, "");
          return "";
        }
        if (key.toLowerCase() === "tag") {
          tag = value;
          return "";
        }
        return match;
      },
    )
    .trim();
  return { type, tag, text };
}
export function searchWorkspace(
  owner: string,
  input: string,
  purpose: "workspace" | "link" = "workspace",
): SearchResult[] {
  const { type, tag, text } = parseSearch(input);
  const database = sqlite();
  type Candidate = SearchResult & { searchRow: number };
  const results: Candidate[] = [];
  const enrichers = new Map<
    SearchResult["type"],
    (rows: Candidate[]) => SearchResult[]
  >();
  const fallbacks: (() => void)[] = [];
  for (const area of [
    "note",
    "task",
    "bookmark",
    "artifact",
    "event",
    "form",
  ] as const) {
    if (purpose === "link" && (area === "event" || area === "form")) continue;
    if (type && type !== area && !(type === "journal" && area === "note"))
      continue;
    const table =
      area === "note"
        ? "notes"
        : area === "task"
          ? "tasks"
          : area === "bookmark"
            ? "bookmarks"
            : area === "event"
              ? "calendar_events"
              : area === "form"
                ? "forms"
                : "artifacts";
    const fts = area === "event" ? "events_fts" : `${table}_fts`;
    const conditions = ["owner_id=?", "trashed_at IS NULL"];
    const params: (string | number)[] = [owner];
    if (area === "note") conditions.push("trashed_at IS NULL AND kind='note'");
    if (area === "note" && type === "journal")
      conditions.push("daily_date IS NOT NULL");
    if (area === "note" && type === "note")
      conditions.push("daily_date IS NULL");
    if (tag) {
      conditions.push(
        `EXISTS(SELECT 1 FROM ${area}_tags it JOIN tags t ON t.id=it.tag_id WHERE it.${area}_id=${table}.id AND t.name=? COLLATE NOCASE)`,
      );
      params.push(tag);
    }
    const run = (query: string) => {
      const excerpt =
        area === "note"
          ? "text"
          : area === "task"
            ? "title"
            : area === "artifact"
              ? "content"
              : "description";
      const completed =
        area === "task"
          ? ",completed_at IS NOT NULL AS completed"
          : area === "artifact"
            ? ",kind AS artifactKind"
            : "";
      const read = (
        where: string[],
        values: (string | number)[],
        index: string,
        limit = 12,
      ) =>
        database
          .prepare(
            `SELECT rowid AS searchRow,id,title,${query || purpose === "link" ? "''" : `substr(replace(${excerpt},char(10),' '),1,180)`} AS excerpt,updated_at AS updatedAt${completed}${area === "note" ? ",daily_date AS dailyDate" : ""} FROM ${table}${index} WHERE ${where.join(" AND ")} ORDER BY updated_at DESC,id LIMIT ?`,
          )
          .all(...values, limit) as (Omit<SearchResult, "type"> & {
          searchRow: number;
        })[];
      const where = [...conditions];
      const values = [...params];
      let index = ` INDEXED BY ${table}_search_order_idx`;
      if (query) {
        const matches = database
          .prepare(`SELECT rowid FROM ${fts} WHERE ${fts} MATCH ? LIMIT 513`)
          .all(query) as { rowid: number }[];
        if (!matches.length) return [];
        if (matches.length <= 512) {
          index = " NOT INDEXED";
          where.push(`rowid IN (${matches.map(() => "?").join(",")})`);
          values.push(...matches.map((match) => match.rowid));
        } else {
          where.push(`rowid IN(SELECT rowid FROM ${fts} WHERE ${fts} MATCH ?)`);
          values.push(query);
        }
      }
      return read(where, values, index);
    };
    const context = (
      rows: (Omit<SearchResult, "type"> & { searchRow: number })[],
      query: string,
    ) => {
      const start = `[[${randomUUID()}]]`;
      const end = `[[/${randomUUID()}]]`;
      if (purpose === "link" || !query || !rows.length)
        return rows.map(({ searchRow, ...row }) => {
          void searchRow;
          return row;
        });
      // Keep one FTS cursor so snippet's phrase cache survives across selected rows.
      const marked = database
        .prepare(
          `SELECT rowid AS searchRow,highlight(${fts},0,?,?) AS title,snippet(${fts},-1,?,?,'…',24) AS excerpt FROM ${fts} WHERE rowid BETWEEN ? AND ? AND (rowid+0) IN (${rows.map(() => "?").join(",")}) AND ${fts} MATCH ?`,
        )
        .all(
          start,
          end,
          start,
          end,
          Math.min(...rows.map((row) => row.searchRow)),
          Math.max(...rows.map((row) => row.searchRow)),
          ...rows.map((row) => row.searchRow),
          query,
        ) as { searchRow: number; title: string; excerpt: string }[];
      const byRow = new Map(marked.map((row) => [row.searchRow, row]));
      return rows.map(({ searchRow, ...row }) => {
        const match = byRow.get(searchRow);
        if (!match) return row;
        const title = decodeMatches(match.title, start, end);
        const excerpt = decodeMatches(match.excerpt, start, end);
        return {
          ...row,
          title: title.text,
          excerpt: excerpt.text,
          titleMatches: title.ranges,
          excerptMatches: excerpt.ranges,
          matchTerms: [
            ...new Set(
              excerpt.ranges.map(([from, to]) => excerpt.text.slice(from, to)),
            ),
          ].slice(0, 20),
        };
      });
    };
    const query = ftsQuery(text);
    if (text && !query) continue;
    const collect = (usedQuery: string) => {
      const found = run(usedQuery);
      enrichers.set(area, (rows) =>
        context(rows, usedQuery).map((row) => ({ ...row, type: area })),
      );
      results.push(
        ...found.map((r) => ({
          ...r,
          type: area,
          ...(area === "task" ? { completed: Boolean(r.completed) } : {}),
        })),
      );
    };
    collect(query);
    if (purpose === "workspace" && query && area !== "event" && area !== "form")
      fallbacks.push(() => {
        const fuzzy = fuzzyQuery(
          text,
          table as "notes" | "tasks" | "bookmarks" | "artifacts",
        );
        if (fuzzy) collect(fuzzy);
      });
  }
  if (!results.length) for (const fallback of fallbacks) fallback();
  const selected = results
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, purpose === "link" ? 10 : 30);
  const enriched = new Map<string, SearchResult>();
  for (const [area, enrich] of enrichers) {
    for (const row of enrich(selected.filter((row) => row.type === area)))
      enriched.set(`${area}:${row.id}`, row);
  }
  return selected.map((row) => enriched.get(`${row.type}:${row.id}`)!);
}
