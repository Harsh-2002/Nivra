import { createHash } from "node:crypto";
import { sqlite } from "../db";
export type AiSource = {
  source_key: string;
  source_kind: string;
  source_id: string;
  owner_id: string;
  item_kind: string;
  item_id: string;
  title: string;
  text: string;
  active: number;
  created_at: number;
  updated_at: number;
  generation: number;
};
export function sourceFor(key: string): AiSource | undefined {
  return sqlite()
    .prepare(
      "SELECT s.*,c.generation FROM ai_sources s JOIN ai_content c USING(source_key) WHERE source_key=? AND source_kind=? AND source_id=?",
    )
    .get(
      key,
      key.slice(0, key.indexOf(":")),
      key.slice(key.indexOf(":") + 1),
    ) as AiSource | undefined;
}
function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === "object")
    return Object.entries(value)
      .filter(([key]) =>
        [
          "label",
          "description",
          "placeholder",
          "text",
          "title",
          "options",
          "value",
          "name",
          "fields",
          "choices",
          "startDate",
          "endDate",
          "startTime",
          "endTime",
          "timezone",
        ].includes(key),
      )
      .flatMap(([, v]) => strings(v));
  return [];
}
export function sourceText(source: AiSource) {
  let text = source.text;
  if (source.source_kind === "bookmark") {
    const article = sqlite()
      .prepare(
        "SELECT a.plain_text AS text FROM bookmark_articles a JOIN bookmarks b ON b.id=a.bookmark_id AND b.article_version=a.version WHERE b.id=? AND b.owner_id=? AND a.owner_id=?",
      )
      .get(source.source_id, source.owner_id, source.owner_id) as
      { text: string } | undefined;
    const highlights = sqlite()
      .prepare(
        "SELECT quote,annotation FROM bookmark_highlights WHERE bookmark_id=? AND owner_id=? ORDER BY created_at,id",
      )
      .all(source.source_id, source.owner_id) as {
      quote: string;
      annotation: string;
    }[];
    text = [
      text,
      article?.text ?? "",
      ...highlights.map((item) => item.quote + "\n" + item.annotation),
    ].join("\n");
  }
  if (source.source_kind === "event" || source.source_kind === "form") {
    const row = sqlite()
      .prepare(
        source.source_kind === "event"
          ? "SELECT description,data AS data FROM calendar_events WHERE id=?"
          : "SELECT description,definition AS data,closing_date AS closingDate,status FROM forms WHERE id=?",
      )
      .get(source.source_id) as {
      description: string;
      data: string;
      closingDate?: string | null;
      status?: string;
    };
    text = [
      row.description,
      strings(JSON.parse(row.data)).join(" "),
      row.closingDate ?? "",
      row.status ?? "",
    ].join(" ");
  }
  return (source.title + "\n" + text).normalize("NFKC").trim();
}
export function fingerprint(text: string) {
  return createHash("sha256").update(text).digest("hex");
}
function whitespace(code: number) {
  return (
    (code >= 0x09 && code <= 0x0d) ||
    code === 0x20 ||
    code === 0xa0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000 ||
    code === 0xfeff
  );
}
export function textChunkCount(text: string, limit = Number.POSITIVE_INFINITY) {
  let words = 0,
    inWord = false;
  const maxWords = limit * 160;
  for (let i = 0; i < text.length; i++) {
    const isSpace = whitespace(text.charCodeAt(i));
    if (!isSpace && !inWord && ++words > maxWords) return limit + 1;
    inWord = !isSpace;
  }
  return Math.ceil(words / 160);
}
export function* textChunks(text: string) {
  const words: string[] = [];
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    const isSpace = whitespace(text.charCodeAt(i));
    if (isSpace) {
      if (start >= 0) {
        words.push(text.slice(start, i));
        start = -1;
        if (words.length === 160) {
          yield words.join(" ");
          words.length = 0;
        }
      }
    } else if (start < 0) start = i;
  }
  if (start >= 0) words.push(text.slice(start));
  if (words.length) yield words.join(" ");
}
