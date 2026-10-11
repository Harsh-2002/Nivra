import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
test("AI HTTP controls require owner session, retain origin checks and validate settings revisions", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "nivra-ai-http-"));
  process.env.NIVRA_DATA_DIR = directory;
  const base = "http://localhost:3000";
  process.env.NIVRA_PUBLIC_URL = base;
  const routes = await import("../src/app/api/v1/[...path]/route");
  const { sqlite } = await import("../src/lib/server/db");
  const { stopJobWorker } = await import("../src/lib/server/jobs");
  let cookie = "";
  async function call(
    endpoint: string,
    method = "GET",
    body?: unknown,
    extra: Record<string, string> = {},
  ) {
    return routes.GET(
      new Request(base + "/api/v1/" + endpoint, {
        method,
        headers: {
          origin: base,
          host: "localhost:3000",
          cookie,
          "content-type": "application/json",
          ...extra,
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      }),
      { params: Promise.resolve({ path: endpoint.split("?")[0].split("/") }) },
    );
  }
  try {
    const setup = await call("setup", "POST", {
      name: "AI HTTP test",
      username: "ai_http_test",
      password: "Synthetic-" + randomUUID(),
    });
    assert.equal(setup.status, 200);
    cookie = setup.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    assert.ok(cookie);
    const initial = await call("ai");
    assert.equal(initial.status, 200);
    const state = await initial.json();
    assert.equal(state.enabled, false);
    assert.equal(
      (await call("ai", "GET", undefined, { cookie: "" })).status,
      401,
    );
    assert.equal(
      (
        await call(
          "ai",
          "PATCH",
          { enabled: true, revision: state.revision },
          { origin: "https://untrusted.example.test" },
        )
      ).status,
      403,
    );
    assert.equal(
      (await call("ai", "PATCH", { enabled: "true", revision: state.revision }))
        .status,
      400,
    );
    assert.equal(
      (
        await call("ai", "PATCH", {
          enabled: true,
          revision: state.revision + 1,
        })
      ).status,
      409,
    );
    const enabled = await call("ai", "PATCH", {
      enabled: true,
      revision: state.revision,
    });
    assert.equal(enabled.status, 200);
    const next = await enabled.json();
    assert.equal(next.enabled, true);
    const suggestions = await call("ai/suggestions");
    assert.deepEqual(await suggestions.json(), { items: [] });
    const credentials = await call("ai-connections", "POST", {
      action: "create-key",
      name: "Synthetic AI read",
      access: "read",
    });
    assert.equal(credentials.status, 201);
    const key = await credentials.json();
    const token = key.key;
    assert.equal(typeof token, "string");
    assert.equal(
      (await call("ai", "GET", undefined, { authorization: "Bearer " + token }))
        .status,
      403,
    );
    assert.equal(
      (
        await call("ai/suggestions", "GET", undefined, {
          authorization: "Bearer " + token,
        })
      ).status,
      403,
    );
    const search = await call(
      "search?mode=suggest&strategy=semantic&q=synthetic",
      "GET",
      undefined,
      { authorization: "Bearer " + token },
    );
    assert.equal(search.status, 200);
    assert.ok(!JSON.stringify(await search.json()).includes("embedding"));
    assert.equal(
      (await call("ai", "PATCH", { enabled: false, revision: next.revision }))
        .status,
      200,
    );
  } finally {
    await stopJobWorker();
    sqlite().close();
    delete (globalThis as { nivraSqlite?: unknown }).nivraSqlite;
    await rm(directory, { recursive: true, force: true });
  }
});
