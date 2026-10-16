import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, beforeEach, mock, test } from "node:test";

process.env.NIVRA_DATA_DIR = mkdtempSync(path.join(tmpdir(), "nivra-update-"));
type Fetcher = typeof import("../src/lib/server/link-metadata").fetchPublic;
const release = (overrides: Record<string, unknown> = {}) => ({
  tag_name: "v2026.10.20",
  published_at: "2026-10-20T09:30:00Z",
  html_url: "https://github.com/Harsh-2002/Nivra/releases/tag/v2026.10.20",
  ...overrides,
});
const answer = (body: unknown): Fetcher =>
  (async () => ({
    bytes: Buffer.from(typeof body === "string" ? body : JSON.stringify(body)),
    type: "application/json",
    url: "https://api.github.com/repos/Harsh-2002/Nivra/releases/latest",
  })) as Fetcher;
mock.timers.enable({ apis: ["Date"], now: Date.now() });
after(() => mock.timers.reset());
beforeEach(async () => {
  (await import("../src/lib/server/updates")).forgetLatestRelease();
  delete process.env.NIVRA_VERSION;
  // Each test starts after the one-minute request allowance has passed.
  mock.timers.tick(61_000);
});

test("an older release is reported as an update and the same or newer one as current", async () => {
  const { checkForUpdates, forgetLatestRelease } =
    await import("../src/lib/server/updates");
  process.env.NIVRA_VERSION = "v2026.10.16";
  const available = await checkForUpdates(answer(release()));
  assert.equal(available.state, "available");
  assert.deepEqual(available.latest, {
    version: "v2026.10.20",
    publishedAt: "2026-10-20T09:30:00Z",
    url: "https://github.com/Harsh-2002/Nivra/releases/tag/v2026.10.20",
  });
  for (const running of ["v2026.10.20", "v2026.11.01"]) {
    forgetLatestRelease();
    process.env.NIVRA_VERSION = running;
    assert.equal((await checkForUpdates(answer(release()))).state, "current");
  }
  forgetLatestRelease();
  delete process.env.NIVRA_VERSION;
  const unknown = await checkForUpdates(answer(release()));
  assert.equal(unknown.state, "unknown");
  assert.equal(unknown.current, null);
});

test("the answer is reused for ten minutes so a click costs no request", async () => {
  const { checkForUpdates } = await import("../src/lib/server/updates");
  let requests = 0;
  const fetcher: Fetcher = (async (...args: Parameters<Fetcher>) => {
    requests++;
    assert.equal(
      args[0],
      "https://api.github.com/repos/Harsh-2002/Nivra/releases/latest",
    );
    assert.equal(args[4], "application/vnd.github+json");
    return answer(release())(...args);
  }) as Fetcher;
  await checkForUpdates(fetcher);
  await checkForUpdates(fetcher);
  assert.equal(requests, 1);
});

test("anything unexpected from GitHub becomes one clear error", async () => {
  const { checkForUpdates } = await import("../src/lib/server/updates");
  const failing: Fetcher = (async () => {
    throw new Error("getaddrinfo ENOTFOUND api.github.com");
  }) as Fetcher;
  for (const fetcher of [
    failing,
    answer("<html>rate limited</html>"),
    answer(release({ tag_name: "latest" })),
    answer(release({ published_at: "yesterday" })),
    answer(
      release({
        html_url: "https://evil.example.com/Harsh-2002/Nivra/releases/tag/v1",
      }),
    ),
    answer(
      release({
        html_url:
          "https://github.com/someone-else/repo/releases/tag/v2026.10.20",
      }),
    ),
  ]) {
    await assert.rejects(checkForUpdates(fetcher), (error: unknown) => {
      const failure = error as { status?: number; message: string };
      assert.equal(failure.status, 502);
      assert.match(
        failure.message,
        /could not read the latest release from GitHub/,
      );
      assert.doesNotMatch(failure.message, /ENOTFOUND|SyntaxError|Zod/);
      return true;
    });
  }
});
