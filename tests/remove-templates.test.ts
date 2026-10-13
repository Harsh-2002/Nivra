import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { masterKey, deriveKey } from "../src/lib/server/encryption";

test("existing templates move to trash instead of being deleted, and old bundles import them there", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "nivra-templates-"));
  process.env.NIVRA_DATA_DIR = directory;
  const connection = new Database(path.join(directory, "nivra.sqlite"));
  connection.pragma("cipher='chacha20'");
  connection.pragma(
    `key='${deriveKey(masterKey(directory), "sqlite").toString("hex")}'`,
  );
  connection.exec(
    "CREATE TABLE migrations(name TEXT PRIMARY KEY,applied_at INTEGER NOT NULL)",
  );
  for (const name of (await readdir("migrations"))
    .filter((n) => n < "0013")
    .sort()) {
    connection.exec(await readFile(path.join("migrations", name), "utf8"));
    connection
      .prepare("INSERT INTO migrations VALUES(?,?)")
      .run(name, Date.now());
  }
  const owner = randomUUID();
  connection
    .prepare(
      "INSERT INTO user(id,name,email,username,created_at,updated_at) VALUES(?,?,?,?,?,?)",
    )
    .run(owner, "Upgrade Owner", "templates@local.invalid", "templates", 1, 1);
  const insert = connection.prepare(
    "INSERT INTO notes(id,owner_id,title,document,text,kind,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
  );
  const document =
    '{"schemaVersion":1,"blocks":[{"type":"paragraph","content":[]}]}';
  const template = randomUUID();
  const ordinary = randomUUID();
  insert.run(template, owner, "My template", document, "", "template", 1, 1);
  insert.run(ordinary, owner, "A note", document, "", "note", 2, 2);
  connection.close();

  const { sqlite } = await import("../src/lib/server/db");
  const routes = await import("../src/app/api/v1/[...path]/route");
  try {
    const rows = sqlite()
      .prepare("SELECT id,kind,trashed_at FROM notes ORDER BY id")
      .all() as { id: string; kind: string; trashed_at: number | null }[];
    const moved = rows.find((row) => row.id === template)!;
    assert.equal(moved.kind, "note");
    assert.ok(moved.trashed_at && moved.trashed_at > 1_000_000_000_000);
    assert.equal(rows.find((row) => row.id === ordinary)!.trashed_at, null);
    assert.equal(
      sqlite().prepare("SELECT title FROM notes WHERE id=?").get(template)
        ? (
            sqlite()
              .prepare("SELECT title FROM notes WHERE id=?")
              .get(template) as { title: string }
          ).title
        : "",
      "My template",
    );

    let cookie = "";
    const call = (
      route: string,
      method = "GET",
      body?: BodyInit,
      json = false,
    ) =>
      routes.GET(
        new Request(`http://localhost:3000/api/v1/${route}`, {
          method,
          headers: {
            host: "localhost:3000",
            origin: "http://localhost:3000",
            ...(json ? { "content-type": "application/json" } : {}),
            cookie,
          },
          body,
        }),
        { params: Promise.resolve({ path: route.split("?")[0].split("/") }) },
      );
    sqlite().exec("DELETE FROM notes; DELETE FROM user");
    const setup = await routes.GET(
      new Request("http://localhost:3000/api/v1/setup", {
        method: "POST",
        headers: {
          host: "localhost:3000",
          origin: "http://localhost:3000",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          name: "Templates Owner",
          username: "templates",
          password: `Test-${randomUUID()}`,
        }),
      }),
      { params: Promise.resolve({ path: ["setup"] }) },
    );
    assert.equal(setup.status, 200);
    cookie = setup.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    const made = await (
      await call(
        "notes",
        "POST",
        JSON.stringify({ title: "Becomes a template" }),
        true,
      )
    ).json();
    const exported = unzipSync(
      new Uint8Array(await (await call("export/bundle")).arrayBuffer()),
    );
    const manifest = JSON.parse(strFromU8(exported["manifest.json"]));
    manifest.format = "nivra";
    manifest.notes.find((n: { id: string }) => n.id === made.id).kind =
      "template";
    exported["manifest.json"] = strToU8(JSON.stringify(manifest));
    const imported = await call(
      "import/bundle",
      "POST",
      zipSync(exported) as BodyInit,
    );
    assert.equal(imported.status, 200);
    const trash = (await (await call("notes?view=trash")).json()).items as {
      title: string;
    }[];
    assert.ok(trash.some((note) => note.title === "Becomes a template"));
    const writingTemplates = await call("templates");
    assert.equal(writingTemplates.status, 200);
    assert.deepEqual((await writingTemplates.json()).items, []);
  } finally {
    sqlite().close();
    await rm(directory, { recursive: true, force: true });
  }
});
