import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { bookmarklet, captureInput, sharedCapture } from "../src/lib/capture";

test("capture prepares bounded drafts and an uncredentialed fragment bookmarklet", () => {
  assert.equal(
    sharedCapture({ text: "https://example.org/article" }).type,
    "bookmark",
  );
  assert.equal(sharedCapture({ text: "A thought" }).type, "note");
  assert.equal(
    sharedCapture({
      url: "https://example.org/article",
      text: "https://example.org/article",
    }).text,
    "",
  );
  assert.equal(
    captureInput.safeParse({ type: "bookmark", url: "javascript:alert(1)" })
      .success,
    false,
  );
  assert.equal(
    captureInput.safeParse({
      type: "bookmark",
      url: "https://person:secret@example.org/",
    }).success,
    false,
  );
  assert.equal(
    captureInput.safeParse({ type: "task", title: "x".repeat(301) }).success,
    false,
  );
  assert.throws(() => sharedCapture({ text: "x".repeat(10_001) }));
  const code = bookmarklet("https://example.org");
  assert.ok(code.includes('"https://example.org/capture"'));
  assert.ok(code.includes("'#'"));
  assert.equal(code.includes("/api/"), false);
});

test("bookmarklets reject unsafe bases and keep page text as fragment data", () => {
  for (const origin of [
    "javascript:alert(1)",
    "data:text/html,unsafe",
    "ftp://example.test",
    "https://person:secret@example.test",
    "https://example.test/path",
    "https://example.test/?token=secret",
    "https://example.test/#</script>",
    "not a URL",
  ])
    assert.throws(() => bookmarklet(origin));

  const title = `Quoted \"title\" </script><script>window.injected=true</script>\u2028`;
  const selection = `Selected 'text' \\ \n \u2029`;
  for (const origin of [
    "https://example.test",
    "http://localhost:3000",
    "http://[::1]:3000",
  ]) {
    const calls: unknown[][] = [];
    const window = { open: (...args: unknown[]) => calls.push(args) };
    const code = bookmarklet(origin);
    assert.equal(/[<\u2028\u2029]/.test(code), false);
    runInNewContext(code.slice("javascript:".length), {
      URLSearchParams,
      location: { href: "https://source.example.test/article?topic=notes" },
      document: { title },
      getSelection: () => selection,
      window,
    });
    assert.equal(calls.length, 1);
    const [url, target, features] = calls[0];
    const destination = new URL(url as string);
    assert.equal(destination.origin, origin);
    assert.equal(destination.pathname, "/capture");
    assert.equal(destination.search, "");
    const fields = new URLSearchParams(destination.hash.slice(1));
    assert.equal(fields.get("title"), title);
    assert.equal(fields.get("text"), selection);
    assert.equal(
      fields.get("url"),
      "https://source.example.test/article?topic=notes",
    );
    assert.equal(target, "_blank");
    assert.equal(features, "noopener,noreferrer");
    assert.equal("injected" in window, false);
  }
});

test("PWA sharing prepares a private review draft without saving content", async () => {
  const { POST } = await import("../src/app/capture/receive/route");
  const response = await POST(
    new Request("http://localhost:3015/capture/receive", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        title: "Shared thought",
        text: "SENTINEL_UNSAVED_DRAFT",
      }),
    }),
  );
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  const location = response.headers.get("location")!;
  assert.ok(location.startsWith("/capture#"));
  const target = new URL(location, "http://localhost:3015");
  assert.equal(target.search, "");
  assert.equal(
    new URLSearchParams(target.hash.slice(1)).get("text"),
    "SENTINEL_UNSAVED_DRAFT",
  );
  const oversized = await POST(
    new Request("http://localhost:3015/capture/receive", {
      method: "POST",
      body: "x".repeat(24_001),
    }),
  );
  assert.equal(oversized.status, 413);
});

test("reviewed capture atomically saves a passage and reuses a bookmark on retry", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "nivra-capture-"));
  const old = process.env.NIVRA_DATA_DIR;
  process.env.NIVRA_DATA_DIR = directory;
  const { sqlite } = await import("../src/lib/server/db");
  const { executeContent } = await import("../src/lib/server/content-service");
  const { sourceFor, sourceText } =
    await import("../src/lib/server/ai/content");
  const { stopJobWorker } = await import("../src/lib/server/jobs");
  const d = sqlite();
  const owner = randomUUID();
  d.prepare(
    "INSERT INTO user(id,name,email,username,created_at,updated_at) VALUES(?,?,?,?,?,?)",
  ).run(owner, "Capture Test", `${owner}@example.test`, `u-${owner}`, 1, 1);
  const call = (input: unknown, key = randomUUID()) =>
    executeContent({
      ownerId: owner,
      origin: "http://localhost:3015",
      path: ["capture"],
      method: "POST",
      input,
      idempotencyKey: key,
    });
  try {
    const input = {
      type: "bookmark",
      url: "https://example.test/reading",
      title: "A saved reference",
      text: "SENTINEL_PRIVATE_PASSAGE",
    };
    const key = randomUUID();
    const first = await call(input, key);
    assert.ok("data" in first);
    const value = first.data as {
      id: string;
      noteId: string;
      alreadySaved: boolean;
    };
    assert.equal(first.status, 201);
    assert.equal(value.alreadySaved, false);
    assert.ok(value.noteId);
    const again = await call(input, key);
    assert.deepEqual(again, first);
    assert.equal(
      (d.prepare("SELECT count(*) AS n FROM notes").get() as { n: number }).n,
      1,
    );
    const duplicate = await call({ ...input, text: "" });
    assert.ok("data" in duplicate);
    assert.equal((duplicate.data as { id: string }).id, value.id);
    assert.equal(
      (duplicate.data as { alreadySaved: boolean }).alreadySaved,
      true,
    );
    assert.equal(
      (d.prepare("SELECT count(*) AS n FROM bookmarks").get() as { n: number })
        .n,
      1,
    );
    const before = sourceFor(`bookmark:${value.id}`)!;
    d.prepare(
      "INSERT INTO bookmark_articles(bookmark_id,owner_id,version,source_url,captured_at,title,content_json,plain_text,fingerprint) VALUES(?,?,1,?,1,'Reference','{\"blocks\":[]}','SENTINEL_ARTICLE_TEXT','fingerprint')",
    ).run(value.id, owner, input.url);
    d.prepare("UPDATE bookmarks SET article_version=1 WHERE id=?").run(
      value.id,
    );
    const indexed = sourceFor(`bookmark:${value.id}`)!;
    assert.ok(indexed.generation > before.generation);
    assert.match(sourceText(indexed), /SENTINEL_ARTICLE_TEXT/);
    d.prepare("UPDATE bookmarks SET trashed_at=2 WHERE id=?").run(value.id);
    await assert.rejects(call({ ...input, text: "" }), /Trash/);
    assert.equal(sourceFor(`bookmark:${value.id}`)?.active, 0);
  } finally {
    await stopJobWorker();
    d.close();
    if (old === undefined) delete process.env.NIVRA_DATA_DIR;
    else process.env.NIVRA_DATA_DIR = old;
    await rm(directory, { recursive: true, force: true });
  }
});
