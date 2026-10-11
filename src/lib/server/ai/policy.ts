export type TagVocabulary = { id: string; name: string; aliases: string[] };
export const policy = {
  minWords: 3,
  minSupport: 2,
  semanticThreshold: 0.2,
  maxTags: 1,
  hybridAlpha: 0.5,
  cacheBytes: 192 * 1024 * 1024,
  chunkCapacity: 100_000,
  queryMs: 3000,
} as const;
export const tokens = (text: string) =>
  text.toLowerCase().match(/[a-z][a-z0-9_-]*/g) ?? [];
export const stem = (word: string) =>
  word.endsWith("ies")
    ? word.slice(0, -3)
    : word.endsWith("s") && word.length > 4
      ? word.slice(0, -1)
      : word;
export function tagCandidates(text: string, tags: TagVocabulary[]) {
  const vocabulary = tags.map((tag) => ({
    tag,
    cues: new Set(tokens([tag.name, ...tag.aliases].join(" ")).map(stem)),
  }));
  const frequency = new Map<string, number>();
  for (const { cues } of vocabulary)
    for (const cue of cues) frequency.set(cue, (frequency.get(cue) ?? 0) + 1);
  const vocabularyCues = new Set(frequency.keys());
  const literal = new Set<string>();
  let wordCount = 0;
  for (const [word] of text.toLowerCase().matchAll(/[a-z][a-z0-9_-]*/g)) {
    if (wordCount < policy.minWords) wordCount++;
    const cue = stem(word);
    if (vocabularyCues.has(cue)) literal.add(cue);
  }
  if (wordCount < policy.minWords) return [];
  return vocabulary
    .map(({ tag, cues }) => ({
      tag,
      support: [...cues]
        .filter((cue) => literal.has(cue))
        .reduce((sum, cue) => sum + 1 / frequency.get(cue)!, 0),
    }))
    .filter((row) => row.support >= policy.minSupport);
}
export function cosine(a: Float32Array, b: Float32Array) {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}
export function protectedIdentifiers(query: string) {
  const patterns = [
    /"([^"\n]+)"/g,
    /'([^'\n]+)'/g,
    /(?<![\w-])([A-Z][A-Z0-9]+_[A-Z0-9_]+)(?![\w-])/g,
    /(?<![\w-])([\w.-]+\.(?:pdf|csv|json|md|txt|zip|tar|png|jpg|xlsx|docx|log))(?![\w-])/g,
    /(?<![\w-])([A-Za-z]{1,8}[-_]\d[\w-]*)(?![\w-])/g,
    /\b(\d{4}-\d{2}-\d{2})\b/g,
  ];
  return [
    ...new Set(
      patterns.flatMap((pattern) =>
        [...query.matchAll(pattern)].map((m) => m[1]),
      ),
    ),
  ];
}
export function literalProtection(query: string, text: string) {
  const identifiers = protectedIdentifiers(query);
  return (
    identifiers.length > 0 &&
    identifiers.every((id) =>
      new RegExp(
        "(?<![\\w-])" +
          id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
          "(?![\\w-])",
        "i",
      ).test(text),
    )
  );
}
export function hybridRank(
  query: string,
  dense: { key: string; score: number }[],
  lexical: { key: string; score: number }[],
  texts: Map<string, string>,
) {
  const d = new Map(dense.map((row) => [row.key, row.score])),
    l = new Map(lexical.map((row) => [row.key, row.score]));
  const lo = d.size ? Math.min(...d.values()) : 0,
    hi = d.size ? Math.max(...d.values()) : 1,
    lm = l.size ? Math.max(...l.values()) : 1;
  return [...new Set([...d.keys(), ...l.keys()])]
    .map((key) => ({
      key,
      score:
        (0.5 * ((d.get(key) ?? lo) - lo)) / (hi - lo || 1) +
        (0.5 * (l.get(key) ?? 0)) / (lm || 1),
      protected: literalProtection(query, texts.get(key) ?? ""),
    }))
    .sort(
      (a, b) =>
        Number(b.protected) - Number(a.protected) ||
        b.score - a.score ||
        a.key.localeCompare(b.key),
    )
    .slice(0, 30);
}

export const searchStopwords = new Set([
  "a",
  "about",
  "after",
  "all",
  "also",
  "an",
  "and",
  "any",
  "are",
  "as",
  "at",
  "be",
  "because",
  "been",
  "before",
  "but",
  "by",
  "can",
  "could",
  "did",
  "do",
  "does",
  "down",
  "each",
  "find",
  "for",
  "from",
  "had",
  "has",
  "have",
  "he",
  "her",
  "here",
  "his",
  "how",
  "i",
  "if",
  "in",
  "into",
  "is",
  "it",
  "its",
  "keep",
  "may",
  "me",
  "more",
  "most",
  "must",
  "my",
  "no",
  "not",
  "of",
  "on",
  "only",
  "or",
  "our",
  "out",
  "she",
  "should",
  "show",
  "so",
  "some",
  "than",
  "that",
  "the",
  "their",
  "then",
  "there",
  "they",
  "this",
  "through",
  "to",
  "up",
  "use",
  "used",
  "using",
  "was",
  "we",
  "were",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "will",
  "with",
  "without",
  "would",
  "you",
  "your",
]);
