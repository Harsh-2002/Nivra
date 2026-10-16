import { test } from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
const directory = mkdtempSync(path.join(tmpdir(), "nivra-media-auth-"));
process.env.NIVRA_DATA_DIR = directory;
let remoteMedia: (typeof import("../src/lib/server/remote-media"))["remoteMedia"];
import {
  hasPublishedMedia,
  mediaUrl,
  publicationMedia,
} from "../src/lib/media-url";
import type { Document } from "../src/lib/types";
import type { fetchPublic } from "../src/lib/server/link-metadata";

const source = "https://images.example.com/photo.png";
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);

test("linked media rejects SSRF and active formats, preserves ranges, and bounds simultaneous reads", async () => {
  ({ remoteMedia } = await import("../src/lib/server/remote-media"));
  await assert.rejects(
    remoteMedia(
      new Request("http://localhost/media"),
      "http://127.0.0.1/private",
    ),
    { status: 502 },
  );
  await assert.rejects(
    remoteMedia(
      new Request("http://localhost/media"),
      "https://user:pass@example.com/private",
    ),
    { status: 400 },
  );
  const html: typeof fetchPublic = async () => ({
    bytes: Buffer.from("<html><script>alert(1)</script></html>"),
    type: "image/png",
    url: source,
  });
  await assert.rejects(
    remoteMedia(new Request("http://localhost/media"), source, html),
    { status: 415 },
  );
  const image: typeof fetchPublic = async () => ({
    bytes: png,
    type: "text/html",
    url: source,
  });
  const result = await remoteMedia(
    new Request("http://localhost/media", { headers: { range: "bytes=0-7" } }),
    source,
    image,
  );
  assert.equal(result.status, 206);
  assert.equal(result.headers.get("content-type"), "image/png");
  assert.equal(result.headers.get("x-content-type-options"), "nosniff");
  assert.equal(result.headers.get("cache-control"), "private, no-store");
  assert.equal((await result.arrayBuffer()).byteLength, 8);
  let active = 0,
    peak = 0;
  const releases: (() => void)[] = [];
  const blocked: typeof fetchPublic = async () => {
    peak = Math.max(peak, ++active);
    await new Promise<void>((resolve) => releases.push(resolve));
    active--;
    return { bytes: png, type: "image/png", url: source };
  };
  // Fresh addresses: an earlier fetch of the same address would be answered from the short-lived cache.
  const first = remoteMedia(
    new Request("http://localhost/media"),
    `${source}?busy=1`,
    blocked,
  );
  const second = remoteMedia(
    new Request("http://localhost/media"),
    `${source}?busy=2`,
    blocked,
  );
  const aborted = new AbortController();
  const third = remoteMedia(
    new Request("http://localhost/media", { signal: aborted.signal }),
    `${source}?busy=3`,
    blocked,
  );
  aborted.abort();
  await assert.rejects(third, { status: 504 });
  assert.equal(peak, 2);
  releases.forEach((release) => release());
  await Promise.all([first, second]);
  assert.equal(
    (
      await remoteMedia(
        new Request("http://localhost/media"),
        `${source}?released=1`,
        image,
      )
    ).status,
    200,
  );
});

test("publication media projection preserves originals and scopes relay access to embedded media", () => {
  const document: Document = {
    schemaVersion: 1,
    blocks: [
      { type: "image", props: { url: source } },
      {
        type: "paragraph",
        content: [{ type: "link", href: "https://example.com/" }],
      },
    ],
  };
  const token = "a".repeat(48);
  const projected = publicationMedia(document, token);
  assert.equal((document.blocks[0].props as { url: string }).url, source);
  assert.equal(
    (projected.blocks[0].props as { url: string }).url,
    mediaUrl(source, token),
  );
  assert.equal(hasPublishedMedia(projected, source), true);
  assert.equal(hasPublishedMedia(document, source), true);
  assert.equal(hasPublishedMedia(projected, "https://example.com/"), false);
  assert.equal(mediaUrl("https://user:secret@example.com/photo.png"), "");
});

