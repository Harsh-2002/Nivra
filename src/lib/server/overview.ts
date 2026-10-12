import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { db, sqlite } from "./db";
import { bookmarks, notes, tasks } from "./schema";
import { calendarRange } from "./calendar";
import { addDays } from "../calendar";
import { modelVersion } from "./ai/model";
import { listTagProposals } from "./ai/tagging";
import type { Overview } from "../types";

export function workspaceOverview(
  owner: string,
  today: string,
  timezone = "UTC",
  includeOwnerReview = false,
): Overview {
  return sqlite().transaction(() => {
    const database = db();
    const open = and(
      eq(tasks.ownerId, owner),
      isNull(tasks.completedAt),
      isNull(tasks.trashedAt),
    );
    const taskCounts = sqlite()
      .prepare(
        "SELECT count(*) AS open,coalesce(sum(due_date=?),0) AS today,coalesce(sum(due_date<?),0) AS overdue FROM tasks INDEXED BY tasks_active_counts_idx WHERE owner_id=? AND completed_at IS NULL AND trashed_at IS NULL",
      )
      .get(today, today, owner) as Overview["counts"];
    const recentCandidates = recentCandidateItems(owner);
    return {
      counts: taskCounts,
      tasks: database
        .select({
          id: tasks.id,
          title: tasks.title,
          revision: tasks.revision,
          dueDate: tasks.dueDate,
          recurrence: tasks.recurrence,
        })
        .from(tasks)
        .where(open)
        .orderBy(desc(tasks.createdAt), desc(tasks.id))
        .limit(20)
        .all(),
      calendar: calendarRange(owner, today, addDays(today, 8), timezone, {
        eventsOnly: true,
        limit: 5,
      }).items.map((item) => ({
        id: item.id,
        sourceId: item.sourceId,
        type: "event" as const,
        title: item.title,
        date: item.date,
        ...(item.startAt === undefined ? {} : { startAt: item.startAt }),
        ...(item.endAt === undefined ? {} : { endAt: item.endAt }),
        label: item.label,
        revision: item.revision,
        ...(item.occurrence ? { occurrence: item.occurrence } : {}),
      })),
      recentItems: recentCandidates.slice(0, 8),
      recentContent: recentCandidates
        .filter((item) => item.type !== "bookmark")
        .slice(0, 8),
      notes: database
        .select({
          id: notes.id,
          title: notes.title,
          updatedAt: notes.updatedAt,
        })
        .from(notes)
        .where(
          and(
            eq(notes.ownerId, owner),
            eq(notes.kind, "note"),
            isNull(notes.trashedAt),
          ),
        )
        .orderBy(desc(notes.updatedAt), asc(notes.id))
        .limit(20)
        .all(),
      bookmarks: database
        .select({
          id: bookmarks.id,
          title: bookmarks.title,
          url: bookmarks.url,
          description: bookmarks.description,
          siteName: bookmarks.siteName,
          updatedAt: bookmarks.updatedAt,
        })
        .from(bookmarks)
        .where(and(eq(bookmarks.ownerId, owner), isNull(bookmarks.trashedAt)))
        .orderBy(desc(bookmarks.updatedAt), asc(bookmarks.id))
        .limit(20)
        .all(),
      ...(includeOwnerReview
        ? {
            recentResponses: recentResponses(owner),
            review: reviewCounts(owner),
          }
        : {}),
      refreshedAt: Date.now(),
    };
  })();
}

