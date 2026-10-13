import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("saved bookmark articles, versions, highlights, read state and search stay private and fenced", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "nivra-reader-test-"));
  process.env.NIVRA_DATA_DIR = directory;
  const { sqlite } = await import("../src/lib/server/db");
  const reading = await import("../src/lib/server/bookmark-reading-service");
  const { HttpError } = await import("../src/lib/server/http");
  const { claimJob, commitJob, stopJobWorker } =
    await import("../src/lib/server/jobs");
  const { moveToTrash, restoreTrash } = await import("../src/lib/server/trash");
  const database = sqlite();
  const owner = randomUUID();
  const other = randomUUID();
  const bookmarkId = randomUUID();
  const trashedBookmarkId = randomUUID();
  const now = Date.now();
  try {
    const insertOwner = database.prepare(
      "INSERT INTO user(id,name,email,email_verified,username,created_at,updated_at) VALUES(?,?,?,0,?,?,?)",
    );
    insertOwner.run(
      owner,
      "Reader",
      "reader@local.invalid",
      "reader",
      now,
      now,
    );
    const insertBookmark = database.prepare(
      "INSERT INTO bookmarks(id,owner_id,url,title,created_at,updated_at) VALUES(?,?,?,?,?,?)",
    );
    insertBookmark.run(
      bookmarkId,
      owner,
      "https://example.test/article",
      "Saved article",
      now,
      now,
    );
    insertBookmark.run(
      trashedBookmarkId,
      owner,
      "https://example.test/pending",
      "Pending article",
      now + 1,
      now + 1,
    );
    assert.equal(
      reading.getBookmarkArticle(owner, bookmarkId).status,
      "unavailable",
    );
    const existingJobCount = database
      .prepare(
        "SELECT count(*) AS count FROM background_jobs WHERE kind='article'",
      )
      .get() as { count: number } | undefined;
    assert.equal(
      existingJobCount?.count,
      0,
      "existing bookmarks are not backfilled implicitly",
    );
    const queued = database
      .transaction(() => reading.enqueueNewBookmarkArticle(owner, bookmarkId))
      .immediate();
    assert.equal(queued, true);
    assert.equal(
      reading.getBookmarkArticle(owner, bookmarkId).status,
      "pending",
    );

    const text = "A careful cache protects the receipt metadata and backups.";
    const quote = "receipt metadata";
    const startOffset = text.indexOf(quote);
    const anchor = {
      quote,
      prefix: text.slice(startOffset - 12, startOffset),
      suffix: text.slice(
        startOffset + quote.length,
        startOffset + quote.length + 8,
      ),
      startOffset,
      endOffset: startOffset + quote.length,
    };
    const queueJob = (id: string, generation: number) => {
      database
        .prepare(
          "INSERT INTO background_jobs(id,owner_id,kind,target_id,state,attempts,available_at,created_at,generation) VALUES(?,?,'article',?,'queued',0,?,?,?) ON CONFLICT(kind,target_id) DO UPDATE SET id=excluded.id,state='queued',attempts=0,available_at=excluded.available_at,lease_until=NULL,lease_token=NULL,created_at=excluded.created_at,generation=excluded.generation",
        )
        .run(randomUUID(), owner, id, Date.now(), Date.now(), generation);
      database
        .prepare(
          "UPDATE bookmarks SET article_status='pending',article_generation=? WHERE id=? AND owner_id=?",
        )
        .run(generation, id, owner);
    };
    const makeContext = (target: string, generation: number) => {
      queueJob(target, generation);
      const job = claimJob(Date.now(), "article", true);
      assert.ok(job);
      assert.equal(job.kind, "article");
      return {
        job,
        signal: new AbortController().signal,
        commit: (write: () => string) => commitJob(job, write),
      };
    };
    const process = async (
      target: string,
      generation: number,
      articleText: string,
      title: string,
    ) =>
      reading.processBookmarkArticle(
        makeContext(target, generation),
        async (url) => ({
          url,
          title,
          byline: null,
          text: articleText,
          fingerprint: "worker-hash-is-recomputed",
          content: {
            blocks: [
              {
                type: "paragraph" as const,
                children: [{ type: "text" as const, text: articleText }],
              },
            ],
          },
        }),
      );

    await process(bookmarkId, 1, text, "First version");
    const article = reading.getBookmarkArticle(owner, bookmarkId);
    assert.equal(article.status, "ready");
    assert.equal(article.currentVersion, 1);
    assert.equal(article.article?.text, text);
    assert.equal(article.article?.url, "https://example.test/article");
    const { searchWorkspace } =
      await import("../src/lib/server/unified-search");
    const { listBookmarkPage } = await import("../src/lib/server/bookmarks");
    const articleSearch = searchWorkspace(owner, "receipt metadata");
    assert.equal(articleSearch.length, 1);
    assert.equal(articleSearch[0]?.type, "bookmark");
    assert.equal(articleSearch[0]?.id, bookmarkId);
    assert.match(articleSearch[0]?.excerpt ?? "", /receipt metadata/i);
    assert.deepEqual(searchWorkspace(other, "receipt metadata"), []);
    database
      .prepare(
        "INSERT INTO tags(id,name,color) VALUES('reading','Read Later','gray')",
      )
      .run();
    database
      .prepare(
        "INSERT INTO bookmark_tags(bookmark_id,tag_id) VALUES(?, 'reading')",
      )
      .run(bookmarkId);
    assert.equal(
      searchWorkspace(owner, 'tag:"Read Later" receipt metadata')[0]?.id,
      bookmarkId,
    );
    assert.deepEqual(
      searchWorkspace(owner, 'tag:"Missing" receipt metadata'),
      [],
    );

    const highlight = reading.createBookmarkHighlight(owner, bookmarkId, {
      articleVersion: 1,
      ...anchor,
      annotation: "Follow up on this receipt.",
    });
    assert.equal(highlight.revision, 1);
    assert.deepEqual(
      reading
        .listBookmarkHighlights(owner, bookmarkId, { version: 1 })
        .items.map((item) => item.id),
      [highlight.id],
    );
    const highlightSearch = searchWorkspace(owner, "follow up receipt");
    assert.equal(highlightSearch.length, 1);
    assert.equal(highlightSearch[0]?.id, bookmarkId);
    assert.match(highlightSearch[0]?.excerpt ?? "", /receipt/i);
    assert.throws(
      () =>
        reading.createBookmarkHighlight(owner, bookmarkId, {
          articleVersion: 1,
          ...anchor,
          startOffset: 0,
        }),
      /selected text/,
    );

    await process(bookmarkId, 2, `New introduction. ${text}`, "Second version");
    const newerText = `New introduction. ${text}`;
    const nextStart = newerText.indexOf(quote);
    const movedAnchor = {
      articleVersion: 2,
      quote,
      prefix: newerText.slice(nextStart - 12, nextStart),
      suffix: newerText.slice(
        nextStart + quote.length,
        nextStart + quote.length + 8,
      ),
      startOffset: nextStart,
      endOffset: nextStart + quote.length,
    };
    const reanchored = reading.updateBookmarkHighlight(
      owner,
      bookmarkId,
      highlight.id,
      {
        revision: 1,
        reanchor: movedAnchor,
      },
    );
    assert.equal(reanchored.articleVersion, 2);
    assert.equal(reanchored.revision, 2);
    assert.throws(
      () =>
        reading.updateBookmarkHighlight(owner, bookmarkId, highlight.id, {
          revision: 1,
          annotation: "stale edit",
        }),
      /changed in another tab/,
    );

    assert.throws(
      () => reading.getBookmarkArticle(other, bookmarkId),
      /not found/,
    );
    assert.throws(
      () => reading.listBookmarkHighlights(other, bookmarkId),
      /not found/,
    );

    const currentBookmark = (
      await import("../src/lib/server/bookmarks")
    ).getBookmark(owner, bookmarkId);
    const readResults = await reading.updateBookmarkReadState(owner, {
      items: [
        { id: bookmarkId, revision: currentBookmark.revision, read: true },
        { id: randomUUID(), revision: 1, read: true },
      ],
    });
    assert.deepEqual(
      readResults.map((result) => result.status),
      ["updated", "not_found"],
    );
    assert.equal(readResults[0]?.bookmark?.readAt !== null, true);
    assert.deepEqual(
      listBookmarkPage(owner, { limit: 10, readingState: "read" }).items.map(
        (item) => item.id,
      ),
      [bookmarkId],
    );
    assert.deepEqual(
      listBookmarkPage(owner, { limit: 10, readingState: "unread" }).items.map(
        (item) => item.id,
      ),
      [trashedBookmarkId],
    );
    const staleRead = await reading.updateBookmarkReadState(owner, {
      items: [
        { id: bookmarkId, revision: currentBookmark.revision, read: false },
      ],
    });
    assert.equal(staleRead[0]?.status, "conflict");

    assert.equal(
      (await import("../src/lib/server/bookmarks")).listBookmarks(
        owner,
        "receipt metadata",
      ).length,
      1,
    );

    const limitBookmarkId = randomUUID();
    const limitText = "A quota anchor for highlights.";
    const limitOffset = limitText.indexOf("quota");
    const limitAnchor = {
      articleVersion: 1,
      quote: "quota",
      prefix: limitText.slice(0, limitOffset),
      suffix: limitText.slice(limitOffset + 5, limitOffset + 13),
      startOffset: limitOffset,
      endOffset: limitOffset + 5,
    };
    insertBookmark.run(
      limitBookmarkId,
      owner,
      "https://example.test/highlight-limits",
      "Highlight limits",
      now + 2,
      now + 2,
    );
    await process(limitBookmarkId, 1, limitText, "Highlight limits");

    const directHighlight = database.prepare(
      "INSERT INTO bookmark_highlights(id,owner_id,bookmark_id,article_version,quote,prefix,suffix,start_offset,end_offset,annotation,revision,created_at,updated_at) VALUES(?,?,?,1,'quota','','',0,5,?,1,?,?)",
    );
    database
      .transaction(() => {
        for (let index = 0; index < 1000; index++)
          directHighlight.run(
            randomUUID(),
            owner,
            limitBookmarkId,
            "",
            now + index,
            now + index,
          );
      })
      .immediate();
    assert.throws(
      () =>
        reading.createBookmarkHighlight(owner, limitBookmarkId, {
          ...limitAnchor,
          annotation: "",
        }),
      (error: unknown) => error instanceof HttpError && error.status === 422,
    );
    assert.throws(
      () =>
        directHighlight.run(
          randomUUID(),
          owner,
          limitBookmarkId,
          "",
          now + 1000,
          now + 1000,
        ),
      /bookmark_highlight_limit/,
    );
    database
      .prepare(
        "DELETE FROM bookmark_highlights WHERE owner_id=? AND bookmark_id=?",
      )
      .run(owner, limitBookmarkId);

    const longAnnotation = "x".repeat(3000);
    for (let index = 0; index < 66; index++)
      reading.createBookmarkHighlight(owner, limitBookmarkId, {
        ...limitAnchor,
        annotation: longAnnotation,
      });
    const emptyHighlight = reading.createBookmarkHighlight(
      owner,
      limitBookmarkId,
      {
        ...limitAnchor,
        annotation: "",
      },
    );
    assert.throws(
      () =>
        reading.updateBookmarkHighlight(
          owner,
          limitBookmarkId,
          emptyHighlight!.id,
          { revision: emptyHighlight!.revision, annotation: longAnnotation },
        ),
      (error: unknown) => error instanceof HttpError && error.status === 422,
    );
    const unchangedAfterRejectedUpdate = database
      .prepare("SELECT annotation,revision FROM bookmark_highlights WHERE id=?")
      .get(emptyHighlight.id) as
      { annotation: string; revision: number } | undefined;
    assert.deepEqual(unchangedAfterRejectedUpdate, {
      annotation: "",
      revision: 1,
    });
    assert.throws(
      () =>
        reading.createBookmarkHighlight(owner, limitBookmarkId, {
          ...limitAnchor,
          annotation: longAnnotation,
        }),
      (error: unknown) => error instanceof HttpError && error.status === 422,
    );
    assert.throws(
      () =>
        directHighlight.run(
          randomUUID(),
          owner,
          limitBookmarkId,
          longAnnotation,
          now + 2000,
          now + 2000,
        ),
      /bookmark_highlight_text_limit/,
    );

    const beforeTrash = database
      .prepare("SELECT revision FROM bookmarks WHERE id=?")
      .get(bookmarkId) as { revision: number };
    moveToTrash(owner, "bookmark", bookmarkId, beforeTrash.revision);
    assert.deepEqual(searchWorkspace(owner, "receipt metadata"), []);
    const trashedRevision = database
      .prepare("SELECT revision FROM bookmarks WHERE id=?")
      .get(bookmarkId) as { revision: number };
    restoreTrash(owner, "bookmark", bookmarkId, trashedRevision.revision);

    for (let generation = 3; generation <= 8; generation++)
      await process(bookmarkId, generation, text, `Version ${generation}`);
    const versions = database
      .prepare(
        "SELECT version FROM bookmark_articles WHERE bookmark_id=? ORDER BY version",
      )
      .all(bookmarkId) as { version: number }[];
    assert.deepEqual(
      versions.map((version) => version.version),
      [2, 3, 4, 5, 6, 7, 8],
    );
    const firstVersionPage = reading.listBookmarkArticleVersions(
      owner,
      bookmarkId,
      { limit: 3 },
    );
    assert.deepEqual(
      firstVersionPage.items.map((version) => version.version),
      [8, 7, 6],
    );
    assert.ok(firstVersionPage.next);
    const nextVersionPage = await reading.executeBookmarkReading({
      ownerId: owner,
      origin: "http://local.test",
      path: ["bookmarks", bookmarkId, "article", "versions"],
      method: "GET",
      query: new URLSearchParams({ limit: "3", after: firstVersionPage.next }),
    });
    assert.ok(nextVersionPage && "data" in nextVersionPage);
    if (!nextVersionPage || !("data" in nextVersionPage))
      throw new Error("Expected an article version page response.");
    assert.deepEqual(
      (nextVersionPage.data as { items: { version: number }[] }).items.map(
        (version) => version.version,
      ),
      [5, 4, 3],
    );

    const staleBefore = database
      .prepare(
        "SELECT count(*) AS count FROM bookmark_articles WHERE bookmark_id=?",
      )
      .get(bookmarkId) as { count: number };
    queueJob(bookmarkId, 9);
    database
      .prepare("UPDATE bookmarks SET article_generation=10 WHERE id=?")
      .run(bookmarkId);
    const staleJob = claimJob(Date.now(), "article", true);
    assert.ok(staleJob);
    await reading.processBookmarkArticle(
      {
        job: staleJob,
        signal: new AbortController().signal,
        commit: (write) => commitJob(staleJob, write),
      },
      async (url) => ({
        url,
        title: "Stale content",
        byline: null,
        text: "This stale content must not be committed.",
        fingerprint: "stale",
        content: {
          blocks: [
            {
              type: "paragraph" as const,
              children: [
                {
                  type: "text" as const,
                  text: "This stale content must not be committed.",
                },
              ],
            },
          ],
        },
      }),
    );
    const staleAfter = database
      .prepare(
        "SELECT count(*) AS count FROM bookmark_articles WHERE bookmark_id=?",
      )
      .get(bookmarkId) as { count: number };
    assert.equal(staleAfter.count, staleBefore.count);

    const pendingGeneration = 7;
    queueJob(trashedBookmarkId, pendingGeneration);
    const pendingRow = database
      .prepare("SELECT revision FROM bookmarks WHERE id=?")
      .get(trashedBookmarkId) as { revision: number };
    moveToTrash(owner, "bookmark", trashedBookmarkId, pendingRow.revision);
    const trashedState = database
      .prepare(
        "SELECT article_status,article_generation FROM bookmarks WHERE id=?",
      )
      .get(trashedBookmarkId) as {
      article_status: string;
      article_generation: number;
    };
    assert.equal(trashedState.article_status, "unavailable");
    assert.equal(trashedState.article_generation, pendingGeneration + 1);
    assert.throws(
      () => reading.getBookmarkArticle(owner, trashedBookmarkId),
      /not found/,
    );
    const trashJob = database
      .prepare(
        "SELECT state,lease_token FROM background_jobs WHERE kind='article' AND target_id=?",
      )
      .get(trashedBookmarkId) as { state: string; lease_token: string | null };
    assert.equal(trashJob.state, "failed");
    assert.equal(trashJob.lease_token, null);
    const trashRow = database
      .prepare("SELECT revision FROM bookmarks WHERE id=?")
      .get(trashedBookmarkId) as { revision: number };
    restoreTrash(owner, "bookmark", trashedBookmarkId, trashRow.revision);
    assert.equal(
      (await import("../src/lib/server/bookmarks")).listBookmarks(
        owner,
        "pending",
      ).length,
      1,
    );

    assert.equal(database.pragma("integrity_check", { simple: true }), "ok");
  } finally {
    await stopJobWorker();
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("bookmark parser child returns safe article blocks without HTML or external media", async () => {
  const worker = path.resolve("generated/bookmark-reader-worker.mjs");
  const child = fork(worker, [], {
    execArgv: ["--max-old-space-size=128"],
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  try {
    const result = await new Promise<Record<string, unknown>>(
      (resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("reader test timed out")),
          15_000,
        );
        child.once("message", (message: unknown) => {
          clearTimeout(timeout);
          resolve(message as Record<string, unknown>);
        });
        child.once("error", reject);
        child.send({
          html: `<!doctype html><html><head><title>Field Notes</title></head><body>
          <article><h1>Field Notes</h1><p>Keep <strong>useful evidence</strong> and <a href="/reference">references</a>.</p>
          <img src="https://tracking.example/pixel.png"><script>process.send({bad:true})</script>
          <p onclick="alert(1)">A second paragraph.</p></article>
        </body></html>`,
          url: "https://example.test/article",
          fallbackTitle: "Saved bookmark",
        });
      },
    );
    assert.equal(result.error, undefined);
    const article = result.result as Record<string, unknown>;
    assert.equal(article.title, "Field Notes");
    assert.equal(article.url, "https://example.test/article");
    assert.match(String(article.text), /useful evidence/);
    assert.equal(JSON.stringify(article).includes("<script"), false);
    assert.equal(JSON.stringify(article).includes("tracking.example"), false);
    assert.equal(JSON.stringify(article).includes("onclick"), false);
  } finally {
    child.kill("SIGKILL");
  }
});
