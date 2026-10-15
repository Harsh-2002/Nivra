import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { test } from "node:test";

const extensionId = "afdnjjepnkbmblblbcjfjakoimgniabn";
const otherId = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const verifierFor = () => randomBytes(32).toString("base64url");
const challengeOf = (verifier: string) =>
  createHash("sha256").update(verifier).digest("base64url");

test("browser extension pairing issues a narrow, origin-bound, revocable key", async (t) => {
  const directory = await mkdtemp(`${tmpdir()}/nivra-extension-`);
  process.env.NIVRA_DATA_DIR = directory;
  const browser = await import("../src/app/api/v1/[...path]/route");
  const mcp = await import("../src/app/mcp/route");
  let base = "";
  const server = createServer(async (req, res) => {
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers))
      if (value)
        headers.set(key, Array.isArray(value) ? value.join(",") : value);
    const request = new Request(`${base}${req.url}`, {
      method: req.method,
      headers,
      ...(req.method !== "GET" && req.method !== "HEAD"
        ? {
            body: Readable.toWeb(req) as unknown as ReadableStream<Uint8Array>,
            duplex: "half" as const,
          }
        : {}),
    });
    const pathname = new URL(request.url).pathname;
    const response =
      pathname === "/mcp"
        ? await mcp.POST(request)
        : await browser.GET(request, {
            params: Promise.resolve({
              path: pathname.slice("/api/v1/".length).split("/"),
            }),
          });
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  process.env.NIVRA_PUBLIC_URL = base;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try {
      await (await import("../src/lib/server/jobs")).stopJobWorker();
    } catch {
      // The worker is not started by every path.
    }
    await rm(directory, { recursive: true, force: true });
  });

  let cookie = "";
  const call = async (
    route: string,
    method: string,
    options: {
      body?: unknown;
      token?: string;
      origin?: string | null;
      session?: boolean;
    } = {},
  ) => {
    const headers = new Headers();
    if (options.origin !== null) headers.set("origin", options.origin ?? base);
    if (options.token) headers.set("authorization", `Bearer ${options.token}`);
    else if (options.session !== false && cookie) headers.set("cookie", cookie);
    if (options.body !== undefined)
      headers.set("content-type", "application/json");
    const response = await fetch(`${base}/api/v1/${route}`, {
      method,
      headers,
      ...(options.body !== undefined
        ? { body: JSON.stringify(options.body) }
        : {}),
    });
    const text = await response.text();
    return {
      status: response.status,
      body: text ? JSON.parse(text) : undefined,
    };
  };

  const setup = await fetch(`${base}/api/v1/setup`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({
      username: "extensionowner",
      name: "Extension Owner",
      password: `Test-${randomUUID()}`,
    }),
  });
  assert.equal(setup.status, 200);
  cookie = setup.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");

  const extensionOrigin = `chrome-extension://${extensionId}`;
  const pair = async () => {
    const verifier = verifierFor();
    const authorized = await call("extension/authorize", "POST", {
      body: {
        extensionId,
        deviceName: "Test laptop",
        challenge: challengeOf(verifier),
      },
    });
    assert.equal(authorized.status, 201);
    return { code: authorized.body.code as string, verifier };
  };

  // Authorization is an owner browser action for recognized extensions only.
  assert.equal(
    (
      await call("extension/authorize", "POST", {
        body: {
          extensionId: otherId,
          deviceName: "Other",
          challenge: challengeOf(verifierFor()),
        },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await call("extension/authorize", "POST", {
        session: false,
        body: {
          extensionId,
          deviceName: "Anonymous",
          challenge: challengeOf(verifierFor()),
        },
      })
    ).status,
    401,
  );

  // The code is the credential: wrong origin, wrong extension and replay fail.
  const { code, verifier } = await pair();
  for (const origin of [base, `chrome-extension://${otherId}`, null])
    assert.equal(
      (
        await call("extension/pair", "POST", {
          session: false,
          origin,
          body: { code, extensionId, verifier },
        })
      ).status,
      403,
    );
  const paired = await call("extension/pair", "POST", {
    session: false,
    origin: extensionOrigin,
    body: { code, extensionId, verifier },
  });
  assert.equal(paired.status, 201);
  assert.match(paired.body.key, /^nivra_/);
  assert.equal(
    (
      await call("extension/pair", "POST", {
        session: false,
        origin: extensionOrigin,
        body: { code, extensionId, verifier },
      })
    ).status,
    400,
  );

  // Expired codes are rejected.
  const { sqlite } = await import("../src/lib/server/db");
  const expiredPairing = await pair();
  const expired = expiredPairing.code;
  sqlite()
    .prepare("UPDATE extension_pairing SET expires_at=?")
    .run(Date.now() - 1000);
  assert.equal(
    (
      await call("extension/pair", "POST", {
        session: false,
        origin: extensionOrigin,
        body: { code: expired, extensionId, verifier: expiredPairing.verifier },
      })
    ).status,
    400,
  );

  // A wrong verifier fails and still consumes the code.
  const proof = await pair();
  assert.equal(
    (
      await call("extension/pair", "POST", {
        session: false,
        origin: extensionOrigin,
        body: {
          code: proof.code,
          extensionId,
          verifier: verifierFor(),
        },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await call("extension/pair", "POST", {
        session: false,
        origin: extensionOrigin,
        body: { code: proof.code, extensionId, verifier: proof.verifier },
      })
    ).status,
    400,
  );
  // Account recovery removes codes that were still outstanding.
  const outstanding = await pair();
  const { revokeAllAgents } = await import("../src/lib/server/agent-access");
  const ownerRow = sqlite().prepare("SELECT id FROM user LIMIT 1").get() as {
    id: string;
  };
  revokeAllAgents(ownerRow.id);
  assert.equal(
    (
      await call("extension/pair", "POST", {
        session: false,
        origin: extensionOrigin,
        body: {
          code: outstanding.code,
          extensionId,
          verifier: outstanding.verifier,
        },
      })
    ).status,
    400,
  );
  // revokeAllAgents also removed the first key, so pair again for the remaining checks.
  const second = await pair();
  const repaired = await call("extension/pair", "POST", {
    session: false,
    origin: extensionOrigin,
    body: { code: second.code, extensionId, verifier: second.verifier },
  });
  assert.equal(repaired.status, 201);

  const key = repaired.body.key as string;
  const asExtension = (
    route: string,
    method = "GET",
    body?: unknown,
    origin: string | null = extensionOrigin,
  ) => call(route, method, { token: key, origin, body });

  // Allowed operations work from the extension origin.
  const saved = await asExtension("capture", "POST", {
    type: "bookmark",
    url: "https://example.org/extension-test",
    title: "Extension test",
  });
  assert.equal(saved.status, 201);
  assert.equal(saved.body.alreadySaved, false);
  const again = await asExtension("capture", "POST", {
    type: "bookmark",
    url: "https://example.org/extension-test",
  });
  assert.equal(again.body.alreadySaved, true);
  const bookmark = await asExtension(`bookmarks/${saved.body.id}`);
  assert.equal(bookmark.status, 200);
  assert.equal(
    (
      await asExtension(`bookmarks/${saved.body.id}`, "PATCH", {
        revision: bookmark.body.revision,
        collection: "Reading",
      })
    ).status,
    200,
  );
  assert.equal((await asExtension("tags")).status, 200);
  assert.equal(
    (await asExtension(`item-tags/bookmark/${saved.body.id}`)).status,
    200,
  );
  assert.equal(
    (await asExtension("notes", "POST", { title: "From the browser" })).status,
    201,
  );
  const session = await asExtension("extension/session");
  assert.equal(session.status, 200);
  assert.match(session.body.name, /Test laptop/);
  assert.ok(["light", "dark", "system"].includes(session.body.theme));

  // Writes are limited to plain links, notes and the note just created.
  assert.equal(
    (await asExtension("capture", "POST", { type: "task", title: "Nope" }))
      .status,
    403,
  );
  for (const block of [
    { type: "heading", props: { level: 1 }, content: [] },
    { type: "image", props: { url: "https://tracker.example/pixel.png" } },
    {
      type: "paragraph",
      content: [{ type: "link", href: "https://example.org", content: [] }],
    },
  ])
    assert.equal(
      (
        await asExtension("notes", "POST", {
          title: "Blocked",
          document: { schemaVersion: 1, blocks: [block] },
        })
      ).status,
      403,
    );
  const older = await call("notes", "POST", { body: { title: "Old note" } });
  sqlite()
    .prepare("UPDATE notes SET created_at=? WHERE id=?")
    .run(Date.now() - 60 * 60_000, older.body.id);
  const current = await asExtension(`bookmarks/${saved.body.id}`);
  assert.equal(
    (
      await asExtension(`bookmarks/${saved.body.id}`, "PATCH", {
        revision: current.body.revision,
        noteId: older.body.id,
      })
    ).status,
    403,
  );
  const fresh = await asExtension("notes", "POST", {
    title: "Fresh note",
    document: {
      schemaVersion: 1,
      blocks: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "Hello", styles: {} }],
        },
      ],
    },
  });
  assert.equal(fresh.status, 201);
  assert.equal(
    (
      await asExtension(`bookmarks/${saved.body.id}`, "PATCH", {
        revision: current.body.revision,
        noteId: fresh.body.id,
      })
    ).status,
    200,
  );

  // Everything else stays closed, including MCP and owner administration.
  for (const [route, method] of [
    ["settings", "GET"],
    ["notes", "GET"],
    ["tasks", "GET"],
    ["trash", "GET"],
    ["ai-connections", "GET"],
    ["bookmarks/" + saved.body.id + "/refresh", "POST"],
    ["export/bundle", "GET"],
  ] as const)
    assert.equal(
      (await asExtension(route, method, method === "POST" ? {} : undefined))
        .status,
      403,
      `${method} ${route}`,
    );
  const mcpResponse = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  assert.equal(mcpResponse.status, 403);

  // Origin rules: only the pinned extension for extension keys; cookies stay same-origin.
  for (const origin of [`chrome-extension://${otherId}`, "https://evil.test"])
    assert.equal(
      (await asExtension("tags", "GET", undefined, origin)).status,
      403,
      origin,
    );
  assert.equal(
    (
      await call("bookmarks", "POST", {
        origin: extensionOrigin,
        body: { url: "https://example.org/cookie-origin" },
      })
    ).status,
    403,
  );
  const ordinary = await call("ai-connections", "POST", {
    body: { action: "create-key", name: "Ordinary", access: "full" },
  });
  assert.equal(ordinary.status, 201);
  assert.equal(
    (
      await call("tags", "GET", {
        token: ordinary.body.key,
        origin: extensionOrigin,
      })
    ).status,
    403,
  );
  assert.equal(
    (await call("extension/session", "GET", { token: ordinary.body.key }))
      .status,
    403,
  );

  // The extension can disconnect itself; the key stops working immediately.
  assert.equal((await asExtension("extension/session", "DELETE")).status, 200);
  assert.equal((await asExtension("tags")).status, 401);
  assert.equal(
    (
      sqlite().prepare("SELECT count(*) AS n FROM extension_keys").get() as {
        n: number;
      }
    ).n,
    0,
  );
});
