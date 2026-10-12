import { sqlite } from "../db";
import { fingerprint } from "./content";
import { modelVersion } from "./model";
import { adaptiveTaggingPolicy, literalTagEvidence } from "./policy";

export type AdaptiveTag = { id: string; name: string; aliases: string[] };
export type AdaptiveTagVector = {
  tag: AdaptiveTag;
  labelScore: number;
  exampleScore?: number;
  support: number;
  literalEvidence?: boolean;
  ownerCorrection?: boolean;
};
export type AdaptiveTagMatch = {
  tag: AdaptiveTag;
  score: number;
  support: number;
  automaticEligible: boolean;
  origin: "label" | "examples" | "both";
};

type CachedTag = {
  id: string;
  name: string;
  aliases: string;
  embedding: Buffer;
  example_embedding: Buffer | null;
  example_owner_id: string | null;
  example_count: number;
  learned_revision: number;
  tag_revision: number;
};

type TaggedSource = {
  source_key: string;
  generation: number;
  fingerprint: string;
  item_id: string;
  canonical_item_key: string;
};

type CachedExampleProfile = {
  tag_id: string;
  owner_id: string;
  learned_revision: number;
  tag_revision: number;
};

const assignmentTables: Record<string, { table: string; itemColumn: string }> =
  {
    note: { table: "note_tags", itemColumn: "note_id" },
    task: { table: "task_tags", itemColumn: "task_id" },
    bookmark: { table: "bookmark_tags", itemColumn: "bookmark_id" },
    artifact: { table: "artifact_tags", itemColumn: "artifact_id" },
    event: { table: "event_tags", itemColumn: "event_id" },
    form: { table: "form_tags", itemColumn: "form_id" },
    response: { table: "response_tags", itemColumn: "response_id" },
  };

function normalized(vector: Float32Array) {
  if (vector.length !== 384) return undefined;
  const result = new Float32Array(384);
  let norm = 0;
  for (let i = 0; i < 384; i++) {
    if (!Number.isFinite(vector[i])) return undefined;
    result[i] = vector[i];
    norm += vector[i] * vector[i];
  }
  norm = Math.sqrt(norm);
  if (norm < 1e-5) return undefined;
  for (let i = 0; i < 384; i++) result[i] /= norm;
  return result;
}

function decode(input: Buffer) {
  if (input.length !== 1536) return undefined;
  const result = new Float32Array(384);
  for (let i = 0; i < 384; i++) result[i] = input.readFloatLE(i * 4);
  return normalized(result);
}

function encode(input: Float32Array) {
  const result = Buffer.alloc(1536);
  for (let i = 0; i < 384; i++) result.writeFloatLE(input[i], i * 4);
  return result;
}

function dot(left: Float32Array, right: Float32Array) {
  let score = 0;
  for (let i = 0; i < 384; i++) score += left[i] * right[i];
  return Math.max(-1, Math.min(1, score));
}

function tagFingerprint(name: string, aliases: string[]) {
  return fingerprint(
    JSON.stringify([
      name.normalize("NFKC").trim(),
      aliases.map((alias) => alias.normalize("NFKC").trim()),
    ]),
  );
}

function storedAliases(input: string) {
  const aliases = JSON.parse(input) as unknown;
  if (
    !Array.isArray(aliases) ||
    !aliases.every((alias) => typeof alias === "string")
  )
    throw new Error("Invalid tag alias cache identity.");
  return aliases;
}

function labelText(name: string, aliases: string[]) {
  return `${name}: ${aliases.join(" ")}`;
}

function currentLearnedRevision() {
  return (
    sqlite()
      .prepare(
        "SELECT learned_tag_revision AS revision FROM ai_configuration WHERE id=1",
      )
      .get() as { revision: number }
  ).revision;
}

function staleLabelRows(limit: number) {
  return sqlite()
    .prepare(
      `SELECT t.id,t.name,t.aliases FROM tags t
       LEFT JOIN ai_tag_embeddings e ON e.tag_id=t.id
       WHERE e.tag_id IS NULL OR e.model_version<>? OR e.tag_name IS NOT t.name OR e.aliases IS NOT t.aliases
       ORDER BY t.id LIMIT ?`,
    )
    .all(modelVersion, limit) as {
    id: string;
    name: string;
    aliases: string;
  }[];
}

