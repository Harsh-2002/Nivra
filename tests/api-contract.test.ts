import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { test } from "node:test";

test("empty streamed JSON bodies are optional only at content boundaries", async () => {
  const { json, HttpError } = await import("../src/lib/server/http");
  const request = (text = "", length?: number) =>
    new Request("http://localhost:3000/api/v1/tags/test", {
      method: "DELETE",
      body: new TextEncoder().encode(text),
      headers: length === undefined ? {} : { "content-length": String(length) },
    });
  assert.ok(request().body);
  assert.equal(await json(request(), true), undefined);
  await assert.rejects(
    json(request()),
    (error: unknown) => error instanceof HttpError && error.status === 400,
  );
  await assert.rejects(
    json(request(" "), true),
    (error: unknown) => error instanceof HttpError && error.status === 400,
  );
  await assert.rejects(
    json(request("", 8 * 1024 * 1024 + 1), true),
    (error: unknown) => error instanceof HttpError && error.status === 413,
  );
  assert.deepEqual(await json(request("{}"), true), {});
});

test("versioned media migration preserves content, history and published attachment references", async () => {
  const db = new Database(":memory:");
  try {
    for (const file of (await readdir("migrations"))
      .filter((name) => name.endsWith(".sql") && name < "0035")
      .sort())
      db.exec(await readFile(path.join("migrations", file), "utf8"));
    db.exec(
      "INSERT INTO user(id,name,email,username,created_at,updated_at) VALUES('owner','Owner','owner@local.invalid','owner',1,1)",
    );
    const document = JSON.stringify({
      schemaVersion: 1,
      blocks: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Keep /api/nivra/files/written-prose" },
          ],
        },
        { type: "image", props: { url: "/api/nivra/files/attachment" } },
      ],
    });
    db.prepare(
      "INSERT INTO notes(id,owner_id,title,document,text,created_at,updated_at,revision) VALUES('note','owner','Kept',?,'Kept',1,1,7)",
    ).run(document);
    db.prepare(
      "INSERT INTO note_versions VALUES('version','note','Kept',?,6,1)",
    ).run(document);
    db.prepare(
      "INSERT INTO publications VALUES('token','note','Kept',?,'Kept',7,1)",
    ).run(document);
    db.exec(
      "INSERT INTO publication_pages VALUES('token','old HTML','old renderer')",
    );
    const before = db.prepare("SELECT * FROM notes").get() as Record<
      string,
      unknown
    >;
    db.exec(
      await readFile("migrations/0035_versioned_media_routes.sql", "utf8"),
    );
    const after = db.prepare("SELECT * FROM notes").get() as Record<
      string,
      unknown
    >;
    assert.equal(after.revision, 8);
    assert.deepEqual(
      { ...after, document: before.document, revision: before.revision },
      before,
    );
    assert.equal(
      JSON.parse(after.document as string).blocks[1].props.url,
      "/api/v1/files/attachment",
    );
    assert.equal(
      JSON.parse(after.document as string).blocks[0].content[0].text,
      "Keep /api/nivra/files/written-prose",
    );
    for (const table of ["note_versions", "publications"]) {
      const row = db
        .prepare(`SELECT document,revision FROM ${table}`)
        .get() as { document: string; revision: number };
      assert.equal(
        JSON.parse(row.document).blocks[1].props.url,
        "/api/v1/files/attachment",
      );
      assert.equal(row.revision, table === "note_versions" ? 6 : 7);
    }
    assert.equal(
      (
        db.prepare("SELECT count(*) AS n FROM publication_pages").get() as {
          n: number;
        }
      ).n,
      0,
    );
    assert.equal(db.pragma("integrity_check", { simple: true }), "ok");
    assert.deepEqual(db.pragma("foreign_key_check"), []);
  } finally {
    db.close();
  }
});

