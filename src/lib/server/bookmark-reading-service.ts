import { createHash, randomUUID } from "node:crypto";
import { fork, type ChildProcess } from "node:child_process";
import path from "node:path";
import {
  articleActionSchema,
  parseArticleContent,
  bookmarkHighlightCreateSchema,
  bookmarkHighlightDeleteSchema,
  bookmarkHighlightUpdateSchema,
  bookmarkReadStateBatchSchema,
  type ArticleBlock,
  type ArticleContent,
  type ArticleInline,
  type ArticleStatus,
  type BookmarkArticle,
  type BookmarkArticleResult,
  type BookmarkHighlight,
} from "../bookmark-reading";
import type { Bookmark } from "../types";
import type { ContentCommand, ContentResult } from "./content-service";
import { bookmarkUrl, fetchPublic } from "./link-metadata";
import { sqlite } from "./db";
import { HttpError } from "./http";
import { completionEvent, startJobWorker, type JobContext } from "./jobs";
import { heavyInference } from "./heavy-inference";
import { decodeCursor, encodeCursor, pageLimit } from "./pagination";

const maxQueuedArticles = 64;
const maxHighlightsPerBookmark = 1000;
const maxHighlightTextBytes = 200_000;
const articleBytes = 2 * 1024 * 1024;
const fetchDeadlineMs = 15_000;
const parseDeadlineMs = 5000;

type BookmarkRow = {
  id: string;
  owner_id: string;
  url: string;
  title: string;
  trashed_at: number | null;
  revision: number;
  read_at: number | null;
  article_status: ArticleStatus;
  article_generation: number;
  article_version: number;
};

function activeBookmark(owner: string, id: string): BookmarkRow {
  const row = sqlite()
    .prepare(
      "SELECT id,owner_id,url,title,trashed_at,revision,read_at,article_status,article_generation,article_version FROM bookmarks WHERE id=? AND owner_id=? AND trashed_at IS NULL",
    )
    .get(id, owner) as BookmarkRow | undefined;
  if (!row) throw new HttpError(404, "This bookmark was not found.");
  return row;
}

function currentJob(owner: string, id: string) {
  return sqlite()
    .prepare(
      "SELECT id FROM background_jobs WHERE owner_id=? AND kind='article' AND target_id=? AND state IN ('queued','running')",
    )
    .get(owner, id) as { id: string } | undefined;
}

function articleQueueSize() {
  return (
    sqlite()
      .prepare(
        "SELECT count(*) AS count FROM background_jobs WHERE kind='article' AND state IN ('queued','running')",
      )
      .get() as { count: number }
  ).count;
}

function queueArticleInTransaction(owner: string, id: string) {
  const d = sqlite();
  const current = activeBookmark(owner, id);
  if (articleQueueSize() >= maxQueuedArticles)
    return { queued: false as const, jobId: null, row: current };

  const now = Date.now();
  const generation = current.article_generation + 1;
  const jobId = randomUUID();
  d.prepare(
    `INSERT INTO background_jobs(id,owner_id,kind,target_id,state,attempts,available_at,lease_until,lease_token,created_at,generation)
     VALUES(?,?,'article',?,'queued',0,?,NULL,NULL,?,?)
     ON CONFLICT(kind,target_id) DO UPDATE SET id=excluded.id,owner_id=excluded.owner_id,state='queued',attempts=0,available_at=excluded.available_at,lease_until=NULL,lease_token=NULL,created_at=excluded.created_at,generation=excluded.generation`,
  ).run(jobId, owner, id, now, now, generation);
  d.prepare(
    "UPDATE bookmarks SET article_status='pending',article_generation=? WHERE id=? AND owner_id=? AND trashed_at IS NULL",
  ).run(generation, id, owner);
  completionEvent(owner, "bookmark", id, "article-pending");
  return {
    queued: true as const,
    jobId,
    row: {
      ...current,
      article_status: "pending" as const,
      article_generation: generation,
    },
  };
}

