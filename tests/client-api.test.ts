import assert from "node:assert/strict";
import { test } from "node:test";
import {
  api,
  ApiError,
  authRequest,
  downloadRequest,
  unreachable,
} from "../src/lib/client";

const original = globalThis.fetch;
async function using<T>(
  handler: () => Response | Promise<Response>,
  run: () => Promise<T>,
) {
  globalThis.fetch = (async () => handler()) as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}
const html = (status: number) =>
  new Response("<!DOCTYPE html><html><body>Bad gateway</body></html>", {
    status,
    headers: { "Content-Type": "text/html" },
  });
const failure = (error: unknown) => {
  assert.ok(error instanceof ApiError);
  return error;
};

test("network failures read as one clear message instead of the browser's", async () => {
  globalThis.fetch = (async () => {
    throw new TypeError("Failed to fetch");
  }) as typeof fetch;
  try {
    for (const call of [
      () => api("notes"),
      () => authRequest("sign-out", {}),
      () => downloadRequest("export", "export.zip"),
    ]) {
      const error = failure(await call().catch((cause) => cause));
      assert.equal(error.message, unreachable);
      assert.equal(error.status, 0);
      assert.equal(error.code, "unreachable");
    }
  } finally {
    globalThis.fetch = original;
  }
});

test("aborted requests still reject with the original abort", async () => {
  const controller = new AbortController();
  globalThis.fetch = (async () => {
    controller.abort();
    throw new DOMException("The operation was aborted.", "AbortError");
  }) as typeof fetch;
  try {
    const error = await api("notes", { signal: controller.signal }).catch(
      (cause) => cause,
    );
    assert.ok(error instanceof DOMException);
    assert.equal(error.name, "AbortError");
  } finally {
    globalThis.fetch = original;
  }
});

test("proxy and server pages never leak parser errors", async () => {
  for (const [status, expected] of [
    [502, /try again in a moment/i],
    [503, /try again in a moment/i],
    [413, /larger than the server accepts/i],
    [429, /too many requests/i],
    [404, /could not be completed/i],
  ] as const) {
    for (const call of [
      () => api("notes"),
      () => authRequest("sign-in/username", {}),
      () => downloadRequest("export", "export.zip"),
    ]) {
      const error = failure(
        await using(
          () => html(status),
          () => call().catch((cause) => cause),
        ),
      );
      assert.equal(error.status, status);
      assert.match(error.message, expected);
      assert.doesNotMatch(error.message, /JSON|Unexpected token|DOCTYPE|</);
    }
  }
});

test("server messages and codes are preserved", async () => {
  const error = failure(
    await using(
      () =>
        Response.json(
          { error: "Changed elsewhere.", code: "revision" },
          { status: 409 },
        ),
      () => api("notes/1").catch((cause) => cause),
    ),
  );
  assert.deepEqual(
    [error.message, error.status, error.code],
    ["Changed elsewhere.", 409, "revision"],
  );
  const auth = failure(
    await using(
      () => Response.json({ message: "Wrong password." }, { status: 401 }),
      () => authRequest("sign-in/username", {}).catch((cause) => cause),
    ),
  );
  assert.equal(auth.message, "Wrong password.");
});

test("successful bodies are returned as sent and malformed ones are reported", async () => {
  assert.equal(
    await using(
      () => Response.json(null),
      () => api("publication"),
    ),
    null,
  );
  assert.deepEqual(
    await using(
      () => Response.json({ ok: true }),
      () => authRequest("sign-out", {}),
    ),
    { ok: true },
  );
  const malformed = failure(
    await using(
      () => new Response("<html>", { status: 200 }),
      () => api("notes").catch((cause) => cause),
    ),
  );
  assert.equal(malformed.code, "invalid-response");
  assert.doesNotMatch(malformed.message, /JSON|Unexpected token/);
});