test("actual v1 routes enforce schemas, scoped credentials, pagination, conflicts and retries", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "nivra-api-contract-"));
  process.env.NIVRA_DATA_DIR = directory;
  const { GET } = await import("../src/app/api/v1/[...path]/route");
  const { apiOperations, openApiDocument } =
    await import("../src/lib/server/api-contract");
  const { apiOutputs } = await import("../src/lib/server/api-schemas");
  const { sqlite } = await import("../src/lib/server/db");
  let cookie = "";
  async function call(
    route: string,
    method = "GET",
    input?: unknown,
    token?: string,
    headers: Record<string, string> = {},
  ) {
    return GET(
      new Request("http://localhost:3000/api/v1/" + route, {
        method,
        headers: {
          host: "localhost:3000",
          origin: "http://localhost:3000",
          "content-type": "application/json",
          ...(token ? { authorization: "Bearer " + token } : { cookie }),
          ...headers,
        },
        body:
          input === undefined
            ? method !== "GET"
              ? new Uint8Array()
              : undefined
            : JSON.stringify(input),
      }),
      { params: Promise.resolve({ path: route.split("?")[0].split("/") }) },
    );
  }
  async function body(response: Response, status = 200) {
    const value = await response.json();
    assert.equal(response.status, status, JSON.stringify(value));
    return value;
  }
  try {
    assert.equal((await call("openapi.json")).status, 404);
    const setup = await call("setup", "POST", {
      name: "Contract Owner",
      username: "contract",
      password: "Test-" + randomUUID(),
    });
    cookie = setup.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    await body(setup);
    assert.ok(cookie);
    const emptyBodyTag = await body(
      await call("tags", "POST", {
        name: "Empty body deletion",
        color: "gray",
      }),
      201,
    );
    await body(await call("tags/" + emptyBodyTag.id, "DELETE"));
    assert.equal((await call("tags/" + emptyBodyTag.id)).status, 404);
    assert.equal((await call("notes", "POST")).status, 400);
    assert.equal(
      new Set(apiOperations.map((value) => value.method + value.path)).size,
      apiOperations.length,
    );
    assert.ok(openApiDocument().paths["/api/v1/notes"]);
    assert.equal(openApiDocument().paths["/api/v1/openapi.json"], undefined);
    for (const [route, token] of [
      ["/api/v1/published/{token}", "a".repeat(48)],
      ["/api/v1/public/forms/{token}", "A".repeat(32)],
    ]) {
      const parameters = (
        openApiDocument().paths[route].get as {
          parameters: { name: string; schema: { pattern: string } }[];
        }
      ).parameters;
      const pattern = parameters.find((entry) => entry.name === "token")!.schema
        .pattern;
      assert.match(token, new RegExp(pattern));
      assert.equal(new RegExp(pattern).test(token + "a"), false);
    }
    assert.equal((await call("openapi.json")).status, 404);
    const noteParameters = (
      openApiDocument().paths["/api/v1/notes"].get as {
        parameters: {
          name: string;
          required: boolean;
          schema: { default?: number };
        }[];
      }
    ).parameters;
    assert.equal(
      noteParameters.find((parameter) => parameter.name === "limit")?.required,
      false,
    );
    assert.equal(
      noteParameters.find((parameter) => parameter.name === "limit")?.schema
        .default,
      60,
    );
    assert.equal((await call("unknown")).status, 404);
    assert.equal((await call("notes", "PUT", {})).status, 405);
    assert.equal((await call("notes?limit=101")).status, 400);
    assert.equal((await call("notes?limit=2&limit=3")).status, 400);
    assert.equal((await call("notes?unsupported=true")).status, 400);
    const read = await body(
      await call("ai-connections", "POST", {
        action: "create-key",
        name: "Read",
        access: "read",
      }),
      201,
    );
    const write = await body(
      await call("ai-connections", "POST", {
        action: "create-key",
        name: "Write",
        access: "full",
      }),
      201,
    );
    const failure = await body(
      await call("notes", "POST", { title: "Denied" }, read.key),
      403,
    );
    assert.ok(apiOutputs.error.safeParse(failure).success);
    for (const route of ["settings", "system", "backups", "ai-connections"])
      assert.equal(
        (await call(route, "GET", undefined, write.key)).status,
        403,
      );
    assert.equal(
      (await call("notes", "GET", undefined, "invalid-key")).status,
      401,
    );
    assert.equal(
      (
        await call("notes", "POST", { title: "Cross origin" }, write.key, {
          origin: "https://other.invalid",
        })
      ).status,
      403,
    );
    const retry = { "Idempotency-Key": "contract-retry-001" };
    const first = await body(
      await call(
        "notes",
        "POST",
        { title: "Contract needle" },
        write.key,
        retry,
      ),
      201,
    );
    assert.ok(apiOutputs.note.safeParse(first).success);
    const again = await body(
      await call(
        "notes",
        "POST",
        { title: "Contract needle" },
        write.key,
        retry,
      ),
      201,
    );
    assert.equal(again.id, first.id);
    assert.equal(
      (await call("notes", "POST", { title: "Different" }, write.key, retry))
        .status,
      409,
    );
    for (let index = 0; index < 4; index++)
      await body(
        await call(
          "notes",
          "POST",
          { title: "Contract needle " + index },
          write.key,
        ),
        201,
      );
    const page = await body(
      await call("notes?limit=2", "GET", undefined, read.key),
    );
    assert.equal(page.items.length, 2);
    assert.ok(page.next);
    const second = await body(
      await call(
        "notes?limit=2&after=" + encodeURIComponent(page.next),
        "GET",
        undefined,
        read.key,
      ),
    );
    assert.equal(second.items.length, 2);
    assert.ok(second.next);
    const last = await body(
      await call(
        "notes?limit=2&after=" + encodeURIComponent(second.next),
        "GET",
        undefined,
        read.key,
      ),
    );
    assert.equal(last.items.length, 1);
    assert.equal(last.next, null);
    assert.equal(
      (await call("notes?limit=3&after=" + encodeURIComponent(page.next)))
        .status,
      400,
    );
    const counts = await body(await call("counts", "GET", undefined, read.key));
    assert.equal(counts.counts.notes, 5);
    const search = await body(
      await call("search?q=needle&limit=2", "GET", undefined, read.key),
    );
    assert.equal(search.total, 5);
    assert.equal(search.items.length, 2);
    assert.ok(search.next);
    await body(
      await call(
        "notes/" + first.id,
        "PATCH",
        { revision: first.revision, title: "Changed" },
        write.key,
      ),
    );
    assert.equal(
      (
        await call(
          "notes/" + first.id,
          "PATCH",
          { revision: first.revision, title: "Stale" },
          write.key,
        )
      ).status,
      409,
    );
    await body(
      await call("notes/" + first.id, "DELETE", { revision: 2 }, write.key),
    );
    const trash = await body(await call("trash", "GET", undefined, read.key));
    assert.equal(trash.items.length, 1);
    for (const [route, method, input] of [
      ["trash/note/" + first.id + "/restore", "POST", { revision: 3 }],
      ["trash/note/" + first.id, "DELETE", { revision: 3 }],
      ["notes/" + first.id, "PATCH", { revision: 3, title: "Forbidden" }],
    ] as const)
      assert.equal((await call(route, method, input, write.key)).status, 403);
    await body(
      await call("trash/note/" + first.id + "/restore", "POST", {
        revision: 3,
      }),
    );
    assert.equal((await call("notes/" + first.id)).status, 200);
    const artifact = await body(
      await call("artifacts", "POST", { text: "Contract artifact" }, write.key),
      201,
    );
    assert.ok(apiOutputs.artifact.safeParse(artifact).success);
    assert.equal(
      (
        sqlite().prepare("SELECT count(*) AS n FROM notes").get() as {
          n: number;
        }
      ).n,
      5,
    );
    const journal = await body(
      await call("journals", "POST", { date: "2026-10-09" }, write.key),
      201,
    );
    assert.equal(journal.dailyDate, "2026-10-09");
    assert.equal((await body(await call("journals"))).items.length, 1);
    assert.equal((await body(await call("notes"))).items.length, 5);
    const tag = await body(
      await call(
        "tags",
        "POST",
        { name: "Contract tag", color: "blue" },
        write.key,
      ),
      201,
    );
    const assigned = await body(
      await call(
        "item-tags/note/" + first.id,
        "PATCH",
        { revision: 4, tags: [tag.id] },
        write.key,
      ),
    );
    assert.equal(assigned.tags[0].id, tag.id);
    const tagged = await body(
      await call("tags/" + tag.id + "/items", "GET", undefined, read.key),
    );
    assert.equal(tagged.items[0].id, first.id);
    await body(
      await call(
        "notes/" + first.id,
        "PATCH",
        { revision: assigned.revision, favorite: true },
        write.key,
      ),
    );
    assert.equal(
      (await body(await call("favorites", "GET", undefined, read.key))).items[0]
        .id,
      first.id,
    );
    const board = await body(
      await call("boards", "POST", { name: "Contract board" }, write.key),
      201,
    );
    const task = await body(
      await call(
        "tasks",
        "POST",
        { title: "Contract task", boardId: board.id },
        write.key,
      ),
      201,
    );
    assert.ok(apiOutputs.task.safeParse(task).success);
    assert.equal((await body(await call("boards/" + board.id))).id, board.id);
    assert.equal(
      (await body(await call("tasks?limit=1", "GET", undefined, read.key)))
        .items[0].id,
      task.id,
    );
    const eventInput = {
      title: "Contract event",
      start: "2026-10-09",
      end: "2026-10-10",
      timezone: "UTC",
    };
    const event = await body(
      await call("events", "POST", eventInput, write.key),
      201,
    );
    const calendarQuery =
      "calendar/range?from=2026-10-01&to=2026-11-01&timezone=UTC&limit=500&preview=3";
    const calendar = await body(await call(calendarQuery));
    assert.ok(
      calendar.items.some(
        (item: { sourceId: string }) => item.sourceId === event.id,
      ),
    );
    assert.equal(calendar.next, null);
    await body(
      await call(
        "events",
        "POST",
        { ...eventInput, title: "Calendar pagination event" },
        write.key,
      ),
      201,
    );
    const calendarPage = await body(
      await call(
        calendarQuery.replace("limit=500&preview=3", "limit=1&preview=0"),
      ),
    );
    assert.ok(calendarPage.next);
    {
      const next = await body(
        await call(
          calendarQuery.replace("limit=500&preview=3", "limit=1&preview=0") +
            "&after=" +
            encodeURIComponent(calendarPage.next),
        ),
      );
      assert.notEqual(next.items[0].id, calendarPage.items[0].id);
    }
    const defaultPreviewQuery = calendarQuery.replace(
      "limit=500&preview=3",
      "limit=1",
    );
    const cachedPage = await body(await call(defaultPreviewQuery));
    assert.ok(cachedPage.next);
    const cachedNext = await body(
      await call(
        defaultPreviewQuery + "&after=" + encodeURIComponent(cachedPage.next),
      ),
    );
    assert.notEqual(cachedNext.items[0].id, cachedPage.items[0].id);
    assert.equal(
      (await body(await call("events?q=Contract", "GET", undefined, read.key)))
        .items[0].id,
      event.id,
    );
    await body(
      await call(
        "events/" + event.id,
        "PATCH",
        { revision: 1, input: { ...eventInput, title: "Changed event" } },
        write.key,
      ),
    );
    assert.equal(
      (
        await call(
          "events/" + event.id,
          "PATCH",
          { revision: 1, input: eventInput },
          write.key,
        )
      ).status,
      409,
    );
    const reader = (await call("completions")).body!.getReader();
    const decoder = new TextDecoder();
    try {
      assert.match(
        decoder.decode((await reader.read()).value),
        /event: resync/,
      );
      const changed = await body(
        await call("journals", "POST", { date: "2026-10-10" }, write.key),
        201,
      );
      let streamed = "";
      for (
        let attempt = 0;
        attempt < 5 && !streamed.includes('"kind":"content"');
        attempt++
      )
        streamed += decoder.decode((await reader.read()).value);
      assert.match(streamed, /"kind":"content"/);
      assert.ok(changed.id);
    } finally {
      await reader.cancel();
    }
    const form = new FormData();
    form.set("note", first.id);
    form.set(
      "file",
      new File([await readFile("public/icons/icon-192.png")], "contract.png", {
        type: "image/png",
      }),
    );
    const upload = await GET(
      new Request("http://localhost:3000/api/v1/files", {
        method: "POST",
        headers: {
          host: "localhost:3000",
          origin: "http://localhost:3000",
          authorization: "Bearer " + write.key,
        },
        body: form,
      }),
      { params: Promise.resolve({ path: ["files"] }) },
    );
    const file = await body(upload, 201);
    assert.equal(file.url, "http://localhost:3000/api/v1/files/" + file.id);
    assert.equal(
      (await call("files/" + file.id, "GET", undefined, read.key)).status,
      200,
    );
    const publication = await body(
      await call(
        "notes/" + first.id + "/publication",
        "POST",
        { revision: assigned.revision + 1 },
        write.key,
      ),
    );
    assert.equal(
      publication.url,
      "http://localhost:3000/share/" + publication.token,
    );
    for (let index = 0; index < 3; index++)
      sqlite()
        .prepare(
          "INSERT INTO notes(id,owner_id,title,document,text,favorite,created_at,updated_at) VALUES(?,?,?,?,'',1,1,1)",
        )
        .run(
          randomUUID(),
          first.ownerId ??
            (sqlite().prepare("SELECT id FROM user").get() as { id: string })
              .id,
          "Favorite fixture " + index,
          JSON.stringify(first.document),
        );
    const favoritePage = await body(
      await call("favorites?limit=2", "GET", undefined, read.key),
    );
    assert.equal(favoritePage.items.length, 2);
    assert.equal(typeof favoritePage.next, "string");
    const favoriteNext = await body(
      await call(
        "favorites?limit=2&after=" + encodeURIComponent(favoritePage.next),
        "GET",
        undefined,
        read.key,
      ),
    );
    assert.equal(favoriteNext.items.length, 2);
    assert.equal(favoriteNext.next, null);
    assert.ok(
      favoriteNext.items.every(
        (item: { id: string }) =>
          !favoritePage.items.some(
            (before: { id: string }) => before.id === item.id,
          ),
      ),
    );
    const { enqueueJob, completionEvent } =
      await import("../src/lib/server/jobs");
    const owner = (
      sqlite().prepare("SELECT id FROM user").get() as { id: string }
    ).id;
    enqueueJob(owner, "artifact", artifact.id);
    const job = sqlite()
      .prepare("SELECT id FROM background_jobs WHERE target_id=?")
      .get(artifact.id) as { id: string };
    const status = await body(
      await call("jobs/" + job.id, "GET", undefined, read.key),
    );
    assert.ok(["queued", "running", "done", "failed"].includes(status.status));
    assert.equal(status.targetId, artifact.id);
    assert.equal(
      (await call("jobs/" + randomUUID(), "GET", undefined, read.key)).status,
      404,
    );
    completionEvent(owner, "artifact", artifact.id, "done");
    const repeats = await Promise.all([
      call("tasks", "POST", { title: "Retry task" }, write.key, {
        "Idempotency-Key": "concurrent-create",
      }),
      call("tasks", "POST", { title: "Retry task" }, write.key, {
        "Idempotency-Key": "concurrent-create",
      }),
    ]);
    assert.ok(
      repeats.every((response) => [201, 409].includes(response.status)),
    );
    assert.equal(
      (
        sqlite()
          .prepare("SELECT count(*) AS n FROM tasks WHERE title='Retry task'")
          .get() as { n: number }
      ).n,
      1,
    );
  } finally {
    const { stopJobWorker } = await import("../src/lib/server/jobs");
    await stopJobWorker();
    sqlite().close();
    await rm(directory, { recursive: true, force: true });
  }
});
