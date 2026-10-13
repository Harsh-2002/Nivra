import { randomUUID } from "node:crypto";
import { decodeMatches } from "../search-context";
import { sqlite } from "./db";
import { ftsQuery } from "./validation";
import { fuzzyQuery } from "./search";
import { journalPeriodSql } from "./journal-classification";
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
  type Candidate = SearchResult & {
    searchRow: number;
    searchSource?: "primary" | "article" | "highlight" | "task-step";
  };
  const results: Candidate[] = [];
  const enrichers = new Map<
    SearchResult["type"],
    (rows: Candidate[]) => SearchResult[]
  >();
  const fallbacks: (() => void)[] = [];
  const tagMatch = tag
    ? "EXISTS(SELECT 1 FROM bookmark_tags bt JOIN tags t ON t.id=bt.tag_id WHERE bt.bookmark_id=b.id AND t.name=? COLLATE NOCASE)"
    : "";
  const readBookmarkText = (
    fts: "bookmark_articles_fts" | "bookmark_highlights_fts",
    query: string,
  ) => {
    if (!query) return;
    const start = `[[${randomUUID()}]]`;
    const end = `[[/${randomUUID()}]]`;
    const source = fts === "bookmark_articles_fts" ? "article" : "highlight";
    const matches =
      source === "article"
        ? (database
            .prepare(
              `SELECT b.id,b.title,b.updated_at AS updatedAt,
                 (SELECT a.rowid FROM bookmark_articles a
                  WHERE a.bookmark_id=b.id AND a.owner_id=b.owner_id
                    AND a.rowid IN (SELECT rowid FROM bookmark_articles_fts WHERE bookmark_articles_fts MATCH ?)
                  ORDER BY a.version DESC LIMIT 1) AS sourceRow
               FROM bookmarks AS b INDEXED BY bookmarks_search_order_idx
               WHERE b.owner_id=? AND b.trashed_at IS NULL
                 AND b.id IN (
                   SELECT a.bookmark_id FROM bookmark_articles a
                   WHERE a.owner_id=b.owner_id
                     AND a.rowid IN (SELECT rowid FROM bookmark_articles_fts WHERE bookmark_articles_fts MATCH ?)
                 ) ${tagMatch ? `AND ${tagMatch}` : ""}
               ORDER BY b.updated_at DESC,b.id LIMIT 12`,
            )
            .all(query, owner, query, ...(tagMatch ? [tag] : [])) as {
            id: string;
            title: string;
            updatedAt: number;
            sourceRow: number;
          }[])
        : (database
            .prepare(
              `SELECT b.id,b.title,b.updated_at AS updatedAt,
                 (SELECT h.rowid FROM bookmark_highlights h
                  WHERE h.bookmark_id=b.id AND h.owner_id=b.owner_id
                    AND h.rowid IN (SELECT rowid FROM bookmark_highlights_fts WHERE bookmark_highlights_fts MATCH ?)
                  ORDER BY h.updated_at DESC,h.id LIMIT 1) AS sourceRow
               FROM bookmarks AS b INDEXED BY bookmarks_search_order_idx
               WHERE b.owner_id=? AND b.trashed_at IS NULL
                 AND b.id IN (
                   SELECT h.bookmark_id FROM bookmark_highlights h
                   WHERE h.owner_id=b.owner_id
                     AND h.rowid IN (SELECT rowid FROM bookmark_highlights_fts WHERE bookmark_highlights_fts MATCH ?)
                 ) ${tagMatch ? `AND ${tagMatch}` : ""}
               ORDER BY b.updated_at DESC,b.id LIMIT 12`,
            )
            .all(query, owner, query, ...(tagMatch ? [tag] : [])) as {
            id: string;
            title: string;
            updatedAt: number;
            sourceRow: number;
          }[]);
    if (!matches.length) return;
    const marked = database
      .prepare(
        `SELECT rowid AS sourceRow,snippet(${fts},-1,?,?,'…',24) AS excerpt
         FROM ${fts} WHERE ${fts} MATCH ? AND rowid IN (${matches.map(() => "?").join(",")})`,
      )
      .all(start, end, query, ...matches.map((row) => row.sourceRow)) as {
      sourceRow: number;
      excerpt: string;
    }[];
    const snippets = new Map(marked.map((row) => [row.sourceRow, row.excerpt]));
    for (const row of matches) {
      const rawExcerpt = snippets.get(row.sourceRow);
      if (!rawExcerpt) continue;
      const excerpt = decodeMatches(rawExcerpt, start, end);
      results.push({
        searchRow: row.sourceRow,
        id: row.id,
        type: "bookmark",
        title: row.title,
        excerpt: excerpt.text,
        updatedAt: row.updatedAt,
        excerptMatches: excerpt.ranges,
        matchTerms: [
          ...new Set(
            excerpt.ranges.map(([from, to]) => excerpt.text.slice(from, to)),
          ),
        ].slice(0, 20),
        searchSource: source,
      });
    }
  };
  const readTaskSteps = (query: string) => {
    if (!query) return;
    const start = `[[${randomUUID()}]]`;
    const end = `[[/${randomUUID()}]]`;
    const taskTag = tag
      ? "AND EXISTS(SELECT 1 FROM task_tags tt JOIN tags tg ON tg.id=tt.tag_id WHERE tt.task_id=t.id AND tg.name=? COLLATE NOCASE)"
      : "";
    const candidates = database
      .prepare(
        `SELECT t.id,t.title,t.updated_at AS updatedAt,
           t.completed_at IS NOT NULL AS completed,
           (SELECT s.rowid FROM task_steps s
            WHERE s.owner_id=t.owner_id AND s.task_id=t.id
              AND s.rowid IN (SELECT rowid FROM task_steps_fts WHERE task_steps_fts MATCH ?)
            ORDER BY s.position,s.id LIMIT 1) AS sourceRow
         FROM tasks t
         WHERE t.owner_id=? AND t.trashed_at IS NULL
           AND t.id IN (SELECT s.task_id FROM task_steps s
             WHERE s.owner_id=?
               AND s.rowid IN (SELECT rowid FROM task_steps_fts WHERE task_steps_fts MATCH ?))
           ${taskTag}
         ORDER BY t.updated_at DESC,t.id LIMIT 12`,
      )
      .all(query, owner, owner, query, ...(tag ? [tag] : [])) as {
      id: string;
      title: string;
      updatedAt: number;
      completed: number | boolean;
      sourceRow: number;
    }[];
    if (!candidates.length) return;
    const snippets = database
      .prepare(
        `SELECT rowid AS sourceRow,snippet(task_steps_fts,0,?,?,'…',24) AS excerpt
         FROM task_steps_fts WHERE task_steps_fts MATCH ? AND rowid IN (${candidates.map(() => "?").join(",")})`,
      )
      .all(start, end, query, ...candidates.map((row) => row.sourceRow)) as {
      sourceRow: number;
      excerpt: string;
    }[];
    const byRow = new Map(snippets.map((row) => [row.sourceRow, row.excerpt]));
    for (const task of candidates) {
      const raw = byRow.get(task.sourceRow);
      if (!raw) continue;
      const excerpt = decodeMatches(raw, start, end);
      results.push({
        searchRow: task.sourceRow,
        searchSource: "task-step",
        id: task.id,
        type: "task",
        title: task.title,
        excerpt: purpose === "link" ? "" : excerpt.text,
        updatedAt: task.updatedAt,
        completed: Boolean(task.completed),
        ...(purpose === "link" ? {} : { excerptMatches: excerpt.ranges }),
        matchTerms:
          purpose === "link"
            ? []
            : [
                ...new Set(
                  excerpt.ranges.map(([from, to]) =>
                    excerpt.text.slice(from, to),
                  ),
                ),
              ].slice(0, 20),
      });
    }
  };
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
      conditions.push(`${journalPeriodSql("notes")} IS NOT NULL`);
    if (area === "note" && type === "note")
      conditions.push(`${journalPeriodSql("notes")} IS NULL`);
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
            `SELECT rowid AS searchRow,id,title,${query || purpose === "link" ? "''" : `substr(replace(${excerpt},char(10),' '),1,180)`} AS excerpt,updated_at AS updatedAt${completed}${area === "note" ? ",daily_date AS dailyDate,journal_period AS journalPeriod,journal_period_start AS journalPeriodStart" : ""} FROM ${table}${index} WHERE ${where.join(" AND ")} ORDER BY updated_at DESC,id LIMIT ?`,
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
    const context = (rows: Candidate[], query: string) => {
      const start = `[[${randomUUID()}]]`;
      const end = `[[/${randomUUID()}]]`;
      if (purpose === "link" || !query || !rows.length)
        return rows.map(
          ({ searchRow, searchSource: _searchSource, ...row }) => {
            void searchRow;
            void _searchSource;
            return row;
          },
        );
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
      return rows.map(({ searchRow, searchSource: _searchSource, ...row }) => {
        void _searchSource;
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
      enrichers.set(area, (rows) => context(rows, usedQuery));
      results.push(
        ...found.map((r) => ({
          ...r,
          type:
            area === "note" && (r.journalPeriod || r.dailyDate)
              ? "journal"
              : (area as SearchResult["type"]),
          searchSource: "primary" as const,
          ...(area === "task" ? { completed: Boolean(r.completed) } : {}),
        })),
      );
      if (area === "bookmark" && usedQuery) {
        readBookmarkText("bookmark_articles_fts", usedQuery);
        readBookmarkText("bookmark_highlights_fts", usedQuery);
      }
    };
    collect(query);
    if (area === "task" && query) readTaskSteps(query);
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
  const unique = new Map<string, Candidate>();
  const sourcePriority = {
    primary: 0,
    article: 1,
    highlight: 2,
    "task-step": 3,
  } as const;
  for (const row of results) {
    const key = `${row.type}:${row.id}`;
    const previous = unique.get(key);
    if (
      !previous ||
      sourcePriority[row.searchSource ?? "primary"] >
        sourcePriority[previous.searchSource ?? "primary"]
    )
      unique.set(key, row);
  }
  const selected = [...unique.values()]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, purpose === "link" ? 10 : 30);
  const enriched = new Map<string, SearchResult>();
  for (const [area, enrich] of enrichers) {
    for (const row of enrich(
      selected.filter(
        (row) =>
          (row.type === area || (area === "note" && row.type === "journal")) &&
          row.searchSource === "primary",
      ) as Candidate[],
    ))
      enriched.set(`${row.type}:${row.id}`, row);
  }
  return selected.map((row) => {
    const matched = enriched.get(`${row.type}:${row.id}`);
    if (matched) return matched;
    const {
      searchRow: _searchRow,
      searchSource: _searchSource,
      ...result
    } = row;
    void _searchRow;
    void _searchSource;
    return result;
  });
}
