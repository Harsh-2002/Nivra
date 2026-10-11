import { sqlite } from "../db";
import { modelVersion } from "./model";
import { policy } from "./policy";
type Source = {
  source_key: string;
  item_kind: string;
  item_id: string;
  key: string;
};
const blocks: { vectors: Float32Array; sources: Source[] }[] = [];
const sources = new Map<string, Source>();
let prefixOwner = "",
  prefixEnd = 0,
  cacheBytes = 0,
  epoch = -1,
  prefixFull = false;
export function clearVectorCache() {
  blocks.length = 0;
  sources.clear();
  prefixOwner = "";
  prefixEnd = 0;
  cacheBytes = 0;
  epoch = -1;
  prefixFull = false;
}
export async function vectorSearch(
  owner: string,
  query: Float32Array,
  deadline: number,
  type = "",
  tag = "",
) {
  const d = sqlite();
  const generation = () =>
    (
      d
        .prepare("SELECT index_generation FROM ai_configuration WHERE id=1")
        .get() as { index_generation: number }
    ).index_generation;
  const version = generation();
  if (epoch !== version) {
    clearVectorCache();
    epoch = version;
  }
  const rank = new Map<string, { score: number; sourceKey: string }>();
  let after = 0,
    count = 0;
  let filter = "";
  const parameters: (string | number)[] = [owner, modelVersion];
  if (type) {
    if (type === "note" || type === "journal") {
      filter +=
        " AND s.item_kind='note' AND EXISTS(SELECT 1 FROM notes n WHERE n.id=s.item_id AND n.daily_date IS " +
        (type === "journal" ? "NOT " : "") +
        "NULL)";
    } else {
      filter += " AND s.item_kind=?";
      parameters.push(type);
    }
  }
  if (tag) {
    filter +=
      " AND (" +
      (
        [
          "note",
          "task",
          "bookmark",
          "artifact",
          "event",
          "form",
          "response",
        ] as const
      )
        .map(
          (kind) =>
            `(s.item_kind='${kind}' AND EXISTS(SELECT 1 FROM ${kind}_tags it JOIN tags t ON t.id=it.tag_id WHERE it.${kind}_id=s.item_id AND t.name=? COLLATE NOCASE))`,
        )
        .join(" OR ") +
      ")";
    parameters.push(...Array(7).fill(tag));
  }
  const reusable = !type && !tag;
  if (reusable && prefixOwner !== owner) {
    clearVectorCache();
    epoch = version;
    prefixOwner = owner;
  }
  let cutoff: [string, { score: number; sourceKey: string }] | undefined;
  const scoreRow = (row: Source, vector: Float32Array, offset = 0) => {
    if (++count > policy.chunkCapacity)
      throw new Error("Semantic query capacity exceeded.");
    if (count % 16 === 0 && Date.now() > deadline)
      throw new Error("Semantic query resource limit reached.");
    let score = 0;
    for (let i = 0; i < 384; i++) score += query[i] * vector[offset + i];
    if (!Number.isFinite(score)) throw new Error("Invalid indexed embedding.");
    const key = row.key;
    if (score > (rank.get(key)?.score ?? -Infinity)) {
      if (!rank.has(key) && rank.size >= 30) {
        if (
          cutoff &&
          (score < cutoff[1].score ||
            (score === cutoff[1].score && key >= cutoff[0]))
        )
          return;
        if (cutoff) rank.delete(cutoff[0]);
      }
      rank.set(key, { score, sourceKey: row.source_key });
      if (rank.size >= 30) {
        cutoff = undefined;
        for (const entry of rank)
          if (
            !cutoff ||
            entry[1].score < cutoff[1].score ||
            (entry[1].score === cutoff[1].score && entry[0] > cutoff[0])
          )
            cutoff = entry;
      }
    }
  };
  if (reusable) {
    for (const block of blocks)
      for (let i = 0; i < block.sources.length; i++)
        scoreRow(block.sources[i], block.vectors, i * 384);
    after = prefixEnd;
  }
  const scan = d.prepare(
    `SELECT c.rowid AS row_id,c.source_key,c.ordinal,c.generation,s.item_kind,s.item_id FROM ai_chunks c NOT INDEXED CROSS JOIN ai_content s INDEXED BY sqlite_autoindex_ai_content_1 ON s.source_key=c.source_key WHERE s.owner_id=? AND c.model_version=? AND c.dimensions=384 AND c.modality='text' AND s.state='indexed' AND c.generation=s.generation ${filter} AND c.rowid>? ORDER BY c.rowid LIMIT 256`,
  );
  for (;;) {
    if (Date.now() > deadline || process.memoryUsage().rss > 448 * 1024 * 1024)
      throw new Error("Semantic query resource limit reached.");
    const rows = scan.all(...parameters, after) as {
      row_id: number;
      source_key: string;
      ordinal: number;
      generation: number;
      item_kind: string;
      item_id: string;
    }[];
    if (!rows.length) break;
    const embeddings = new Map<number, Buffer>(
      (
        d
          .prepare(
            `SELECT rowid AS row_id,embedding FROM ai_chunks WHERE rowid IN (${rows.map(() => "?").join(",")})`,
          )
          .all(...rows.map((row) => row.row_id)) as {
          row_id: number;
          embedding: Buffer;
        }[]
      ).map((row) => [row.row_id, row.embedding]),
    );
    const vectors = new Float32Array(rows.length * 384),
      rowSources: Source[] = [];
    let addedBytes = vectors.byteLength + rows.length * 16;
    const newSources = new Map<string, Source>();
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i],
        embedding = embeddings.get(row.row_id);
      if (!embedding || embedding.byteLength !== 1536)
        throw new Error("Invalid indexed embedding.");
      embedding.copy(Buffer.from(vectors.buffer, i * 1536, 1536));
      let source =
        sources.get(row.source_key) ?? newSources.get(row.source_key);
      if (!source) {
        source = {
          source_key: row.source_key,
          item_kind: row.item_kind,
          item_id: row.item_id,
          key: row.item_kind + ":" + row.item_id,
        };
        newSources.set(row.source_key, source);
        addedBytes +=
          256 +
          2 *
            (source.source_key.length +
              source.item_id.length +
              source.key.length);
      }
      rowSources.push(source);
    }
    if (
      reusable &&
      !prefixFull &&
      cacheBytes + addedBytes <= policy.cacheBytes
    ) {
      blocks.push({ vectors, sources: rowSources });
      for (const [key, source] of newSources) sources.set(key, source);
      cacheBytes += addedBytes;
      prefixEnd = rows.at(-1)!.row_id;
    } else if (reusable) prefixFull = true;
    for (let i = 0; i < rows.length; i++)
      scoreRow(rowSources[i], vectors, i * 384);
    after = rows.at(-1)!.row_id;
    await new Promise((resolve) => setImmediate(resolve));
  }
  if (generation() !== version)
    throw new Error("Semantic index changed during retrieval.");
  return [...rank]
    .map(([key, { score, sourceKey }]) => ({ key, sourceKey, score }))
    .sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
}
