import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { unzipSync, strFromU8, zipSync, strToU8 } from "fflate";
import type {
  Note,
  Task,
  Bookmark,
  NoteVersion,
  Connections,
  SearchResult,
} from "../src/lib/types";
import { nextDate, validDate } from "../src/lib/dates";

test("calendar recurrence preserves dates across leap years and short months", () => {
  assert.equal(validDate("2026-02-29"), false);
  assert.equal(validDate("2028-02-29"), true);
  assert.equal(validDate("2026-13-01"), false);
  assert.equal(nextDate("2026-01-31", "monthly", 31), "2026-02-28");
  assert.equal(nextDate("2026-02-28", "monthly", 31), "2026-03-31");
  assert.equal(nextDate("2028-02-28", "daily"), "2028-02-29");
  assert.equal(nextDate("2026-12-29", "weekly"), "2027-01-05");
});
test("connected workspace retains private search, recovery, journal and scheduled relationships", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "nivra-connected-"));
  process.env.NIVRA_DATA_DIR = directory;
  const routes = await import("../src/app/api/v1/[...path]/route");
  const { sqlite } = await import("../src/lib/server/db");
  const { createStorage } = await import("../src/lib/server/storage");
  const { checkpoint } = await import("../src/lib/server/note-history");
  let cookie = "";
  const call = (
    route: string,
    method = "GET",
    body?: unknown,
    authenticated = true,
  ) => {
    const headers: Record<string, string> = {
      host: "localhost:3000",
      origin: "http://localhost:3000",
    };
    if (authenticated) headers.cookie = cookie;
    if (body && !(body instanceof FormData) && !(body instanceof Uint8Array))
      headers["content-type"] = "application/json";
    return routes.GET(
      new Request(`http://localhost:3000/api/v1/${route}`, {
        method,
        headers,
        body:
          body === undefined
            ? undefined
            : body instanceof FormData || body instanceof Uint8Array
              ? (body as BodyInit)
              : JSON.stringify(body),
      }),
      { params: Promise.resolve({ path: route.split("?")[0].split("/") }) },
    );
  };
  const value = async <T>(
    route: string,
    method = "GET",
    body?: unknown,
  ): Promise<T> => {
    if (route.startsWith("search?")) route += "&mode=suggest";
    const response = await call(route, method, body);
    assert.ok(
      response.ok,
      `${method} ${route}: ${response.status} ${await response.clone().text()}`,
    );
    const result = await response.json();
    return (
      method === "GET" &&
      (/^notes(?:\?|$)/.test(route) || route.startsWith("search?"))
        ? result.items
        : result
    ) as T;
  };
  const allTasks = async () =>
    (
      await Promise.all(
        ["open", "completed"].map((filter) =>
          value<{ items: Task[] }>(`tasks?filter=${filter}&limit=100`),
        ),
      )
    ).flatMap((page) => page.items);
  const document = (text: string) => ({
    schemaVersion: 1,
    blocks: [
      { type: "paragraph", content: [{ type: "text", text, styles: {} }] },
    ],
  });
  let target: Note, source: Note, task: Task, bookmark: Bookmark;
  let fileId = "";
  try {
    const setup = await call(
      "setup",
      "POST",
      {
        name: "Connected Owner",
        username: "connected",
        password: `Test-${randomUUID()}`,
      },
      false,
    );
    assert.equal(setup.status, 200);
    cookie = setup.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    target = await value<Note>("notes", "POST", {
      title: "Architecture nebula",
      document: document("Private decisions"),
    });
    source = await value<Note>("notes", "POST", {
      title: "Project nebula",
      document: {
        schemaVersion: 1,
        blocks: [
          {
            type: "paragraph",
            content: [
              {
                type: "link",
                href: `/?note=${target.id}`,
                content: [{ type: "text", text: "Architecture", styles: {} }],
              },
            ],
          },
        ],
      },
    });
    await t.test(
      "search excerpts find buried matches and paged previews preserve full notes",
      async () => {
        const text = `${"An introductory paragraph with ordinary content. ".repeat(60)} The résumé milestone is ready. <script>alert(1)</script>`;
        const note = await value<Note>("notes", "POST", {
          title: "Context safety",
          document: document(text),
        });
        const results = await value<SearchResult[]>("search?q=milestone");
        const result = results.find((item) => item.id === note.id)!;
        assert.ok(result.excerpt.includes("milestone"));
        assert.ok(result.excerpt.length < text.length);
        assert.ok(
          result.excerptMatches?.some(
            ([from, to]) => result.excerpt.slice(from, to) === "milestone",
          ),
        );
        assert.ok(result.matchTerms?.includes("milestone"));
        assert.ok(!result.excerpt.includes("[[/"));
        const page = await value<Note[]>("notes?limit=2&preview=1&sort=title");
        const next = await value<Note[]>(
          "notes?limit=2&preview=1&sort=title&offset=2",
        );
        assert.equal(page.length, 2);
        assert.equal(next.length, 1);
        assert.ok(
          !page.some((item) => next.some((other) => other.id === item.id)),
        );
        assert.ok([...page, ...next].every((item) => item.text.length <= 180));
        assert.equal((await value<Note>(`notes/${note.id}`)).text, text);
        assert.equal(
          (await value<Note[]>("notes?q=Context&limit=1&offset=1")).length,
          0,
        );
        assert.equal(
          (await call("notes?limit=2&preview=1", "GET", undefined, false))
            .status,
          401,
        );
      },
    );
    await t.test(
      "fuzzy cache invalidates when indexed content changes",
      async () => {
        assert.equal(
          (await value<SearchResult[]>("search?q=type%3Atask%20cachemilestne"))
            .length,
          0,
        );
        const item = await value<Task>("tasks", "POST", {
          title: "Cachemilestone",
        });
        assert.deepEqual(
          (
            await value<SearchResult[]>("search?q=type%3Atask%20cachemilestne")
          ).map((result) => result.id),
          [item.id],
        );
        const database = sqlite();
        const prepare = database.prepare;
        let vocabularyReads = 0;
        database.prepare = ((sql: string) => {
          if (sql.includes("_fts_vocab")) vocabularyReads++;
          return prepare.call(database, sql);
        }) as typeof database.prepare;
        try {
          database.prepare("UPDATE session SET user_agent=user_agent").run();
          assert.deepEqual(
            (
              await value<SearchResult[]>(
                "search?q=type%3Atask%20cachemilestne",
              )
            ).map((result) => result.id),
            [item.id],
          );
          assert.equal(
            vocabularyReads,
            0,
            "Authentication writes must preserve the fuzzy cache",
          );
        } finally {
          database.prepare = prepare;
        }
        const { fuzzyQuery } = await import("../src/lib/server/search");
        assert.throws(
          database.transaction(() => {
            database
              .prepare("UPDATE tasks SET title=? WHERE id=?")
              .run("Interimmilestone", item.id);
            assert.match(
              fuzzyQuery("interimmilestne", "tasks"),
              /interimmilestone/,
            );
            throw new Error("Rollback cache fixture");
          }),
          /Rollback cache fixture/,
        );
        database
          .prepare("UPDATE tasks SET title=? WHERE id=?")
          .run("Freshmilestone", item.id);
        assert.equal(
          fuzzyQuery("interimmilestne", "tasks"),
          "",
          "Rolled-back versions must not seed the cache",
        );
        database
          .prepare("UPDATE tasks SET title=? WHERE id=?")
          .run(item.title, item.id);
        assert.equal(
          (
            await call(`tasks/${item.id}`, "DELETE", {
              revision: item.revision,
            })
          ).status,
          200,
        );
        assert.equal(
          (await value<SearchResult[]>("search?q=type%3Atask%20cachemilestne"))
            .length,
          0,
        );
      },
    );
    await t.test(
      "search spans all types, tolerates typos, applies tags and denies anonymous access",
      async () => {
        task = await value<Task>("tasks", "POST", { title: "Review nebula" });
        bookmark = await value<Bookmark>("bookmarks", "POST", {
          url: "http://127.0.0.1/nebula",
          collection: "Research",
        });
        bookmark = await value<Bookmark>(`bookmarks/${bookmark.id}`, "PATCH", {
          revision: bookmark.revision,
          title: "Nebula reference",
        });
        const results = await value<SearchResult[]>("search?q=nebula");
        assert.deepEqual([...new Set(results.map((r) => r.type))].sort(), [
          "bookmark",
          "note",
          "task",
        ]);
        assert.deepEqual(
          (await value<SearchResult[]>("search?q=type%3Atask%20neubla")).map(
            (r) => r.id,
          ),
          [task.id],
        );
        const tag = await value<{ id: string }>("tags", "POST", {
          name: "Work notes",
          color: "blue",
        });
        target = await value<Note>(`notes/${target.id}`, "PATCH", {
          revision: target.revision,
          tags: [tag.id],
        });
        assert.deepEqual(
          (
            await value<SearchResult[]>(
              "search?q=tag%3A%22Work%20notes%22%20nebula",
            )
          ).map((r) => r.id),
          [target.id],
        );
        assert.equal(
          (await call("search?q=nebula", "GET", undefined, false)).status,
          401,
        );
        assert.equal(
          (await value<SearchResult[]>("search?q=%21%21%21")).length,
          0,
        );
        assert.equal(
          (await call(`notes/${target.id}/history`, "GET", undefined, false))
            .status,
          401,
        );
        assert.equal(
          (await call("notes?view=journal", "GET", undefined, false)).status,
          401,
        );
      },
    );
    await t.test(
      "stable links follow renames and exclude trashed targets, tasks and bookmarks connect",
      async () => {
        task = await value<Task>(`tasks/${task.id}`, "PATCH", {
          revision: task.revision,
          noteId: target.id,
        });
        bookmark = await value<Bookmark>(`bookmarks/${bookmark.id}`, "PATCH", {
          revision: bookmark.revision,
          noteId: target.id,
        });
        target = await value<Note>(`notes/${target.id}`, "PATCH", {
          revision: target.revision,
          title: "Renamed architecture",
        });
        const connections = await value<Connections>(
          `notes/${target.id}/connections`,
        );
        assert.equal(connections.incoming[0].id, source.id);
        assert.equal(connections.tasks[0].id, task.id);
        assert.equal(connections.bookmarks[0].id, bookmark.id);
        assert.equal(
          (await value<Connections>(`notes/${source.id}/connections`))
            .outgoing[0].title,
          target.title,
        );
        target = await value<Note>(`notes/${target.id}`, "PATCH", {
          revision: target.revision,
          trashed: true,
        });
        assert.equal(
          (await value<Connections>(`notes/${source.id}/connections`)).outgoing
            .length,
          0,
        );
        assert.equal(
          (
            await call(`tasks/${task.id}`, "PATCH", {
              revision: task.revision,
              noteId: target.id,
            })
          ).status,
          400,
        );
        target = await value<Note>(`notes/${target.id}`, "PATCH", {
          revision: target.revision,
          trashed: false,
        });
      },
    );
    await t.test(
      "history coalesces autosaves, preserves replaced content, and rejects stale restore",
      async () => {
        source = await value<Note>(`notes/${source.id}`, "PATCH", {
          revision: source.revision,
          title: "Edited project",
          document: document("First revision"),
        });
        source = await value<Note>(`notes/${source.id}`, "PATCH", {
          revision: source.revision,
          document: document("Second revision"),
        });
        const versions = await value<NoteVersion[]>(
          `notes/${source.id}/history`,
        );
        assert.equal(versions.length, 1);
        assert.equal(
          (
            await call(
              `notes/${source.id}/history/${versions[0].id}/restore`,
              "POST",
              {
                revision: source.revision - 1,
              },
            )
          ).status,
          409,
        );
        source = await value<Note>(
          `notes/${source.id}/history/${versions[0].id}/restore`,
          "POST",
          { revision: source.revision },
        );
        assert.equal(source.title, "Project nebula");
        assert.equal(
          (await value<NoteVersion[]>(`notes/${source.id}/history`)).length,
          2,
        );
        const current = await value<NoteVersion>(
          `notes/${source.id}/history/${(await value<NoteVersion[]>(`notes/${source.id}/history`))[0].id}`,
        );
        assert.match(JSON.stringify(current.document), /Second revision/);
        assert.equal(
          (await value<Connections>(`notes/${target.id}/connections`))
            .incoming[0].id,
          source.id,
        );
        for (let i = 0; i < 105; i++)
          checkpoint({ ...source, title: `Checkpoint ${i}` }, true);
        assert.equal(
          (await value<NoteVersion[]>(`notes/${source.id}/history`)).length,
          100,
        );
      },
    );
    await t.test(
      "completing recurrence creates exactly one next occurrence and keeps month anchor",
      async () => {
        const recurring = await value<Task>("tasks", "POST", {
          title: "Monthly review",
          dueDate: "2026-01-31",
          recurrence: "monthly",
          noteId: target.id,
        });
        const completions = await Promise.all([
          call(`tasks/${recurring.id}`, "PATCH", {
            revision: 1,
            completed: true,
          }),
          call(`tasks/${recurring.id}`, "PATCH", {
            revision: 1,
            completed: true,
          }),
        ]);
        assert.deepEqual(completions.map((r) => r.status).sort(), [200, 409]);
        let list = await allTasks();
        const next = list.find((r) => r.parentTaskId === recurring.id)!;
        assert.equal(next.dueDate, "2026-02-28");
        assert.equal(next.noteId, target.id);
        const editedNext = await value<Task>(`tasks/${next.id}`, "PATCH", {
          revision: next.revision,
          title: "Edited monthly review",
          dueDate: next.dueDate,
          recurrence: next.recurrence,
        });
        await value<Task>(`tasks/${next.id}`, "PATCH", {
          revision: editedNext.revision,
          completed: true,
        });
        list = await allTasks();
        assert.equal(
          list.find((r) => r.parentTaskId === next.id)?.dueDate,
          "2026-03-31",
        );
        const old = list.find((r) => r.id === recurring.id)!;
        const reopened = await value<Task>(`tasks/${old.id}`, "PATCH", {
          revision: old.revision,
          completed: false,
        });
        await value<Task>(`tasks/${old.id}`, "PATCH", {
          revision: reopened.revision,
          completed: true,
        });
        assert.equal(
          (await allTasks()).filter((r) => r.parentTaskId === recurring.id)
            .length,
          1,
        );
        assert.equal(
          (
            await call("tasks", "POST", {
              title: "Invalid date",
              dueDate: "2026-02-30",
            })
          ).status,
          400,
        );
        assert.equal(
          (
            await call("tasks", "POST", {
              title: "Missing date",
              recurrence: "daily",
            })
          ).status,
          400,
        );
      },
    );
    await t.test(
      "journal entries are blank, unique per day, and listed apart from notes",
      async () => {
        const blank = await value<Note>("journals", "POST", {
          date: "2026-10-03",
        });
        assert.equal(blank.text.trim(), "");
        assert.equal(blank.document.blocks.length, 1);
        assert.equal(blank.dailyDate, "2026-10-03");
        const trashed = await value<Note>(`notes/${blank.id}`, "PATCH", {
          revision: blank.revision,
          trashed: true,
        });
        assert.equal(
          (await call("journals", "POST", { date: "2026-10-03" })).status,
          409,
        );
        await value(`trash/journal/${blank.id}`, "DELETE", {
          revision: trashed.revision,
        });
        const form = new FormData();
        form.set("note", source.id);
        form.set("file", new File(["attachment payload"], "reference.txt"));
        const file = await value<{ id: string; url: string }>(
          "files",
          "POST",
          form,
        );
        fileId = file.id;
        source = await value<Note>(`notes/${source.id}`, "PATCH", {
          revision: source.revision,
          document: {
            schemaVersion: 1,
            blocks: [
              { type: "file", props: { url: file.url, name: "reference.txt" } },
            ],
          },
        });
        const days = await Promise.all([
          value<Note>("journals", "POST", { date: "2026-10-04" }),
          value<Note>("journals", "POST", { date: "2026-10-04" }),
        ]);
        assert.equal(days[0].id, days[1].id);
        assert.equal(days[0].dailyDate, "2026-10-04");
        const journal = await value<Note[]>("notes?view=journal");
        assert.deepEqual(
          journal.map((note) => note.id),
          [days[0].id],
        );
        assert.ok(
          !(await value<Note[]>("notes?view=all")).some(
            (note) => note.id === days[0].id,
          ),
        );
        assert.ok(
          (await value<Note[]>("notes?view=all")).some(
            (note) => note.id === source.id,
          ),
        );
        assert.equal(
          (await call("journals", "POST", { date: "2026-02-30" })).status,
          400,
        );
        assert.deepEqual(
          (await value<{ items: unknown[] }>("templates")).items,
          [],
        );
      },
    );
    await t.test(
      "portable bundles remap note links, task series, artifacts and history",
      async () => {
        const tag = await value<{ id: string }>("tags", "POST", {
          name: "Universal organization",
          color: "gray",
        });
        const artifact = await value<{ id: string; revision: number }>(
          "artifacts",
          "POST",
          {
            text: "Indexed artifact words",
          },
        );
        for (const [type, item] of [
          ["note", source],
          ["task", task],
          ["bookmark", bookmark],
          ["artifact", artifact],
        ] as const) {
          const endpoint = `item-tags/${type}/${item.id}`;
          assert.equal(
            (await call(endpoint, "GET", undefined, false)).status,
            401,
          );
          const current = await value<{ revision: number }>(endpoint);
          const tagged = await value<{
            revision: number;
            tags: { id: string }[];
          }>(endpoint, "PATCH", { revision: current.revision, tags: [tag.id] });
          assert.equal(tagged.tags[0].id, tag.id);
          assert.equal(
            (
              await call(endpoint, "PATCH", {
                revision: current.revision,
                tags: [],
              })
            ).status,
            409,
          );
          assert.equal(
            (
              await call(endpoint, "PATCH", {
                revision: tagged.revision,
                tags: ["invalid"],
              })
            ).status,
            400,
          );
        }
        const organized = await value<{ items: { type: string }[] }>(
          `tags/${tag.id}/items?limit=60`,
        );
        assert.deepEqual(
          new Set(organized.items.map((item) => item.type)),
          new Set(["note", "task", "bookmark", "artifact"]),
        );
        assert.equal(
          (await call(`tags/${tag.id}/items?limit=1000`)).status,
          400,
        );
        assert.equal(
          (await call(`tags/${tag.id}/items?limit=60`, "GET", undefined, false))
            .status,
          401,
        );
        assert.equal(
          (await call("favorites?limit=60", "GET", undefined, false)).status,
          401,
        );
        assert.equal((await call("favorites?limit=1000")).status, 400);
        assert.equal((await call("favorites?offset=-1")).status, 400);
        assert.ok(
          Array.isArray(
            (await value<{ items: unknown[] }>("favorites?limit=60")).items,
          ),
        );
        const portableBoard = await value<import("../src/lib/types").Board>(
          "boards",
          "POST",
          { name: "Portable project" },
        );
        const portableTask = await value<Task>("tasks", "POST", {
          title: "Portable project task",
          boardId: portableBoard.id,
          status: "in_progress",
        });
        await value("boards/" + portableBoard.id, "PATCH", {
          revision: portableBoard.revision,
          archived: true,
        });
        const readAt = Date.now();
        sqlite()
          .prepare("UPDATE bookmarks SET read_at=? WHERE id=?")
          .run(readAt, bookmark.id);
        const exported = await call("export/bundle");
        const bytes = new Uint8Array(await exported.arrayBuffer());
        const manifest = JSON.parse(
          strFromU8(unzipSync(bytes)["manifest.json"]),
        );
        assert.equal(manifest.version, 5);
        assert.ok(
          manifest.calendar.artifacts.some(
            (item: { id: string }) => item.id === artifact.id,
          ),
        );
        assert.ok(
          manifest.tasks.some((item: { tags: { name: string }[] }) =>
            item.tags.some((tag) => tag.name === "Universal organization"),
          ),
        );
        assert.ok(
          manifest.bookmarks.some((item: { tags: { name: string }[] }) =>
            item.tags.some((tag) => tag.name === "Universal organization"),
          ),
        );
        assert.deepEqual(
          manifest.bookmarkReading.readStates.find(
            (item: { bookmarkId: string }) => item.bookmarkId === bookmark.id,
          ),
          { bookmarkId: bookmark.id, readAt },
        );
        assert.equal("articles" in manifest.bookmarkReading, false);
        assert.equal("highlights" in manifest.bookmarkReading, false);
        const invalid = structuredClone(manifest);
        invalid.tasks[0].parentTaskId = invalid.tasks[0].id;
        const invalidEntries = unzipSync(bytes);
        invalidEntries["manifest.json"] = strToU8(JSON.stringify(invalid));
        const countBeforeInvalid = (await allTasks()).length;
        assert.equal(
          (await call("import/bundle", "POST", zipSync(invalidEntries))).status,
          400,
        );
        assert.equal((await allTasks()).length, countBeforeInvalid);

        assert.ok(manifest.history.length);
        const before = await allTasks();
        const imported = await value<{ dailyConflicts: number }>(
          "import/bundle",
          "POST",
          bytes,
        );
        assert.equal(imported.dailyConflicts, 1);
        const portableRows = sqlite()
          .prepare(
            "SELECT t.id,t.open_stage,t.board_id,b.archived_at FROM tasks t JOIN task_boards b ON b.id=t.board_id WHERE t.title=? AND t.id<>?",
          )
          .all(portableTask.title, portableTask.id) as {
          id: string;
          open_stage: string;
          board_id: string;
          archived_at: number | null;
        }[];
        assert.equal(portableRows.length, 1);
        assert.equal(portableRows[0].open_stage, "in_progress");
        assert.notEqual(portableRows[0].board_id, portableBoard.id);
        assert.ok(portableRows[0].archived_at);
        const after = await allTasks();
        const restored = after.filter(
          (r) => !before.some((b) => b.id === r.id),
        );
        const linked = restored.find((r) => r.title === task.title)!;
        const restoredTags = await value<{ tags: { name: string }[] }>(
          `item-tags/task/${linked.id}`,
        );
        assert.ok(
          restoredTags.tags.some(
            (tag) => tag.name === "Universal organization",
          ),
        );
        assert.notEqual(linked.noteId, target.id);
        assert.ok(linked.noteId);
        const series = restored.find((r) => r.parentTaskId !== null)!;
        assert.ok(restored.some((r) => r.id === series.parentTaskId));
        const importedTarget = await value<Connections>(
          `notes/${linked.noteId}/connections`,
        );
        assert.equal(importedTarget.incoming.length, 0);
        const copies = await value<Note[]>("notes");
        const copiedSource = copies.find(
          (n) => n.title === source.title && n.id !== source.id,
        )!;
        assert.equal(
          (await value<NoteVersion[]>(`notes/${copiedSource.id}/history`))
            .length,
          100,
        );
        const copiedHistory = await value<NoteVersion>(
          `notes/${copiedSource.id}/history/${(await value<NoteVersion[]>(`notes/${copiedSource.id}/history`))[0].id}`,
        );
        assert.ok(copiedHistory.document);
        assert.match(
          JSON.stringify(copiedHistory.document),
          new RegExp(linked.noteId!),
        );
        const legacyManifest = structuredClone(manifest);
        const restoredReadAt = readAt + 1_000;
        legacyManifest.bookmarkReading = {
          readStates: [
            {
              bookmarkId: bookmark.id,
              readAt: restoredReadAt,
              articleStatus: "ready",
              articleGeneration: 1,
              articleVersion: 1,
            },
          ],
          articles: [
            {
              bookmarkId: bookmark.id,
              version: 1,
              sourceUrl: bookmark.url,
              capturedAt: readAt,
              title: "Legacy reader archive",
              byline: null,
              content: {
                blocks: [
                  {
                    type: "paragraph",
                    children: [
                      { type: "text", text: "Archived article body." },
                    ],
                  },
                ],
              },
              plainText: "Archived article body.",
              fingerprint: "c".repeat(64),
            },
          ],
          highlights: [
            {
              id: randomUUID(),
              bookmarkId: bookmark.id,
              articleVersion: 1,
              quote: "article body",
              prefix: "Archived ",
              suffix: ".",
              startOffset: 9,
              endOffset: 21,
              annotation: "Legacy annotation",
              revision: 1,
              createdAt: readAt,
              updatedAt: readAt,
            },
          ],
        };
        const legacyEntries = unzipSync(bytes);
        legacyEntries["manifest.json"] = strToU8(
          JSON.stringify(legacyManifest),
        );
        const archiveCounts = () =>
          sqlite()
            .prepare(
              "SELECT (SELECT count(*) FROM bookmark_articles WHERE bookmark_id=?) AS articles,(SELECT count(*) FROM bookmark_highlights WHERE bookmark_id=?) AS highlights",
            )
            .get(bookmark.id, bookmark.id) as {
            articles: number;
            highlights: number;
          };
        const beforeLegacyImport = archiveCounts();
        const beforeLegacyState = sqlite()
          .prepare(
            "SELECT article_status AS articleStatus,article_version AS articleVersion FROM bookmarks WHERE id=?",
          )
          .get(bookmark.id) as {
          articleStatus: string;
          articleVersion: number;
        };
        await value("import/bundle", "POST", zipSync(legacyEntries));
        assert.deepEqual(archiveCounts(), beforeLegacyImport);
        assert.deepEqual(
          sqlite()
            .prepare(
              "SELECT read_at AS readAt,article_status AS articleStatus,article_version AS articleVersion FROM bookmarks WHERE id=?",
            )
            .get(bookmark.id),
          { readAt: restoredReadAt, ...beforeLegacyState },
        );
      },
    );
    await t.test(
      "recovery rejects a task search index that disagrees with its records",
      async () => {
        const backups = await import("../src/lib/server/backups");
        sqlite()
          .prepare("INSERT INTO tasks_fts(tasks_fts) VALUES('delete-all')")
          .run();
        try {
          const inconsistent = await backups.startBackup();
          await assert.rejects(backups.verifyBackup(inconsistent.id));
        } finally {
          sqlite()
            .prepare("INSERT INTO tasks_fts(tasks_fts) VALUES('rebuild')")
            .run();
        }
      },
    );
    await t.test(
      "encrypted full-instance recovery includes connections, schedules, journal and versions",
      async () => {
        const backups = await import("../src/lib/server/backups");
        const backup = await backups.startBackup();
        await backups.verifyBackup(backup.id);
        const destination = path.join(directory, "restored");
        await backups.restoreBackup(backup.id, destination);
        assert.equal(
          (
            await createStorage({ NIVRA_DATA_DIR: destination }).read(fileId)
          ).toString(),
          "attachment payload",
        );
        const Database = (await import("better-sqlite3")).default;
        const { masterKey, deriveKey } =
          await import("../src/lib/server/encryption");
        const recovered = new Database(path.join(destination, "nivra.sqlite"));
        recovered.pragma("cipher='chacha20'");
        recovered.pragma(
          `key='${deriveKey(masterKey(destination, true), "sqlite").toString("hex")}'`,
        );
        assert.ok(
          (
            recovered
              .prepare("SELECT count(*) AS n FROM note_versions")
              .get() as { n: number }
          ).n >= 200,
        );
        assert.ok(
          (
            recovered
              .prepare(
                "SELECT count(*) AS n FROM tasks WHERE recurrence IS NOT NULL",
              )
              .get() as { n: number }
          ).n >= 6,
        );
        assert.equal(
          (
            recovered
              .prepare(
                "SELECT count(*) AS n FROM notes WHERE daily_date IS NOT NULL",
              )
              .get() as { n: number }
          ).n,
          1,
        );
        assert.ok(
          (
            recovered
              .prepare(
                "SELECT count(*) AS n FROM tasks_fts WHERE tasks_fts MATCH ?",
              )
              .get("monthly") as { n: number }
          ).n >= 2,
        );
        for (const type of ["note", "task", "bookmark", "artifact"]) {
          const table = `${type}_tags`;
          const expected = sqlite()
            .prepare(`SELECT count(*) AS n FROM ${table}`)
            .get() as { n: number };
          const actual = recovered
            .prepare(`SELECT count(*) AS n FROM ${table}`)
            .get() as { n: number };
          assert.ok(expected.n > 0);
          assert.equal(actual.n, expected.n);
        }
        recovered.close();
      },
    );
  } finally {
    await (await import("../src/lib/server/jobs")).stopJobWorker();
    sqlite().close();
    await rm(directory, { recursive: true, force: true });
  }
});
