import { randomUUID } from "node:crypto";
import { db, sqlite } from "./db";
import { notes } from "./schema";
import { getNote, tagsFor } from "./notes";
import { HttpError } from "./http";
import { ftsQuery, plainText } from "./validation";
import { fuzzyQuery } from "./search";
import {
  journalPeriodEnd,
  journalPeriodStart,
  type JournalPeriod,
} from "../writing";
import type { Document, Note, NoteSummary, Page } from "../types";
import { decodeCursor, encodeCursor, pageLimit } from "./pagination";
import { Temporal } from "@js-temporal/polyfill";
import { resolveTaskSchedule, type TaskSchedule } from "../task-planning";

const blankDocument: Document = {
  schemaVersion: 1,
  blocks: [{ type: "paragraph", content: [] }],
};

type JournalRow = NoteSummary & { period: JournalPeriod; periodStart: string };

function journalFromRow(row: Record<string, unknown>): JournalRow {
  return {
    id: String(row.id),
    title: String(row.title),
    text: String(row.text ?? ""),
    revision: Number(row.revision),
    favorite: Boolean(row.favorite),
    editorWidth: row.editorWidth === "wide" ? "wide" : "standard",
    trashedAt: row.trashedAt == null ? null : Number(row.trashedAt),
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
    kind: "note",
    dailyDate: row.dailyDate == null ? null : String(row.dailyDate),
    journalPeriod: row.period as JournalPeriod,
    journalPeriodStart: String(row.periodStart),
    period: row.period as JournalPeriod,
    periodStart: String(row.periodStart),
    tags: tagsFor(String(row.id)),
  };
}

function summaryFromRow(
  row: Record<string, unknown> & { id: string },
): NoteSummary {
  return {
    id: row.id,
    title: String(row.title),
    text: String(row.text ?? ""),
    revision: Number(row.revision),
    favorite: Boolean(row.favorite),
    editorWidth: row.editorWidth === "wide" ? "wide" : "standard",
    trashedAt: row.trashedAt == null ? null : Number(row.trashedAt),
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
    kind: "note",
    dailyDate: row.dailyDate == null ? null : String(row.dailyDate),
    journalPeriod: row.journalPeriod as JournalPeriod,
    journalPeriodStart: String(row.journalPeriodStart),
    tags: tagsFor(row.id),
  };
}

export function journalByPeriod(
  owner: string,
  date: string,
  period: JournalPeriod,
): Note | undefined {
  const start = journalPeriodStart(date, period);
  const row = sqlite()
    .prepare(
      "SELECT id FROM notes WHERE owner_id=? AND kind='note' AND journal_period=? AND journal_period_start=?",
    )
    .get(owner, period, start) as { id: string } | undefined;
  return row ? getNote(row.id) : undefined;
}