function writeLabel(
  row: { id: string; name: string; aliases: string },
  vector: Float32Array,
) {
  const aliases = storedAliases(row.aliases);
  const d = sqlite();
  d.prepare(
    `INSERT INTO ai_tag_embeddings(tag_id,model_version,tag_fingerprint,tag_name,aliases,dimensions,embedding,learned_revision,example_count,example_embedding,updated_at)
     VALUES(?,?,?,?,?,384,?,0,0,NULL,?)
     ON CONFLICT(tag_id) DO UPDATE SET model_version=excluded.model_version,tag_fingerprint=excluded.tag_fingerprint,tag_name=excluded.tag_name,aliases=excluded.aliases,dimensions=384,embedding=excluded.embedding,example_owner_id=NULL,learned_revision=0,example_count=0,example_embedding=NULL,updated_at=excluded.updated_at`,
  ).run(
    row.id,
    modelVersion,
    tagFingerprint(row.name, aliases),
    row.name,
    row.aliases,
    encode(vector),
    Date.now(),
  );
}

function staleExampleRows(ownerId: string, limit: number) {
  return sqlite()
    .prepare(
      `SELECT t.id,t.name,t.aliases,r.revision
       FROM tags t
       JOIN ai_tag_revisions r ON r.tag_id=t.id
       JOIN ai_tag_embeddings e ON e.tag_id=t.id AND e.model_version=?
       WHERE (e.learned_revision<>r.revision OR e.example_owner_id IS NOT ?) AND EXISTS(
         SELECT 1 FROM ai_source_tag_examples x
         JOIN ai_sources s USING(source_key)
         JOIN ai_content c USING(source_key)
         WHERE x.tag_id=t.id AND s.owner_id=? AND s.active=1
           AND c.state='indexed' AND c.indexed_generation=c.generation
           AND c.model_version=? AND c.fingerprint IS NOT NULL
          AND NOT EXISTS(SELECT 1 FROM ai_auto_assignments aa JOIN ai_sources aut USING(source_key) WHERE aut.owner_id=s.owner_id AND aut.item_kind=s.item_kind AND aut.item_id=s.item_id AND aa.tag_id=x.tag_id AND aa.approved=0)
       )
       ORDER BY t.id LIMIT ?`,
    )
    .all(modelVersion, ownerId, ownerId, modelVersion, limit) as {
    id: string;
    name: string;
    aliases: string;
    revision: number;
  }[];
}

function staleExampleCacheRows(ownerId: string, limit: number) {
  return sqlite()
    .prepare(
      `SELECT e.tag_id,e.example_owner_id AS owner_id,e.learned_revision,r.revision AS tag_revision
       FROM ai_tag_embeddings e
       JOIN ai_tag_revisions r ON r.tag_id=e.tag_id
       WHERE e.model_version=? AND e.example_owner_id=?
         AND e.learned_revision<>r.revision
         AND (e.example_embedding IS NOT NULL OR e.example_count>0)
       ORDER BY e.tag_id LIMIT ?`,
    )
    .all(modelVersion, ownerId, limit) as CachedExampleProfile[];
}

function staleOtherOwnerExampleRows(ownerId: string, limit: number) {
  return sqlite()
    .prepare(
      `SELECT tag_id,example_owner_id AS owner_id,learned_revision
       FROM ai_tag_embeddings
       WHERE model_version=? AND example_owner_id IS NOT NULL AND example_owner_id<>?
       ORDER BY tag_id LIMIT ?`,
    )
    .all(modelVersion, ownerId, limit) as Omit<
    CachedExampleProfile,
    "tag_revision"
  >[];
}

function clearExampleProfile(input: {
  tagId: string;
  ownerId: string;
  learnedRevision: number;
  tagRevision?: number;
}) {
  sqlite()
    .prepare(
      `UPDATE ai_tag_embeddings
       SET example_owner_id=NULL,learned_revision=0,example_count=0,example_embedding=NULL,updated_at=?
       WHERE tag_id=? AND model_version=? AND example_owner_id=? AND learned_revision=?
         AND (? IS NULL OR EXISTS(
           SELECT 1 FROM ai_tag_revisions r WHERE r.tag_id=ai_tag_embeddings.tag_id AND r.revision=?
         ))`,
    )
    .run(
      Date.now(),
      input.tagId,
      modelVersion,
      input.ownerId,
      input.learnedRevision,
      input.tagRevision ?? null,
      input.tagRevision ?? null,
    );
}