export function enqueueNewBookmarkArticle(owner: string, id: string) {
  const d = sqlite();
  const wasInTransaction = d.inTransaction;
  const work = () => queueArticleInTransaction(owner, id);
  const result = d.inTransaction ? work() : d.transaction(work).immediate();
  if (result.queued) {
    if (!wasInTransaction) startJobWorker();
  } else {
    const changed = d
      .prepare(
        "UPDATE bookmarks SET article_status='unavailable' WHERE id=? AND owner_id=? AND article_status='pending' AND article_generation=?",
      )
      .run(id, owner, result.row.article_generation);
    if (changed.changes)
      completionEvent(owner, "bookmark", id, "article-unavailable");
  }
  return result.queued;
}

export function requestBookmarkArticle(
  owner: string,
  id: string,
  input: unknown,
): { jobId: string; status: "pending" } | BookmarkArticleResult {
  const { action } = articleActionSchema.parse(input);
  const d = sqlite();
  const work = () => {
    const row = activeBookmark(owner, id);
    const existingJob = currentJob(owner, id);
    if (row.article_status === "pending" && existingJob && action !== "refresh")
      return { jobId: existingJob.id, status: "pending" as const };
    if (action === "save" && row.article_status === "ready")
      return getBookmarkArticle(owner, id);
    if (action === "retry" && row.article_status === "ready")
      throw new HttpError(
        409,
        "This saved article is already available. Refresh it to capture a newer version.",
      );
    if (action === "refresh" && row.article_status === "pending")
      return existingJob
        ? { jobId: existingJob.id, status: "pending" as const }
        : undefined;
    const queued = queueArticleInTransaction(owner, id);
    if (!queued.queued)
      throw new HttpError(429, "The article queue is full. Try again shortly.");
    return { jobId: queued.jobId, status: "pending" as const };
  };
  const result = d.inTransaction ? work() : d.transaction(work).immediate();
  if (result === undefined)
    throw new HttpError(409, "This article is already being saved.");
  if ("jobId" in result && result.status === "pending") startJobWorker();
  return result;
}

function articleRow(owner: string, id: string, version: number) {
  return sqlite()
    .prepare(
      "SELECT bookmark_id,version,source_url,captured_at,title,byline,content_json,plain_text,fingerprint FROM bookmark_articles WHERE owner_id=? AND bookmark_id=? AND version=?",
    )
    .get(owner, id, version) as
    | {
        bookmark_id: string;
        version: number;
        source_url: string;
        captured_at: number;
        title: string;
        byline: string | null;
        content_json: string;
        plain_text: string;
        fingerprint: string;
      }
    | undefined;
}

function exposeArticle(
  row: NonNullable<ReturnType<typeof articleRow>>,
): BookmarkArticle {
  return {
    bookmarkId: row.bookmark_id,
    version: row.version,
    url: row.source_url,
    capturedAt: row.captured_at,
    title: row.title,
    byline: row.byline,
    fingerprint: row.fingerprint,
    content: parseArticleContent(JSON.parse(row.content_json)),
    text: row.plain_text,
  };
}

export function getBookmarkArticle(
  owner: string,
  id: string,
  version?: number,
): BookmarkArticleResult {
  const row = activeBookmark(owner, id);
  const requestedVersion = version ?? row.article_version;
  const job = currentJob(owner, id);
  const article =
    requestedVersion > 0 ? articleRow(owner, id, requestedVersion) : undefined;
  if (version !== undefined && !article)
    throw new HttpError(404, "This saved article version was not found.");
  return {
    status: row.article_status,
    currentVersion: row.article_version,
    article: article ? exposeArticle(article) : null,
    jobId: job?.id ?? null,
  };
}

export function listBookmarkArticleVersions(
  owner: string,
  id: string,
  options: { limit?: number; after?: string | null } = {},
): {
  items: { version: number; capturedAt: number; title: string }[];
  next: string | null;
} {
  activeBookmark(owner, id);
  const limit = options.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50)
    throw new HttpError(400, "The version page size is not valid.");
  const cursor = decodeCursor(options.after ?? null, ["number"]);
  const where = ["owner_id=?", "bookmark_id=?"];
  const values: (number | string)[] = [owner, id];
  if (cursor) {
    where.push("version<?");
    values.push(cursor[0]);
  }
  const rows = sqlite()
    .prepare(
      `SELECT version,captured_at,title FROM bookmark_articles
       WHERE ${where.join(" AND ")} ORDER BY version DESC LIMIT ?`,
    )
    .all(...values, limit + 1) as {
    version: number;
    captured_at: number;
    title: string;
  }[];
  const items = rows.slice(0, limit).map((row) => ({
    version: row.version,
    capturedAt: row.captured_at,
    title: row.title,
  }));
  const last = items.at(-1);
  return {
    items,
    next: rows.length > limit && last ? encodeCursor([last.version]) : null,
  };
}

