import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { test } from "node:test";

test("new content APIs preserve owner, read/write, Trash, retry and file boundaries", async (t) => {
  const directory = await mkdtemp(`${tmpdir()}/nivra-foundations-api-`);
  process.env.NIVRA_DATA_DIR = directory;
  const browser = await import("../src/app/api/v1/[...path]/route");
  const mcp = await import("../src/app/mcp/route");
  let base = "";
  const server = createServer(async (req, res) => {
    const requestAbort = new AbortController();
    req.on("aborted", () => requestAbort.abort());
    res.on("close", () => {
      if (!res.writableEnded) requestAbort.abort();
    });
    try {
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers))
        if (value)
          headers.set(key, Array.isArray(value) ? value.join(",") : value);
      const request = new Request(`${base}${req.url}`, {
        method: req.method,
        headers,
        signal: requestAbort.signal,
        ...(req.method !== "GET" && req.method !== "HEAD"
          ? {
              body: Readable.toWeb(
                req,
              ) as unknown as ReadableStream<Uint8Array>,
              duplex: "half" as const,
            }
          : {}),
      });
      const pathname = new URL(request.url).pathname;
      const response =
        pathname === "/mcp"
          ? await mcp.POST(request)
          : await browser.GET(request, {
              params: Promise.resolve({
                path: pathname.slice("/api/v1/".length).split("/"),
              }),
            });
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body)
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>)
          res.write(chunk);
      res.end();
    } catch (error) {
      console.error(
        `API test server ${req.method} ${new URL(req.url ?? "/", base).pathname} failed`,
        error instanceof Error ? error.message : "Unknown transport error.",
      );
      if (res.headersSent) {
        res.destroy(error instanceof Error ? error : undefined);
        return;
      }
      res.writeHead(500);
      res.end();
    }
  });
  server.keepAliveTimeout = 120_000;
  server.headersTimeout = 125_000;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  process.env.NIVRA_PUBLIC_URL = base;

  let cookie = "";
  let readKey = "";
  let writeKey = "";
  const clients: Client[] = [];
  const contextual = async <T>(label: string, run: () => Promise<T>) => {
    try {
      return await run();
    } catch (error) {
      throw new Error(`${label} failed`, { cause: error });
    }
  };
  const request = async (
    route: string,
    method = "GET",
    input?: unknown,
    token?: string,
    options: {
      headers?: Record<string, string>;
      body?: BodyInit;
      unauthenticated?: boolean;
    } = {},
  ) => {
    const headers = new Headers({ origin: base, ...options.headers });
    if (token) headers.set("authorization", `Bearer ${token}`);
    else if (cookie && !options.unauthenticated) headers.set("cookie", cookie);
    if (input !== undefined) headers.set("content-type", "application/json");
    try {
      return await fetch(`${base}/api/v1/${route}`, {
        method,
        headers,
        ...(options.body !== undefined
          ? { body: options.body }
          : input !== undefined
            ? { body: JSON.stringify(input) }
            : {}),
      });
    } catch (error) {
      throw new Error(`${method} /api/v1/${route} transport failed`, {
        cause: error,
      });
    }
  };
  const result = async <T = Record<string, unknown>>(
    route: string,
    method = "GET",
    input?: unknown,
    token?: string,
    status = 200,
    options?: {
      headers?: Record<string, string>;
      body?: BodyInit;
      unauthenticated?: boolean;
    },
  ): Promise<T> => {
    const response = await request(route, method, input, token, options);
    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      throw new Error(
        `${method} /api/v1/${route} response body failed (HTTP ${response.status})`,
        { cause: error },
      );
    }
    const value = text ? JSON.parse(text) : undefined;
    assert.equal(response.status, status, `${method} ${route}: ${text}`);
    return value as T;
  };
  const connect = async (key: string) => {
    const client = new Client({
      name: "Nivra foundations security test",
      version: "1",
    });
    await contextual("MCP client initialization", () =>
      client.connect(
        new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
          requestInit: { headers: { authorization: `Bearer ${key}` } },
        }),
      ),
    );
    clients.push(client);
    return client;
  };
  const tool = async <T = Record<string, unknown>>(
    client: Client,
    name: string,
    args: Record<string, unknown>,
  ) => {
    const response = await contextual(`MCP tool ${name}`, () =>
      client.callTool({ name, arguments: args }),
    );
    assert.equal(response.isError, undefined, JSON.stringify(response));
    return (response.structuredContent as { data: T }).data;
  };

  t.after(async () => {
    for (const client of clients) await client.close().catch(() => undefined);
    server.closeAllConnections();
    if (server.listening)
      await new Promise<void>((resolve) => server.close(() => resolve()));
    try {
      await (await import("../src/lib/server/jobs")).stopJobWorker();
    } catch {
      // The worker is not started by every test path.
    }
    await rm(directory, { recursive: true, force: true });
  });

  const setupResponse = await request("setup", "POST", {
    username: "contractfoundations",
    name: "Contract Owner",
    password: `Test-${randomUUID()}`,
  });
  assert.equal(setupResponse.status, 200, await setupResponse.clone().text());
  cookie = setupResponse.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  assert.ok(cookie);

  readKey = (
    await result<{ key: string }>(
      "ai-connections",
      "POST",
      { action: "create-key", name: "Read only", access: "read" },
      undefined,
      201,
    )
  ).key;
  writeKey = (
    await result<{ key: string }>(
      "ai-connections",
      "POST",
      { action: "create-key", name: "Read and write", access: "full" },
      undefined,
      201,
    )
  ).key;

  const capturedInput = {
    type: "note",
    title: "Idempotent capture",
    text: "Captured once, even when retried.",
    url: "",
    collection: "",
  };
  const captured = await result<{ id: string; type: string }>(
    "capture",
    "POST",
    capturedInput,
    writeKey,
    201,
    { headers: { "Idempotency-Key": "capture-retry-001" } },
  );
  const capturedAgain = await result<{ id: string }>(
    "capture",
    "POST",
    capturedInput,
    writeKey,
    201,
    { headers: { "Idempotency-Key": "capture-retry-001" } },
  );
  assert.equal(capturedAgain.id, captured.id);
  assert.equal(
    (
      await request(
        "capture",
        "POST",
        { ...capturedInput, title: "Conflicting capture" },
        writeKey,
        { headers: { "Idempotency-Key": "capture-retry-001" } },
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await request("capture", "POST", capturedInput, readKey, {
        headers: { "Idempotency-Key": "capture-read-001" },
      })
    ).status,
    403,
  );

  const task = await result<{
    id: string;
    revision: number;
    stepProgress: { total: number };
  }>("tasks", "POST", { title: "Plan a focused task" }, writeKey, 201);
  const emptySteps = await result<{ taskRevision: number; items: unknown[] }>(
    `tasks/${task.id}/steps`,
    "GET",
    undefined,
    readKey,
  );
  assert.equal(emptySteps.taskRevision, task.revision);
  assert.equal(emptySteps.items.length, 0);
  const step = await result<{
    task: { revision: number; stepProgress: { total: number } };
    step: { id: string };
  }>(
    `tasks/${task.id}/steps`,
    "POST",
    { revision: task.revision, text: "Check the evidence" },
    writeKey,
    201,
  );
  assert.equal(step.task.stepProgress.total, 1);
  const stepPage = await result<{ items: { id: string }[] }>(
    `tasks/${task.id}/steps`,
    "GET",
    undefined,
    readKey,
  );
  assert.equal(stepPage.items[0].id, step.step.id);
  assert.equal(
    (
      await request(
        `tasks/${task.id}/steps/${step.step.id}`,
        "PATCH",
        { revision: step.task.revision, completed: true },
        readKey,
      )
    ).status,
    403,
  );
  const completedStep = await result<{
    task: { revision: number };
    step: { id: string; completed: boolean };
  }>(
    `tasks/${task.id}/steps/${step.step.id}`,
    "PATCH",
    { revision: step.task.revision, completed: true },
    writeKey,
  );
  assert.equal(completedStep.step.completed, true);
  const secondStep = await result<{
    task: { revision: number };
    step: { id: string };
  }>(
    `tasks/${task.id}/steps`,
    "POST",
    {
      revision: completedStep.task.revision,
      text: "Publish the result",
      position: 0,
    },
    writeKey,
    201,
  );
  const reordered = await result<{
    task: { revision: number };
    items: { id: string }[];
  }>(
    `tasks/${task.id}/steps/reorder`,
    "POST",
    {
      revision: secondStep.task.revision,
      stepIds: [secondStep.step.id, step.step.id],
    },
    writeKey,
  );
  assert.deepEqual(
    reordered.items.map((item) => item.id),
    [secondStep.step.id, step.step.id],
  );
  assert.equal(
    (
      await request(
        `tasks/${task.id}/steps/${step.step.id}`,
        "DELETE",
        { revision: reordered.task.revision },
        readKey,
      )
    ).status,
    403,
  );
  const deletedStep = await result<{
    task: { stepProgress: { total: number } };
  }>(
    `tasks/${task.id}/steps/${step.step.id}`,
    "DELETE",
    { revision: reordered.task.revision },
    writeKey,
  );
  assert.equal(deletedStep.task.stepProgress.total, 1);

  const checklist = {
    schemaVersion: 1,
    blocks: [
      {
        id: "plan-check-1",
        type: "checkListItem",
        props: { checked: false },
        content: [{ type: "text", text: "Publish the summary", styles: {} }],
      },
    ],
  };
  const note = await result<{ id: string; revision: number }>(
    "notes",
    "POST",
    { title: "Linked work", document: checklist },
    writeKey,
    201,
  );
  assert.equal(
    (
      await request(
        `notes/${note.id}/tasks`,
        "POST",
        {
          revision: note.revision,
          blockId: "plan-check-1",
          idempotencyKey: "linked-task-0001",
        },
        readKey,
      )
    ).status,
    403,
  );
  const linked = await result<{
    note: {
      id: string;
      revision: number;
      document: { blocks: { id: string; type: string }[] };
    };
    task: { id: string };
    created: boolean;
  }>(
    `notes/${note.id}/tasks`,
    "POST",
    {
      revision: note.revision,
      blockId: "plan-check-1",
      idempotencyKey: "linked-task-0001",
    },
    writeKey,
    201,
  );
  assert.equal(linked.created, true);
  const linkedBlock = linked.note.document.blocks.find(
    (block) => block.type === "taskLink",
  );
  assert.ok(linkedBlock);
  assert.equal(
    (
      await request(
        `notes/${note.id}/tasks/${linkedBlock.id}`,
        "DELETE",
        { revision: linked.note.revision },
        readKey,
      )
    ).status,
    403,
  );
  const unlinked = await result<{
    note: { document: { blocks: { type: string }[] } };
  }>(
    `notes/${note.id}/tasks/${linkedBlock.id}`,
    "DELETE",
    { revision: linked.note.revision },
    writeKey,
  );
  assert.ok(
    unlinked.note.document.blocks.some(
      (block) => block.type === "checkListItem",
    ),
  );

  const sseNote = await result<{ id: string; revision: number }>(
    "notes",
    "POST",
    {
      title: "Live linked task status",
      document: {
        schemaVersion: 1,
        blocks: [
          {
            id: "live-task-check",
            type: "checkListItem",
            props: { checked: false },
            content: [{ type: "text", text: "Linked task", styles: {} }],
          },
        ],
      },
    },
    writeKey,
    201,
  );
  const sseLinked = await result<{
    note: { revision: number };
    task: { id: string };
  }>(
    `notes/${sseNote.id}/tasks`,
    "POST",
    {
      revision: sseNote.revision,
      blockId: "live-task-check",
      idempotencyKey: "linked-task-trash-event-001",
    },
    writeKey,
    201,
  );
  const linkedTask = await result<{ id: string; revision: number }>(
    `tasks/${sseLinked.task.id}`,
    "GET",
    undefined,
    writeKey,
  );
  const beforeTrash = await result<{
    document: {
      blocks: { type: string; props?: { taskAvailable?: boolean } }[];
    };
  }>(`notes/${sseNote.id}`, "GET", undefined, writeKey);
  assert.equal(
    beforeTrash.document.blocks.find((block) => block.type === "taskLink")
      ?.props?.taskAvailable,
    true,
  );

  const completionAbort = new AbortController();
  const completionResponse = await fetch(`${base}/api/v1/completions`, {
    headers: { cookie, accept: "text/event-stream" },
    signal: completionAbort.signal,
  });
  assert.equal(completionResponse.status, 200);
  assert.match(
    completionResponse.headers.get("content-type") ?? "",
    /text\/event-stream/,
  );
  assert.ok(completionResponse.body);
  const completionReader = completionResponse.body.getReader();

  await result(
    `tasks/${linkedTask.id}`,
    "DELETE",
    { revision: linkedTask.revision },
    writeKey,
  );
  const { sqlite } = await import("../src/lib/server/db");
  const trashEventCount = sqlite()
    .prepare(
      "SELECT count(*) AS count FROM completion_events WHERE kind='content' AND target_id=? AND status='trashed'",
    )
    .get(linkedTask.id) as { count: number };
  assert.equal(trashEventCount.count, 1);

  let completionBuffer = "";
  let sawTaskTrashEvent = false;
  const completionDeadline = Date.now() + 5000;
  try {
    while (!sawTaskTrashEvent && Date.now() < completionDeadline) {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const read = await Promise.race([
        completionReader.read(),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error("Timed out waiting for task SSE event.")),
            Math.max(1, completionDeadline - Date.now()),
          );
        }),
      ]).finally(() => clearTimeout(timeout));
      if (read.done) break;
      completionBuffer += new TextDecoder().decode(read.value, {
        stream: true,
      });
      const frames = completionBuffer.split("\n\n");
      completionBuffer = frames.pop() ?? "";
      for (const frame of frames) {
        const eventName = frame.match(/^event: (.+)$/m)?.[1];
        const payload = frame.match(/^data: (.+)$/m)?.[1];
        if (eventName !== "completion" || !payload) continue;
        const event = JSON.parse(payload) as {
          kind?: string;
          target?: string;
          status?: string;
        };
        if (
          event.kind === "content" &&
          event.target === linkedTask.id &&
          event.status === "trashed"
        )
          sawTaskTrashEvent = true;
      }
    }
  } finally {
    completionAbort.abort();
    await completionReader.cancel().catch(() => undefined);
  }
  assert.equal(sawTaskTrashEvent, true);
  const afterTrash = await result<{
    document: {
      blocks: { type: string; props?: { taskAvailable?: boolean } }[];
    };
  }>(`notes/${sseNote.id}`, "GET", undefined, writeKey);
  assert.equal(
    afterTrash.document.blocks.find((block) => block.type === "taskLink")?.props
      ?.taskAvailable,
    false,
  );

  const templateDocument = {
    schemaVersion: 1,
    blocks: [
      {
        id: "template-paragraph",
        type: "paragraph",
        content: [
          { type: "text", text: "A reusable starting point.", styles: {} },
        ],
      },
    ],
  };
  const template = await result<{ id: string; revision: number; kind: string }>(
    "templates",
    "POST",
    { name: "Focused note", kind: "note", document: templateDocument },
    writeKey,
    201,
  );
  assert.equal(
    (
      await request(
        "templates",
        "POST",
        { name: "Denied", kind: "note", document: templateDocument },
        readKey,
      )
    ).status,
    403,
  );
  const listedTemplates = await result<{ items: { id: string }[] }>(
    "templates?kind=note",
    "GET",
    undefined,
    readKey,
  );
  assert.ok(listedTemplates.items.some((item) => item.id === template.id));
  const templateDetail = await result<{
    id: string;
    document: unknown;
    attachments: unknown[];
  }>(`templates/${template.id}`, "GET", undefined, readKey);
  assert.equal(templateDetail.id, template.id);
  assert.equal(
    (
      await request(
        `templates/${template.id}`,
        "DELETE",
        { revision: template.revision },
        writeKey,
      )
    ).status,
    403,
  );
  const updatedTemplate = await result<{
    revision: number;
    description: string;
  }>(
    `templates/${template.id}`,
    "PATCH",
    { revision: template.revision, description: "A concise reusable note." },
    writeKey,
  );
  assert.equal(updatedTemplate.description, "A concise reusable note.");
  assert.equal(
    (
      await request(
        `templates/${template.id}`,
        "PATCH",
        { revision: updatedTemplate.revision, name: "Read key cannot write" },
        readKey,
      )
    ).status,
    403,
  );
  const applied = await result<{ note: { id: string }; created: boolean }>(
    `templates/${template.id}/apply`,
    "POST",
    {
      revision: updatedTemplate.revision,
      idempotencyKey: "apply-template-001",
      title: "From template",
      timezone: "UTC",
    },
    writeKey,
    201,
  );
  assert.equal(applied.created, true);
  const appliedAgain = await result<{ note: { id: string }; created: boolean }>(
    `templates/${template.id}/apply`,
    "POST",
    {
      revision: updatedTemplate.revision,
      idempotencyKey: "apply-template-001",
      title: "From template",
      timezone: "UTC",
    },
    writeKey,
    200,
  );
  assert.equal(appliedAgain.note.id, applied.note.id);
  assert.equal(appliedAgain.created, false);

  const journalTemplate = await result<{ id: string; revision: number }>(
    "templates",
    "POST",
    { name: "Daily review", kind: "journal", document: templateDocument },
    writeKey,
    201,
  );
  const preference = await result<{
    revision: number;
    defaultJournalTemplateId: string | null;
  }>("writing/preferences", "GET", undefined);
  assert.equal(preference.defaultJournalTemplateId, null);
  assert.equal(
    (await request("writing/preferences", "GET", undefined, writeKey)).status,
    403,
  );
  assert.equal(
    (
      await request(
        "writing/preferences",
        "PATCH",
        {
          revision: preference.revision,
          defaultJournalTemplateId: journalTemplate.id,
        },
        readKey,
      )
    ).status,
    403,
  );
  const updatedPreference = await result<{
    revision: number;
    defaultJournalTemplateId: string | null;
  }>("writing/preferences", "PATCH", {
    revision: preference.revision,
    defaultJournalTemplateId: journalTemplate.id,
  });
  assert.equal(updatedPreference.defaultJournalTemplateId, journalTemplate.id);
  const journal = await result<{
    id: string;
    journalPeriod: string;
    journalPeriodStart: string;
  }>(
    "journals",
    "POST",
    { date: "2026-10-13", period: "daily" },
    writeKey,
    201,
  );
  assert.equal(journal.journalPeriod, "daily");
  const journalPage = await result<{ items: { id: string }[] }>(
    "journals?period=daily&from=2026-10-13&to=2026-10-13",
    "GET",
    undefined,
    readKey,
  );
  assert.ok(journalPage.items.some((item) => item.id === journal.id));
  const review = await result<{
    period: string;
    periodStart: string;
    entry: { id: string } | null;
  }>(
    "journals/review?period=daily&date=2026-10-13&timezone=UTC",
    "GET",
    undefined,
    readKey,
  );
  assert.equal(review.periodStart, "2026-10-13");
  assert.equal(review.entry?.id, journal.id);
  const lastYearJournal = await result<{ id: string }>(
    "journals",
    "POST",
    { date: "2025-10-13", period: "daily" },
    writeKey,
    201,
  );
  const journalHistory = await result<{ items: { id: string }[] }>(
    "journals/on-this-day?date=2026-10-13",
    "GET",
    undefined,
    readKey,
  );
  assert.ok(
    journalHistory.items.some((item) => item.id === lastYearJournal.id),
  );
  const navigation = await result<{ item: { id: string } | null }>(
    `journals/${journal.id}/navigate?direction=previous`,
    "GET",
    undefined,
    readKey,
  );
  assert.equal(navigation.item?.id, lastYearJournal.id);

  const owner = (await import("../src/lib/server/db")).sqlite();
  const ownerId = (owner.prepare("SELECT id FROM user").get() as { id: string })
    .id;
  const bookmarkId = randomUUID();
  const capturedAt = Date.now();
  const articleText = "The river remembers the old stone bridge.";
  const article = {
    blocks: [
      {
        type: "paragraph",
        children: [{ type: "text", text: articleText }],
      },
    ],
  };
  owner
    .prepare(
      "INSERT INTO bookmarks(id,owner_id,url,title,description,site_name,collection,favorite,read_at,article_status,article_generation,article_version,title_edited,description_edited,metadata_status,revision,created_at,updated_at) VALUES(?,?,?,'Saved river article','','Example','','0',NULL,'ready',1,1,1,0,'done',1,?,?)",
    )
    .run(
      bookmarkId,
      ownerId,
      "https://example.test/river",
      capturedAt,
      capturedAt,
    );
  owner
    .prepare(
      "INSERT INTO bookmark_articles(bookmark_id,owner_id,version,source_url,captured_at,title,byline,content_json,plain_text,fingerprint) VALUES(?,?,1,?,?,'Saved river article',NULL,?,?,?)",
    )
    .run(
      bookmarkId,
      ownerId,
      "https://example.test/river",
      capturedAt,
      JSON.stringify(article),
      articleText,
      createHash("sha256").update(articleText).digest("hex"),
    );
  const storedBookmark = await result<{ id: string; revision: number }>(
    `bookmarks/${bookmarkId}`,
    "GET",
    undefined,
    readKey,
  );
  const articleResult = await result<{
    article: { version: number; text: string } | null;
    currentVersion: number;
  }>(`bookmarks/${bookmarkId}/article?version=1`, "GET", undefined, readKey);
  assert.equal(articleResult.article?.text, articleText);
  assert.equal(articleResult.currentVersion, 1);
  assert.equal(
    (
      await request(
        `bookmarks/${bookmarkId}/article?version=1`,
        "GET",
        undefined,
        undefined,
        {
          unauthenticated: true,
        },
      )
    ).status,
    401,
    "Saved article text must remain private.",
  );
  const versions = await result<{
    items: { version: number }[];
    next: string | null;
  }>(
    `bookmarks/${bookmarkId}/article/versions?limit=1`,
    "GET",
    undefined,
    readKey,
  );
  assert.equal(versions.items[0].version, 1);
  const savedArticle = await result<{ article: { version: number } | null }>(
    `bookmarks/${bookmarkId}/article`,
    "POST",
    { action: "save" },
    writeKey,
    200,
  );
  assert.equal(savedArticle.article?.version, 1);
  const savedState = await result<{
    items: { status: string; bookmark?: { readAt: number | null } }[];
  }>(
    "bookmarks/read-state",
    "POST",
    {
      items: [
        { id: bookmarkId, revision: storedBookmark.revision, read: true },
      ],
    },
    writeKey,
  );
  assert.equal(savedState.items[0].status, "updated");
  const readState = await result<{ items: { id: string }[] }>(
    "bookmarks?readingState=read",
    "GET",
    undefined,
    readKey,
  );
  assert.ok(readState.items.some((item) => item.id === bookmarkId));
  assert.equal(
    (
      await request(
        "bookmarks/read-state",
        "POST",
        {
          items: [
            {
              id: bookmarkId,
              revision: storedBookmark.revision + 1,
              read: false,
            },
          ],
        },
        readKey,
      )
    ).status,
    403,
  );
  const startOffset = articleText.indexOf("old stone");
  const quote = "old stone";
  const highlight = await result<{
    id: string;
    revision: number;
    quote: string;
  }>(
    `bookmarks/${bookmarkId}/highlights`,
    "POST",
    {
      articleVersion: 1,
      quote,
      prefix: "The river remembers the ",
      suffix: " bridge.",
      startOffset,
      endOffset: startOffset + quote.length,
      annotation: "Crossing note",
    },
    writeKey,
    201,
  );
  const highlights = await result<{ items: { id: string }[] }>(
    `bookmarks/${bookmarkId}/highlights?version=1`,
    "GET",
    undefined,
    readKey,
  );
  assert.equal(highlights.items[0].id, highlight.id);
  const editedHighlight = await result<{
    revision: number;
    annotation: string;
  }>(
    `bookmarks/${bookmarkId}/highlights/${highlight.id}`,
    "PATCH",
    { revision: highlight.revision, annotation: "Updated crossing note" },
    writeKey,
  );
  assert.equal(editedHighlight.annotation, "Updated crossing note");
  assert.equal(
    (
      await request(
        `bookmarks/${bookmarkId}/highlights/${highlight.id}`,
        "DELETE",
        { revision: editedHighlight.revision },
        writeKey,
      )
    ).status,
    403,
  );
  await result(
    `bookmarks/${bookmarkId}/highlights/${highlight.id}`,
    "DELETE",
    { revision: editedHighlight.revision },
    undefined,
  );
  const emptyHighlights = await result<{ items: unknown[] }>(
    `bookmarks/${bookmarkId}/highlights`,
    "GET",
    undefined,
    readKey,
  );
  assert.equal(emptyHighlights.items.length, 0);

  assert.equal(
    (
      await request(
        "calendar/export?from=2026-10-13&to=2026-10-14&timezone=UTC",
        "GET",
        undefined,
        readKey,
      )
    ).status,
    403,
    "Calendar export is an owner-session operation.",
  );
  const calendar = await request(
    "calendar/export?from=2026-10-13&to=2026-10-14&timezone=UTC",
    "GET",
    undefined,
  );
  assert.equal(calendar.status, 200, await calendar.clone().text());
  assert.match(await calendar.text(), /BEGIN:VCALENDAR/);

  const fileNote = await result<{ id: string }>(
    "notes",
    "POST",
    { title: "Private attachment" },
    writeKey,
    201,
  );
  const form = new FormData();
  form.set("note", fileNote.id);
  form.set(
    "file",
    new File([await readFile("public/icons/icon-192.png")], "private.png", {
      type: "image/png",
    }),
  );
  const uploaded = await result<{ id: string; url: string }>(
    "files",
    "POST",
    undefined,
    writeKey,
    201,
    { body: form },
  );
  assert.equal(
    (
      await request(`files/${uploaded.id}`, "GET", undefined, undefined, {
        unauthenticated: true,
      })
    ).status,
    401,
    "An attachment must not be anonymously readable.",
  );
  const privateFile = await request(
    `files/${uploaded.id}`,
    "GET",
    undefined,
    readKey,
  );
  assert.equal(privateFile.status, 200);
  assert.equal(privateFile.headers.get("cache-control"), "private, no-store");

  const trashTarget = await result<{ id: string; revision: number }>(
    "notes",
    "POST",
    { title: "Agent Trash boundary" },
    writeKey,
    201,
  );
  await result(
    `notes/${trashTarget.id}`,
    "DELETE",
    { revision: trashTarget.revision },
    writeKey,
  );
  const trash = await result<{ items: { id: string }[] }>(
    "trash",
    "GET",
    undefined,
    readKey,
  );
  assert.ok(trash.items.some((item) => item.id === trashTarget.id));
  assert.equal(
    (
      await request(
        `trash/note/${trashTarget.id}/restore`,
        "POST",
        { revision: trashTarget.revision + 1 },
        writeKey,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await request(
        `trash/note/${trashTarget.id}`,
        "DELETE",
        { revision: trashTarget.revision + 1 },
        writeKey,
      )
    ).status,
    403,
  );

  const readClient = await connect(readKey);
  const writeClient = await connect(writeKey);
  const readTools = (
    await contextual("MCP read tool listing", () => readClient.listTools())
  ).tools;
  const writeTools = (
    await contextual("MCP write tool listing", () => writeClient.listTools())
  ).tools;
  for (const name of [
    "save_capture",
    "add_task_step",
    "create_writing_template",
    "apply_writing_template",
    "set_bookmark_read_state",
    "create_bookmark_highlight",
  ]) {
    assert.ok(
      writeTools.some((entry) => entry.name === name),
      `write MCP tool ${name}`,
    );
    assert.ok(
      !readTools.some((entry) => entry.name === name),
      `read-only MCP excludes ${name}`,
    );
  }
  assert.ok(
    !writeTools.some((entry) => entry.name === "delete_bookmark_highlight"),
  );
  assert.ok(
    !readTools.some((entry) => entry.name === "delete_bookmark_highlight"),
  );
  assert.ok(readTools.some((entry) => entry.name === "get_bookmark_article"));
  assert.ok(readTools.some((entry) => entry.name === "list_task_steps"));
  const mcpCapture = await tool<{ id: string; type: string }>(
    writeClient,
    "save_capture",
    {
      type: "note",
      title: "MCP capture contract",
      text: "Saved through the write-enabled MCP tool.",
      url: "",
      collection: "",
      idempotencyKey: "mcp-capture-001",
    },
  );
  assert.equal(mcpCapture.type, "note");
  const readOnlyCapture = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${readKey}`,
      origin: base,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "read-only-capture-denied",
      method: "tools/call",
      params: {
        name: "save_capture",
        arguments: {
          type: "note",
          title: "Denied MCP capture",
          text: "",
          url: "",
          collection: "",
        },
      },
    }),
  });
  assert.equal(readOnlyCapture.status, 403);
  assert.match(
    readOnlyCapture.headers.get("www-authenticate") ?? "",
    /error="insufficient_scope"/,
  );
  assert.match(await readOnlyCapture.text(), /additional permissions/);

  const { apiOperations } = await import("../src/lib/server/api-contract");
  for (const route of [
    "capture",
    "tasks/{id}/steps",
    "tasks/{id}/steps/{stepId}",
    "tasks/{id}/steps/reorder",
    "notes/{id}/tasks",
    "notes/{id}/tasks/{blockId}",
    "journals/review",
    "journals/on-this-day",
    "journals/{id}/navigate",
    "templates",
    "templates/{id}",
    "templates/{id}/apply",
    "writing/preferences",
    "bookmarks/read-state",
    "bookmarks/{id}/article",
    "bookmarks/{id}/article/versions",
    "bookmarks/{id}/highlights",
    "bookmarks/{id}/highlights/{highlightId}",
    "calendar/export",
  ]) {
    assert.ok(
      apiOperations.some((operation) => operation.path === `/api/v1/${route}`),
      `API operation registered: ${route}`,
    );
  }
});