function positiveExamples(ownerId: string, tagId: string) {
  const d = sqlite();
  const items = d
    .prepare(
      `SELECT x.canonical_item_key,s.item_kind,s.item_id,max(s.updated_at) AS updated_at
       FROM ai_source_tag_examples x
       JOIN ai_sources s USING(source_key)
       JOIN ai_content c USING(source_key)
       WHERE x.tag_id=? AND s.owner_id=? AND s.active=1
         AND c.state='indexed' AND c.indexed_generation=c.generation
         AND c.model_version=? AND c.fingerprint IS NOT NULL
         AND NOT EXISTS(SELECT 1 FROM ai_auto_assignments aa JOIN ai_sources aut USING(source_key) WHERE aut.owner_id=s.owner_id AND aut.item_kind=s.item_kind AND aut.item_id=s.item_id AND aa.tag_id=x.tag_id AND aa.approved=0)
       GROUP BY x.canonical_item_key,s.item_kind,s.item_id
       ORDER BY max(s.updated_at) DESC,s.item_id LIMIT ?`,
    )
    .all(
      tagId,
      ownerId,
      modelVersion,
      adaptiveTaggingPolicy.examplesPerTag,
    ) as {
    canonical_item_key: string;
    item_kind: string;
    item_id: string;
  }[];
  const sources = d.prepare(
    `SELECT s.source_key,s.item_id,c.generation,c.fingerprint,x.canonical_item_key
     FROM ai_source_tag_examples x
     JOIN ai_sources s USING(source_key)
     JOIN ai_content c USING(source_key)
     WHERE x.tag_id=? AND s.owner_id=? AND s.active=1
       AND s.item_kind=? AND s.item_id=?
       AND c.state='indexed' AND c.indexed_generation=c.generation
       AND c.model_version=? AND c.fingerprint IS NOT NULL
       AND NOT EXISTS(SELECT 1 FROM ai_auto_assignments aa JOIN ai_sources aut USING(source_key) WHERE aut.owner_id=s.owner_id AND aut.item_kind=s.item_kind AND aut.item_id=s.item_id AND aa.tag_id=x.tag_id AND aa.approved=0)
     ORDER BY CASE WHEN s.source_kind=s.item_kind THEN 0 ELSE 1 END,s.updated_at DESC,s.source_key
     LIMIT ?`,
  );
  return items.flatMap(
    (item) =>
      sources.all(
        tagId,
        ownerId,
        item.item_kind,
        item.item_id,
        modelVersion,
        adaptiveTaggingPolicy.chunksPerExample,
      ) as TaggedSource[],
  );
}

function buildExampleVector(ownerId: string, tagId: string) {
  const sources = positiveExamples(ownerId, tagId);
  const mean = new Float32Array(384);
  let examples = 0;
  const byItem = new Map<string, TaggedSource[]>();
  for (const source of sources) {
    const group = byItem.get(source.canonical_item_key) ?? [];
    group.push(source);
    byItem.set(source.canonical_item_key, group);
  }
  for (const itemSources of byItem.values()) {
    const item = new Float32Array(384);
    let sourceCount = 0;
    for (const source of itemSources) {
      const chunks = sqlite()
        .prepare(
          `SELECT embedding FROM ai_chunks
           WHERE source_key=? AND generation=? AND model_version=? AND modality='text' AND dimensions=384
           ORDER BY ordinal LIMIT ?`,
        )
        .all(
          source.source_key,
          source.generation,
          modelVersion,
          adaptiveTaggingPolicy.chunksPerExample,
        ) as { embedding: Buffer }[];
      const sourceVector = new Float32Array(384);
      let chunkCount = 0;
      for (const chunk of chunks) {
        const vector = decode(chunk.embedding);
        if (!vector) continue;
        for (let i = 0; i < 384; i++) sourceVector[i] += vector[i];
        chunkCount++;
      }
      if (!chunkCount) continue;
      const normalizedSource = normalized(sourceVector);
      if (!normalizedSource) continue;
      for (let i = 0; i < 384; i++) item[i] += normalizedSource[i];
      sourceCount++;
    }
    if (!sourceCount) continue;
    const itemVector = normalized(item);
    if (!itemVector) continue;
    for (let i = 0; i < 384; i++) mean[i] += itemVector[i];
    examples++;
  }
  return { vector: examples ? normalized(mean) : undefined, examples };
}

