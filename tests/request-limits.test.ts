import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { mock, test } from "node:test";
import { formDefinitionSchema } from "../src/lib/forms";

test("the client key is the address the nearest proxy saw, bounded in length", async () => {
  const { clientKey } = await import("../src/lib/server/http");
  const key = (headers: Record<string, string>) =>
    clientKey(new Request("http://localhost/", { headers }));
  assert.equal(
    key({ "x-forwarded-for": "203.0.113.7, 10.1.1.1, 198.51.100.4 " }),
    "198.51.100.4",
  );
  assert.equal(key({ "x-forwarded-for": "203.0.113.7, " }), "203.0.113.7");
  assert.equal(key({ "x-real-ip": "192.0.2.9" }), "192.0.2.9");
  assert.equal(key({}), "unknown");
  assert.equal(key({ "x-forwarded-for": "a".repeat(500) }).length, 64);
});

test("throttle windows expire, and rotating client keys cannot reset fixed limits", async (t) => {
  const { throttle, throttleClient } = await import("../src/lib/server/http");
  mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  t.after(() => mock.timers.reset());
  const status = (call: () => void) => {
    try {
      call();
      return 200;
    } catch (error) {
      return (error as { status?: number }).status;
    }
  };
  const fixed = (key: string, limit: number) =>
    status(() => throttle(key, limit));
  const client = (key: string, limit: number) =>
    status(() => throttleClient(key, limit));
  assert.equal(fixed("window", 2), 200);
  assert.equal(fixed("window", 2), 200);
  assert.equal(fixed("window", 2), 429);
  mock.timers.tick(61_000);
  assert.equal(fixed("window", 2), 200);

  assert.equal(fixed("recover", 1), 200);
  assert.equal(fixed("recover", 1), 429);
  assert.equal(client("evicted", 1), 200);
  for (let index = 0; index < 5200; index++)
    assert.equal(client(`rotating:${index}`, 1), 200);
  // Client keys are capped, so the oldest record was dropped and starts over.
  assert.equal(client("evicted", 1), 200);
  // Fixed limits live apart from them and are never evicted.
  assert.equal(fixed("recover", 1), 429);
});

test("anonymous form caps hold when forwarding headers are forged", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "nivra-limits-"));
  process.env.NIVRA_DATA_DIR = directory;
  process.env.NIVRA_PUBLIC_URL = "http://localhost:3000";
  const { sqlite } = await import("../src/lib/server/db");
  const { createForm, publishForm, publicFormExists } =
    await import("../src/lib/server/forms");
  const { publicFormApi } = await import("../src/lib/server/public-form-api");
  const owner = randomUUID();
  sqlite()
    .prepare(
      "INSERT INTO user(id,name,email,username,created_at,updated_at) VALUES(?,?,?,?,1,1)",
    )
    .run(owner, "Owner", "owner@example.test", "owner");
  try {
    const definition = formDefinitionSchema.parse({
      schemaVersion: 1,
      title: "Survey",
      fields: [{ id: randomUUID(), type: "short_text", label: "Idea" }],
    });
    const draft = createForm(owner, { definition });
    const token = publishForm(owner, draft.id, draft.revision).publicToken!;
    const status = async (
      headers: Record<string, string>,
      value = token,
      action = "uploads",
    ) => {
      try {
        await publicFormApi(
          new Request(`http://localhost:3000/api/v1/public/forms/${value}`, {
            method: "POST",
            headers: { "content-type": "application/json", ...headers },
            body: "{}",
          }),
          ["public", "forms", value, action],
        );
        return 200;
      } catch (error) {
        return (error as { status?: number }).status ?? 400;
      }
    };
    assert.equal(publicFormExists(token), true);
    assert.equal(publicFormExists("x".repeat(32)), false);
    assert.equal(publicFormExists("short"), false);

    // A forged first entry does not buy a fresh per-client allowance.
    const same = (index: number) => ({
      "x-forwarded-for": `10.0.${index}.1, 203.0.113.50`,
    });
    for (let index = 0; index < 120; index++)
      assert.notEqual(await status(same(index)), 429);
    assert.equal(await status(same(999)), 429);

    // Unknown or malformed links are refused without spending any allowance.
    for (let index = 0; index < 40; index++) {
      assert.equal(
        await status(
          { "x-forwarded-for": `198.51.100.${index}` },
          randomUUID().replaceAll("-", ""),
        ),
        404,
      );
      assert.equal(
        await status({ "x-forwarded-for": `198.51.100.${index}` }, "bad"),
        404,
      );
    }

    // Rotating the last entry too meets the per-form cap: 120 requests above already count toward its 600.
    let refused = 0;
    for (let index = 0; index < 600; index++)
      if ((await status({ "x-forwarded-for": `192.0.${index}.1` })) === 429)
        refused++;
    assert.equal(refused, 120);
    assert.equal(await status({ "x-forwarded-for": "192.0.250.250" }), 429);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