test("media APIs require a private session or a live publication that references the requested media", async () => {
  const routes = await import("../src/app/api/v1/[...path]/route");
  const { sqlite } = await import("../src/lib/server/db");
  const { stopJobWorker } = await import("../src/lib/server/jobs");
  const request = (
    endpoint: string,
    method = "GET",
    body?: unknown,
    cookie = "",
  ) =>
    new Request("http://localhost:3000/api/v1/" + endpoint, {
      method,
      headers: {
        origin: "http://localhost:3000",
        cookie,
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const context = (endpoint: string) => ({
    params: Promise.resolve({ path: endpoint.split("?")[0].split("/") }),
  });
  try {
    assert.equal(
      (
        await routes.GET(
          request("media?url=" + encodeURIComponent(source)),
          context("media"),
        )
      ).status,
      401,
    );
    const setup = await routes.POST(
      request("setup", "POST", {
        name: "Fixture",
        username: "mediafixture",
        password: "Fixture-media-password-123",
      }),
      context("setup"),
    );
    assert.equal(setup.status, 200);
    const cookie = setup.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    const created = await routes.POST(
      request(
        "notes",
        "POST",
        {
          title: "Media fixture",
          document: {
            schemaVersion: 1,
            blocks: [
              { type: "image", props: { url: "http://127.0.0.1/private" } },
              {
                type: "paragraph",
                props: { textAlignment: "center" },
                content: [
                  {
                    type: "text",
                    text: "Colored publication",
                    styles: { textColor: "red", backgroundColor: "yellow" },
                  },
                ],
              },
            ],
          },
        },
        cookie,
      ),
      context("notes"),
    );
    assert.equal(created.status, 201);
    const note = await created.json();
    const publication = await routes.POST(
      request(
        `notes/${note.id}/publication`,
        "POST",
        { revision: note.revision },
        cookie,
      ),
      context(`notes/${note.id}/publication`),
    );
    assert.equal(publication.status, 200);
    const { token } = await publication.json();
    const share = await import("../src/app/share/[token]/route");
    const shared = await share.GET(request(`share/${token}`), {
      params: Promise.resolve({ token }),
    });
    const sharedAgain = await share.GET(request(`share/${token}`), {
      params: Promise.resolve({ token }),
    });
    assert.equal(shared.status, 200);
    const policy = shared.headers.get("Content-Security-Policy")!;
    const nonce = policy.match(/'nonce-([^']+)'/)![1];
    assert.notEqual(policy, sharedAgain.headers.get("Content-Security-Policy"));
    const html = await shared.text();
    assert.ok(html.includes(`nonce="${nonce}"`));
    assert.ok(html.includes(`content="${nonce}"`));
    assert.ok(html.includes("color:#c43c3c"));
    assert.ok(html.includes("text-align:center"));
    assert.ok(!html.includes("__NIVRA_CSP_NONCE__"));
    assert.ok(!/\sstyle=/.test(html));
    assert.ok(html.includes(`/api/v1/published/${token}/media?url=`));
    const endpoint = `published/${token}/media`;
    assert.equal(
      (
        await routes.GET(
          request(endpoint + "?url=" + encodeURIComponent(source)),
          context(endpoint),
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await routes.GET(
          request(
            endpoint + "?url=" + encodeURIComponent("http://127.0.0.1/private"),
          ),
          context(endpoint),
        )
      ).status,
      502,
    );
    await routes.DELETE(
      request(`notes/${note.id}/publication`, "DELETE", undefined, cookie),
      context(`notes/${note.id}/publication`),
    );
    assert.equal(
      (
        await routes.GET(
          request(endpoint + "?url=" + encodeURIComponent(source)),
          context(endpoint),
        )
      ).status,
      404,
    );
  } finally {
    await stopJobWorker();
    sqlite().close();
    await rm(directory, { recursive: true, force: true });
  }
});
