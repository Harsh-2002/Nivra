import { sqlite } from "../db";
import { HttpError } from "../http";
import {
  approveAutomaticItemTag,
  assignItemTags,
  itemTagState,
  type TaggedType,
} from "../item-tags";
import { completionEvent, wakeJobs } from "../jobs";
import { fingerprint, sourceFor, sourceText } from "./content";
import { aiEnabled, stopAi } from "./indexer";
import { modelVersion } from "./model";
import { policy } from "./policy";
export type TaggingMode = "manual" | "automatic";
export function aiStatus(owner: string) {
  const d = sqlite();
  const configuration = d
    .prepare(
      "SELECT enabled,revision,tagging_mode FROM ai_configuration WHERE id=1",
    )
    .get() as {
    enabled: number;
    revision: number;
    tagging_mode: TaggingMode;
  };
  const counts = d
    .prepare(
      "SELECT count(*) AS total,sum(c.state='indexed' AND c.model_version=? AND c.indexed_generation=c.generation) AS indexed,sum(c.state='failed') AS failed,sum(c.state='capacity') AS capacity FROM ai_content c JOIN ai_sources s USING(source_key) WHERE s.owner_id=? AND s.active=1",
    )
    .get(modelVersion, owner) as {
    total: number;
    indexed: number | null;
    failed: number | null;
    capacity: number | null;
  };
  return {
    enabled: Boolean(configuration.enabled),
    revision: configuration.revision,
    taggingMode: configuration.tagging_mode,
    total: counts.total,
    indexed: counts.indexed ?? 0,
    failed: counts.failed ?? 0,
    capacity: counts.capacity ?? 0,
    chunkLimit: policy.chunkCapacity,
  };
}
export async function configureAi(
  owner: string,
  enabled: boolean,
  revision: number,
  taggingMode?: TaggingMode,
) {
  if (
    taggingMode !== undefined &&
    taggingMode !== "manual" &&
    taggingMode !== "automatic"
  )
    throw new HttpError(400, "Choose a supported tagging mode.");
  const d = sqlite();
  d.transaction(() => {
    const current = d
      .prepare("SELECT tagging_mode FROM ai_configuration WHERE id=1")
      .get() as { tagging_mode: TaggingMode };
    const changed = d
      .prepare(
        "UPDATE ai_configuration SET enabled=?,tagging_mode=coalesce(?,tagging_mode),revision=revision+1 WHERE id=1 AND revision=?",
      )
      .run(Number(enabled), taggingMode ?? null, revision);
    if (!changed.changes)
      throw new HttpError(409, "AI settings changed. Reload and try again.");
    const taggingModeChanged =
      taggingMode !== undefined && current.tagging_mode !== taggingMode;
    if (taggingModeChanged)
      d.prepare(
        "UPDATE ai_content SET pending=1,failures=0,retry_after=0 WHERE state='indexed' AND EXISTS(SELECT 1 FROM ai_sources s WHERE s.source_key=ai_content.source_key AND s.active=1)",
      ).run();
    if (enabled)
      d.prepare(
        "UPDATE ai_content SET failures=0,retry_after=0 WHERE state='failed'",
      ).run();
    completionEvent(owner, "ai", "settings", "changed");
  }).immediate();
  if (!enabled) await stopAi();
  else wakeJobs();
  return aiStatus(owner);
}
type Proposal = {
  id: string;
  source_key: string;
  generation: number;
  fingerprint: string;
  model_version: string;
  vocabulary_generation: number;
  tag_id: string;
  name: string;
  color: string;
  item_kind: TaggedType;
  item_id: string;
  title: string;
  score: number;
  created_at: number;
};
function proposals(owner: string) {
  if (!aiEnabled()) return [];
  const d = sqlite();
  const assigned = [
    "note",
    "task",
    "bookmark",
    "artifact",
    "event",
    "form",
    "response",
  ]
    .map(
      (kind) =>
        `(s.item_kind='${kind}' AND EXISTS(SELECT 1 FROM ${kind}_tags it WHERE it.${kind}_id=s.item_id AND it.tag_id=p.tag_id))`,
    )
    .join(" OR ");
  const rows = d
    .prepare(
      `SELECT p.*,t.name,t.color,s.item_kind,s.item_id,s.title FROM ai_suggestions p JOIN tags t ON t.id=p.tag_id JOIN ai_content c USING(source_key) JOIN ai_sources s USING(source_key) JOIN ai_configuration a ON a.id=1 WHERE s.owner_id=? AND s.active=1 AND p.generation=c.generation AND c.indexed_generation=c.generation AND p.model_version=? AND p.vocabulary_generation=a.vocabulary_generation AND NOT EXISTS(SELECT 1 FROM ai_decisions decision WHERE decision.source_key=p.source_key AND decision.fingerprint=p.fingerprint AND decision.decision='rejected') AND NOT (${assigned}) ORDER BY p.score DESC,p.created_at DESC,p.id LIMIT 100`,
    )
    .all(owner, modelVersion) as Proposal[];
  const seen = new Set<string>();
  return rows
    .filter((row) => {
      const key = row.item_kind + ":" + row.item_id;
      if (seen.has(key)) return false;
      if (
        itemTagState(owner, row.item_kind, row.item_id).tags.some(
          (tag) => tag.id === row.tag_id,
        )
      )
        return false;
      seen.add(key);
      return true;
    })
    .slice(0, 30);
}
export function listSuggestions(owner: string) {
  const excerpt = (row: Proposal) => {
    const chunk = sqlite()
      .prepare(
        "SELECT text FROM ai_chunks WHERE source_key=? AND generation=? AND model_version=? ORDER BY ordinal LIMIT 1",
      )
      .get(row.source_key, row.generation, row.model_version) as
      { text: string } | undefined;
    const text = chunk?.text ?? "";
    return (
      text.startsWith(row.title) ? text.slice(row.title.length).trim() : text
    ).slice(0, 240);
  };
  return sqlite()
    .transaction(() => ({
      items: proposals(owner).map((row) => ({
        id: row.id,
        itemId: row.item_id,
        type: row.item_kind,
        title: row.title,
        excerpt: excerpt(row),
        ...(row.item_kind === "response"
          ? {
              formId: (
                sqlite()
                  .prepare("SELECT form_id FROM form_responses WHERE id=?")
                  .get(row.item_id) as { form_id: string }
              ).form_id,
            }
          : {}),
        tag: { id: row.tag_id, name: row.name, color: row.color },
        createdAt: row.created_at,
      })),
    }))
    .deferred();
}
export function decideSuggestion(
  owner: string,
  id: string,
  decision: "accepted" | "rejected",
) {
  const d = sqlite();
  return d
    .transaction(() => {
      if (!aiEnabled()) throw new HttpError(409, "Local AI is disabled.");
      const previous = d
        .prepare(
          "SELECT a.decision FROM ai_decisions a JOIN ai_sources s USING(source_key) WHERE a.proposal_id=? AND s.owner_id=? AND s.active=1",
        )
        .get(id, owner) as { decision: string } | undefined;
      if (previous) {
        if (previous.decision !== decision)
          throw new HttpError(409, "This suggestion was already reviewed.");
        return { ok: true };
      }
      const proposal = proposals(owner).find((row) => row.id === id);
      if (!proposal)
        throw new HttpError(
          409,
          "This suggestion is no longer available. Refresh and try again.",
        );
      const source = sourceFor(proposal.source_key);
      if (
        !source?.active ||
        source.owner_id !== owner ||
        source.generation !== proposal.generation ||
        fingerprint(sourceText(source)) !== proposal.fingerprint
      )
        throw new HttpError(409, "This item changed. Refresh its suggestions.");
      const current = itemTagState(owner, proposal.item_kind, proposal.item_id);
      if (
        decision === "accepted" &&
        !current.tags.some((tag) => tag.id === proposal.tag_id)
      )
        assignItemTags(
          owner,
          proposal.item_kind,
          proposal.item_id,
          current.revision,
          [...current.tags.map((tag) => tag.id), proposal.tag_id],
        );
      else if (decision === "accepted")
        approveAutomaticItemTag(
          owner,
          proposal.item_kind,
          proposal.item_id,
          proposal.tag_id,
        );
      d.prepare(
        "INSERT OR REPLACE INTO ai_decisions(source_key,fingerprint,tag_id,tag_fingerprint,proposal_id,decision,created_at) VALUES(?,?,?,?,?,?,?)",
      ).run(
        proposal.source_key,
        proposal.fingerprint,
        proposal.tag_id,
        fingerprint(proposal.name.normalize("NFKC").trim().toLowerCase()),
        proposal.id,
        decision,
        Date.now(),
      );
      if (decision === "rejected") {
        const siblings = d
          .prepare(
            "SELECT c.source_key,c.fingerprint FROM ai_content c JOIN ai_sources s USING(source_key) WHERE s.owner_id=? AND s.item_kind=? AND s.item_id=? AND c.fingerprint IS NOT NULL AND c.indexed_generation=c.generation AND s.active=1 AND c.source_key<>?",
          )
          .all(
            owner,
            proposal.item_kind,
            proposal.item_id,
            proposal.source_key,
          ) as { source_key: string; fingerprint: string }[];
        const record = d.prepare(
          "INSERT OR IGNORE INTO ai_decisions(source_key,fingerprint,tag_id,tag_fingerprint,decision,created_at) VALUES(?,?,?,?,?,?)",
        );
        for (const sibling of siblings)
          record.run(
            sibling.source_key,
            sibling.fingerprint,
            proposal.tag_id,
            fingerprint(proposal.name.normalize("NFKC").trim().toLowerCase()),
            decision,
            Date.now(),
          );
      }
      d.prepare(
        "DELETE FROM ai_suggestions WHERE source_key IN(SELECT source_key FROM ai_sources WHERE item_kind=? AND item_id=?)",
      ).run(proposal.item_kind, proposal.item_id);
      completionEvent(owner, "ai", proposal.item_id, decision);
      return { ok: true };
    })
    .immediate();
}