export function createJournalPeriod(
  owner: string,
  date: string,
  period: JournalPeriod = "daily",
  document?: Document,
): Note {
  const start = journalPeriodStart(date, period);
  const dailyDate = period === "daily" ? start : null;
  const existing = sqlite()
    .prepare(
      "SELECT id,trashed_at AS trashedAt FROM notes WHERE owner_id=? AND kind='note' AND journal_period=? AND journal_period_start=?",
    )
    .get(owner, period, start) as
    { id: string; trashedAt: number | null } | undefined;
  if (existing) {
    if (existing.trashedAt !== null)
      throw new HttpError(409, "Restore this journal entry from Trash first.");
    if (document)
      throw new HttpError(
        409,
        "This journal entry already exists. Read its revision before editing.",
      );
    return getNote(existing.id)!;
  }
  const id = randomUUID();
  const now = Date.now();
  const title =
    period === "daily"
      ? start
      : period === "weekly"
        ? `Week of ${start}`
        : new Intl.DateTimeFormat("en", {
            month: "long",
            year: "numeric",
            timeZone: "UTC",
          }).format(new Date(`${start}T12:00:00.000Z`));
  const initialDocument = document ?? blankDocument;
  try {
    db()
      .insert(notes)
      .values({
        id,
        ownerId: owner,
        title,
        document: initialDocument,
        text: plainText(initialDocument.blocks),
        dailyDate,
        journalPeriod: period,
        journalPeriodStart: start,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  } catch (error) {
    const winner = sqlite()
      .prepare(
        "SELECT id,trashed_at AS trashedAt FROM notes WHERE owner_id=? AND kind='note' AND journal_period=? AND journal_period_start=?",
      )
      .get(owner, period, start) as
      { id: string; trashedAt: number | null } | undefined;
    if (!winner) throw error;
    if (winner.trashedAt !== null)
      throw new HttpError(409, "Restore this journal entry from Trash first.");
    if (document)
      throw new HttpError(
        409,
        "This journal entry was created concurrently. Read it before editing.",
      );
    return getNote(winner.id)!;
  }
  return getNote(id)!;
}

// Kept as the compatibility entry point for daily journal creation.
export function dailyNote(
  owner: string,
  date: string,
  document?: Document,
): Note {
  return createJournalPeriod(owner, date, "daily", document);
}

export function listJournalPage(
  owner: string,
  options: {
    period: JournalPeriod;
    from?: string;
    to?: string;
    limit: number;
    after?: string | null;
    q?: string;
  },
): Page<JournalRow> {
  const limit = pageLimit(String(options.limit));
  const query = (options.q ?? "").trim();
  const search = ftsQuery(query);
  const rawSearchCursor =
    search && options.after
      ? decodeCursor(options.after, ["string", "number", "string", "string"])
      : undefined;
  const searchCursor = rawSearchCursor as
    ["exact" | "fuzzy", number, string, string] | undefined;
  if (
    searchCursor &&
    searchCursor[0] !== "exact" &&
    searchCursor[0] !== "fuzzy"
  )
    throw new HttpError(400, "This page position is no longer valid.");
  const searchMode = searchCursor?.[0] ?? "exact";
  const database = sqlite();
  const where = [
    "n.owner_id=?",
    "n.kind='note'",
    "n.trashed_at IS NULL",
    "n.journal_period=?",
  ];
  const args: (string | number)[] = [owner, options.period];
  if (options.from) {
    where.push("n.journal_period_start>=?");
    args.push(journalPeriodStart(options.from, options.period));
  }
  if (options.to) {
    where.push("n.journal_period_start<=?");
    args.push(journalPeriodStart(options.to, options.period));
  }

  type PageRow = Record<string, unknown> & {
    id: string;
    periodStart: string;
    searchRank?: number;
  };
  const select = `n.id,n.title,n.text,n.revision,n.favorite,n.editor_width AS editorWidth,n.trashed_at AS trashedAt,n.created_at AS createdAt,n.updated_at AS updatedAt,n.daily_date AS dailyDate,n.journal_period AS period,n.journal_period_start AS periodStart`;
  const loadDatePage = () => {
    const pageWhere = [...where];
    const pageArgs = [...args];
    const cursor = decodeCursor(options.after ?? null, ["string", "string"]);
    if (cursor) {
      pageWhere.push("(n.journal_period_start,n.id)<(?,?)");
      pageArgs.push(...cursor);
    }
    return database
      .prepare(
        `SELECT ${select} FROM notes n WHERE ${pageWhere.join(" AND ")} ORDER BY n.journal_period_start DESC,n.id DESC LIMIT ?`,
      )
      .all(...pageArgs, limit + 1) as PageRow[];
  };
  const loadSearchPage = (
    fts: string,
    cursor?: ["exact" | "fuzzy", number, string, string],
  ) => {
    const pageWhere = [...where, "notes_fts MATCH ?"];
    const pageArgs = [...args, fts];
    if (cursor) {
      const [, rank, periodStart, id] = cursor;
      pageWhere.push(
        "(notes_fts.rank>? OR (notes_fts.rank=? AND (n.journal_period_start<? OR (n.journal_period_start=? AND n.id<?))))",
      );
      pageArgs.push(rank, rank, periodStart, periodStart, id);
    }
    return database
      .prepare(
        `SELECT ${select},notes_fts.rank AS searchRank FROM notes_fts CROSS JOIN notes n ON notes_fts.rowid=n.rowid WHERE ${pageWhere.join(" AND ")} ORDER BY notes_fts.rank ASC,n.journal_period_start DESC,n.id DESC LIMIT ?`,
      )
      .all(...pageArgs, limit + 1) as PageRow[];
  };

  const selectedSearch = searchMode === "fuzzy" ? fuzzyQuery(query) : search;
  let rows = selectedSearch
    ? loadSearchPage(selectedSearch, searchCursor)
    : search
      ? []
      : loadDatePage();
  let nextSearchMode: "exact" | "fuzzy" = searchMode;
  if (search && rows.length === 0 && !options.after) {
    const fallback = fuzzyQuery(query);
    if (fallback) {
      rows = loadSearchPage(fallback);
      nextSearchMode = "fuzzy";
    }
  }
  const items = rows.slice(0, limit).map(journalFromRow);
  const last = items.at(-1);
  let next: string | null = null;
  if (rows.length > limit && last) {
    if (search) {
      const searchRank = rows[limit - 1].searchRank;
      if (typeof searchRank !== "number" || !Number.isFinite(searchRank))
        throw new Error("The journal search rank could not be paginated.");
      next = encodeCursor([
        nextSearchMode,
        searchRank,
        last.periodStart,
        last.id,
      ]);
    } else next = encodeCursor([last.periodStart, last.id]);
  }
  return {
    items,
    next,
  };
}

export function journalReview(
  owner: string,
  date: string,
  period: JournalPeriod,
  timezone = "UTC",
) {
  const start = journalPeriodStart(date, period);
  const end = journalPeriodEnd(start, period);
  const lastDateValue = new Date(`${end}T12:00:00.000Z`);
  lastDateValue.setUTCDate(lastDateValue.getUTCDate() - 1);
  const lastDate = lastDateValue.toISOString().slice(0, 10);
  const database = sqlite();
  const entryRow = database
    .prepare(
      "SELECT id,title,text,revision,favorite,editor_width AS editorWidth,trashed_at AS trashedAt,created_at AS createdAt,updated_at AS updatedAt,daily_date AS dailyDate,journal_period AS journalPeriod,journal_period_start AS journalPeriodStart FROM notes WHERE owner_id=? AND kind='note' AND trashed_at IS NULL AND journal_period=? AND journal_period_start=?",
    )
    .get(owner, period, start) as
    (Record<string, unknown> & { id: string }) | undefined;
  const entries = listJournalPage(owner, {
    period,
    from: start,
    to: lastDate,
    limit: 100,
  }).items;
  const queryStart = new Date(`${start}T12:00:00.000Z`);
  queryStart.setUTCDate(queryStart.getUTCDate() - 1);
  const queryEnd = new Date(`${end}T12:00:00.000Z`);
  queryEnd.setUTCDate(queryEnd.getUTCDate() + 1);
  const startInstant = Number(
    Temporal.PlainDateTime.from(`${start}T00:00`).toZonedDateTime(timezone)
      .epochMilliseconds,
  );
  const endInstant = Number(
    Temporal.PlainDateTime.from(`${end}T00:00`).toZonedDateTime(timezone)
      .epochMilliseconds,
  );
  const taskRows = database
    .prepare(
      "SELECT id,title,due_date AS dueDate,planned_date AS plannedDate,completed_at AS completedAt,schedule_start_local AS scheduleStartLocal,schedule_timezone AS scheduleTimezone,schedule_duration_minutes AS scheduleDurationMinutes,schedule_disambiguation AS scheduleDisambiguation FROM tasks WHERE owner_id=? AND trashed_at IS NULL AND ((due_date>=? AND due_date<?) OR (planned_date>=? AND planned_date<?) OR (schedule_start_local>=? AND schedule_start_local<?)) ORDER BY COALESCE(schedule_start_local,planned_date,due_date),created_at DESC LIMIT 500",
    )
    .all(
      owner,
      start,
      end,
      start,
      end,
      `${queryStart.toISOString().slice(0, 10)}T00:00`,
      `${queryEnd.toISOString().slice(0, 10)}T00:00`,
    ) as {
    id: string;
    title: string;
    dueDate: string | null;
    plannedDate: string | null;
    completedAt: number | null;
    scheduleStartLocal: string | null;
    scheduleTimezone: string | null;
    scheduleDurationMinutes: number | null;
    scheduleDisambiguation: "earlier" | "later" | "reject" | null;
  }[];
  const tasks = taskRows
    .filter((task) => {
      if (
        [task.dueDate, task.plannedDate].some(
          (value) => value !== null && value >= start && value < end,
        )
      )
        return true;
      if (
        !task.scheduleStartLocal ||
        !task.scheduleTimezone ||
        !task.scheduleDurationMinutes ||
        !task.scheduleDisambiguation
      )
        return false;
      try {
        const schedule: TaskSchedule = {
          start: task.scheduleStartLocal,
          timezone: task.scheduleTimezone,
          durationMinutes: task.scheduleDurationMinutes,
          disambiguation: task.scheduleDisambiguation,
        };
        const { startAt } = resolveTaskSchedule(schedule);
        return startAt >= startInstant && startAt < endInstant;
      } catch {
        return false;
      }
    })
    .slice(0, 100);
  const events = database
    .prepare(
      "SELECT id,title,start_date AS startDate,end_date AS endDate,data FROM calendar_events WHERE owner_id=? AND trashed_at IS NULL AND start_date<? AND end_date>? ORDER BY start_date,id LIMIT 100",
    )
    .all(owner, end, start) as {
    id: string;
    title: string;
    startDate: string;
    endDate: string;
    data: string;
  }[];
  return {
    period,
    start,
    end,
    entry: entryRow ? summaryFromRow(entryRow) : null,
    entries,
    activity: {
      tasks: tasks.map(({ id, title, dueDate, plannedDate, completedAt }) => ({
        id,
        title,
        dueDate,
        plannedDate,
        completedAt,
      })),
      events: events.map(({ data, ...event }) => ({
        ...event,
        data: JSON.parse(data),
      })),
    },
  };
}

export function journalsOnThisDay(owner: string, date: string) {
  const monthDay = date.slice(5);
  return sqlite()
    .prepare(
      "SELECT id,title,revision,favorite,editor_width AS editorWidth,created_at AS createdAt,updated_at AS updatedAt,daily_date AS dailyDate,journal_period AS journalPeriod,journal_period_start AS journalPeriodStart,text FROM notes WHERE owner_id=? AND kind='note' AND trashed_at IS NULL AND journal_period='daily' AND journal_period_start<? AND substr(journal_period_start,6,5)=? ORDER BY journal_period_start DESC,id DESC LIMIT 50",
    )
    .all(owner, date, monthDay)
    .map((row) =>
      summaryFromRow(row as Record<string, unknown> & { id: string }),
    );
}

export function navigateJournal(
  owner: string,
  id: string,
  direction: "previous" | "next",
): NoteSummary | null {
  const current = sqlite()
    .prepare(
      "SELECT journal_period AS period,journal_period_start AS start FROM notes WHERE id=? AND owner_id=? AND kind='note' AND journal_period IS NOT NULL AND trashed_at IS NULL",
    )
    .get(id, owner) as { period: JournalPeriod; start: string } | undefined;
  if (!current) throw new HttpError(404, "This journal entry was not found.");
  const comparison = direction === "previous" ? "<" : ">";
  const order = direction === "previous" ? "DESC" : "ASC";
  const row = sqlite()
    .prepare(
      `SELECT id,title,revision,favorite,editor_width AS editorWidth,created_at AS createdAt,updated_at AS updatedAt,daily_date AS dailyDate,journal_period AS journalPeriod,journal_period_start AS journalPeriodStart,text FROM notes WHERE owner_id=? AND kind='note' AND trashed_at IS NULL AND journal_period=? AND journal_period_start ${comparison} ? ORDER BY journal_period_start ${order},id ${order} LIMIT 1`,
    )
    .get(owner, current.period, current.start) as
    (Record<string, unknown> & { id: string }) | undefined;
  return row ? summaryFromRow(row) : null;
}
