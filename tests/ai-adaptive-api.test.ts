import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

test("adaptive tagging preferences and proposal reviews remain owner-only and revision checked", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "nivra-adaptive-api-"));
  process.env.NIVRA_DATA_DIR = directory;
  const routes = await import("../src/app/api/v1/[...path]/route");
  const { sqlite } = await import("../src/lib/server/db");
  const { stopJobWorker } = await import("../src/lib/server/jobs");
  const { stopAi } = await import("../src/lib/server/ai/indexer");
  const { operationFor } = await import("../src/lib/server/api-contract");
  let cookie = "";
  const call = (route: string, method = "GET", body?: unknown, auth = true) =>
    routes.GET(
      new Request(`http://localhost:3000/api/v1/${route}`, {
        method,
        headers: {
          origin: "http://localhost:3000",
          host: "localhost:3000",
          "content-type": "application/json",
          ...(auth ? { cookie } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      { params: Promise.resolve({ path: route.split("/") }) },
    );
  const value = async (route: string, method = "GET", body?: unknown) => {
    const response = await call(route, method, body);
    assert.ok(response.ok, await response.clone().text());
    return response.json();
  };
  try {
    const setup = await call(
      "setup",
      "POST",
      {
        name: "Adaptive API Test",
        username: "adaptive_api_test",
        password: `Test-${randomUUID()}`,
      },
      false,
    );
    assert.equal(setup.status, 200);
    cookie = setup.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    const initial = await value("ai");
    assert.equal(initial.enabled, false);
    assert.equal(initial.taggingMode, "manual");
    const automatic = await value("ai", "PATCH", {
      enabled: false,
      revision: initial.revision,
      taggingMode: "automatic",
    });
    assert.equal(automatic.taggingMode, "automatic");
    assert.equal(
      automatic.enabled,
      false,
      "Selecting a mode does not turn on the master feature flag",
    );
    assert.equal(
      (
        await call("ai", "PATCH", {
          enabled: false,
          revision: initial.revision,
          taggingMode: "manual",
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await call("ai", "PATCH", {
          enabled: false,
          revision: automatic.revision,
          taggingMode: "invalid",
        })
      ).status,
      400,
    );
    const preserved = await value("ai", "PATCH", {
      enabled: false,
      revision: automatic.revision,
    });
    assert.equal(
      preserved.taggingMode,
      "automatic",
      "Old callers omitting the mode preserve the current preference",
    );
    const manual = await value("ai", "PATCH", {
      enabled: false,
      revision: preserved.revision,
      taggingMode: "manual",
    });
    assert.equal(manual.taggingMode, "manual");
    assert.deepEqual(await value("ai/tag-proposals"), { items: [] });
    assert.equal(
      (await call("ai/tag-proposals", "GET", undefined, false)).status,
      401,
    );
    assert.equal(
      (await call("ai/tag-proposals/not-a-uuid/accept", "POST", {})).status,
      400,
    );
    for (const action of ["accept", "reject"]) {
      const missing = await call(
        `ai/tag-proposals/${randomUUID()}/${action}`,
        "POST",
        {},
      );
      assert.ok([404, 409].includes(missing.status));
    }
    const key = await value("ai-connections", "POST", {
      name: "Adaptive API test",
      action: "create-key",
      access: "full",
    });
    const token = key.token ?? key.key;
    assert.ok(
      typeof token === "string",
      "API key response includes the one-time token",
    );
    for (const route of ["ai", "ai/tag-proposals"]) {
      const denied = await routes.GET(
        new Request(`http://localhost:3000/api/v1/${route}`, {
          headers: { authorization: `Bearer ${token}` },
        }),
        { params: Promise.resolve({ path: route.split("/") }) },
      );
      assert.equal(
        denied.status,
        403,
        "Agent keys cannot configure or review owner learning state",
      );
    }
    for (const route of ["ai", "ai/tag-proposals"]) {
      const op = operationFor(`/api/v1/${route}`, "GET");
      assert.ok(op);
      assert.ok(
        op.output.safeParse(await value(route)).success,
        "Actual owner responses match the OpenAPI executable schema",
      );
    }
  } finally {
    await stopJobWorker();
    await stopAi();
    sqlite().close();
    delete (globalThis as { nivraSqlite?: unknown }).nivraSqlite;
    await rm(directory, { recursive: true, force: true });
  }
});
