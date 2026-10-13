import type { SearchResult } from "../../types";
import { sqlite } from "../db";
import { parseSearch, searchWorkspace } from "../unified-search";
import { aiEnabled, aiOperation } from "./indexer";
import { sourceFor, sourceText } from "./content";
import {
  hybridRank,
  literalProtection,
  policy,
  protectedIdentifiers,
  searchStopwords,
} from "./policy";
import { modelVersion } from "./model";
import { journalPeriodSql } from "../journal-classification";
type Candidate = { key: string; sourceKey: string; score: number };
const kinds = [
  "note",
  "task",
  "bookmark",
  "artifact",
  "event",
  "form",
  "response",
] as const;
function permitted(
  owner: string,
  sourceKey: string,
  type: string,
  tag: string,
) {
  const source = sourceFor(sourceKey);
  if (!source?.active || source.owner_id !== owner) return;
  if (
    type &&
    source.item_kind !== type &&
    !(["note", "journal"].includes(type) && source.item_kind === "note")
  )
    return;
  const d = sqlite();
  if (type === "note" || type === "journal") {
    const note = d
      .prepare(
        `SELECT daily_date,journal_period FROM notes WHERE id=? AND owner_id=?`,
      )
      .get(source.item_id, owner) as
      { daily_date: string | null; journal_period: string | null } | undefined;
    if (!note) return;
    const isJournal = Boolean(note.journal_period || note.daily_date);
    if (isJournal !== (type === "journal")) return;
  }
  if (
    tag &&
    !d
      .prepare(
        `SELECT 1 FROM ${source.item_kind}_tags it JOIN tags t ON t.id=it.tag_id WHERE it.${source.item_kind}_id=? AND t.name=? COLLATE NOCASE`,
      )
      .get(source.item_id, tag)
  )
    return;
  return source;
}
function lexical(owner: string, text: string, type: string, tag: string) {
  const terms = (text.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [])
    .filter((word) => !searchStopwords.has(word))
    .slice(0, 20);
  const expressions = [
    terms.map((word) => '"' + word + '"').join(" OR "),
    ...protectedIdentifiers(text).map(
      (word) => '"' + word.replaceAll('"', '""') + '"',
    ),
  ].filter(Boolean);
  const d = sqlite(),
    rank = new Map<string, Candidate>();
  for (const expression of [...new Set(expressions)]) {
    for (const kind of kinds) {
      if (type && type !== kind && !(type === "journal" && kind === "note"))
        continue;
      const table =
        kind === "event"
          ? "calendar_events"
          : kind === "response"
            ? "form_responses"
            : kind === "artifact"
              ? "artifacts"
              : kind + "s";
      const fts = kind === "event" ? "events_fts" : table + "_fts";
      const params: (string | number)[] = [expression, owner];
      let filters =
        kind === "response"
          ? "f.owner_id=? AND f.trashed_at IS NULL AND i.trashed_at IS NULL"
          : "i.owner_id=? AND i.trashed_at IS NULL";
      if (kind === "note")
        filters +=
          " AND i.kind='note'" +
          (type === "journal"
            ? ` AND ${journalPeriodSql("i")} IS NOT NULL`
            : type === "note"
              ? ` AND ${journalPeriodSql("i")} IS NULL`
              : "");
      if (tag) {
        filters += ` AND EXISTS(SELECT 1 FROM ${kind}_tags it JOIN tags t ON t.id=it.tag_id WHERE it.${kind}_id=i.id AND t.name=? COLLATE NOCASE)`;
        params.push(tag);
      }
      const rows = d
        .prepare(
          `SELECT i.id,-bm25(${fts},2,1) AS score FROM ${fts} JOIN ${table} i ON i.rowid=${fts}.rowid ${kind === "response" ? "JOIN forms f ON f.id=i.form_id" : ""} WHERE ${fts} MATCH ? AND ${filters} ORDER BY bm25(${fts},2,1),i.id LIMIT 30`,
        )
        .all(...params) as { id: string; score: number }[];
      for (const row of rows) {
        const key = kind + ":" + row.id;
        if (row.score > (rank.get(key)?.score ?? -Infinity))
          rank.set(key, { key, sourceKey: key, score: row.score });
      }
    }
    const rows = d
      .prepare(
        "SELECT c.source_key,-bm25(ai_chunks_fts,2,1) AS score FROM ai_chunks_fts JOIN ai_chunks c ON c.rowid=ai_chunks_fts.rowid JOIN ai_content a USING(source_key) WHERE ai_chunks_fts MATCH ? AND a.owner_id=? AND a.state='indexed' AND c.generation=a.generation AND c.model_version=? AND c.modality='text' ORDER BY bm25(ai_chunks_fts,2,1),c.rowid LIMIT 60",
      )
      .all(expression, owner, modelVersion) as {
      source_key: string;
      score: number;
    }[];
    for (const row of rows) {
      const source = permitted(owner, row.source_key, type, tag);
      if (!source) continue;
      const key = source.item_kind + ":" + source.item_id;
      if (row.score > (rank.get(key)?.score ?? -Infinity))
        rank.set(key, { key, sourceKey: row.source_key, score: row.score });
    }
  }
  return [...rank.values()]
    .sort((a, b) => {
      const sa = sourceFor(a.sourceKey),
        sb = sourceFor(b.sourceKey);
      return (
        Number(Boolean(sb && literalProtection(text, sourceText(sb)))) -
          Number(Boolean(sa && literalProtection(text, sourceText(sa)))) ||
        b.score - a.score ||
        a.key.localeCompare(b.key)
      );
    })
    .slice(0, 30);
}
function canonical(
  owner: string,
  candidate: Candidate,
  type: string,
  tag: string,
): SearchResult | undefined {
  const source = permitted(owner, candidate.sourceKey, type, tag);
  if (!source) return;
  const root = sourceFor(source.item_kind + ":" + source.item_id);
  if (!root?.active || root.owner_id !== owner) return;
  const d = sqlite();
  const sourceTitle = source.title.normalize("NFKC").trim();
  let excerpt = sourceText(source).slice(sourceTitle.length).trim();
  if (sourceTitle && excerpt.startsWith(sourceTitle))
    excerpt = excerpt.slice(sourceTitle.length).trim();
  const result: SearchResult = {
    id: root.item_id,
    type: root.item_kind as SearchResult["type"],
    title: root.title,
    excerpt: excerpt.slice(0, 180),
    updatedAt: root.updated_at,
  };
  if (root.item_kind === "note") {
    const note = d
      .prepare(
        "SELECT daily_date AS dailyDate,journal_period AS journalPeriod,journal_period_start AS journalPeriodStart FROM notes WHERE id=? AND owner_id=?",
      )
      .get(root.item_id, owner) as {
      dailyDate: string | null;
      journalPeriod: SearchResult["journalPeriod"];
      journalPeriodStart: string | null;
    };
    result.dailyDate = note.dailyDate;
    result.journalPeriod =
      note.journalPeriod ?? (note.dailyDate ? "daily" : null);
    result.journalPeriodStart = note.journalPeriodStart ?? note.dailyDate;
    if (result.journalPeriod) result.type = "journal";
  }
  if (root.item_kind === "artifact")
    result.artifactKind = (
      d.prepare("SELECT kind FROM artifacts WHERE id=?").get(root.item_id) as {
        kind: "text" | "image" | "file";
      }
    ).kind;
  if (root.item_kind === "task")
    result.completed = Boolean(
      (
        d
          .prepare("SELECT completed_at FROM tasks WHERE id=?")
          .get(root.item_id) as { completed_at: number | null }
      ).completed_at,
    );
  if (root.item_kind === "response")
    result.formId = (
      d
        .prepare("SELECT form_id FROM form_responses WHERE id=?")
        .get(root.item_id) as { form_id: string }
    ).form_id;
  return result;
}
export async function relatedSearch(owner: string, input: string) {
  const fallback = () => ({
    items: searchWorkspace(owner, input),
    strategyUsed: "keyword" as const,
  });
  const { type, tag, text } = parseSearch(input);
  if (!aiEnabled() || !text.trim()) return fallback();
  const d = sqlite(),
    deadline = Date.now() + policy.queryMs;
  const epoch = () =>
    (
      d
        .prepare("SELECT index_generation FROM ai_configuration WHERE id=1")
        .get() as { index_generation: number }
    ).index_generation;
  const generation = epoch();
  try {
    const lex = lexical(owner, text, type, tag);
    const dense = await aiOperation(
      (worker) => worker.search(owner, text, deadline, type, tag),
      deadline,
    );
    return d
      .transaction(() => {
        if (!aiEnabled() || Date.now() > deadline || epoch() !== generation)
          return fallback();
        const candidates = new Map(
          [...dense, ...lex].map((row) => [row.key, row]),
        );
        const texts = new Map<string, string>();
        for (const [key, candidate] of candidates) {
          const source = permitted(owner, candidate.sourceKey, type, tag);
          if (source) texts.set(key, sourceText(source));
        }
        const items = hybridRank(text, dense, lex, texts).flatMap((row) => {
          const candidate = candidates.get(row.key);
          if (!candidate) return [];
          const result = canonical(owner, candidate, type, tag);
          return result ? [result] : [];
        });
        return { items, strategyUsed: "semantic" as const };
      })
      .deferred();
  } catch {
    return fallback();
  }
}
