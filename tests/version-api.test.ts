import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

test("only the owner can read the running build or look for updates", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "nivra-version-api-"));
  process.env.NIVRA_DATA_DIR = directory;
  process.env.NIVRA_PUBLIC_URL = "http://localhost:3000";
  process.env.NIVRA_VERSION = "v2026.10.16";
  process.env.NIVRA_COMMIT = "4ce815f1c19dfc77355b0cf62fc3490576def9b2";
  const { GET } = await import("../src/app/api/v1/[...path]/route");
  const { sqlite } = await import("../src/lib/server/db");
  const { stopJobWorker } = await import("../src/lib/server/jobs");
  let cookie = "";
  const call = (
    route: string,
    method = "GET",
    input?: unknown,
    auth?: string,
  ) =>
    GET(
      new Request(`http://localhost:3000/api/v1/${route}`, {
        method,
        headers: {
          host: "localhost:3000",
          origin: "http://localhost:3000",
          "content-type": "application/json",
          ...(auth
            ? { authorization: `Bearer ${auth}` }
            : cookie
              ? { cookie }
              : {}),
        },
        body: input === undefined ? undefined : JSON.stringify(input),
      }),
      { params: Promise.resolve({ path: route.split("/") }) },
    );
  try {
    const setup = await call("setup", "POST", {
      name: "Version Owner",
      username: "version",
      password: "Test-" + randomUUID(),
    });
    assert.equal(setup.status, 200);
    cookie = setup.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    const system = await (await call("system")).json();
    assert.deepEqual(system.build, {
      version: "v2026.10.16",
      commit: "4ce815f1c19dfc77355b0cf62fc3490576def9b2",
      modified: false,
    });
    const keys = [];
    for (const access of ["read", "full"])
      keys.push(
        (
          await (
            await call("ai-connections", "POST", {
              action: "create-key",
              name: access,
              access,
            })
          ).json()
        ).key,
      );
    cookie = "";
    assert.equal((await call("system/updates", "POST")).status, 401);
    assert.equal((await call("system")).status, 401);
    for (const key of keys) {
      assert.equal(
        (await call("system/updates", "POST", undefined, key)).status,
        403,
      );
      assert.equal((await call("system", "GET", undefined, key)).status, 403);
    }
  } finally {
    await stopJobWorker();
    sqlite().close();
    await rm(directory, { recursive: true, force: true });
  }
});