function inlineText(items: ArticleInline[]): string {
  return items
    .map((item) =>
      item.type === "text" ? item.text : inlineText(item.children),
    )
    .join("");
}

function blockText(block: ArticleBlock): string {
  if (block.type === "rule") return "";
  if (block.type === "code-block") return block.text;
  if (block.type === "table")
    return [...block.header, ...block.rows.flat()].join(" ");
  if (block.type === "list") return block.items.map(inlineText).join("\n");
  return inlineText(block.children);
}

function parsedText(content: ArticleContent) {
  return content.blocks.map(blockText).filter(Boolean).join("\n\n");
}

function runReader(
  input: { html: string; url: string; fallbackTitle: string },
  signal?: AbortSignal,
): Promise<{
  url: string;
  title: string;
  byline: string | null;
  content: ArticleContent;
  text: string;
  fingerprint: string;
}> {
  const readerPath = path.resolve("generated/bookmark-reader-worker.mjs");
  const child: ChildProcess = fork(readerPath, [], {
    execArgv: ["--max-old-space-size=128"],
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, result?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      signal?.removeEventListener("abort", abort);
      child.removeAllListeners();
      if (error) {
        child.kill("SIGKILL");
        reject(error);
        return;
      }
      child.disconnect();
      void child.kill();
      try {
        if (!result || typeof result !== "object")
          throw new Error("Invalid reader output.");
        const data = result as Record<string, unknown>;
        if (typeof data.error === "string") throw new Error(data.error);
        const content = parseArticleContent(
          data.result && (data.result as Record<string, unknown>).content,
        );
        const parsed = data.result as Record<string, unknown>;
        if (
          typeof parsed.title !== "string" ||
          (parsed.byline !== null && typeof parsed.byline !== "string")
        )
          throw new Error("Invalid reader metadata.");
        const text = parsedText(content);
        if (!text.trim() || text.length > 200_000)
          throw new Error("Article text is outside the save limit.");
        resolve({
          url:
            typeof parsed.url === "string"
              ? bookmarkUrl(parsed.url)
              : input.url,
          title: parsed.title.slice(0, 300),
          byline: parsed.byline as string | null,
          content,
          text,
          fingerprint: createHash("sha256")
            .update(
              JSON.stringify({
                title: parsed.title,
                byline: parsed.byline,
                content,
              }),
            )
            .digest("hex"),
        });
      } catch (cause) {
        reject(
          cause instanceof Error ? cause : new Error("Invalid reader output."),
        );
      }
    };
    const deadline = setTimeout(
      () => finish(new Error("Article parsing timed out.")),
      parseDeadlineMs,
    );
    deadline.unref();
    const abort = () => finish(new Error("Article parsing was cancelled."));
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
    child.once("message", (message: unknown) => finish(undefined, message));
    child.once("error", (error) => finish(error));
    child.once("exit", (code) => {
      if (!settled)
        finish(new Error(`Article parser exited (${code ?? "unknown"}).`));
    });
    child.send(input, (error) => {
      if (error) finish(error);
    });
  });
}

async function captureArticle(
  url: string,
  fallbackTitle: string,
  signal?: AbortSignal,
) {
  const deadline = AbortSignal.timeout(fetchDeadlineMs);
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const page = await fetchPublic(
    bookmarkUrl(url),
    articleBytes,
    combined,
    0,
    "text/html,application/xhtml+xml",
  );
  if (!new Set(["text/html", "application/xhtml+xml"]).has(page.type))
    throw new Error("This link does not provide an HTML article.");
  return heavyInference(
    () =>
      runReader(
        {
          html: page.bytes.toString("utf8"),
          url: page.url,
          fallbackTitle,
        },
        signal,
      ),
    parseDeadlineMs + 5_000,
    signal,
  );
}

