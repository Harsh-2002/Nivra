import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomUUID, createHash } from "node:crypto";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
test("MCP shares content while isolating agent credentials and account administration", async (t) => {
  const directory = await mkdtemp(`${tmpdir()}/nivra-mcp-`);
  process.env.NIVRA_DATA_DIR = directory;

  const server = createServer(
    { keepAliveTimeout: 60_000, keepAliveTimeoutBuffer: 5_000 },
    async (req, res) => {
      try {
        const headers = new Headers();
        for (const [k, v] of Object.entries(req.headers))
          if (v) headers.set(k, Array.isArray(v) ? v.join(",") : v);
        const request = new Request(`${base}${req.url}`, {
          method: req.method,
          headers,
          ...(req.method !== "GET" && req.method !== "HEAD"
            ? {
                body: Readable.toWeb(
                  req,
                ) as unknown as ReadableStream<Uint8Array>,
                duplex: "half" as const,
              }
            : {}),
        });
        const result = await dispatch(request);
        res.writeHead(result.status, Object.fromEntries(result.headers));
        if (result.body)
          for await (const chunk of result.body as unknown as AsyncIterable<Uint8Array>)
            res.write(chunk);
        res.end();
      } catch {
        res.writeHead(500);
        res.end();
      }
    },
  );
  t.after(async () => {
    server.closeAllConnections();
    if (server.listening)
      await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  process.env.NIVRA_PUBLIC_URL = base;
  const browser = await import("../src/app/api/v1/[...path]/route");
  const authRoute = await import("../src/app/api/auth/[...all]/route");
  const mcp = await import("../src/app/mcp/route");
  const meta =
    await import("../src/app/.well-known/oauth-authorization-server/api/auth/route");
  const share = await import("../src/app/share/[token]/route");
  const files = await import("../src/app/mcp/files/[...path]/route");
  const { sqlite } = await import("../src/lib/server/db");
  const { revokeOAuth } = await import("../src/lib/server/agent-access");
  const dispatch = async (r: Request) => {
    const p = new URL(r.url).pathname;
    if (p.startsWith("/share/"))
      return share.GET(r, { params: Promise.resolve({ token: p.slice(7) }) });
    if (p === "/mcp") return r.method === "POST" ? mcp.POST(r) : mcp.GET();
    if (p.startsWith("/mcp/files/"))
      return files.GET(r, {
        params: Promise.resolve({ path: p.slice(11).split("/") }),
      });
    if (p.startsWith("/api/auth/")) return authRoute.POST(r);
    if (p.startsWith("/.well-known/")) return meta.GET(r);
    return browser.GET(r, {
      params: Promise.resolve({ path: p.slice("/api/v1/".length).split("/") }),
    });
  };
  let cookie = "";
  const human = async (path: string, body?: unknown) => {
    const r = await fetch(`${base}/api/v1/${path}`, {
      method: body ? "POST" : "GET",
      headers: { cookie, origin: base, "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!cookie)
      cookie = r.headers
        .getSetCookie()
        .map((s) => s.split(";")[0])
        .join("; ");
    assert.ok(r.ok, await r.clone().text());
    return r.json();
  };
  const clients: Client[] = [];
  const connect = async (key: string) => {
    const client = new Client({ name: "Nivra test agent", version: "1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${key}` } },
      }),
    );
    clients.push(client);
    return client;
  };
  const call = async <T = Record<string, unknown>>(
    client: Client,
    name: string,
    args: Record<string, unknown>,
  ) => {
    const r = await client.callTool({ name, arguments: args });
    assert.equal(r.isError, undefined, JSON.stringify(r));
    return (r.structuredContent as { data: T }).data;
  };
  try {
    const password = `Test-${randomUUID()}`;
    const setup = await human("setup", {
      username: "mcptester",
      name: "MCP Test",
      password,
    });
    assert.ok(setup.recoveryCode);
    const owner = (
      sqlite().prepare("SELECT id FROM user").get() as { id: string }
    ).id;
    await t.test(
      "valid older owner sessions manage MCP credentials without signing in again",
      async () => {
        sqlite()
          .prepare("UPDATE session SET created_at=? WHERE user_id=?")
          .run(Date.now() - 86400000, owner);
        const created = await human("ai-connections", {
          action: "create-key",
          name: "Older session ".padEnd(80, "n"),
          access: "read",
        });
        assert.ok(created.key);
        assert.equal(
          (
            sqlite()
              .prepare("SELECT name FROM apikey WHERE id=?")
              .get(created.id) as { name: string }
          ).name.length,
          80,
        );
        assert.equal((await human("status")).owner.id, owner);
        await human("ai-connections", { action: "revoke-key", id: created.id });
        assert.equal(
          sqlite().prepare("SELECT 1 FROM apikey WHERE id=?").get(created.id),
          undefined,
        );
        const oversized = await fetch(`${base}/api/v1/ai-connections`, {
          method: "POST",
          headers: { cookie, origin: base, "content-type": "application/json" },
          body: JSON.stringify({
            action: "create-key",
            name: "n".repeat(81),
            access: "read",
          }),
        });
        assert.equal(oversized.status, 400);
        const anonymous = await fetch(`${base}/api/v1/ai-connections`, {
          method: "POST",
          headers: { origin: base, "content-type": "application/json" },
          body: JSON.stringify({
            action: "create-key",
            name: "Denied",
            access: "read",
          }),
        });
        assert.equal(anonymous.status, 401);
        sqlite()
          .prepare("UPDATE session SET created_at=? WHERE user_id=?")
          .run(Date.now(), owner);
      },
    );
    let fullKey = "",
      readKey = "";
    await t.test(
      "keys are hashed, scoped, and cannot administer owner settings",
      async () => {
        const full = await human("ai-connections", {
          action: "create-key",
          name: "Full test",
          access: "full",
        });
        fullKey = full.key;
        assert.equal(
          (
            sqlite().prepare("SELECT count(*) AS n FROM jwks").get() as {
              n: number;
            }
          ).n,
          0,
          "Browser session checks must not generate unused JWT signing keys",
        );
        const read = await human("ai-connections", {
          action: "create-key",
          name: "Read test",
          access: "read",
        });
        readKey = read.key;
        assert.ok(fullKey.startsWith("nivra_"));
        assert.equal(
          sqlite().prepare("SELECT 1 FROM apikey WHERE key=?").get(fullKey),
          undefined,
        );
        const privateResponse = await fetch(`${base}/api/v1/settings`, {
          headers: { authorization: `Bearer ${fullKey}` },
        });
        assert.equal(privateResponse.status, 403);
        const anonymous = await fetch(`${base}/mcp`, { method: "POST" });
        assert.equal(anonymous.status, 401);
        assert.match(
          anonymous.headers.get("www-authenticate")!,
          /resource_metadata/,
        );
        assert.match(
          anonymous.headers.get("www-authenticate")!,
          /scope="nivra:read nivra:write"/,
        );
      },
    );
    const client = await connect(fullKey);
    await t.test("SDK discovery and bounded content tools", async () => {
      const { tools } = await client.listTools();
      assert.ok(tools.some((x) => x.name === "create_note"));
      assert.ok(
        !tools.some((x) => /recovery|password|sql|backup/.test(x.name)),
      );
      assert.ok(tools.length > 35);
      const writeOnly = await fetch(
        `${base}/api/auth/oauth2/authorize?scope=nivra%3Awrite`,
      );
      assert.equal(writeOnly.status, 400);
      assert.equal((await writeOnly.json()).error, "invalid_scope");
    });
    await t.test(
      "MCP semantic search returns canonical content and preserves read-only access",
      async () => {
        const { enqueueJob, claimJob, commitJob } =
          await import("../src/lib/server/jobs");
        const { processSemantic, stopAi } =
          await import("../src/lib/server/ai/indexer");
        const id = randomUUID(),
          key = "note:" + id,
          formId = randomUUID(),
          versionId = randomUUID(),
          responseId = randomUUID(),
          fileId = randomUUID(),
          tagId = randomUUID();
        const d = sqlite();
        d.prepare(
          "INSERT INTO notes(id,owner_id,title,document,text,created_at,updated_at) VALUES(?,?,'recovery-73.pdf SQLite backup','[]','Encrypted SQLite database backup restore verification.',1,1)",
        ).run(id, owner);
        d.prepare("UPDATE ai_configuration SET enabled=1").run();
        try {
          enqueueJob(owner, "semantic", key);
          const job = claimJob();
          assert.ok(job);
          await processSemantic({
            job,
            commit: (write) => commitJob(job, write),
          });
          assert.equal(
            (
              d
                .prepare("SELECT state FROM ai_content WHERE source_key=?")
                .get(key) as { state: string }
            ).state,
            "indexed",
          );
          const reader = await connect(readKey);
          const tools = (await reader.listTools()).tools;
          assert.ok(tools.some((tool) => tool.name === "search"));
          assert.ok(
            !tools.some((tool) => /suggestion|configure_ai/.test(tool.name)),
          );
          const found = await call<{ id: string; title: string }[]>(
            reader,
            "search",
            { query: "recover recovery-73.pdf", strategy: "semantic" },
          );
          assert.ok(found.some((row) => row.id === id));
          assert.ok(!JSON.stringify(found).includes("embedding"));
          await assert.rejects(
            reader.callTool({
              name: "create_note",
              arguments: { title: "Denied" },
            }),
            /Insufficient scope/,
          );
          assert.ok(
            !tools.some((tool) => tool.name === "assign_tags"),
            "Read-only connections cannot change response tags",
          );

          const createdAt = Date.now();
          const definition = JSON.stringify({
            schemaVersion: 1,
            title: "Private response form",
            fields: [],
          });
          d.prepare(
            "INSERT INTO forms(id,owner_id,title,definition,created_at,updated_at) VALUES(?,?,?,?,?,?)",
          ).run(
            formId,
            owner,
            "Private feedback",
            definition,
            createdAt,
            createdAt,
          );
          d.prepare(
            "INSERT INTO form_versions(id,form_id,revision,definition,created_at) VALUES(?,?,1,?,?)",
          ).run(versionId, formId, definition, createdAt);
          d.prepare(
            "INSERT INTO form_responses(id,form_id,version_id,answers,search_text,retry_key,request_hash,created_at) VALUES(?,?,?,'{}',?,?,?,?)",
          ).run(
            responseId,
            formId,
            versionId,
            "Submitted privately without an incident.",
            "retry-" + responseId,
            "hash-" + responseId,
            createdAt,
          );
          d.prepare(
            "INSERT INTO form_files(id,form_id,response_id,field_id,filename,mime,size,storage_key,state,created_at) VALUES(?,?,?,'evidence','private-evidence.txt','text/plain',32,?,'attached',?)",
          ).run(fileId, formId, responseId, fileId, createdAt);
          d.prepare(
            "INSERT INTO ai_extractions(source_key,storage_key,text,status) VALUES(?,?,?,'done')",
          ).run(
            "form-file:" + fileId,
            fileId,
            "Private upload contains tealquasar incident evidence.",
          );
          d.prepare(
            "INSERT INTO tags(id,name,color) VALUES(?,'Private evidence','gray')",
          ).run(tagId);
          d.prepare(
            "INSERT INTO response_tags(response_id,tag_id) VALUES(?,?)",
          ).run(responseId, tagId);

          const runtime = globalThis as unknown as {
            nivraAi?: {
              worker: {
                search: (
                  ownerId: string,
                  text: string,
                  deadline: number,
                  filterType?: string,
                  tag?: string,
                ) => Promise<
                  { key: string; sourceKey: string; score: number }[]
                >;
              };
            };
          };
          assert.ok(runtime.nivraAi?.worker);
          const worker = runtime.nivraAi.worker;
          const originalSearch = worker.search;
          worker.search = async (_ownerId, text) =>
            text.includes("tealquasar")
              ? [
                  {
                    key: "response:" + responseId,
                    sourceKey: "form-file:" + fileId,
                    score: 0.99,
                  },
                ]
              : [];
          try {
            const privateMatches = await call<
              {
                id: string;
                type: string;
                title: string;
                excerpt: string;
                updatedAt: number;
                formId: string;
              }[]
            >(reader, "search", {
              query: "type:response tealquasar",
              strategy: "semantic",
            });
            assert.deepEqual(privateMatches, [
              {
                id: responseId,
                type: "response",
                title: "Private feedback — response",
                excerpt:
                  "Private upload contains tealquasar incident evidence.",
                updatedAt: createdAt,
                formId,
              },
            ]);
            assert.ok(
              !JSON.stringify(privateMatches).match(
                /embedding|sourceKey|score|vector/i,
              ),
            );

            const tagged = await call<{
              items: {
                id: string;
                type: string;
                formId: string;
                tags: { id: string }[];
              }[];
              nextOffset: number | null;
            }>(reader, "tagged_items", { id: tagId, limit: 20 });
            assert.deepEqual(tagged.items, [
              {
                id: responseId,
                type: "response",
                title: "Private feedback — response",
                excerpt: "Submitted privately without an incident.",
                updatedAt: createdAt,
                dailyDate: null,
                journalPeriod: null,
                journalPeriodStart: null,
                favorite: false,
                completed: false,
                formId,
                tags: [{ id: tagId, name: "Private evidence", color: "gray" }],
              },
            ]);
            assert.ok(
              !JSON.stringify(tagged).match(
                /embedding|sourceKey|score|vector/i,
              ),
            );

            d.prepare("UPDATE form_responses SET trashed_at=? WHERE id=?").run(
              Date.now(),
              responseId,
            );
            const trashedSearch = await call<{ id: string; type: string }[]>(
              reader,
              "search",
              {
                query: "type:response tealquasar",
                strategy: "semantic",
              },
            );
            const trashedTagged = await call<{
              items: { id: string; type: string }[];
            }>(reader, "tagged_items", { id: tagId, limit: 20 });
            assert.ok(!trashedSearch.some((row) => row.id === responseId));
            assert.ok(
              !trashedTagged.items.some((row) => row.id === responseId),
            );

            d.prepare(
              "UPDATE form_responses SET trashed_at=NULL WHERE id=?",
            ).run(responseId);
            d.prepare("UPDATE forms SET trashed_at=? WHERE id=?").run(
              Date.now(),
              formId,
            );
            const trashedFormSearch = await call<
              { id: string; type: string }[]
            >(reader, "search", {
              query: "type:response tealquasar",
              strategy: "semantic",
            });
            const trashedFormTagged = await call<{
              items: { id: string; type: string }[];
            }>(reader, "tagged_items", { id: tagId, limit: 20 });
            assert.ok(!trashedFormSearch.some((row) => row.id === responseId));
            assert.ok(
              !trashedFormTagged.items.some((row) => row.id === responseId),
            );
          } finally {
            worker.search = originalSearch;
          }

          d.prepare("UPDATE notes SET trashed_at=1 WHERE id=?").run(id);
          assert.ok(
            !(
              await call<{ id: string }[]>(reader, "search", {
                query: "recovery-73.pdf",
                strategy: "semantic",
              })
            ).some((row) => row.id === id),
          );
          d.prepare("UPDATE ai_configuration SET enabled=0").run();
          d.prepare("UPDATE notes SET trashed_at=NULL WHERE id=?").run(id);
          assert.ok(
            (
              await call<{ id: string }[]>(reader, "search", {
                query: "recovery-73.pdf",
                strategy: "semantic",
              })
            ).some((row) => row.id === id),
          );
        } finally {
          d.prepare("UPDATE ai_configuration SET enabled=0").run();
          await stopAi();
          d.prepare("DELETE FROM forms WHERE id=?").run(formId);
          d.prepare("DELETE FROM notes WHERE id=?").run(id);
        }
      },
    );
    await t.test(
      "Forms tools publish typed definitions, count submissions and enforce scopes",
      async () => {
        const question = randomUUID();
        const definition = {
          schemaVersion: 1,
          title: "Agent survey",
          fields: [
            { id: question, type: "short_text", label: "Idea", required: true },
          ],
        };
        const form = await call<{ id: string; revision: number }>(
          client,
          "create_form",
          {
            definition,
            deadline: { date: "2099-11-01", timezone: "UTC" },
            idempotencyKey: "form-" + randomUUID(),
          },
        );
        const published = await call<{
          id: string;
          revision: number;
          publicToken: string;
          publishedVersionId: string;
          url: string;
        }>(client, "publish_form", { id: form.id, revision: form.revision });
        assert.equal(published.url, `${base}/form/${published.publicToken}`);
        const result = await human(
          `public/forms/${published.publicToken}/responses`,
          {
            versionId: published.publishedVersionId,
            retryKey: randomUUID(),
            answers: { [question]: "A helpful idea" },
          },
        );
        const summary = await call<{ total: number }>(
          client,
          "get_form_summary",
          { id: form.id },
        );
        assert.equal(summary.total, 1);
        const page = await call<{
          total: number;
          items: { id: string; revision: number }[];
        }>(client, "list_form_responses", { formId: form.id, limit: 1 });
        assert.equal(page.total, 1);
        assert.equal(page.items[0].id, result.id);
        const detail = await call<{
          answers: Record<string, string>;
          revision: number;
        }>(client, "get_form_response", {
          formId: form.id,
          responseId: result.id,
        });
        assert.equal(detail.answers[question], "A helpful idea");
        const calendar = await call<{
          items: { type: string; sourceId: string; label: string }[];
        }>(client, "list_calendar", {
          from: "2099-11-01",
          to: "2099-11-02",
          timezone: "UTC",
        });
        assert.ok(
          calendar.items.some(
            (item) =>
              item.type === "form" &&
              item.sourceId === form.id &&
              item.label === "Closes",
          ),
        );
        assert.equal(
          (
            await call<{ total: number }>(client, "list_form_responses", {
              formId: form.id,
              date: "2099-11-01",
              timezone: "UTC",
            })
          ).total,
          0,
        );

        const filteredExport = await call<{ url: string }>(
          client,
          "file_transfer",
          {
            target: "form-export",
            formId: form.id,
            format: "json",
            date: "2099-11-01",
            timezone: "UTC",
          },
        );
        assert.equal(
          new URL(filteredExport.url).searchParams.get("date"),
          "2099-11-01",
        );
        const emptyExport = await fetch(filteredExport.url, {
          headers: { authorization: `Bearer ${fullKey}` },
        });
        assert.equal(emptyExport.status, 200);
        assert.deepEqual(await emptyExport.json(), []);
        const reader = await connect(readKey);
        assert.ok(
          (await reader.listTools()).tools.some(
            (tool) => tool.name === "get_form_summary",
          ),
        );
        assert.ok(
          !(await reader.listTools()).tools.some(
            (tool) => tool.name === "create_form",
          ),
        );
        assert.equal(
          (
            await call<{ total: number }>(reader, "list_form_responses", {
              formId: form.id,
            })
          ).total,
          1,
        );
        const trashResponse = {
          formId: form.id,
          responseId: result.id,
          revision: detail.revision,
          idempotencyKey: "response-trash-" + randomUUID(),
        };
        await call(client, "trash_form_response", trashResponse);
        await call(client, "trash_form_response", trashResponse);
        assert.equal(
          (
            await call<{ total: number }>(reader, "get_form_summary", {
              id: form.id,
            })
          ).total,
          0,
        );
        const denied = await client.callTool({
          name: "review_form_response",
          arguments: {
            formId: form.id,
            responseId: result.id,
            revision: detail.revision + 1,
            reviewed: true,
          },
        });
        assert.equal(denied.isError, true);
        const trashForm = {
          id: form.id,
          revision: published.revision,
          idempotencyKey: "form-trash-" + randomUUID(),
        };
        await call(client, "trash_form", trashForm);
        await call(client, "trash_form", trashForm);
        const deleted = await call<{ items: { kind: string; id: string }[] }>(
          reader,
          "list_trash",
          { kind: "form" },
        );
        assert.ok(deleted.items.some((item) => item.id === form.id));
        const gone = await fetch(
          `${base}/api/v1/public/forms/${published.publicToken}`,
        );
        assert.equal(gone.status, 404);
      },
    );
    await t.test(
      "Kanban tools share tasks, exact counts, ordering and scoped permissions",
      async () => {
        const board = await call<
          import("../src/lib/types").Board & { url: string }
        >(client, "create_board", {
          name: "MCP project",
          idempotencyKey: "kanban-board-create",
        });
        assert.equal(board.url, `${base}/tasks?view=board&board=${board.id}`);
        const repeated = await call<import("../src/lib/types").Board>(
          client,
          "create_board",
          { name: "MCP project", idempotencyKey: "kanban-board-create" },
        );
        assert.equal(repeated.id, board.id);
        const first = await call<import("../src/lib/types").Task>(
          client,
          "create_task",
          { title: "Board first", boardId: board.id },
        );
        const second = await call<import("../src/lib/types").Task>(
          client,
          "create_task",
          { title: "Board second", boardId: board.id },
        );
        const moved = await call<import("../src/lib/types").Task>(
          client,
          "move_task",
          {
            id: first.id,
            revision: first.revision,
            boardId: board.id,
            status: "in_progress",
          },
        );
        assert.equal(moved.status, "in_progress");
        const summary = await call<import("../src/lib/types").BoardDetail>(
          client,
          "get_board",
          { id: board.id },
        );
        assert.deepEqual(summary.counts, { todo: 1, in_progress: 1, done: 0 });
        const listed = await call<
          import("../src/lib/types").Page<import("../src/lib/types").Task>
        >(client, "list_tasks", {
          boardId: board.id,
          status: "in_progress",
          order: "board",
          limit: 1,
        });
        assert.equal(listed.items[0].id, first.id);
        const stale = await client.callTool({
          name: "move_task",
          arguments: {
            id: first.id,
            revision: first.revision,
            boardId: board.id,
            status: "done",
          },
        });
        assert.equal(stale.isError, true);
        const done = await call<import("../src/lib/types").Task>(
          client,
          "update_task",
          { id: moved.id, revision: moved.revision, completed: true },
        );
        assert.equal(done.status, "done");
        const archived = await call<import("../src/lib/types").Board>(
          client,
          "update_board",
          { id: board.id, revision: board.revision, archived: true },
        );
        assert.ok(archived.archivedAt);
        await call(client, "update_board", {
          id: board.id,
          revision: archived.revision,
          archived: false,
        });
        const reader = await connect(readKey);
        const catalog = (await reader.listTools()).tools.map((t) => t.name);
        assert.ok(catalog.includes("get_board"));
        assert.ok(
          !catalog.includes("create_board") && !catalog.includes("move_task"),
        );
        assert.equal(
          (await call(reader, "get_task", { id: second.id })).boardId,
          board.id,
        );
        const invalid = await client.callTool({
          name: "move_task",
          arguments: {
            id: second.id,
            revision: second.revision,
            boardId: board.id,
            status: "blocked",
          },
        });
        assert.equal(invalid.isError, true);
        sqlite().prepare("DELETE FROM tasks WHERE board_id=?").run(board.id);
        sqlite().prepare("DELETE FROM task_boards WHERE id=?").run(board.id);
      },
    );
    await t.test(
      "calendar tools validate events, return canonical links and enforce revisions",
      async () => {
        const input = {
          title: "MCP calendar fixture",
          start: "2026-10-08",
          end: "2026-10-09",
          timezone: "UTC",
          recurrence: { frequency: "daily", count: 3 },
        };
        const created = await call<{
          id: string;
          revision: number;
          url: string;
        }>(client, "create_event", { input });
        assert.equal(created.url, `${base}/calendar?event=${created.id}`);
        const loaded = await call<{ title: string; linkedItems: unknown[] }>(
          client,
          "get_event",
          { id: created.id },
        );
        assert.equal(loaded.title, input.title);
        assert.deepEqual(loaded.linkedItems, []);
        const range = await call<{
          items: { sourceId: string }[];
          total: number;
        }>(client, "list_calendar", {
          from: "2026-10-08",
          to: "2026-10-12",
          timezone: "UTC",
          limit: 1,
        });
        assert.ok(range.total >= 3);
        assert.equal(range.items.length, 1);
        const invalid = await client.callTool({
          name: "create_event",
          arguments: { input: { ...input, start: "2026-02-30" } },
        });
        assert.equal(invalid.isError, true);
        const edited = await call<{ revision: number }>(
          client,
          "update_event",
          {
            id: created.id,
            revision: created.revision,
            input: { ...input, title: "Updated calendar fixture" },
          },
        );
        const stale = await client.callTool({
          name: "update_event",
          arguments: { id: created.id, revision: created.revision, input },
        });
        assert.equal(stale.isError, true);
        await call(client, "trash_event", {
          id: created.id,
          revision: edited.revision,
        });
        assert.ok(
          sqlite()
            .prepare(
              "SELECT 1 FROM calendar_events WHERE id=? AND trashed_at IS NOT NULL",
            )
            .get(created.id),
        );
      },
    );
    await t.test(
      "calendar task tools preserve totals, reminders and read-only access",
      async () => {
        const calendarKey = await human("ai-connections", {
          action: "create-key",
          name: "Calendar scenarios",
          access: "full",
        });
        const calendarClient = await connect(calendarKey.key);
        const reader = await connect(readKey);
        const catalog = (await reader.listTools()).tools.map(
          (tool) => tool.name,
        );
        assert.ok(catalog.includes("list_calendar_tasks"));
        assert.ok(catalog.includes("get_task_reminders"));
        for (const name of [
          "create_event",
          "update_event",
          "trash_event",
          "set_task_reminders",
          "dismiss_reminder",
        ])
          assert.ok(!catalog.includes(name));
        const task = await call<{ id: string; revision: number }>(
          calendarClient,
          "create_task",
          {
            title: "Calendar overdue fixture",
            dueDate: "2026-10-07",
            plannedDate: "2026-10-06",
          },
        );
        assert.deepEqual(
          await call(reader, "get_task_reminders", { id: task.id }),
          { reminders: [] },
        );
        const settings = {
          id: task.id,
          revision: task.revision,
          timezone: "UTC",
          field: "due",
          offsets: [0, 60],
        };
        await call(calendarClient, "set_task_reminders", settings);
        assert.deepEqual(
          await call(reader, "get_task_reminders", { id: task.id }),
          {
            reminders: [{ field: "due", timezone: "UTC", offsets: [0, 60] }],
          },
        );
        for (const patch of [
          { timezone: "Invalid/Zone" },
          { offsets: [-1] },
          { revision: task.revision + 1 },
        ])
          assert.equal(
            (
              await calendarClient.callTool({
                name: "set_task_reminders",
                arguments: { ...settings, ...patch },
              })
            ).isError,
            true,
          );
        await call(calendarClient, "set_task_reminders", {
          ...settings,
          offsets: [],
        });
        assert.deepEqual(
          (
            await call<{ reminders: { offsets: number[] }[] }>(
              reader,
              "get_task_reminders",
              { id: task.id },
            )
          ).reminders[0].offsets,
          [],
        );
        assert.equal(
          (
            await call(reader, "list_calendar_tasks", {
              mode: "overdue",
              date: "2026-10-08",
            })
          ).total,
          1,
        );
        await call(calendarClient, "update_task", {
          id: task.id,
          revision: task.revision,
          completed: true,
        });
        assert.equal(
          (
            await call(reader, "list_calendar_tasks", {
              mode: "overdue",
              date: "2026-10-08",
            })
          ).total,
          0,
        );
        const rangeInput = {
          from: "2026-10-06",
          to: "2026-10-09",
          timezone: "UTC",
        };
        const included = await call<{ items: { sourceId: string }[] }>(
          reader,
          "list_calendar",
          rangeInput,
        );
        const excluded = await call<{ items: { sourceId: string }[] }>(
          reader,
          "list_calendar",
          { ...rangeInput, includeCompleted: false },
        );
        assert.ok(included.items.some((item) => item.sourceId === task.id));
        assert.ok(!excluded.items.some((item) => item.sourceId === task.id));
        for (let i = 0; i < 51; i++)
          await call(calendarClient, "create_task", {
            title: `Undated pagination fixture ${i}`,
          });
        const first = await call<{
          items: { id: string }[];
          total: number;
          nextOffset: number;
        }>(reader, "list_calendar_tasks", {
          mode: "unscheduled",
          date: "2026-10-08",
        });
        assert.equal(first.total, 51);
        assert.equal(first.items.length, 50);
        assert.equal(first.nextOffset, 50);
        const second = await call<{
          items: { id: string }[];
          total: number;
          nextOffset: null;
        }>(reader, "list_calendar_tasks", {
          mode: "unscheduled",
          date: "2026-10-08",
          offset: first.nextOffset,
        });
        assert.equal(second.total, 51);
        assert.equal(second.items.length, 1);
        assert.equal(second.nextOffset, null);
        assert.ok(!first.items.some((item) => item.id === second.items[0].id));
        assert.equal(
          (
            await calendarClient.callTool({
              name: "list_calendar_tasks",
              arguments: { mode: "overdue", date: "2026-02-30" },
            })
          ).isError,
          true,
        );
        assert.equal(
          (
            await calendarClient.callTool({
              name: "get_task_reminders",
              arguments: { id: randomUUID() },
            })
          ).isError,
          true,
        );
        await human("ai-connections", {
          action: "revoke-key",
          id: calendarKey.id,
        });
      },
    );
    await t.test(
      "agents receive the instance origin and ready canonical public links",
      async () => {
        assert.ok(
          client.getInstructions()?.includes(`This Nivra instance is ${base}.`),
        );
        const instance = await call<{
          url: string;
          mcpUrl: string;
          routes: Record<string, string>;
        }>(client, "get_instance", {});
        assert.equal(instance.url, base);
        assert.equal(instance.mcpUrl, `${base}/mcp`);
        assert.equal(instance.routes.notes, "/notes");
        assert.equal(instance.routes.overview, "/overview");
        const note = await call<{ id: string; revision: number }>(
          client,
          "create_note",
          { title: "Exact public link", markdown: "Published through MCP." },
        );
        assert.equal(
          await call(client, "get_publication", { id: note.id }),
          null,
        );
        const publication = await call<{ url: string; token: string }>(
          client,
          "publish_note",
          { id: note.id, revision: note.revision },
        );
        assert.equal(publication.url, `${base}/share/${publication.token}`);
        assert.deepEqual(
          await call(client, "get_publication", { id: note.id }),
          publication,
        );
        assert.deepEqual(
          await human(`notes/${note.id}/publication`),
          publication,
        );
        const opened = await fetch(publication.url);
        assert.equal(opened.status, 200);
        assert.match(await opened.text(), /Exact public link/);
        await call(client, "revoke_publication", { id: note.id });
        assert.equal((await fetch(publication.url)).status, 404);
        assert.equal(
          await call(client, "get_publication", { id: note.id }),
          null,
        );
      },
    );
    await t.test(
      "legacy Streamable HTTP clients initialize and list tools without a session",
      async () => {
        const headers = {
          authorization: `Bearer ${fullKey}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "MCP-Protocol-Version": "2025-11-25",
        };
        const invoke = (body: unknown) =>
          fetch(`${base}/mcp`, {
            method: "POST",
            headers,
            body: JSON.stringify(body),
          });
        const initialized = await invoke({
          jsonrpc: "2.0",
          id: 71,
          method: "initialize",
          params: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: { name: "Legacy test", version: "1" },
          },
        });
        assert.equal(initialized.status, 200, await initialized.clone().text());
        assert.match(await initialized.text(), /2025-11-25/);
        const listed = await invoke({
          jsonrpc: "2.0",
          id: 72,
          method: "tools/list",
          params: {},
        });
        assert.equal(listed.status, 200);
        assert.match(await listed.text(), /create_note/);
      },
    );
    let note: import("../src/lib/types").Note,
      task: import("../src/lib/types").Task,
      artifact: import("../src/lib/types").Artifact,
      tag: import("../src/lib/types").Tag;
    await t.test(
      "rich notes, Markdown append, stable block edits, revision conflicts, and retries",
      async () => {
        const input = {
          title: "MCP knowledge",
          document: {
            schemaVersion: 1,
            blocks: [
              {
                id: "keep-drawing",
                type: "canvas",
                props: { scene: '{"elements":[]}' },
                children: [],
              },
              {
                id: "paragraph",
                type: "paragraph",
                content: [{ type: "text", text: "Original", styles: {} }],
              },
            ],
          },
          idempotencyKey: "create-note-test",
        };
        note = await call<import("../src/lib/types").Note>(
          client,
          "create_note",
          input,
        );
        assert.equal(
          (
            await call<import("../src/lib/types").Note>(
              client,
              "create_note",
              input,
            )
          ).id,
          note.id,
        );
        note = await call<import("../src/lib/types").Note>(
          client,
          "append_note",
          {
            id: note.id,
            revision: note.revision,
            markdown: "## Agent addition\n\n**Indexed knowledge**",
          },
        );
        assert.equal(note.document.blocks[0].id, "keep-drawing");
        assert.match(note.text, /Indexed knowledge/);
        const conflict = await client.callTool({
          name: "update_note",
          arguments: { id: note.id, revision: 1, title: "stale" },
        });
        assert.equal(conflict.isError, true);
        note = await call<import("../src/lib/types").Note>(
          client,
          "edit_note_blocks",
          {
            id: note.id,
            revision: note.revision,
            edits: [
              {
                blockId: "paragraph",
                block: {
                  type: "paragraph",
                  content: [{ type: "text", text: "Changed", styles: {} }],
                },
              },
            ],
          },
        );
        assert.equal(note.document.blocks[0].type, "canvas");
        const changed = await client.callTool({
          name: "create_note",
          arguments: { ...input, title: "different" },
        });
        assert.equal(changed.isError, true);
        assert.ok(
          (await call<unknown[]>(client, "search", { query: "knowledge" }))
            .length,
        );
      },
    );
    await t.test(
      "journals, tasks, tags, favorites, artifacts, and processing status",
      async () => {
        const journal = await call(client, "create_journal", {
          date: "2026-10-07",
          markdown: "Daily agent journal",
        });
        assert.equal(
          (await call(client, "get_journal", { date: "2026-10-07" })).id,
          journal.id,
        );
        assert.equal(
          (
            await client.callTool({
              name: "create_journal",
              arguments: { date: "2026-10-07", markdown: "overwrite" },
            })
          ).isError,
          true,
        );
        task = await call<import("../src/lib/types").Task>(
          client,
          "create_task",
          { title: "Agent task", dueDate: "2026-10-09" },
        );
        task = await call<import("../src/lib/types").Task>(
          client,
          "update_task",
          { id: task.id, revision: task.revision, completed: true },
        );
        assert.ok(task.completedAt);
        tag = await call<import("../src/lib/types").Tag>(client, "create_tag", {
          name: "agent-tag",
        });
        await call(client, "assign_tags", {
          id: note.id,
          type: "note",
          revision: note.revision,
          tags: [tag.id],
        });
        note = await call<import("../src/lib/types").Note>(client, "get_note", {
          id: note.id,
        });
        note = await call<import("../src/lib/types").Note>(
          client,
          "update_note",
          { id: note.id, revision: note.revision, favorite: true },
        );
        assert.ok(
          (
            await call<{ items: { id: string }[] }>(
              client,
              "list_favorites",
              {},
            )
          ).items.some((x) => x.id === note.id),
        );
        artifact = await call<import("../src/lib/types").Artifact>(
          client,
          "create_text_artifact",
          { text: "Indexed artifact content" },
        );
        assert.ok(
          (
            await call<import("../src/lib/types").ArtifactDetail>(
              client,
              "get_artifact",
              { id: artifact.id },
            )
          ).content.includes("Indexed"),
        );
        const artifactOwner = sqlite()
          .prepare("SELECT owner_id FROM artifacts WHERE id=?")
          .get(artifact.id) as { owner_id: string };
        sqlite()
          .prepare(
            "INSERT INTO background_jobs(id,owner_id,kind,target_id,state,attempts,available_at,created_at) VALUES(?,?,'article',?,'failed',1,?,?)",
          )
          .run(
            randomUUID(),
            artifactOwner.owner_id,
            artifact.id,
            Date.now(),
            Date.now(),
          );
        assert.equal(
          (
            await call<unknown[]>(client, "processing_status", {
              kind: "artifact",
              id: artifact.id,
            })
          ).length,
          0,
        );
        assert.ok(
          sqlite()
            .prepare("SELECT 1 FROM completion_events WHERE kind='content'")
            .get(),
        );
      },
    );
    await t.test(
      "exact inventory, schemas and pagination cover large collections and journals",
      async () => {
        const before = await call<{ counts: Record<string, number> }>(
          client,
          "count_items",
          {},
        );
        const ids = Array.from({ length: 65 }, () => randomUUID());
        const tag = await call(client, "create_tag", {
          name: "Paged MCP",
          color: "blue",
          aliases: ["library paging", "paged records"],
        });
        const updatedAliases = ["cursor pagination", "paged results"];
        await call(client, "update_tag", {
          id: tag.id,
          aliases: updatedAliases,
        });
        const reader = await connect(readKey);
        const visibleTags = await call<{
          items: {
            id: string;
            name: string;
            color: string;
            aliases?: string[];
          }[];
        }>(reader, "list_tags", { limit: 100 });
        assert.deepEqual(
          visibleTags.items.find((item) => item.id === tag.id),
          {
            id: tag.id,
            name: "Paged MCP",
            color: "blue",
            aliases: updatedAliases,
          },
        );
        sqlite().transaction(() => {
          for (const id of ids) {
            sqlite()
              .prepare(
                "INSERT INTO notes(id,owner_id,title,document,favorite,created_at,updated_at) VALUES(?,?,?,?,1,?,?)",
              )
              .run(
                id,
                owner,
                "Paged fixture",
                JSON.stringify({ schemaVersion: 1, blocks: [] }),
                Date.now(),
                Date.now(),
              );
            sqlite()
              .prepare("INSERT INTO note_tags(note_id,tag_id) VALUES(?,?)")
              .run(id, tag.id);
          }
        })();
        const journal = await call(client, "create_journal", {
          date: "2042-03-04",
          markdown: "Journal fixture",
        });
        const journalTags = await call(client, "item_tags", {
          type: "journal",
          id: journal.id,
        });
        await call(client, "assign_tags", {
          type: "journal",
          id: journal.id,
          revision: journalTags.revision,
          tags: [tag.id],
        });
        const counts = await call<{ counts: Record<string, number> }>(
          client,
          "count_items",
          {},
        );
        assert.equal(counts.counts.notes, before.counts.notes + 65);
        assert.equal(counts.counts.journals, before.counts.journals + 1);
        const page = await call<{
          items: { id: string; type: string }[];
          nextOffset: number | null;
        }>(client, "tagged_items", { id: tag.id, limit: 50 });
        assert.equal(page.items.length, 50);
        assert.equal(page.nextOffset, 50);
        const rest = await call<{
          items: { id: string; type: string }[];
          nextOffset: number | null;
        }>(client, "tagged_items", {
          id: tag.id,
          limit: 50,
          offset: page.nextOffset,
        });
        assert.equal(rest.items.length, 16);
        assert.equal(rest.nextOffset, null);
        assert.equal(
          new Set([...page.items, ...rest.items].map((i) => i.id)).size,
          66,
        );
        assert.ok(
          [...page.items, ...rest.items].some(
            (i) => i.id === journal.id && i.type === "journal",
          ),
        );
        const search = await call<{ id: string; type: string }[]>(
          client,
          "search",
          { query: "type:journal Journal fixture" },
        );
        assert.ok(
          search.some((i) => i.id === journal.id && i.type === "journal"),
        );
        const renamed = await call(client, "update_tag", {
          id: tag.id,
          name: "Renamed MCP",
        });
        assert.equal(renamed.color, "blue");
        const matches = await call<{
          items: { id: string }[];
          total: number;
          nextOffset: number | null;
        }>(client, "search_items", {
          query: 'type:note tag:"Renamed MCP" Paged',
          limit: 50,
        });
        assert.equal(matches.total, 65);
        assert.equal(matches.items.length, 50);
        assert.equal(matches.nextOffset, 50);
        const remaining = await call<{
          items: { id: string }[];
          total: number;
          nextOffset: number | null;
        }>(client, "search_items", {
          query: 'type:note tag:"Renamed MCP" Paged',
          limit: 50,
          offset: matches.nextOffset,
        });
        assert.equal(remaining.items.length, 15);
        assert.equal(remaining.total, 65);
        assert.equal(remaining.nextOffset, null);
        const malformed = await client.callTool({
          name: "update_note",
          arguments: { id: note.id, revision: note.revision },
        });
        assert.equal(malformed.isError, true);
        const missing = await client.callTool({
          name: "file_transfer",
          arguments: { target: "attachment" },
        });
        assert.equal(missing.isError, true);
        const catalog = (await client.listTools()).tools;
        assert.ok(
          catalog.find((t) => t.name === "count_items")?.outputSchema
            ?.properties,
        );
        sqlite().transaction(() => {
          for (const id of [...ids, String(journal.id)])
            sqlite()
              .prepare("DELETE FROM notes WHERE id=? AND owner_id=?")
              .run(id, owner);
          sqlite().prepare("DELETE FROM tags WHERE id=?").run(tag.id);
        })();
      },
    );
    await t.test("file upload and authenticated binary transfer", async () => {
      const bookmarkId = randomUUID();
      sqlite()
        .prepare(
          "INSERT INTO bookmarks(id,owner_id,url,title,created_at,updated_at) VALUES(?,?,?,?,?,?)",
        )
        .run(
          bookmarkId,
          owner,
          "https://bookmark.example/contract",
          "Contract bookmark",
          Date.now(),
          Date.now(),
        );
      assert.equal(
        (await call(client, "get_bookmark", { id: bookmarkId })).favorite,
        false,
      );
      await call(client, "update_bookmark", {
        id: bookmarkId,
        revision: 1,
        favorite: true,
      });
      assert.equal(
        (await call(client, "get_bookmark", { id: bookmarkId })).favorite,
        true,
      );
      const attachment = await call(client, "upload_file", {
        target: "attachment",
        noteId: note.id,
        name: "agent-note.txt",
        mime: "text/plain",
        base64: Buffer.from("Agent attachment").toString("base64"),
      });
      const attachmentTransfer = await call(client, "file_transfer", {
        target: "attachment",
        id: attachment.id,
      });
      assert.equal(
        await (
          await fetch(String(attachmentTransfer.url), {
            headers: { authorization: `Bearer ${fullKey}` },
          })
        ).text(),
        "Agent attachment",
      );
      const bundle = await call(client, "file_transfer", {
        target: "export-bundle",
      });
      const exported = await fetch(String(bundle.url), {
        headers: { authorization: `Bearer ${fullKey}` },
      });
      assert.equal(exported.status, 200);
      assert.ok(exported.headers.get("content-type")?.includes("zip"));
      const upload = await call(client, "upload_transfer", {
        target: "upload-attachment",
        noteId: note.id,
      });
      assert.equal(upload.method, "POST");
      assert.deepEqual(upload.fields, { note: note.id });
      const file = await call(client, "upload_file", {
        target: "artifact",
        name: "agent.txt",
        mime: "text/plain",
        base64: Buffer.from("Agent file").toString("base64"),
      });
      const transfer = await call(client, "file_transfer", {
        target: "artifact",
        id: file.id,
      });
      const r = await fetch(String(transfer.url), {
        headers: { authorization: `Bearer ${fullKey}` },
      });
      assert.equal(r.status, 200);
      assert.equal(await r.text(), "Agent file");
      assert.equal((await fetch(String(transfer.url))).status, 401);
    });
    await t.test(
      "read-only credentials cannot call writes and bad origins are denied",
      async () => {
        const reader = await connect(readKey);
        assert.ok(
          !(await reader.listTools()).tools.some(
            (tool) => tool.name === "upload_transfer",
          ),
        );
        assert.equal((await call(reader, "count_items", {})).exact, true);
        assert.ok(
          !(await reader.listTools()).tools.some(
            (x) => x.name === "purge_item",
          ),
        );
        assert.equal(
          (await call(reader, "get_note", { id: note.id })).id,
          note.id,
        );
        const write = await fetch(`${base}/mcp`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${readKey}`,
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "MCP-Protocol-Version": "2025-11-25",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name: "create_note", arguments: { title: "denied" } },
          }),
        });
        assert.equal(write.status, 403);
        const invalid = await fetch(`${base}/mcp`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${fullKey}`,
            origin: "https://untrusted.invalid",
          },
        });
        assert.equal(invalid.status, 403);
      },
    );
    await t.test(
      "agents can list Trash but cannot restore, purge, or change deleted items",
      async () => {
        const catalog = (await client.listTools()).tools.map(
          (tool) => tool.name,
        );
        assert.ok(!catalog.includes("restore_item"));
        assert.ok(!catalog.includes("purge_item"));
        await call(client, "trash_item", {
          id: task.id,
          kind: "task",
          revision: task.revision,
        });
        const trashed = (
          await call<{ items: import("../src/lib/types").TrashItem[] }>(
            client,
            "list_trash",
            {},
          )
        ).items.find((item) => item.id === task.id);
        assert.ok(trashed);
        const { handleWorkspace } =
          await import("../src/lib/server/workspace-api");
        const principal = {
          ownerId: owner,
          connectionId: "test",
          scopes: ["nivra:read", "nivra:write"],
        };
        const invoke = (path: string, method: string, body: unknown) =>
          handleWorkspace(
            new Request(`${base}/api/v1/${path}`, {
              method,
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            }),
            { params: Promise.resolve({ path: path.split("/") }) },
            principal,
          );
        for (const method of ["POST", "DELETE"])
          assert.equal(
            (
              await invoke(`trash/task/${task.id}`, method, {
                revision: trashed.revision,
              })
            ).status,
            403,
          );
        assert.equal(
          (
            await invoke(`tasks/${task.id}`, "PATCH", {
              revision: trashed.revision,
              title: "denied",
            })
          ).status,
          403,
        );
        const deletedNote = await call<import("../src/lib/types").Note>(
          client,
          "create_note",
          {
            title: "Deleted guard fixture",
          },
        );
        await call(client, "trash_item", {
          id: deletedNote.id,
          kind: "note",
          revision: deletedNote.revision,
        });
        for (const body of [{ title: "denied" }, { trashed: false }])
          assert.equal(
            (
              await invoke(`notes/${deletedNote.id}`, "PATCH", {
                revision: deletedNote.revision + 1,
                ...body,
              })
            ).status,
            403,
          );
        assert.equal(
          (await invoke(`notes/${deletedNote.id}`, "DELETE", {})).status,
          403,
        );
        assert.equal(
          (
            sqlite()
              .prepare(
                "SELECT title FROM notes WHERE id=? AND trashed_at IS NOT NULL",
              )
              .get(deletedNote.id) as { title: string } | undefined
          )?.title,
          "Deleted guard fixture",
        );
        const reader = await connect(readKey);
        assert.ok(
          (
            await call<{ items: import("../src/lib/types").TrashItem[] }>(
              reader,
              "list_trash",
              {},
            )
          ).items.some((item) => item.id === deletedNote.id),
        );
        const restored = await fetch(
          `${base}/api/v1/trash/task/${task.id}/restore`,
          {
            method: "POST",
            headers: {
              cookie,
              origin: base,
              "content-type": "application/json",
            },
            body: JSON.stringify({ revision: trashed.revision }),
          },
        );
        assert.equal(
          restored.status,
          200,
          "Human restoration must remain available",
        );
        const purged = await fetch(
          `${base}/api/v1/trash/note/${deletedNote.id}`,
          {
            method: "DELETE",
            headers: {
              cookie,
              origin: base,
              "content-type": "application/json",
            },
            body: JSON.stringify({ revision: deletedNote.revision + 1 }),
          },
        );
        assert.equal(
          purged.status,
          200,
          "Human permanent deletion must remain available",
        );
      },
    );
    await t.test(
      "OAuth discovery, PKCE, consent, JWT audience and immediate revocation",
      async () => {
        const metadata = await (
          await fetch(`${base}/.well-known/oauth-authorization-server/api/auth`)
        ).json();
        assert.equal(metadata.issuer, `${base}/api/auth`);
        assert.ok(metadata.code_challenge_methods_supported.includes("S256"));
        assert.equal(
          metadata.registration_endpoint,
          `${base}/api/auth/oauth2/register`,
        );
        assert.equal(metadata.client_id_metadata_document_supported, true);
        const removed = await fetch(`${base}/api/v1/ai-connections`, {
          method: "POST",
          headers: { cookie, origin: base, "content-type": "application/json" },
          body: JSON.stringify({
            action: "create-client",
            name: "Removed form",
            redirectUri: "http://localhost:9999/callback",
            public: true,
          }),
        });
        assert.equal(removed.status, 400);
        const registration = await fetch(metadata.registration_endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            client_name: "DCR public client",
            redirect_uris: ["http://localhost:9999/callback"],
            token_endpoint_auth_method: "none",
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"],
            scope: "nivra:read nivra:write offline_access",
          }),
        });
        assert.equal(
          registration.status,
          201,
          await registration.clone().text(),
        );
        const c = await registration.json();
        assert.equal(c.client_secret, undefined);
        assert.equal(c.application_type, "native");
        const registrationHeaders = { "content-type": "application/json" };
        const register = (body: unknown) =>
          fetch(metadata.registration_endpoint, {
            method: "POST",
            headers: registrationHeaders,
            body: JSON.stringify(body),
          });
        const confidential = await register({
          client_name: "DCR confidential client",
          redirect_uris: ["https://client.example/callback"],
          token_endpoint_auth_method: "client_secret_post",
        });
        assert.equal(confidential.status, 201);
        const confidentialClient = await confidential.json();
        assert.ok(confidentialClient.client_secret);
        const { auth } = await import("../src/lib/server/auth");
        for (const input of [
          { redirect_uris: ["http://private.example/callback"] },
          { redirect_uris: ["https://client.example/callback#fragment"] },
          {
            redirect_uris: ["https://client.example/callback"],
            grant_types: ["client_credentials"],
          },

          {
            redirect_uris: ["https://client.example/callback"],
            require_pkce: false,
          },
        ])
          assert.equal((await register(input)).status, 400);
        await assert.rejects(
          auth(new Request(base)).api.registerOAuthClient({
            body: {
              redirect_uris: ["https://client.example/callback"],
              scope: "admin",
            },
          }),
          (error: unknown) =>
            (error as { body?: { error?: string } }).body?.error ===
            "invalid_scope",
        );
        assert.equal(
          (
            await register({
              redirect_uris: ["https://client.example/callback"],
            })
          ).status,
          429,
        );
        const oversized = await register({
          client_name: "x".repeat(17000),
          redirect_uris: ["https://client.example/callback"],
        });
        assert.equal(oversized.status, 413);
        assert.equal(
          (
            await fetch(`${base}/mcp`, {
              method: "POST",
              headers: { authorization: `Bearer ${c.client_id}` },
            })
          ).status,
          401,
        );
        assert.ok(c.client_id);
        const verifier = randomUUID() + randomUUID();
        const challenge = createHash("sha256")
          .update(verifier)
          .digest("base64url");
        const query = new URLSearchParams({
          client_id: c.client_id,
          redirect_uri: "http://localhost:9999/callback",
          response_type: "code",
          scope: "nivra:read nivra:write offline_access",
          resource: `${base}/mcp`,
          state: "test",
          code_challenge: challenge,
          code_challenge_method: "S256",
        });
        const noPkce = new URLSearchParams(query);
        noPkce.delete("code_challenge");
        noPkce.delete("code_challenge_method");
        const deniedPkce = await fetch(
          `${base}/api/auth/oauth2/authorize?${noPkce}`,
          { headers: { cookie, accept: "text/html" }, redirect: "manual" },
        );
        assert.ok(
          deniedPkce.status >= 400 ||
            (deniedPkce.headers.get("location") || "").includes("error="),
          `Public clients must use PKCE (${deniedPkce.status}, ${await deniedPkce.clone().text()})`,
        );
        if (deniedPkce.status >= 300 && deniedPkce.status < 400) {
          const pkceError = new URL(deniedPkce.headers.get("location")!, base);
          assert.equal(pkceError.pathname, "/callback");
          assert.equal(pkceError.searchParams.get("error"), "invalid_request");
          assert.equal(pkceError.searchParams.has("code"), false);
        }
        const missingClient = new URLSearchParams(query);
        missingClient.delete("client_id");
        const missingClientResponse = await fetch(
          `${base}/api/auth/oauth2/authorize?${missingClient}`,
          { headers: { accept: "text/html" }, redirect: "manual" },
        );
        assert.equal(missingClientResponse.status, 302);
        const missingClientLocation = new URL(
          missingClientResponse.headers.get("location")!,
          base,
        );
        assert.equal(missingClientLocation.origin, base);
        assert.equal(missingClientLocation.pathname, "/oauth/error");
        assert.equal(
          missingClientLocation.searchParams.get("error"),
          "invalid_request",
        );
        assert.equal(
          missingClientLocation.searchParams.has("client_id"),
          false,
        );
        const unknownClient = new URLSearchParams(query);
        unknownClient.set("client_id", "unregistered-oauth-error-fixture");
        const unknownClientResponse = await fetch(
          `${base}/api/auth/oauth2/authorize?${unknownClient}`,
          { headers: { accept: "text/html" }, redirect: "manual" },
        );
        assert.equal(unknownClientResponse.status, 302);
        const unknownClientLocation = new URL(
          unknownClientResponse.headers.get("location")!,
          base,
        );
        assert.equal(unknownClientLocation.origin, base);
        assert.equal(unknownClientLocation.pathname, "/oauth/error");
        assert.equal(
          unknownClientLocation.searchParams.get("error"),
          "invalid_client",
        );
        assert.equal(
          unknownClientLocation.searchParams.has("client_id"),
          false,
        );
        const badRedirect = new URLSearchParams(query);
        badRedirect.set("redirect_uri", "https://attacker.example/callback");
        const deniedRedirect = await fetch(
          `${base}/api/auth/oauth2/authorize?${badRedirect}`,
          { headers: { cookie, accept: "text/html" }, redirect: "manual" },
        );
        assert.ok(
          deniedRedirect.status >= 400 ||
            (deniedRedirect.headers.get("location") || "").includes("error="),
        );
        const loginRedirect = await fetch(
          `${base}/api/auth/oauth2/authorize?${query}`,
          { headers: { accept: "text/html" }, redirect: "manual" },
        );
        assert.equal(loginRedirect.status, 302);
        const loginUrl = new URL(loginRedirect.headers.get("location")!, base);
        assert.equal(loginUrl.pathname, "/oauth/login");
        const resume = await fetch(`${base}/api/auth/oauth2/continue`, {
          method: "POST",
          headers: { cookie, origin: base, "content-type": "application/json" },
          body: JSON.stringify({
            oauth_query: loginUrl.search.slice(1),
            postLogin: true,
          }),
        });
        assert.equal(resume.status, 200, await resume.clone().text());
        const resumed = await resume.json();
        assert.equal(
          new URL(resumed.url || resumed.redirect_uri, base).pathname,
          "/oauth/consent",
        );
        const login = await fetch(`${base}/api/auth/sign-in/username`, {
          method: "POST",
          headers: { origin: base, "content-type": "application/json" },
          body: JSON.stringify({
            username: "mcptester",
            password,
            oauth_query: loginUrl.search.slice(1),
          }),
        });
        assert.equal(login.status, 200, await login.clone().text());
        const loggedIn = await login.json();
        assert.equal(
          new URL(loggedIn.url || loggedIn.redirect_uri, base).pathname,
          "/oauth/consent",
        );
        assert.ok(
          login.headers
            .getSetCookie()
            .some((s) => s.includes("session_token=")),
        );
        const authorize = await fetch(
          `${base}/api/auth/oauth2/authorize?${query}`,
          { headers: { cookie, accept: "text/html" }, redirect: "manual" },
        );
        assert.equal(authorize.status, 302, await authorize.clone().text());
        const consentUrl = new URL(authorize.headers.get("location")!, base);
        assert.equal(consentUrl.pathname, "/oauth/consent");
        const approved = await fetch(`${base}/api/auth/oauth2/consent`, {
          method: "POST",
          headers: { cookie, origin: base, "content-type": "application/json" },
          body: JSON.stringify({
            accept: true,
            scope: "nivra:read offline_access",
            oauth_query: consentUrl.search.slice(1),
          }),
        });
        assert.ok(approved.ok, await approved.clone().text());
        const consentResult = await approved.json();
        const code = new URL(
          consentResult.redirect_uri || consentResult.url,
        ).searchParams.get("code")!;
        const tokenResponse = await fetch(`${base}/api/auth/oauth2/token`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            client_id: c.client_id,
            code,
            code_verifier: verifier,
            redirect_uri: "http://localhost:9999/callback",
            resource: `${base}/mcp`,
          }),
        });
        assert.ok(tokenResponse.ok, await tokenResponse.clone().text());
        const token = await tokenResponse.json();
        assert.ok(token.access_token);
        const { decodeJwt } = await import("jose");
        assert.deepEqual([decodeJwt(token.access_token).aud].flat(), [
          `${base}/mcp`,
        ]);
        assert.ok(
          !String(decodeJwt(token.access_token).scope).includes("nivra:write"),
        );

        const directApi = await fetch(`${base}/api/v1/notes`, {
          headers: { authorization: `Bearer ${token.access_token}` },
        });
        assert.equal(
          directApi.status,
          401,
          "MCP OAuth tokens must not authorize the direct content API",
        );
        const oauth = await connect(token.access_token);
        const oauthBoards = await call<{ items: unknown[] }>(
          oauth,
          "list_boards",
          {},
        );
        assert.ok(Array.isArray(oauthBoards.items));
        assert.ok(
          !(await oauth.listTools()).tools.some((t) => t.name === "move_task"),
        );
        assert.equal(
          (await call(oauth, "get_note", { id: note.id })).id,
          note.id,
        );
        const fileQuestion = randomUUID();
        const fileForm = await call<{ id: string; revision: number }>(
          client,
          "create_form",
          {
            definition: {
              schemaVersion: 1,
              title: "OAuth attachments",
              fields: [
                {
                  id: fileQuestion,
                  type: "file",
                  label: "Document",
                  fileTypes: ["document"],
                },
              ],
            },
          },
        );
        const filePublication = await call<{
          publicToken: string;
          publishedVersionId: string;
        }>(client, "publish_form", {
          id: fileForm.id,
          revision: fileForm.revision,
        });
        const fileSession = await human(
          `public/forms/${filePublication.publicToken}/sessions`,
          { versionId: filePublication.publishedVersionId },
        );
        const bytes = Buffer.from("OAuth form file");
        const reserved = await human(
          `public/forms/${filePublication.publicToken}/uploads`,
          {
            secret: fileSession.secret,
            fieldId: fileQuestion,
            filename: "oauth.txt",
            size: bytes.length,
          },
        );
        const uploaded = await fetch(
          `${base}/api/v1/public/forms/${filePublication.publicToken}/uploads/${reserved.id}`,
          {
            method: "PUT",
            headers: {
              origin: base,
              "X-Form-Upload": fileSession.secret,
              "content-type": "application/octet-stream",
            },
            body: bytes,
          },
        );
        assert.equal(uploaded.status, 200);
        const submitted = await human(
          `public/forms/${filePublication.publicToken}/responses`,
          {
            versionId: filePublication.publishedVersionId,
            retryKey: randomUUID(),
            uploadSecret: fileSession.secret,
            answers: { [fileQuestion]: [reserved.id] },
          },
        );
        const oauthResponse = await call<{ files: { url: string }[] }>(
          oauth,
          "get_form_response",
          { formId: fileForm.id, responseId: submitted.id },
        );
        assert.equal(
          oauthResponse.files[0].url,
          `${base}/mcp/files/form-file/${fileForm.id}/${reserved.id}`,
        );
        const transfer = await call<{ url: string }>(oauth, "file_transfer", {
          target: "form-file",
          formId: fileForm.id,
          id: reserved.id,
        });
        assert.equal(transfer.url, oauthResponse.files[0].url);
        assert.equal((await fetch(transfer.url)).status, 401);
        const downloaded = await fetch(transfer.url, {
          headers: { authorization: `Bearer ${token.access_token}` },
        });
        assert.equal(downloaded.status, 200);
        assert.equal(await downloaded.text(), bytes.toString());
        const exportTransfer = await call<{ url: string }>(
          oauth,
          "file_transfer",
          {
            target: "form-export",
            formId: fileForm.id,
            format: "json",
            reviewed: "new",
          },
        );
        const exported = await fetch(exportTransfer.url, {
          headers: { authorization: `Bearer ${token.access_token}` },
        });
        assert.equal(exported.status, 200);
        const exportedResponses = await exported.json();
        assert.equal(exportedResponses.length, 1);
        assert.equal(exportedResponses[0].id, submitted.id);
        assert.equal(exportedResponses[0].files[0].id, reserved.id);
        sqlite()
          .prepare("INSERT OR REPLACE INTO agent_rate_limits VALUES(?,?,?)")
          .run(`oauth:${c.client_id}`, Date.now(), 120);
        const limited = await fetch(`${base}/mcp`, {
          method: "POST",
          headers: { authorization: `Bearer ${token.access_token}` },
        });
        assert.equal(limited.status, 429);
        assert.equal(limited.headers.get("retry-after"), "60");
        const startedAt = Date.now() - 1;
        revokeOAuth(owner, c.client_id);
        const { captureOAuthToken } =
          await import("../src/lib/server/agent-auth");
        const late = await captureOAuthToken(
          new Request(`${base}/api/auth/oauth2/token`, { method: "POST" }),
          Response.json(token),
          startedAt,
        );
        assert.equal(late.status, 400);
        const revoked = await fetch(`${base}/mcp`, {
          method: "POST",
          headers: { authorization: `Bearer ${token.access_token}` },
        });
        assert.equal(revoked.status, 401);
        const refreshed = await fetch(`${base}/api/auth/oauth2/token`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            client_id: c.client_id,
            refresh_token: token.refresh_token,
            resource: `${base}/mcp`,
          }),
        });
        assert.equal(refreshed.status, 400);
      },
    );
    await t.test(
      "agent keys, signing keys, grants and token revocations survive encrypted backup recovery",
      async () => {
        const backups = await import("../src/lib/server/backups");
        const backup = await backups.createBackup();
        await backups.verifyBackup(backup.id);
        const target = `${directory}/restored`;
        await backups.restoreBackup(backup.id, target);
        const { default: Database } = await import("better-sqlite3");
        const { deriveKey, masterKey } =
          await import("../src/lib/server/encryption");
        const restored = new Database(`${target}/nivra.sqlite`);
        try {
          restored.pragma("cipher = 'chacha20'");
          restored.pragma(
            `key = '${deriveKey(masterKey(directory), "sqlite").toString("hex")}'`,
          );
          assert.equal(
            restored.pragma("integrity_check", { simple: true }),
            "ok",
          );
          for (const table of [
            "apikey",
            "jwks",
            "oauth_client",
            "agent_revocations",
            "agent_idempotency",
          ])
            assert.deepEqual(
              restored.prepare(`SELECT count(*) AS count FROM ${table}`).get(),
              sqlite().prepare(`SELECT count(*) AS count FROM ${table}`).get(),
            );
        } finally {
          restored.close();
        }
      },
    );
    await t.test("API key revocation is immediate", async () => {
      const stored = sqlite()
        .prepare("SELECT id FROM apikey WHERE name='Read test'")
        .get() as { id: string };
      await human("ai-connections", { action: "revoke-key", id: stored.id });
      assert.equal(
        (
          await fetch(`${base}/mcp`, {
            method: "POST",
            headers: { authorization: `Bearer ${readKey}` },
          })
        ).status,
        401,
      );
    });
  } finally {
    for (const c of clients) await c.close();
    const { stopJobWorker } = await import("../src/lib/server/jobs");
    await stopJobWorker();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    sqlite().close();
    await rm(directory, { recursive: true, force: true });
  }
});
