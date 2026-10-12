import { randomUUID } from "node:crypto";
import { sqlite } from "../db";
import { HttpError } from "../http";
import { completionEvent } from "../jobs";
import { assignItemTags, itemTagState, type TaggedType } from "../item-tags";
import { fingerprint, sourceFor, sourceText, type AiSource } from "./content";
import { modelVersion } from "./model";
import { searchStopwords } from "./policy";

const vectorDimensions = 384;
const maxProposalNameLength = 60;
const maxCandidatesPerSource = 3;
const maxEvidencePerProposal = 12;
const maxPendingProposals = 30;
const maxProposalHistory = 100;
const maxProposalHistoryAge = 180 * 24 * 60 * 60 * 1000;
const proposalCooldown = 30 * 24 * 60 * 60 * 1000;
const proposalCohesionThreshold = 0.3;
const automaticCohesionThreshold = 0.5;
const automaticTagsPerDay = 3;
const genericPhraseWords = new Set([
  "note",
  "notes",
  "task",
  "tasks",
  "bookmark",
  "bookmarks",
  "artifact",
  "artifacts",
  "event",
  "events",
  "form",
  "forms",
  "response",
  "responses",
  "attachment",
  "attachments",
  "content",
  "item",
  "items",
  "document",
  "documents",
  "information",
  "thing",
  "things",
  "today",
  "yesterday",
  "tomorrow",
  "important",
  "update",
  "updates",
  "updated",
  "using",
  "used",
  "make",
  "made",
  "take",
  "taken",
  "need",
  "needs",
  "want",
  "wants",
  "get",
  "gets",
  "got",
  "look",
  "looks",
  "seem",
  "seems",
  "found",
  "include",
  "includes",
  "included",
  "create",
  "created",
  "write",
  "written",
  "working",
  "keep",
  "show",
  "showing",
  "trying",
  "help",
  "helped",
  "started",
  "finished",
]);
const itemTables: Record<TaggedType, string> = {
  note: "notes",
  task: "tasks",
  bookmark: "bookmarks",
  artifact: "artifacts",
  event: "calendar_events",
  form: "forms",
  response: "form_responses",
};

export type IndexedTagMatch = {
  tagId: string;
  score: number;
  support: number;
  automaticEligible: boolean;
  origin?: string;
};

export type IndexedTaggingInput = {
  ownerId: string;
  sourceKey: string;
  generation: number;
  fingerprint: string;
  itemKind: TaggedType;
  itemId: string;
  text: string;
  meanVector: Float32Array;
  matches: IndexedTagMatch[];
  learnedRevision: number;
};

type IndexedSource = AiSource & {
  configuration_enabled: number;
  tagging_mode: "manual" | "automatic";
  content_state: string;
  indexed_generation: number | null;
  model_version: string | null;
  content_fingerprint: string | null;
  learned_revision: number;
};

type ProposalEvidence = {
  source_key: string;
  canonical_item_key: string;
  generation: number;
  fingerprint: string;
  item_kind: TaggedType;
  item_id: string;
  title: string;
  created_at: number;
  embedding: Buffer;
  terms: string;
};

function normalizedName(name: string) {
  const clean = name
    .normalize("NFKC")
    .trim()
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/gu, " ");
  const words = clean.split(" ");
  if (
    clean.length < 3 ||
    clean.length > maxProposalNameLength ||
    words.length < 1 ||
    words.length > 3 ||
    words.some(
      (word) =>
        word.length < 3 ||
        word.length > 24 ||
        searchStopwords.has(word.toLowerCase()) ||
        genericPhraseWords.has(word.toLowerCase()) ||
        !/[\p{L}]/u.test(word),
    ) ||
    new Set(words.map((word) => word.toLocaleLowerCase())).size !== words.length
  )
    return undefined;
  return clean.toLocaleLowerCase();
}

function comparableName(name: string) {
  return name
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/\p{M}/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
}

function existingTagForName(name: string) {
  const wanted = comparableName(name);
  const rows = sqlite()
    .prepare("SELECT id,name,aliases FROM tags ORDER BY id")
    .all() as { id: string; name: string; aliases: string }[];
  for (const row of rows) {
    let aliases: string[] = [];
    try {
      aliases = JSON.parse(row.aliases) as string[];
    } catch {
      aliases = [];
    }
    if (
      [row.name, ...aliases].some((value) => comparableName(value) === wanted)
    )
      return row;
  }
  return undefined;
}