export async function processBookmarkArticle(
  { job, commit, signal }: JobContext,
  fetchAndParse = captureArticle,
) {
  if (!Number.isInteger(job.generation))
    throw new Error("Article job generation is missing.");
  const source = sqlite()
    .prepare(
      "SELECT url,title,article_generation FROM bookmarks WHERE id=? AND owner_id=? AND trashed_at IS NULL AND article_status='pending'",
    )
    .get(job.target_id, job.owner_id) as
    { url: string; title: string; article_generation: number } | undefined;
  if (!source || source.article_generation !== job.generation) {
    commit(() => "cancelled");
    return;
  }
  const extracted = await fetchAndParse(source.url, source.title, signal);
  const content = parseArticleContent(extracted.content);
  const title =
    extracted.title.trim().slice(0, 300) || source.title.slice(0, 300);
  const byline = extracted.byline?.trim().slice(0, 200) || null;
  const sourceUrl = bookmarkUrl(extracted.url);
  const resultText = parsedText(content);
  if (!resultText.trim() || resultText.length > 200_000)
    throw new Error("Article text is outside the save limit.");
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ title, byline, content }))
    .digest("hex");
  commit(() => {
    const database = sqlite();
    const current = database
      .prepare(
        "SELECT article_generation,article_version FROM bookmarks WHERE id=? AND owner_id=? AND trashed_at IS NULL AND article_status='pending'",
      )
      .get(job.target_id, job.owner_id) as
      { article_generation: number; article_version: number } | undefined;
    if (!current || current.article_generation !== job.generation)
      return "cancelled";
    const existingVersion = current.article_version
      ? articleRow(job.owner_id, job.target_id, current.article_version)
      : undefined;
    if (existingVersion?.fingerprint === fingerprint) {
      database
        .prepare(
          "UPDATE bookmarks SET article_status='ready' WHERE id=? AND owner_id=? AND article_generation=?",
        )
        .run(job.target_id, job.owner_id, job.generation);
      return "ready";
    }
    const version = (
      database
        .prepare(
          "SELECT coalesce(max(version),0)+1 AS version FROM bookmark_articles WHERE owner_id=? AND bookmark_id=?",
        )
        .get(job.owner_id, job.target_id) as { version: number }
    ).version;
    const capturedAt = Date.now();
    database
      .prepare(
        "INSERT INTO bookmark_articles(bookmark_id,owner_id,version,source_url,captured_at,title,byline,content_json,plain_text,fingerprint) VALUES(?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        job.target_id,
        job.owner_id,
        version,
        sourceUrl,
        capturedAt,
        title,
        byline,
        JSON.stringify(content),
        resultText,
        fingerprint,
      );
    database
      .prepare(
        "UPDATE bookmarks SET article_status='ready',article_version=? WHERE id=? AND owner_id=? AND article_generation=?",
      )
      .run(version, job.target_id, job.owner_id, job.generation);
    database
      .prepare(
        `DELETE FROM bookmark_articles
         WHERE owner_id=? AND bookmark_id=?
           AND version<>?
           AND NOT EXISTS(SELECT 1 FROM bookmark_highlights h WHERE h.bookmark_id=bookmark_articles.bookmark_id AND h.article_version=bookmark_articles.version)
           AND version NOT IN (
             SELECT version FROM bookmark_articles old
             WHERE old.owner_id=? AND old.bookmark_id=? AND old.version<>?
               AND NOT EXISTS(SELECT 1 FROM bookmark_highlights h WHERE h.bookmark_id=old.bookmark_id AND h.article_version=old.version)
             ORDER BY version DESC LIMIT 5
           )`,
      )
      .run(
        job.owner_id,
        job.target_id,
        version,
        job.owner_id,
        job.target_id,
        version,
      );
    return "ready";
  });
}

function articlePlainText(owner: string, bookmarkId: string, version: number) {
  const article = articleRow(owner, bookmarkId, version);
  if (!article)
    throw new HttpError(404, "This saved article version was not found.");
  return article.plain_text;
}