function saveExampleVector(tagId: string, revision: number, ownerId: string) {
  const profile = buildExampleVector(ownerId, tagId);
  const d = sqlite();
  d.prepare(
    `UPDATE ai_tag_embeddings
     SET example_owner_id=?,learned_revision=?,example_count=?,example_embedding=?,updated_at=?
     WHERE tag_id=? AND model_version=? AND EXISTS(SELECT 1 FROM ai_tag_revisions WHERE tag_id=? AND revision=?)`,
  ).run(
    profile.vector ? ownerId : null,
    profile.vector ? revision : 0,
    profile.examples,
    profile.vector ? encode(profile.vector) : null,
    Date.now(),
    tagId,
    modelVersion,
    tagId,
    revision,
  );
}

function assignedTagIds(itemKind: string, itemId: string) {
  const table = assignmentTables[itemKind];
  if (!table) return new Set<string>();
  return new Set(
    (
      sqlite()
        .prepare(
          `SELECT tag_id FROM ${table.table} WHERE ${table.itemColumn}=?`,
        )
        .all(itemId) as { tag_id: string }[]
    ).map(({ tag_id }) => tag_id),
  );
}

export function hasOwnerTagCorrection(
  sourceKey: string,
  contentFingerprint: string,
) {
  return Boolean(
    sqlite()
      .prepare(
        "SELECT 1 FROM ai_decisions WHERE source_key=? AND fingerprint=? AND decision='rejected' LIMIT 1",
      )
      .get(sourceKey, contentFingerprint),
  );
}

function better(
  left: AdaptiveTagVector & {
    score: number;
    origin: "label" | "examples" | "both";
  },
  right: AdaptiveTagVector & {
    score: number;
    origin: "label" | "examples" | "both";
  },
) {
  return (
    right.score - left.score ||
    right.support - left.support ||
    left.tag.name.localeCompare(right.tag.name) ||
    left.tag.id.localeCompare(right.tag.id)
  );
}

function asRanked(candidate: AdaptiveTagVector) {
  const labelScore = Number.isFinite(candidate.labelScore)
    ? candidate.labelScore
    : -1;
  const exampleScore = Number.isFinite(candidate.exampleScore)
    ? candidate.exampleScore!
    : -1;
  const origin =
    candidate.exampleScore !== undefined &&
    Math.abs(labelScore - exampleScore) <= 0.035
      ? "both"
      : exampleScore > labelScore
        ? "examples"
        : "label";
  return {
    ...candidate,
    score: Math.max(labelScore, exampleScore),
    origin: origin as "label" | "examples" | "both",
  };
}

function automaticEligible(
  score: number,
  exampleScore: number | undefined,
  support: number,
  origin: "label" | "examples" | "both",
  margin: number,
  literalEvidence: boolean,
) {
  return (
    (exampleScore !== undefined &&
      support >= adaptiveTaggingPolicy.automaticMinimumSupport &&
      exampleScore >= adaptiveTaggingPolicy.automaticMinimumScore &&
      margin >= adaptiveTaggingPolicy.automaticMargin) ||
    (score >= adaptiveTaggingPolicy.automaticLabelMinimumScore &&
      origin !== "examples" &&
      literalEvidence &&
      margin >= adaptiveTaggingPolicy.automaticLabelMargin)
  );
}