function extractPhrases(text: string) {
  const source = text
    .normalize("NFKC")
    .slice(0, 30_000)
    .replace(/\b[\w.+-]+@[\w.-]+\.[A-Z]{2,}\b/giu, " ")
    .replace(/\bhttps?:\/\/\S+/giu, " ")
    .replace(/\bwww\.\S+/giu, " ")
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/gu, " ")
    .replace(/(?<!\w)\+?\d[\d\s().-]{7,}\d(?!\w)/gu, " ")
    .replace(/\b\d{4}-\d{2}-\d{2}\b/gu, " ")
    .replace(/\b(?=[A-Z0-9_-]*\d)[A-Z0-9][A-Z0-9_-]{5,}\b/giu, " ")
    .replace(
      /\b[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}\b/giu,
      " ",
    );
  const raw = [...source.matchAll(/[\p{L}][\p{L}'’\-]{2,30}/gu)].slice(0, 5000);
  const words: { value: string; start: number; end: number }[] = [];
  for (const match of raw) {
    const value = match[0];
    const normalized = value.toLocaleLowerCase();
    if (
      searchStopwords.has(normalized) ||
      genericPhraseWords.has(normalized) ||
      /\d/u.test(value) ||
      normalized.length < 3
    )
      continue;
    words.push({
      value: normalized,
      start: match.index,
      end: match.index + value.length,
    });
  }
  const counts = new Map<string, number>();
  for (let size = 1; size <= 3; size++) {
    for (let i = 0; i + size <= words.length; i++) {
      const segment = words.slice(i, i + size);
      if (
        new Set(segment.map((word) => word.value)).size !== size ||
        segment.some(
          (word, index) =>
            index > 0 &&
            !/^\s+$/u.test(source.slice(segment[index - 1].end, word.start)),
        )
      )
        continue;
      const phrase = segment.map((word) => word.value).join(" ");
      counts.set(phrase, (counts.get(phrase) ?? 0) + 1);
    }
  }
  return [...counts]
    .map(([name, count]) => ({
      name,
      rank: count + (name.split(" ").length - 1) * 0.25,
    }))
    .sort((a, b) => b.rank - a.rank || a.name.localeCompare(b.name))
    .slice(0, maxCandidatesPerSource)
    .map(({ name }) => name);
}

function normalizedVector(input: Float32Array) {
  if (!(input instanceof Float32Array) || input.length !== vectorDimensions)
    return undefined;
  const copy = new Float32Array(vectorDimensions);
  let norm = 0;
  for (let i = 0; i < vectorDimensions; i++) {
    if (!Number.isFinite(input[i])) return undefined;
    copy[i] = input[i];
    norm += input[i] * input[i];
  }
  norm = Math.sqrt(norm);
  if (norm < 1e-5) return undefined;
  for (let i = 0; i < vectorDimensions; i++) copy[i] /= norm;
  return copy;
}

function encodeVector(vector: Float32Array) {
  const output = Buffer.alloc(vectorDimensions * 4);
  for (let i = 0; i < vectorDimensions; i++)
    output.writeFloatLE(vector[i], i * 4);
  return output;
}

function decodeVector(input: Buffer) {
  if (input.length !== vectorDimensions * 4) return undefined;
  const output = new Float32Array(vectorDimensions);
  let norm = 0;
  for (let i = 0; i < vectorDimensions; i++) {
    output[i] = input.readFloatLE(i * 4);
    if (!Number.isFinite(output[i])) return undefined;
    norm += output[i] * output[i];
  }
  norm = Math.sqrt(norm);
  if (norm < 1e-5) return undefined;
  for (let i = 0; i < vectorDimensions; i++) output[i] /= norm;
  return output;
}

function cosine(left: Float32Array, right: Float32Array) {
  let score = 0;
  for (let i = 0; i < vectorDimensions; i++) score += left[i] * right[i];
  return Math.max(-1, Math.min(1, score));
}

function currentSource(input: IndexedTaggingInput): IndexedSource | undefined {
  if (fingerprint(input.text) !== input.fingerprint) return undefined;
  const row = sqlite()
    .prepare(
      "SELECT s.*,c.generation AS generation,c.state AS content_state,c.indexed_generation,c.model_version,c.fingerprint AS content_fingerprint,a.enabled AS configuration_enabled,a.tagging_mode,a.learned_tag_revision AS learned_revision FROM ai_sources s JOIN ai_content c USING(source_key) JOIN ai_configuration a ON a.id=1 WHERE s.source_key=?",
    )
    .get(input.sourceKey) as IndexedSource | undefined;
  if (
    !row ||
    !row.configuration_enabled ||
    row.owner_id !== input.ownerId ||
    !row.active ||
    row.generation !== input.generation ||
    row.item_kind !== input.itemKind ||
    row.item_id !== input.itemId ||
    row.content_state !== "indexed" ||
    row.indexed_generation !== input.generation ||
    row.model_version !== modelVersion ||
    row.content_fingerprint !== input.fingerprint ||
    row.learned_revision !== input.learnedRevision
  )
    return undefined;
  if (
    input.itemKind === "response" &&
    !reviewedPrivateResponse(input.ownerId, input.itemId)
  )
    return undefined;
  const source = sourceFor(input.sourceKey);
  if (
    !source ||
    !source.active ||
    source.owner_id !== input.ownerId ||
    source.generation !== input.generation ||
    fingerprint(sourceText(source)) !== input.fingerprint
  )
    return undefined;
  return row;
}

function reviewedPrivateResponse(owner: string, id: string) {
  return Boolean(
    sqlite()
      .prepare(
        "SELECT 1 FROM form_responses r JOIN forms f ON f.id=r.form_id WHERE r.id=? AND r.reviewed=1 AND r.trashed_at IS NULL AND f.owner_id=? AND f.trashed_at IS NULL",
      )
      .get(id, owner),
  );
}

function tagNameFingerprint(name: string) {
  return fingerprint(name.normalize("NFKC").trim().toLowerCase());
}

function rejectedForSource(
  sourceKey: string,
  contentFingerprint: string,
  tagId: string,
  name: string,
) {
  return Boolean(
    sqlite()
      .prepare(
        "SELECT 1 FROM ai_decisions WHERE source_key=? AND fingerprint=? AND tag_id=? AND tag_fingerprint=? AND decision='rejected'",
      )
      .get(sourceKey, contentFingerprint, tagId, tagNameFingerprint(name)),
  );
}

function sourceItemHasUnapprovedAutomation(
  owner: string,
  type: TaggedType,
  id: string,
  tagId: string,
) {
  return Boolean(
    sqlite()
      .prepare(
        "SELECT 1 FROM ai_auto_assignments aa JOIN ai_sources s USING(source_key) WHERE s.owner_id=? AND s.item_kind=? AND s.item_id=? AND s.active=1 AND aa.tag_id=? AND aa.approved=0 LIMIT 1",
      )
      .get(owner, type, id, tagId),
  );
}

function hasAnyTag(owner: string, type: TaggedType, id: string) {
  return itemTagState(owner, type, id).tags.length > 0;
}

function assignAutomatically(
  owner: string,
  sourceKey: string,
  generation: number,
  sourceFingerprint: string,
  type: TaggedType,
  itemId: string,
  tagId: string,
  tagName: string,
) {
  const d = sqlite();
  const current = d
    .prepare(
      "SELECT s.owner_id,s.active,s.item_kind,s.item_id,c.generation,c.fingerprint,c.indexed_generation,c.state FROM ai_sources s JOIN ai_content c USING(source_key) WHERE s.source_key=?",
    )
    .get(sourceKey) as
    | {
        owner_id: string;
        active: number;
        item_kind: TaggedType;
        item_id: string;
        generation: number;
        fingerprint: string | null;
        indexed_generation: number | null;
        state: string;
      }
    | undefined;
  if (
    !current ||
    current.owner_id !== owner ||
    !current.active ||
    current.item_kind !== type ||
    current.item_id !== itemId ||
    current.generation !== generation ||
    current.indexed_generation !== generation ||
    current.state !== "indexed" ||
    current.fingerprint !== sourceFingerprint ||
    rejectedForSource(sourceKey, sourceFingerprint, tagId, tagName)
  )
    return false;
  if (type === "response" && !reviewedPrivateResponse(owner, itemId))
    return false;
  if (!d.prepare("SELECT 1 FROM tags WHERE id=?").get(tagId)) return false;
  const membership = d
    .prepare(`SELECT 1 FROM ${type}_tags WHERE ${type}_id=? AND tag_id=?`)
    .get(itemId, tagId);
  const previouslyAutomatic = sourceItemHasUnapprovedAutomation(
    owner,
    type,
    itemId,
    tagId,
  );
  let assigned = false;
  if (!membership) {
    d.prepare(
      "INSERT INTO ai_auto_assignments(source_key,tag_id,generation,fingerprint,approved,created_at) VALUES(?,?,?, ?,0,?) ON CONFLICT(source_key,tag_id) DO UPDATE SET generation=excluded.generation,fingerprint=excluded.fingerprint",
    ).run(sourceKey, tagId, generation, sourceFingerprint, Date.now());
    d.prepare(
      `INSERT OR IGNORE INTO ${type}_tags(${type}_id,tag_id) VALUES(?,?)`,
    ).run(itemId, tagId);
    assigned = true;
    const table = itemTables[type];
    d.prepare(
      type === "response"
        ? "UPDATE form_responses SET revision=revision+1 WHERE id=?"
        : `UPDATE ${table} SET revision=revision+1 WHERE id=? AND owner_id=?`,
    ).run(...(type === "response" ? [itemId] : [itemId, owner]));
    completionEvent(
      owner,
      "content",
      itemId,
      type === "form" ? "forms" : "changed",
    );
  }
  if (!assigned && previouslyAutomatic)
    d.prepare(
      "INSERT INTO ai_auto_assignments(source_key,tag_id,generation,fingerprint,approved,created_at) VALUES(?,?,?,?,0,?) ON CONFLICT(source_key,tag_id) DO UPDATE SET generation=excluded.generation,fingerprint=excluded.fingerprint",
    ).run(sourceKey, tagId, generation, sourceFingerprint, Date.now());
  return assigned;
}

function validEvidenceRows(proposalId: string, owner: string) {
  return sqlite()
    .prepare(
      `SELECT e.source_key,e.canonical_item_key,e.generation,e.fingerprint,e.embedding,e.terms,e.created_at,s.item_kind,s.item_id,s.title
       FROM ai_tag_proposal_evidence e
       JOIN ai_content c USING(source_key)
       JOIN ai_sources s USING(source_key)
       WHERE e.proposal_id=? AND s.owner_id=? AND s.active=1
         AND (s.item_kind<>'response' OR EXISTS(
           SELECT 1 FROM form_responses r JOIN forms f ON f.id=r.form_id
           WHERE r.id=s.item_id AND r.reviewed=1 AND r.trashed_at IS NULL
             AND f.owner_id=s.owner_id AND f.trashed_at IS NULL
         ))
         AND NOT EXISTS(
           SELECT 1 FROM ai_decisions d
           WHERE d.source_key=e.source_key AND d.fingerprint=e.fingerprint
             AND d.decision='rejected'
         )
         AND NOT (
           (s.item_kind='note' AND EXISTS(SELECT 1 FROM note_tags x WHERE x.note_id=s.item_id)) OR
           (s.item_kind='task' AND EXISTS(SELECT 1 FROM task_tags x WHERE x.task_id=s.item_id)) OR
           (s.item_kind='bookmark' AND EXISTS(SELECT 1 FROM bookmark_tags x WHERE x.bookmark_id=s.item_id)) OR
           (s.item_kind='artifact' AND EXISTS(SELECT 1 FROM artifact_tags x WHERE x.artifact_id=s.item_id)) OR
           (s.item_kind='event' AND EXISTS(SELECT 1 FROM event_tags x WHERE x.event_id=s.item_id)) OR
           (s.item_kind='form' AND EXISTS(SELECT 1 FROM form_tags x WHERE x.form_id=s.item_id)) OR
           (s.item_kind='response' AND EXISTS(SELECT 1 FROM response_tags x WHERE x.response_id=s.item_id))
         )
         AND e.generation=c.generation AND e.fingerprint=c.fingerprint
         AND e.model_version=c.model_version AND c.model_version=?
         AND c.state='indexed' AND c.indexed_generation=c.generation
       ORDER BY e.created_at,e.canonical_item_key LIMIT ?`,
    )
    .all(
      proposalId,
      owner,
      modelVersion,
      maxEvidencePerProposal,
    ) as (ProposalEvidence & {
    item_kind: TaggedType;
    item_id: string;
    title: string;
  })[];
}

function clusterCohesion(rows: ProposalEvidence[]) {
  const vectors: Float32Array[] = [];
  for (const row of rows) {
    const vector = decodeVector(row.embedding);
    if (vector) vectors.push(vector);
  }
  if (vectors.length < 2) return 0;
  let total = 0;
  let pairs = 0;
  for (let i = 0; i < vectors.length; i++)
    for (let j = i + 1; j < vectors.length; j++) {
      total += cosine(vectors[i], vectors[j]);
      pairs++;
    }
  return pairs ? total / pairs : 0;
}

function evidenceIdentity(type: TaggedType, id: string) {
  return `${type}:${id}`;
}

function reclaimEmptyPendingProposals(owner: string) {
  const d = sqlite();
  const proposals = d
    .prepare(
      "SELECT id FROM ai_tag_proposals WHERE owner_id=? AND status='pending' ORDER BY created_at,id",
    )
    .all(owner) as { id: string }[];
  const storedEvidence = d.prepare(
    "SELECT source_key FROM ai_tag_proposal_evidence WHERE proposal_id=?",
  );
  const removeEvidence = d.prepare(
    "DELETE FROM ai_tag_proposal_evidence WHERE proposal_id=? AND source_key=?",
  );
  const removeProposal = d.prepare(
    "DELETE FROM ai_tag_proposals WHERE id=? AND owner_id=? AND status='pending'",
  );

  for (const proposal of proposals) {
    const valid = validEvidenceRows(proposal.id, owner);
    const validSources = new Set(valid.map((row) => row.source_key));
    for (const row of storedEvidence.all(proposal.id) as {
      source_key: string;
    }[])
      if (!validSources.has(row.source_key))
        removeEvidence.run(proposal.id, row.source_key);

    if (!valid.length) removeProposal.run(proposal.id, owner);
  }
}

function storeEvidence(
  owner: string,
  input: IndexedTaggingInput,
  name: string,
  vector: Buffer,
  terms: string[],
) {
  const d = sqlite();
  reclaimEmptyPendingProposals(owner);
  const key = fingerprint(name);
  let proposal = d
    .prepare(
      "SELECT id,status,cooldown_until FROM ai_tag_proposals WHERE owner_id=? AND name_fingerprint=?",
    )
    .get(owner, key) as
    { id: string; status: string; cooldown_until: number | null } | undefined;
  const now = Date.now();
  const evidenceExists = proposal
    ? d
        .prepare(
          "SELECT 1 FROM ai_tag_proposal_evidence WHERE proposal_id=? AND canonical_item_key=? AND source_key=? AND generation=? AND fingerprint=?",
        )
        .get(
          proposal.id,
          evidenceIdentity(input.itemKind, input.itemId),
          input.sourceKey,
          input.generation,
          input.fingerprint,
        )
    : undefined;
  if (
    proposal?.status === "rejected" &&
    proposal.cooldown_until &&
    proposal.cooldown_until > now
  )
    return undefined;
  if (proposal?.status === "rejected" && evidenceExists) return undefined;
  if (
    proposal?.status === "rejected" &&
    (proposal.cooldown_until ?? 0) <= now
  ) {
    d.prepare(
      "UPDATE ai_tag_proposals SET status='pending',reviewed_at=NULL,cooldown_until=NULL,cohesion=0 WHERE id=?",
    ).run(proposal.id);
    proposal = { ...proposal, status: "pending", cooldown_until: null };
  }
  if (
    proposal &&
    (proposal.status === "accepted" || proposal.status === "automatic")
  )
    return undefined;
  if (!proposal) {
    d.prepare(
      "DELETE FROM ai_tag_proposals WHERE owner_id=? AND status<>'pending' AND coalesce(reviewed_at,created_at)<?",
    ).run(owner, now - maxProposalHistoryAge);
    const pendingCount = (
      d
        .prepare(
          "SELECT count(*) AS n FROM ai_tag_proposals WHERE owner_id=? AND status='pending'",
        )
        .get(owner) as { n: number }
    ).n;
    const historyCount = (
      d
        .prepare("SELECT count(*) AS n FROM ai_tag_proposals WHERE owner_id=?")
        .get(owner) as { n: number }
    ).n;
    if (
      pendingCount >= maxPendingProposals ||
      historyCount >= maxProposalHistory
    )
      return undefined;
    const id = randomUUID();
    d.prepare(
      "INSERT INTO ai_tag_proposals(id,owner_id,normalized_name,name_fingerprint,name,status,cohesion,created_at) VALUES(?,?,?,?,?,'pending',0,?)",
    ).run(id, owner, comparableName(name), key, name, now);
    proposal = { id, status: "pending", cooldown_until: null };
  }
  if (!proposal) return undefined;
  const existing = d
    .prepare(
      "SELECT count(*) AS n FROM ai_tag_proposal_evidence WHERE proposal_id=?",
    )
    .get(proposal.id) as { n: number };
  const identity = evidenceIdentity(input.itemKind, input.itemId);
  if (existing.n >= maxEvidencePerProposal && !evidenceExists)
    return proposal.id;
  d.prepare(
    "INSERT INTO ai_tag_proposal_evidence(proposal_id,source_key,canonical_item_key,generation,fingerprint,model_version,cohesion,embedding,terms,created_at) VALUES(?,?,?,?,?,?,0,?,?,?) ON CONFLICT(proposal_id,canonical_item_key) DO UPDATE SET source_key=excluded.source_key,generation=excluded.generation,fingerprint=excluded.fingerprint,model_version=excluded.model_version,embedding=excluded.embedding,terms=excluded.terms,created_at=excluded.created_at",
  ).run(
    proposal.id,
    input.sourceKey,
    identity,
    input.generation,
    input.fingerprint,
    modelVersion,
    vector,
    JSON.stringify(terms.slice(0, maxCandidatesPerSource)),
    now,
  );
  const rows = validEvidenceRows(proposal.id, owner);
  const cohesion = clusterCohesion(rows);
  d.prepare("UPDATE ai_tag_proposals SET cohesion=? WHERE id=?").run(
    cohesion,
    proposal.id,
  );
  return proposal.id;
}

function createOrReuseTag(name: string) {
  const existing = existingTagForName(name);
  if (existing) return { id: existing.id, created: false };
  const id = randomUUID();
  sqlite()
    .prepare("INSERT INTO tags(id,name,color,aliases) VALUES(?,?,'gray','[]')")
    .run(id, name);
  return { id, created: true };
}

function createAutomaticTagIfEligible(
  owner: string,
  proposalId: string,
  name: string,
  current: IndexedSource,
) {
  const d = sqlite();
  const rows = validEvidenceRows(proposalId, owner);
  const itemCount = new Set(rows.map((row) => row.canonical_item_key)).size;
  const cohesion = clusterCohesion(rows);
  if (
    itemCount < 3 ||
    cohesion < automaticCohesionThreshold ||
    current.tagging_mode !== "automatic"
  )
    return false;
  const tagMatch = existingTagForName(name);
  if (!tagMatch) {
    const start = new Date();
    start.setUTCHours(0, 0, 0, 0);
    const createdToday = (
      d
        .prepare(
          "SELECT count(*) AS n FROM ai_tag_proposals WHERE owner_id=? AND status='automatic' AND reviewed_at>=?",
        )
        .get(owner, start.getTime()) as { n: number }
    ).n;
    if (createdToday >= automaticTagsPerDay) return false;
  }
  const tag = tagMatch
    ? { id: tagMatch.id, created: false }
    : createOrReuseTag(name);
  for (const row of rows) {
    const source = sourceFor(row.source_key);
    if (
      !source ||
      !source.active ||
      source.owner_id !== owner ||
      source.generation !== row.generation ||
      row.item_kind !== source.item_kind ||
      row.item_id !== source.item_id ||
      fingerprint(sourceText(source)) !== row.fingerprint
    )
      continue;
    assignAutomatically(
      owner,
      row.source_key,
      row.generation,
      row.fingerprint,
      row.item_kind,
      row.item_id,
      tag.id,
      name,
    );
  }
  d.prepare(
    "UPDATE ai_tag_proposals SET status='automatic',cohesion=?,reviewed_at=?,cooldown_until=NULL,created_tag_id=? WHERE id=? AND owner_id=? AND status='pending'",
  ).run(cohesion, Date.now(), tag.created ? tag.id : null, proposalId, owner);
  return true;
}

export function processIndexedTagging(input: IndexedTaggingInput) {
  const vector = normalizedVector(input.meanVector);
  if (!vector) return "stale" as const;
  const d = sqlite();
  return d
    .transaction(() => {
      const current = currentSource(input);
      if (!current) return "stale" as const;
      if (
        d
          .prepare(
            "SELECT 1 FROM ai_decisions WHERE source_key=? AND fingerprint=? AND decision='rejected' LIMIT 1",
          )
          .get(input.sourceKey, input.fingerprint)
      )
        return "processed" as const;
      if (input.matches.length) {
        if (current.tagging_mode !== "automatic") return "processed" as const;
        const seen = new Set<string>();
        for (const match of input.matches) {
          if (
            !match.automaticEligible ||
            seen.has(match.tagId) ||
            !Number.isFinite(match.score) ||
            match.score < 0 ||
            match.score > 1
          )
            continue;
          seen.add(match.tagId);
          const tag = d
            .prepare("SELECT name FROM tags WHERE id=?")
            .get(match.tagId) as { name: string } | undefined;
          if (!tag) continue;
          assignAutomatically(
            input.ownerId,
            input.sourceKey,
            input.generation,
            input.fingerprint,
            input.itemKind,
            input.itemId,
            match.tagId,
            tag.name,
          );
        }
        return "processed" as const;
      }
      if (hasAnyTag(input.ownerId, input.itemKind, input.itemId))
        return "processed" as const;
      const candidates = extractPhrases(input.text)
        .map((name) => normalizedName(name))
        .filter((name): name is string => Boolean(name))
        .filter((name, index, all) => all.indexOf(name) === index)
        .filter((name) => !existingTagForName(name));
      if (!candidates.length) return "processed" as const;
      const bytes = encodeVector(vector);
      const proposalIds = new Set<string>();
      for (const name of candidates) {
        const proposalId = storeEvidence(
          input.ownerId,
          input,
          name,
          bytes,
          candidates,
        );
        if (proposalId) proposalIds.add(proposalId);
      }
      if (!proposalIds.size) return "processed" as const;
      const cluster = consolidateProposalCluster(
        input.ownerId,
        input,
        vector,
        proposalIds,
      );
      if (!cluster) return "processed" as const;
      if (current.tagging_mode === "automatic")
        createAutomaticTagIfEligible(
          input.ownerId,
          cluster.id,
          cluster.name,
          current,
        );
      return "processed" as const;
    })
    .immediate();
}

function consolidateProposalCluster(
  owner: string,
  input: IndexedTaggingInput,
  currentVector: Float32Array,
  currentProposalIds: Set<string>,
) {
  const d = sqlite();
  const pending = d
    .prepare(
      "SELECT id,name,created_at FROM ai_tag_proposals WHERE owner_id=? AND status='pending' ORDER BY cohesion DESC,created_at,id LIMIT ?",
    )
    .all(owner, maxPendingProposals) as {
    id: string;
    name: string;
    created_at: number;
  }[];
  const relevant = pending
    .map((proposal) => ({
      ...proposal,
      rows: validEvidenceRows(proposal.id, owner),
    }))
    .filter(
      (proposal) =>
        currentProposalIds.has(proposal.id) ||
        proposal.rows.some((row) => {
          const vector = decodeVector(row.embedding);
          return (
            vector && cosine(currentVector, vector) >= proposalCohesionThreshold
          );
        }),
    );
  const uniqueEvidence = new Map<
    string,
    (typeof relevant)[number]["rows"][number]
  >();
  for (const proposal of relevant)
    for (const row of proposal.rows) {
      const current = uniqueEvidence.get(row.canonical_item_key);
      if (!current || row.created_at > current.created_at)
        uniqueEvidence.set(row.canonical_item_key, row);
    }
  const rows = [...uniqueEvidence.values()].slice(0, maxEvidencePerProposal);
  const cohesion = clusterCohesion(rows);
  if (rows.length < 3 || cohesion < proposalCohesionThreshold) return undefined;

  const termScores = new Map<
    string,
    { items: Set<string>; rank: number; count: number }
  >();
  for (const row of rows) {
    let terms: string[] = [];
    try {
      const parsed: unknown = JSON.parse(row.terms);
      if (Array.isArray(parsed))
        terms = parsed.filter(
          (term): term is string => typeof term === "string",
        );
    } catch {
      terms = [];
    }
    for (const [index, candidate] of terms.entries()) {
      const name = normalizedName(candidate);
      if (!name || existingTagForName(name)) continue;
      const entry = termScores.get(name) ?? {
        items: new Set<string>(),
        rank: 0,
        count: 0,
      };
      entry.items.add(row.canonical_item_key);
      entry.rank += maxCandidatesPerSource - index;
      entry.count++;
      termScores.set(name, entry);
    }
  }
  const selected = [...termScores]
    .map(([name, score]) => ({
      name,
      support: score.items.size,
      rank: score.rank,
      count: score.count,
    }))
    .sort(
      (a, b) =>
        b.support - a.support ||
        b.rank - a.rank ||
        b.name.split(" ").length - a.name.split(" ").length ||
        a.name.localeCompare(b.name),
    )[0];
  if (!selected) return undefined;

  const selectedFingerprint = fingerprint(selected.name);
  let target = d
    .prepare(
      "SELECT id,status,cooldown_until FROM ai_tag_proposals WHERE owner_id=? AND name_fingerprint=?",
    )
    .get(owner, selectedFingerprint) as
    { id: string; status: string; cooldown_until: number | null } | undefined;
  if (
    target?.status === "rejected" &&
    target.cooldown_until !== null &&
    target.cooldown_until > Date.now()
  )
    return undefined;
  if (target && (target.status === "accepted" || target.status === "automatic"))
    return undefined;
  if (target?.status === "rejected") {
    d.prepare(
      "UPDATE ai_tag_proposals SET status='pending',reviewed_at=NULL,cooldown_until=NULL WHERE id=?",
    ).run(target.id);
    target = { ...target, status: "pending", cooldown_until: null };
  }
  if (!target) {
    const reusable = relevant.find((proposal) => proposal.id !== target?.id);
    if (!reusable) return undefined;
    d.prepare(
      "UPDATE ai_tag_proposals SET name=?,normalized_name=?,name_fingerprint=?,cohesion=? WHERE id=? AND owner_id=? AND status='pending'",
    ).run(
      selected.name,
      comparableName(selected.name),
      selectedFingerprint,
      cohesion,
      reusable.id,
      owner,
    );
    target = { id: reusable.id, status: "pending", cooldown_until: null };
  }
  const targetId = target.id;
  for (const row of rows)
    d.prepare(
      "INSERT INTO ai_tag_proposal_evidence(proposal_id,source_key,canonical_item_key,generation,fingerprint,model_version,cohesion,embedding,terms,created_at) VALUES(?,?,?,?,?,?,0,?,?,?) ON CONFLICT(proposal_id,canonical_item_key) DO UPDATE SET source_key=excluded.source_key,generation=excluded.generation,fingerprint=excluded.fingerprint,model_version=excluded.model_version,embedding=excluded.embedding,terms=excluded.terms,created_at=excluded.created_at",
    ).run(
      targetId,
      row.source_key,
      row.canonical_item_key,
      row.generation,
      row.fingerprint,
      modelVersion,
      row.embedding,
      row.terms,
      row.created_at,
    );
  const siblingIds = relevant
    .map((proposal) => proposal.id)
    .filter((id) => id !== targetId);
  for (const siblingId of siblingIds)
    d.prepare(
      "UPDATE ai_tag_proposals SET status='rejected',reviewed_at=?,cooldown_until=? WHERE id=? AND owner_id=? AND status='pending'",
    ).run(Date.now(), Date.now() + proposalCooldown, siblingId, owner);
  d.prepare(
    "UPDATE ai_tag_proposals SET cohesion=? WHERE id=? AND owner_id=?",
  ).run(cohesion, targetId, owner);
  return {
    id: targetId,
    name: selected.name,
    cohesion,
    itemCount: rows.length,
  };
}

function proposalRows(owner: string) {
  if (
    !(
      sqlite()
        .prepare("SELECT enabled FROM ai_configuration WHERE id=1")
        .get() as { enabled: number }
    ).enabled
  )
    return [];
  const proposals = sqlite()
    .prepare(
      "SELECT id,name,created_at FROM ai_tag_proposals WHERE owner_id=? AND status='pending' AND coalesce(cooldown_until,0)<=? ORDER BY created_at DESC,id LIMIT ?",
    )
    .all(owner, Date.now(), maxPendingProposals) as {
    id: string;
    name: string;
    created_at: number;
  }[];
  return proposals
    .map((proposal) => {
      const rows = validEvidenceRows(proposal.id, owner);
      return {
        ...proposal,
        item_count: new Set(rows.map((row) => row.canonical_item_key)).size,
        cohesion: clusterCohesion(rows),
      };
    })
    .filter(
      (proposal) =>
        proposal.item_count >= 3 &&
        proposal.cohesion >= proposalCohesionThreshold,
    )
    .sort(
      (a, b) =>
        b.cohesion - a.cohesion ||
        b.created_at - a.created_at ||
        a.id.localeCompare(b.id),
    )
    .slice(0, maxPendingProposals);
}

export function listTagProposals(owner: string) {
  const rows = proposalRows(owner);
  const d = sqlite();
  return {
    items: rows.map((row) => {
      const seen = new Set<string>();
      const sources = validEvidenceRows(row.id, owner).filter((source) => {
        if (seen.has(source.canonical_item_key)) return false;
        seen.add(source.canonical_item_key);
        return true;
      });
      return {
        id: row.id,
        name: row.name.slice(0, maxProposalNameLength),
        color: "gray" as const,
        itemCount: row.item_count,
        items: sources.map((source) => ({
          itemId: source.item_id,
          type: source.item_kind,
          title: source.title,
          ...(source.item_kind === "response"
            ? {
                formId: (
                  d
                    .prepare("SELECT form_id FROM form_responses WHERE id=?")
                    .get(source.item_id) as { form_id: string }
                ).form_id,
              }
            : {}),
        })),
        createdAt: row.created_at,
      };
    }),
  };
}

export function recordTagDeletion(owner: string, tagId: string) {
  const d = sqlite();
  const tag = d
    .prepare("SELECT name,aliases FROM tags WHERE id=?")
    .get(tagId) as { name: string; aliases: string } | undefined;
  if (!tag) return { ok: true, tombstones: 0 };

  const now = Date.now();
  const cooldownUntil = now + proposalCooldown;
  d.prepare(
    "UPDATE ai_tag_proposals SET status=CASE WHEN status='automatic' THEN 'automatic' ELSE 'rejected' END,reviewed_at=CASE WHEN status='automatic' THEN reviewed_at ELSE ? END,cooldown_until=CASE WHEN status='automatic' THEN cooldown_until ELSE ? END WHERE owner_id=? AND created_tag_id=? AND status IN('pending','accepted','automatic')",
  ).run(now, cooldownUntil, owner, tagId);

  d.prepare(
    "DELETE FROM ai_tag_proposals WHERE owner_id=? AND status<>'pending' AND coalesce(reviewed_at,created_at)<?",
  ).run(owner, now - maxProposalHistoryAge);
  let historyCount = (
    d
      .prepare("SELECT count(*) AS n FROM ai_tag_proposals WHERE owner_id=?")
      .get(owner) as { n: number }
  ).n;
  const names = new Set<string>([tag.name]);
  try {
    const aliases: unknown = JSON.parse(tag.aliases);
    if (Array.isArray(aliases))
      for (const alias of aliases.slice(0, 3))
        if (typeof alias === "string") names.add(alias);
  } catch {
    // Ignore malformed legacy alias data; the tag's stored name remains usable.
  }

  let tombstones = 0;
  for (const name of names) {
    const normalized = normalizedName(name);
    if (!normalized) continue;
    const key = fingerprint(normalized);
    const existing = d
      .prepare(
        "SELECT 1 FROM ai_tag_proposals WHERE owner_id=? AND name_fingerprint=?",
      )
      .get(owner, key);
    if (!existing && historyCount >= maxProposalHistory) continue;
    const inserted = d
      .prepare(
        "INSERT INTO ai_tag_proposals(id,owner_id,normalized_name,name_fingerprint,name,status,cohesion,created_at,reviewed_at,cooldown_until) VALUES(?,?,?,?,?,'rejected',0,?,?,?) ON CONFLICT(owner_id,name_fingerprint) DO UPDATE SET status=CASE WHEN ai_tag_proposals.status='automatic' THEN 'automatic' ELSE 'rejected' END,reviewed_at=CASE WHEN ai_tag_proposals.status='automatic' THEN ai_tag_proposals.reviewed_at ELSE excluded.reviewed_at END,cooldown_until=CASE WHEN ai_tag_proposals.status='automatic' THEN ai_tag_proposals.cooldown_until ELSE excluded.cooldown_until END WHERE ai_tag_proposals.created_tag_id IS NULL",
      )
      .run(
        randomUUID(),
        owner,
        comparableName(normalized),
        key,
        normalized,
        now,
        now,
        cooldownUntil,
      );
    if (inserted.changes) {
      tombstones++;
      if (!existing) historyCount++;
    }
  }
  return { ok: true, tombstones };
}

function currentEvidenceForDecision(proposalId: string, owner: string) {
  const rows = validEvidenceRows(proposalId, owner);
  const current: (typeof rows)[number][] = [];
  for (const row of rows) {
    const source = sourceFor(row.source_key);
    if (
      source?.active &&
      source.owner_id === owner &&
      source.generation === row.generation &&
      fingerprint(sourceText(source)) === row.fingerprint &&
      (row.item_kind !== "response" ||
        reviewedPrivateResponse(owner, row.item_id))
    )
      current.push(row);
  }
  return current;
}

export function decideTagProposal(
  owner: string,
  id: string,
  decision: "accepted" | "rejected",
) {
  const d = sqlite();
  return d
    .transaction(() => {
      const enabled = (
        d.prepare("SELECT enabled FROM ai_configuration WHERE id=1").get() as {
          enabled: number;
        }
      ).enabled;
      if (!enabled) throw new HttpError(409, "Local AI is disabled.");
      const proposal = d
        .prepare(
          "SELECT id,name,status,cooldown_until FROM ai_tag_proposals WHERE id=? AND owner_id=?",
        )
        .get(id, owner) as
        | {
            id: string;
            name: string;
            status: string;
            cooldown_until: number | null;
          }
        | undefined;
      if (!proposal)
        throw new HttpError(
          409,
          "This tag proposal is no longer available. Refresh and try again.",
        );
      if (proposal.status === decision) return { ok: true };
      if (proposal.status === "automatic") {
        if (decision === "accepted") return { ok: true };
        throw new HttpError(409, "This tag proposal was already reviewed.");
      }
      if (proposal.status !== "pending")
        throw new HttpError(409, "This tag proposal was already reviewed.");
      if (
        proposal.cooldown_until !== null &&
        proposal.cooldown_until > Date.now()
      )
        throw new HttpError(409, "This tag proposal is cooling down.");
      const evidence = currentEvidenceForDecision(id, owner);
      const itemCount = new Set(evidence.map((row) => row.canonical_item_key))
        .size;
      const cohesion = clusterCohesion(evidence);
      if (itemCount < 3 || cohesion < proposalCohesionThreshold)
        throw new HttpError(
          409,
          "This tag proposal is stale. Refresh and try again.",
        );
      const now = Date.now();
      if (decision === "rejected") {
        d.prepare(
          "UPDATE ai_tag_proposals SET status='rejected',cohesion=?,reviewed_at=?,cooldown_until=? WHERE id=? AND owner_id=? AND status='pending'",
        ).run(cohesion, now, now + proposalCooldown, id, owner);
        completionEvent(owner, "ai", id, "tag-rejected");
        return { ok: true };
      }
      const existing = existingTagForName(proposal.name);
      const tag = existing ?? {
        id: randomUUID(),
        name: proposal.name,
      };
      const learnedRevision = (
        d
          .prepare(
            "SELECT learned_tag_revision FROM ai_configuration WHERE id=1",
          )
          .get() as { learned_tag_revision: number }
      ).learned_tag_revision;
      if (!existing)
        d.prepare(
          "INSERT INTO tags(id,name,color,aliases) VALUES(?,?,'gray','[]')",
        ).run(tag.id, proposal.name);
      for (const row of evidence) {
        let current;
        try {
          current = itemTagState(owner, row.item_kind, row.item_id);
        } catch {
          continue;
        }
        if (!current.tags.some((currentTag) => currentTag.id === tag.id))
          assignItemTags(owner, row.item_kind, row.item_id, current.revision, [
            ...current.tags.map((currentTag) => currentTag.id),
            tag.id,
          ]);
      }
      if (
        (
          d
            .prepare(
              "SELECT learned_tag_revision FROM ai_configuration WHERE id=1",
            )
            .get() as { learned_tag_revision: number }
        ).learned_tag_revision === learnedRevision
      )
        d.prepare(
          "UPDATE ai_configuration SET learned_tag_revision=learned_tag_revision+1 WHERE id=1",
        ).run();
      d.prepare(
        "UPDATE ai_tag_proposals SET status='accepted',cohesion=?,reviewed_at=?,cooldown_until=NULL,created_tag_id=? WHERE id=? AND owner_id=? AND status='pending'",
      ).run(cohesion, now, tag.id, id, owner);
      completionEvent(owner, "ai", id, "tag-accepted");
      return { ok: true };
    })
    .immediate();
}