function exposeHighlight(row: Record<string, unknown>): BookmarkHighlight {
  return {
    id: String(row.id),
    bookmarkId: String(row.bookmark_id),
    articleVersion: Number(row.article_version),
    quote: String(row.quote),
    prefix: String(row.prefix),
    suffix: String(row.suffix),
    startOffset: Number(row.start_offset),
    endOffset: Number(row.end_offset),
    annotation: String(row.annotation),
    revision: Number(row.revision),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export function listBookmarkHighlights(
  owner: string,
  id: string,
  options: { version?: number; limit?: number; after?: string | null } = {},
): { items: BookmarkHighlight[]; next: string | null } {
  activeBookmark(owner, id);
  const limit = pageLimit(
    options.limit === undefined ? null : String(options.limit),
  );
  const cursor = decodeCursor(options.after ?? null, ["number", "string"]);
  const where = ["h.owner_id=?", "h.bookmark_id=?"];
  const values: (string | number)[] = [owner, id];
  if (options.version !== undefined) {
    where.push("h.article_version=?");
    values.push(options.version);
  }
  if (cursor) {
    where.push("(h.created_at<? OR (h.created_at=? AND h.id<?))");
    values.push(cursor[0], cursor[0], cursor[1]);
  }
  const rows = sqlite()
    .prepare(
      `SELECT h.* FROM bookmark_highlights h
       JOIN bookmark_articles a ON a.bookmark_id=h.bookmark_id AND a.version=h.article_version
       WHERE ${where.join(" AND ")}
       ORDER BY h.created_at DESC,h.id DESC LIMIT ?`,
    )
    .all(...values, limit + 1) as Record<string, unknown>[];
  const items = rows.slice(0, limit).map(exposeHighlight);
  const last = items.at(-1);
  return {
    items,
    next:
      rows.length > limit && last
        ? encodeCursor([last.createdAt, last.id])
        : null,
  };
}

function verifyAnchor(
  text: string,
  anchor: {
    quote: string;
    prefix: string;
    suffix: string;
    startOffset: number;
    endOffset: number;
  },
) {
  if (
    anchor.endOffset > text.length ||
    text.slice(anchor.startOffset, anchor.endOffset) !== anchor.quote
  )
    throw new HttpError(
      409,
      "The selected text no longer matches this article version.",
    );
  const prefix = text.slice(
    Math.max(0, anchor.startOffset - anchor.prefix.length),
    anchor.startOffset,
  );
  const suffix = text.slice(
    anchor.endOffset,
    anchor.endOffset + anchor.suffix.length,
  );
  if (prefix !== anchor.prefix || suffix !== anchor.suffix)
    throw new HttpError(
      409,
      "The selected text context does not match this article version.",
    );
}

function enforceHighlightBudget(
  owner: string,
  bookmarkId: string,
  quote: string,
  annotation: string,
  excludingId?: string,
) {
  const d = sqlite();
  const row = d
    .prepare(
      `SELECT count(*) AS count,
              coalesce(sum(length(CAST(quote AS BLOB)) + length(CAST(annotation AS BLOB))),0) AS bytes
       FROM bookmark_highlights
       WHERE owner_id=? AND bookmark_id=?${excludingId ? " AND id<>?" : ""}`,
    )
    .get(owner, bookmarkId, ...(excludingId ? [excludingId] : [])) as {
    count: number;
    bytes: number;
  };
  if (row.count + 1 > maxHighlightsPerBookmark)
    throw new HttpError(
      422,
      `A bookmark can have at most ${maxHighlightsPerBookmark.toLocaleString()} highlights.`,
    );
  if (
    row.bytes +
      Buffer.byteLength(quote, "utf8") +
      Buffer.byteLength(annotation, "utf8") >
    maxHighlightTextBytes
  )
    throw new HttpError(
      422,
      "Highlights and notes for this bookmark must stay within 200 KB of text.",
    );
}

export function createBookmarkHighlight(
  owner: string,
  id: string,
  input: unknown,
): BookmarkHighlight {
  const data = bookmarkHighlightCreateSchema.parse(input);
  const now = Date.now();
  const highlightId = randomUUID();
  const d = sqlite();
  const created = d
    .transaction(() => {
      activeBookmark(owner, id);
      verifyAnchor(articlePlainText(owner, id, data.articleVersion), data);
      enforceHighlightBudget(owner, id, data.quote, data.annotation);
      d.prepare(
        "INSERT INTO bookmark_highlights(id,owner_id,bookmark_id,article_version,quote,prefix,suffix,start_offset,end_offset,annotation,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,1,?,?)",
      ).run(
        highlightId,
        owner,
        id,
        data.articleVersion,
        data.quote,
        data.prefix,
        data.suffix,
        data.startOffset,
        data.endOffset,
        data.annotation,
        now,
        now,
      );
      return d
        .prepare("SELECT * FROM bookmark_highlights WHERE id=? AND owner_id=?")
        .get(highlightId, owner) as Record<string, unknown>;
    })
    .immediate();
  completionEvent(owner, "bookmark", id, "highlight-created");
  return exposeHighlight(created);
}

export function updateBookmarkHighlight(
  owner: string,
  id: string,
  highlightId: string,
  input: unknown,
): BookmarkHighlight {
  const data = bookmarkHighlightUpdateSchema.parse(input);
  const d = sqlite();
  const updated = d
    .transaction(() => {
      activeBookmark(owner, id);
      const existing = d
        .prepare(
          "SELECT * FROM bookmark_highlights WHERE id=? AND bookmark_id=? AND owner_id=?",
        )
        .get(highlightId, id, owner) as Record<string, unknown> | undefined;
      if (!existing) throw new HttpError(404, "This highlight was not found.");
      if (Number(existing.revision) !== data.revision)
        throw new HttpError(
          409,
          "This highlight changed in another tab. Refresh and try again.",
        );
      const changes: Record<string, string | number> = {
        revision: data.revision + 1,
        updated_at: Date.now(),
      };
      if (data.annotation !== undefined) changes.annotation = data.annotation;
      if (data.reanchor) {
        const text = articlePlainText(owner, id, data.reanchor.articleVersion);
        verifyAnchor(text, data.reanchor);
        changes.article_version = data.reanchor.articleVersion;
        changes.quote = data.reanchor.quote;
        changes.prefix = data.reanchor.prefix;
        changes.suffix = data.reanchor.suffix;
        changes.start_offset = data.reanchor.startOffset;
        changes.end_offset = data.reanchor.endOffset;
      }
      enforceHighlightBudget(
        owner,
        id,
        data.reanchor?.quote ?? String(existing.quote),
        data.annotation ?? String(existing.annotation),
        highlightId,
      );
      const assignments = Object.keys(changes)
        .map((key) => `${key}=?`)
        .join(",");
      const values = [
        ...Object.values(changes),
        highlightId,
        id,
        owner,
        data.revision,
      ];
      const result = d
        .prepare(
          `UPDATE bookmark_highlights SET ${assignments} WHERE id=? AND bookmark_id=? AND owner_id=? AND revision=?`,
        )
        .run(...values);
      if (!result.changes)
        throw new HttpError(
          409,
          "This highlight changed in another tab. Refresh and try again.",
        );
      return d
        .prepare("SELECT * FROM bookmark_highlights WHERE id=? AND owner_id=?")
        .get(highlightId, owner) as Record<string, unknown>;
    })
    .immediate();
  completionEvent(owner, "bookmark", id, "highlight-updated");
  return exposeHighlight(updated);
}

export function deleteBookmarkHighlight(
  owner: string,
  id: string,
  highlightId: string,
  input: unknown,
) {
  const { revision } = bookmarkHighlightDeleteSchema.parse(input);
  const d = sqlite();
  d.transaction(() => {
    activeBookmark(owner, id);
    const result = d
      .prepare(
        "DELETE FROM bookmark_highlights WHERE id=? AND bookmark_id=? AND owner_id=? AND revision=?",
      )
      .run(highlightId, id, owner, revision);
    if (!result.changes) {
      const exists = d
        .prepare(
          "SELECT 1 FROM bookmark_highlights WHERE id=? AND bookmark_id=? AND owner_id=?",
        )
        .get(highlightId, id, owner);
      if (!exists) throw new HttpError(404, "This highlight was not found.");
      throw new HttpError(
        409,
        "This highlight changed in another tab. Refresh and try again.",
      );
    }
  }).immediate();
  completionEvent(owner, "bookmark", id, "highlight-deleted");
  return { ok: true as const };
}

export type BookmarkReadStateResult = {
  id: string;
  status: "updated" | "unchanged" | "conflict" | "not_found";
  bookmark?: Bookmark;
};

export async function updateBookmarkReadState(
  owner: string,
  input: unknown,
): Promise<BookmarkReadStateResult[]> {
  const { items } = bookmarkReadStateBatchSchema.parse(input);
  if (new Set(items.map((item) => item.id)).size !== items.length)
    throw new HttpError(400, "A bookmark can only appear once in a batch.");
  const d = sqlite();
  const results = d
    .transaction(() =>
      items.map((item) => {
        const current = d
          .prepare(
            "SELECT revision,read_at FROM bookmarks WHERE id=? AND owner_id=? AND trashed_at IS NULL",
          )
          .get(item.id, owner) as
          { revision: number; read_at: number | null } | undefined;
        if (!current) return { id: item.id, status: "not_found" as const };
        if (current.revision !== item.revision)
          return { id: item.id, status: "conflict" as const };
        if (Boolean(current.read_at) === item.read)
          return { id: item.id, status: "unchanged" as const };
        const result = d
          .prepare(
            "UPDATE bookmarks SET read_at=?,revision=revision+1,updated_at=? WHERE id=? AND owner_id=? AND revision=? AND trashed_at IS NULL",
          )
          .run(
            item.read ? Date.now() : null,
            Date.now(),
            item.id,
            owner,
            item.revision,
          );
        if (!result.changes)
          return { id: item.id, status: "conflict" as const };
        completionEvent(
          owner,
          "bookmark",
          item.id,
          item.read ? "marked-read" : "marked-unread",
        );
        return { id: item.id, status: "updated" as const };
      }),
    )
    .immediate();
  return Promise.all(
    results.map(async (result) => {
      if (result.status !== "updated" && result.status !== "unchanged")
        return result;
      try {
        const { getBookmark } = await import("./bookmarks");
        return { ...result, bookmark: getBookmark(owner, result.id) };
      } catch {
        return { id: result.id, status: "not_found" as const };
      }
    }),
  );
}

export function articleJobFailure(
  owner: string,
  id: string,
  generation: number | null,
) {
  if (generation === null) return;
  sqlite()
    .prepare(
      "UPDATE bookmarks SET article_status='unavailable' WHERE id=? AND owner_id=? AND article_generation=? AND trashed_at IS NULL AND article_status='pending'",
    )
    .run(id, owner, generation);
}

function queryInteger(query: URLSearchParams, key: string): number | undefined {
  const value = query.get(key);
  if (value === null) return undefined;
  if (!/^[1-9]\d*$/.test(value))
    throw new HttpError(400, `The ${key} value is not valid.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed))
    throw new HttpError(400, `The ${key} value is not valid.`);
  return parsed;
}

const contentResult = (data: unknown, status = 200): ContentResult => ({
  data,
  status,
});

export async function executeBookmarkReading(
  command: ContentCommand,
): Promise<ContentResult | null> {
  const [area, id, resource, childId] = command.path;
  if (area !== "bookmarks") return null;
  const owner = command.ownerId;
  const query = command.query ?? new URLSearchParams();

  if (
    command.path.length === 2 &&
    id === "read-state" &&
    command.method === "POST"
  )
    return contentResult({
      items: await updateBookmarkReadState(owner, command.input),
    });

  if (!id || id === "read-state") return null;
  if (
    resource === "article" &&
    childId === "versions" &&
    command.path.length === 4 &&
    command.method === "GET"
  )
    return contentResult(
      listBookmarkArticleVersions(owner, id, {
        limit: queryInteger(query, "limit"),
        after: query.get("after"),
      }),
    );
  if (resource === "article" && command.path.length === 3) {
    if (command.method === "GET")
      return contentResult(
        getBookmarkArticle(owner, id, queryInteger(query, "version")),
      );
    if (command.method === "POST") {
      const result = requestBookmarkArticle(owner, id, command.input);
      return contentResult(result, "article" in result ? 200 : 202);
    }
    return null;
  }

  if (resource === "highlights" && command.path.length === 3) {
    if (command.method === "GET")
      return contentResult(
        listBookmarkHighlights(owner, id, {
          version: queryInteger(query, "version"),
          limit: pageLimit(query.get("limit")),
          after: query.get("after"),
        }),
      );
    if (command.method === "POST")
      return contentResult(
        createBookmarkHighlight(owner, id, command.input),
        201,
      );
    return null;
  }

  if (resource === "highlights" && childId && command.path.length === 4) {
    if (command.method === "PATCH")
      return contentResult(
        updateBookmarkHighlight(owner, id, childId, command.input),
      );
    if (command.method === "DELETE")
      return contentResult(
        deleteBookmarkHighlight(owner, id, childId, command.input),
      );
  }
  return null;
}