export function selectAdaptiveTag(
  candidates: AdaptiveTagVector[],
): AdaptiveTagMatch | undefined {
  const ranked = candidates
    .map(asRanked)
    .filter(
      (candidate) =>
        candidate.score >=
        adaptiveTaggingPolicy.minimumScore -
          adaptiveTaggingPolicy.ambiguityMargin,
    )
    .sort(better);
  const best = ranked[0];
  if (
    !best ||
    best.ownerCorrection ||
    best.score < adaptiveTaggingPolicy.minimumScore
  )
    return undefined;
  const margin = best.score - (ranked[1]?.score ?? -1);
  if (ranked[1] && margin < adaptiveTaggingPolicy.ambiguityMargin)
    return undefined;
  return {
    tag: best.tag,
    score: best.score,
    support: Math.min(adaptiveTaggingPolicy.examplesPerTag, best.support),
    automaticEligible: automaticEligible(
      best.score,
      best.exampleScore,
      best.support,
      best.origin,
      margin,
      best.literalEvidence ?? false,
    ),
    origin: best.origin,
  };
}

export type AdaptivePreparation =
  | { ready: false; learnedRevision: number }
  | {
      ready: true;
      learnedRevision: number;
      ownerCorrection?: boolean;
      match?: AdaptiveTagMatch;
    };

