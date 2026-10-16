import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, mock, test } from "node:test";

const directory = mkdtempSync(path.join(tmpdir(), "nivra-efficiency-"));
process.env.NIVRA_DATA_DIR = directory;
let owner = "";
async function database() {
  const { sqlite } = await import("../src/lib/server/db");
  const connection = sqlite();
  if (!owner) {
    owner = randomUUID();
    connection
      .prepare(
        "INSERT INTO user(id,name,email,username,created_at,updated_at) VALUES(?,?,?,?,1,1)",
      )
      .run(owner, "Owner", "owner@example.test", "owner");
  }
  return connection;
}
after(async () => {
  (await database()).close();
  rmSync(directory, { recursive: true, force: true });
});

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

test("remote media is fetched once per address for a short time and only when small", async () => {
  const { remoteMedia } = await import("../src/lib/server/remote-media");
  let fetched = 0;
  const fetcher = (async (_url: string, limit: number) => {
    fetched++;
    assert.ok(limit > 0);
    return {
      bytes: url.endsWith("large.png")
        ? Buffer.concat([png, Buffer.alloc(5 * 1024 * 1024)])
        : png,
    };
  }) as never;
  let url = "https://media.example.test/small.png";
  const fetchImage = async () => {
    const response = await remoteMedia(
      new Request("http://localhost/api/v1/published/token/media"),
      url,
      fetcher,
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/png");
    return Buffer.from(await response.arrayBuffer());
  };
  assert.deepEqual(await fetchImage(), png);
  assert.deepEqual(await fetchImage(), png);
  assert.equal(fetched, 1);
  url = "https://media.example.test/other.png";
  await fetchImage();
  assert.equal(fetched, 2);
  url = "https://media.example.test/large.png";
  await fetchImage();
  await fetchImage();
  assert.equal(fetched, 4);
});

test("the media cache expires, stays within its entry bound and only outbound fetches are counted", async (t) => {
  const { remoteMedia } = await import("../src/lib/server/remote-media");
  mock.timers.enable({ apis: ["Date"], now: Date.now() });
  t.after(() => mock.timers.reset());
  let fetched = 0;
  let counted = 0;
  const fetcher = (async () => {
    fetched++;
    return { bytes: png };
  }) as never;
  const get = (name: string) =>
    remoteMedia(
      new Request("http://localhost/media"),
      `https://cache.example.test/${name}.png`,
      fetcher,
      () => counted++,
    );
  await get("a");
  await get("a");
  assert.deepEqual(
    [fetched, counted],
    [1, 1],
    "a hit is neither fetched nor counted",
  );
  mock.timers.tick(5 * 60_000 + 1000);
  await get("a");
  assert.deepEqual(
    [fetched, counted],
    [2, 2],
    "an expired entry is fetched again",
  );
  for (let index = 0; index < 300; index++) await get(`many-${index}`);
  const before = fetched;
  await get("many-299");
  assert.equal(fetched, before, "recent entries stay cached");
  await get("many-0");
  assert.equal(
    fetched,
    before + 1,
    "the oldest entries were evicted by the entry bound",
  );
});

test("the shared connection uses WAL and idle job polls stay read-only", async () => {
  const connection = await database();
  const { claimJob, enqueueJob } = await import("../src/lib/server/jobs");
  assert.equal(connection.pragma("journal_mode", { simple: true }), "wal");
  const original = connection.transaction.bind(connection);
  let opened = 0;
  connection.transaction = ((work: () => unknown) => {
    opened++;
    return original(work as never);
  }) as typeof connection.transaction;
  try {
    assert.equal(claimJob(), undefined);
    assert.equal(opened, 0, "an empty queue must not open a transaction");
    enqueueJob(owner, "bookmark", randomUUID());
    const job = claimJob();
    assert.equal(job?.kind, "bookmark");
    assert.equal(job?.attempts, 1);
    assert.equal(opened, 1);
    assert.equal(claimJob(), undefined, "a leased job is not claimed twice");
    const reclaimed = claimJob(Date.now() + 121_000);
    assert.equal(reclaimed?.id, job?.id, "an expired lease is reclaimed");
    assert.equal(reclaimed?.attempts, 2);
  } finally {
    connection.transaction = original;
  }
});

test("the completion stream delivers new events and ends when the session is revoked", async () => {
  const connection = await database();
  const { completionEvent } = await import("../src/lib/server/jobs");
  const { completionStream } =
    await import("../src/lib/server/completion-stream");
  const session = randomUUID();
  connection
    .prepare(
      "INSERT INTO session(id,expires_at,token,created_at,updated_at,user_id) VALUES(?,?,?,1,1,?)",
    )
    .run(session, Date.now() + 3_600_000, randomUUID(), owner);
  const controller = new AbortController();
  const response = completionStream(
    new Request("http://localhost/api/v1/completions", {
      signal: controller.signal,
    }),
    owner,
    session,
  );
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let received = "";
  let read: Promise<ReadableStreamReadResult<Uint8Array>> | undefined;
  const until = async (needle: string, deadline = 6000) => {
    const stop = Date.now() + deadline;
    while (!received.includes(needle) && Date.now() < stop) {
      read ??= reader.read();
      const chunk = await Promise.race([
        read,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 500)),
      ]);
      if (!chunk) continue;
      read = undefined;
      if (chunk.done) break;
      received += decoder.decode(chunk.value);
    }
    assert.ok(received.includes(needle), `missing ${needle} in ${received}`);
  };
  try {
    await until("event: resync");
    completionEvent(owner, "content", "note-1", "updated");
    await until("event: completion");
    assert.match(received, /"target":"note-1"/);
    connection.prepare("DELETE FROM session WHERE id=?").run(session);
    await until("event: revoked");
  } finally {
    controller.abort();
    await reader.cancel().catch(() => {});
  }
});