function recentCandidateItems(owner: string): Overview["recentItems"] {
  return sqlite()
    .prepare(
      `SELECT id,type,title,updatedAt,url,siteName,journalDate FROM (
         SELECT * FROM (
           SELECT id,CASE WHEN daily_date IS NULL THEN 'note' ELSE 'journal' END AS type,title,updated_at AS updatedAt,NULL AS url,NULL AS siteName,daily_date AS journalDate
           FROM notes INDEXED BY notes_search_order_idx WHERE owner_id=? AND kind='note' AND trashed_at IS NULL ORDER BY updated_at DESC,id LIMIT 8
         )
         UNION ALL
         SELECT * FROM (
           SELECT id,'bookmark' AS type,coalesce(nullif(title,''),url) AS title,updated_at AS updatedAt,url,site_name AS siteName,NULL AS journalDate
           FROM bookmarks INDEXED BY bookmarks_search_order_idx WHERE owner_id=? AND trashed_at IS NULL ORDER BY updated_at DESC,id LIMIT 8
         )
         UNION ALL
         SELECT * FROM (
           SELECT id,'artifact' AS type,coalesce(nullif(name,''),title) AS title,updated_at AS updatedAt,NULL AS url,NULL AS siteName,NULL AS journalDate
           FROM artifacts INDEXED BY artifacts_search_order_idx WHERE owner_id=? AND trashed_at IS NULL ORDER BY updated_at DESC,id LIMIT 8
         )
       ) ORDER BY updatedAt DESC,id LIMIT 24`,
    )
    .all(owner, owner, owner)
    .map((value) => {
      const row = value as {
        id: string;
        type: "note" | "journal" | "bookmark" | "artifact";
        title: string;
        updatedAt: number;
        url: string | null;
        siteName: string | null;
        journalDate: string | null;
      };
      const base = {
        id: row.id,
        title: row.title,
        updatedAt: row.updatedAt,
      };
      if (row.type === "bookmark")
        return {
          ...base,
          type: row.type,
          url: row.url ?? "",
          siteName: row.siteName ?? "",
        };
      if (row.type === "journal")
        return { ...base, type: row.type, date: row.journalDate ?? "" };
      return { ...base, type: row.type };
    }) as Overview["recentItems"];
}

function recentResponses(
  owner: string,
): NonNullable<Overview["recentResponses"]> {
  const rows = sqlite()
    .prepare(
      `SELECT r.id,r.form_id AS formId,f.title AS formTitle,r.created_at AS createdAt,r.reviewed
       FROM form_responses r INDEXED BY form_responses_activity
       JOIN forms f ON f.id=r.form_id
       WHERE r.trashed_at IS NULL AND f.owner_id=? AND f.trashed_at IS NULL
       ORDER BY r.created_at DESC,r.id DESC
       LIMIT 5`,
    )
    .all(owner) as {
    id: string;
    formId: string;
    formTitle: string;
    createdAt: number;
    reviewed: number | boolean;
  }[];
  return rows.map((row) => ({ ...row, reviewed: Boolean(row.reviewed) }));
}

function reviewCounts(owner: string): NonNullable<Overview["review"]> {
  const d = sqlite();
  const forms = d
    .prepare(
      "SELECT count(*) AS count FROM form_responses r JOIN forms f ON f.id=r.form_id WHERE f.owner_id=? AND f.trashed_at IS NULL AND r.trashed_at IS NULL AND r.reviewed=0",
    )
    .get(owner) as { count: number };
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
  const configuration = d
    .prepare(
      "SELECT enabled,vocabulary_generation AS vocabularyGeneration FROM ai_configuration WHERE id=1",
    )
    .get() as { enabled: number; vocabularyGeneration: number };
  const suggestions = configuration.enabled
    ? (d
        .prepare(
          `SELECT count(DISTINCT s.item_kind||':'||s.item_id) AS count FROM ai_suggestions p JOIN tags t ON t.id=p.tag_id JOIN ai_content c USING(source_key) JOIN ai_sources s USING(source_key) WHERE s.owner_id=? AND s.active=1 AND p.generation=c.generation AND c.indexed_generation=c.generation AND p.model_version=? AND p.vocabulary_generation=? AND NOT (${assigned})`,
        )
        .get(owner, modelVersion, configuration.vocabularyGeneration) as {
        count: number;
      })
    : { count: 0 };
  return {
    formResponses: forms.count,
    tagSuggestions: suggestions.count + listTagProposals(owner).items.length,
  };
}