export async function prepareAdaptiveTagMatch(input: {
  ownerId: string;
  sourceKey: string;
  sourceFingerprint: string;
  itemKind: string;
  itemId: string;
  text: string;
  meanVector: Float32Array;
  deadline: number;
  signal?: AbortSignal;
  encode: (text: string, deadline: number) => Promise<Float32Array>;
}): Promise<AdaptivePreparation> {
  const d = sqlite();
  const initialRevision = currentLearnedRevision();
  if (hasOwnerTagCorrection(input.sourceKey, input.sourceFingerprint))
    return {
      ready: true,
      learnedRevision: initialRevision,
      ownerCorrection: true,
    };
  const missingLabels = staleLabelRows(
    adaptiveTaggingPolicy.labelEmbeddingsPerJob + 1,
  );
  for (const row of missingLabels.slice(
    0,
    adaptiveTaggingPolicy.labelEmbeddingsPerJob,
  )) {
    if (input.signal?.aborted || Date.now() >= input.deadline)
      throw new Error("Tag label preparation timed out.");
    const aliases = storedAliases(row.aliases);
    const vector = await input.encode(
      labelText(row.name, aliases),
      input.deadline,
    );
    writeLabel(row, vector);
  }
  if (
    missingLabels.length > adaptiveTaggingPolicy.labelEmbeddingsPerJob ||
    staleLabelRows(1).length > 0
  )
    return { ready: false, learnedRevision: initialRevision };

  const staleOtherOwnerProfiles = staleOtherOwnerExampleRows(
    input.ownerId,
    adaptiveTaggingPolicy.profilesPerJob + 1,
  );
  for (const row of staleOtherOwnerProfiles.slice(
    0,
    adaptiveTaggingPolicy.profilesPerJob,
  ))
    clearExampleProfile({
      tagId: row.tag_id,
      ownerId: row.owner_id,
      learnedRevision: row.learned_revision,
    });

  const staleProfiles = staleExampleRows(
    input.ownerId,
    adaptiveTaggingPolicy.profilesPerJob + 1,
  );
  for (const row of staleProfiles.slice(
    0,
    adaptiveTaggingPolicy.profilesPerJob,
  )) {
    if (input.signal?.aborted || Date.now() >= input.deadline)
      throw new Error("Tag example preparation timed out.");
    saveExampleVector(row.id, row.revision, input.ownerId);
  }
  const staleCachedProfiles = staleExampleCacheRows(
    input.ownerId,
    adaptiveTaggingPolicy.profilesPerJob + 1,
  );
  for (const row of staleCachedProfiles.slice(
    0,
    adaptiveTaggingPolicy.profilesPerJob,
  )) {
    if (input.signal?.aborted || Date.now() >= input.deadline)
      throw new Error("Tag example preparation timed out.");
    if (positiveExamples(input.ownerId, row.tag_id).length > 0) continue;
    clearExampleProfile({
      tagId: row.tag_id,
      ownerId: row.owner_id,
      learnedRevision: row.learned_revision,
      tagRevision: row.tag_revision,
    });
  }
  if (
    staleOtherOwnerProfiles.length > adaptiveTaggingPolicy.profilesPerJob ||
    staleOtherOwnerExampleRows(input.ownerId, 1).length > 0 ||
    staleProfiles.length > adaptiveTaggingPolicy.profilesPerJob ||
    staleExampleRows(input.ownerId, 1).length > 0 ||
    staleCachedProfiles.length > adaptiveTaggingPolicy.profilesPerJob ||
    staleExampleCacheRows(input.ownerId, 1).length > 0
  )
    return { ready: false, learnedRevision: initialRevision };

  const finalRevision = currentLearnedRevision();
  if (initialRevision !== finalRevision)
    return { ready: false, learnedRevision: finalRevision };

  const sourceVector = normalized(input.meanVector);
  if (!sourceVector) return { ready: true, learnedRevision: finalRevision };
  const assigned = assignedTagIds(input.itemKind, input.itemId);
  const literalEvidence = literalTagEvidence(
    input.text,
    d
      .prepare("SELECT id,name,aliases FROM tags ORDER BY id")
      .all()
      .map((row) => {
        const tag = row as { id: string; name: string; aliases: string };
        return {
          id: tag.id,
          name: tag.name,
          aliases: storedAliases(tag.aliases),
        };
      }),
  );
  let best:
    | (AdaptiveTagVector & {
        score: number;
        origin: "label" | "examples" | "both";
      })
    | undefined;
  let second: typeof best;
  let corrupt = false;
  const rows = d
    .prepare(
      `SELECT t.id,t.name,t.aliases,e.embedding,e.example_embedding,e.example_owner_id,e.example_count,e.learned_revision,r.revision AS tag_revision
       FROM tags t JOIN ai_tag_embeddings e ON e.tag_id=t.id
       JOIN ai_tag_revisions r ON r.tag_id=t.id
       WHERE e.model_version=? AND e.tag_name=t.name AND e.aliases=t.aliases
       ORDER BY t.id`,
    )
    .iterate(modelVersion) as Iterable<CachedTag>;
  for (const row of rows) {
    if (assigned.has(row.id)) continue;
    const nameAliases = storedAliases(row.aliases);
    const label = decode(row.embedding);
    if (!label) {
      d.prepare("DELETE FROM ai_tag_embeddings WHERE tag_id=?").run(row.id);
      corrupt = true;
      continue;
    }
    const examples =
      row.example_embedding &&
      row.example_owner_id === input.ownerId &&
      row.learned_revision === row.tag_revision &&
      row.example_count > 0
        ? decode(row.example_embedding)
        : undefined;
    if (
      row.example_embedding &&
      row.example_owner_id === input.ownerId &&
      row.learned_revision === row.tag_revision &&
      !examples
    ) {
      d.prepare(
        "UPDATE ai_tag_embeddings SET learned_revision=0,example_count=0,example_embedding=NULL WHERE tag_id=?",
      ).run(row.id);
      corrupt = true;
      continue;
    }
    const candidate = asRanked({
      tag: { id: row.id, name: row.name, aliases: nameAliases },
      labelScore: dot(sourceVector, label),
      ...(examples ? { exampleScore: dot(sourceVector, examples) } : {}),
      support: examples
        ? Math.min(row.example_count, adaptiveTaggingPolicy.examplesPerTag)
        : 0,
      literalEvidence: literalEvidence.has(row.id),
    });
    if (
      candidate.score <
      adaptiveTaggingPolicy.minimumScore - adaptiveTaggingPolicy.ambiguityMargin
    )
      continue;
    if (!best || better(candidate, best) < 0) {
      second = best;
      best = candidate;
    } else if (!second || better(candidate, second) < 0) {
      second = candidate;
    }
  }
  if (corrupt) return { ready: false, learnedRevision: finalRevision };
  const margin = best ? best.score - (second?.score ?? -1) : -1;
  const match =
    best &&
    best.score >= adaptiveTaggingPolicy.minimumScore &&
    (!second || margin >= adaptiveTaggingPolicy.ambiguityMargin)
      ? {
          tag: best.tag,
          score: best.score,
          support: Math.min(best.support, adaptiveTaggingPolicy.examplesPerTag),
          automaticEligible: automaticEligible(
            best.score,
            best.exampleScore,
            best.support,
            best.origin,
            margin,
            best.literalEvidence ?? false,
          ),
          origin: best.origin,
        }
      : undefined;
  return { ready: true, learnedRevision: finalRevision, match };
}
