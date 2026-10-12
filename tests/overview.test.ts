import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

test("overview is private, bounded, date-aware and reflects workspace changes", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "nivra-overview-"));
  process.env.NIVRA_DATA_DIR = directory;
  const routes = await import("../src/app/api/v1/[...path]/route");
  const { sqlite, db } = await import("../src/lib/server/db");
  const { bookmarks } = await import("../src/lib/server/schema");
  const { workspaceOverview } = await import("../src/lib/server/overview");
  let cookie = "";
  const call = (
    route: string,
    method = "GET",
    body?: unknown,
    authenticated = true,
  ) =>
    routes.GET(
      new Request(`http://localhost:3000/api/v1/${route}`, {
        method,
        headers: {
          host: "localhost:3000",
          origin: "http://localhost:3000",
          "content-type": "application/json",
          ...(authenticated ? { cookie } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      { params: Promise.resolve({ path: route.split("?")[0].split("/") }) },
    );
  const value = async (route: string, method = "GET", body?: unknown) => {
    const response = await call(route, method, body);
    assert.ok(response.ok, await response.clone().text());
    return response.json();
  };
  try {
    const setup = await call(
      "setup",
      "POST",
      {
        name: "Overview Owner",
        username: "overview",
        password: `Test-${randomUUID()}`,
      },
      false,
    );
    assert.equal(setup.status, 200);
    cookie = setup.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    await t.test(
      "requires owner authentication and a valid local calendar date",
      async () => {
        assert.equal(
          (await call("overview?date=2026-10-05", "GET", undefined, false))
            .status,
          401,
        );
        for (const date of ["2026-02-30", "wrong", "2026-10-05' OR 1=1"])
          assert.equal(
            (await call(`overview?date=${encodeURIComponent(date)}`)).status,
            400,
          );
        assert.equal((await call("overview")).status, 400);
        const response = await call("overview?date=2026-10-05");
        assert.equal(response.headers.get("cache-control"), "no-store");
        assert.deepEqual((await response.json()).counts, {
          open: 0,
          today: 0,
          overdue: 0,
        });
      },
    );
    const owner = (await value("status")).owner.id;
    const ids: string[] = [];
    for (let i = 0; i < 25; i++) {
      const note = await value("notes", "POST", { title: `Note ${i}` });
      ids.push(note.id);
      sqlite()
        .prepare("UPDATE notes SET updated_at=? WHERE id=?")
        .run(100 + i, note.id);
    }
    await value("notes", "POST", { title: "Trashed recent note" }).then(
      (note) =>
        sqlite()
          .prepare("UPDATE notes SET trashed_at=?,updated_at=? WHERE id=?")
          .run(Date.now(), Date.now(), note.id),
    );
    for (let i = 0; i < 25; i++)
      db()
        .insert(bookmarks)
        .values({
          id: randomUUID(),
          ownerId: owner,
          url: `https://example.com/${i}`,
          title: `Bookmark ${i}`,
          description: "Saved description",
          siteName: "Example",
          createdAt: 100 + i,
          updatedAt: 100 + i,
        })
        .run();
    let recurring: { id: string; revision: number };
    let createdAt = 1000;
    for (const [title, dueDate] of [
      ["Undated", null],
      ["Future", "2026-10-20"],
      ["Overdue", "2026-10-01"],
      ["Today recurring", "2026-10-05"],
      ["Tomorrow", "2026-10-06"],
      ["Later", "2026-10-25"],
      ["Completed", "2026-10-05"],
    ] as const) {
      const task = await value("tasks", "POST", {
        title,
        dueDate,
        ...(title === "Today recurring" ? { recurrence: "daily" } : {}),
      });
      sqlite()
        .prepare("UPDATE tasks SET created_at=? WHERE id=?")
        .run(createdAt++, task.id);
      if (title === "Today recurring") recurring = task;
      if (title === "Completed")
        await value(`tasks/${task.id}`, "PATCH", {
          revision: task.revision,
          completed: true,
        });
    }
    await t.test(
      "caps recents, excludes trash, and sorts by latest edit",
      async () => {
        const snapshot = await value("overview?date=2026-10-05");
        assert.deepEqual(
          snapshot.notes.map((n: { title: string }) => n.title),
          Array.from({ length: 20 }, (_, i) => `Note ${24 - i}`),
        );
        assert.deepEqual(
          snapshot.bookmarks.map((b: { title: string }) => b.title),
          Array.from({ length: 20 }, (_, i) => `Bookmark ${24 - i}`),
        );
        assert.ok(snapshot.refreshedAt > 0);
        assert.ok(
          snapshot.notes.every(
            (n: object) => !("document" in n) && !("text" in n),
          ),
        );
        assert.ok(snapshot.bookmarks.every((b: object) => !("ownerId" in b)));
      },
    );
    await t.test(
      "counts open tasks and lists newest first regardless of due date",
      async () => {
        const snapshot = await value("overview?date=2026-10-05");
        assert.deepEqual(snapshot.counts, { open: 6, today: 1, overdue: 1 });
        assert.deepEqual(
          snapshot.tasks.map((task: { title: string }) => task.title),
          [
            "Later",
            "Tomorrow",
            "Today recurring",
            "Overdue",
            "Future",
            "Undated",
          ],
        );
        assert.deepEqual((await value("overview?date=2026-10-06")).counts, {
          open: 6,
          today: 1,
          overdue: 2,
        });
        assert.deepEqual(workspaceOverview(randomUUID(), "2026-10-05").counts, {
          open: 0,
          today: 0,
          overdue: 0,
        });
        assert.equal(
          workspaceOverview(randomUUID(), "2026-10-05").notes.length,
          0,
        );
        assert.equal(
          workspaceOverview(randomUUID(), "2026-10-05").bookmarks.length,
          0,
        );
      },
    );
    await t.test(
      "creation ties match Tasks and edits do not reorder tasks",
      async () => {
        const { listTasks } = await import("../src/lib/server/tasks");
        const rows = sqlite()
          .prepare(
            "SELECT id,created_at AS createdAt FROM tasks WHERE completed_at IS NULL ORDER BY created_at DESC",
          )
          .all() as { id: string; createdAt: number }[];
        try {
          sqlite()
            .prepare("UPDATE tasks SET created_at=? WHERE completed_at IS NULL")
            .run(2000);
          sqlite()
            .prepare("UPDATE tasks SET updated_at=? WHERE id=?")
            .run(Date.now(), rows[rows.length - 1].id);
          const expected = rows
            .map((row) => row.id)
            .sort()
            .reverse();
          assert.deepEqual(
            (await value("overview?date=2026-10-05")).tasks.map(
              (task: { id: string }) => task.id,
            ),
            expected,
          );
          assert.deepEqual(
            listTasks(owner)
              .filter((task) => task.completedAt === null)
              .map((task) => task.id),
            expected,
          );
        } finally {
          for (const row of rows)
            sqlite()
              .prepare("UPDATE tasks SET created_at=? WHERE id=?")
              .run(row.createdAt, row.id);
        }
      },
    );
    await t.test(
      "refresh includes edits and recurring successor after completion",
      async () => {
        await value(`tasks/${recurring!.id}`, "PATCH", {
          revision: recurring!.revision,
          completed: true,
        });
        await value(`notes/${ids[0]}`, "PATCH", {
          revision: 1,
          title: "Latest edited note",
        });
        const snapshot = await value("overview?date=2026-10-05");
        assert.equal(snapshot.notes[0].title, "Latest edited note");
        assert.deepEqual(snapshot.counts, { open: 6, today: 0, overdue: 1 });
        const next = snapshot.tasks.find(
          (task: { title: string }) => task.title === "Today recurring",
        );
        assert.ok(next);
        assert.notEqual(next.id, recurring!.id);
        assert.equal(next.dueDate, "2026-10-06");
      },
    );
    await t.test(
      "adds bounded recent content, timezone-aware calendar events and owner-only review counts",
      async () => {
        const { modelVersion } = await import("../src/lib/server/ai/model");
        const { executeContent } =
          await import("../src/lib/server/content-service");
        const now = Date.now();
        const recentNote = await value("notes", "POST", {
          title: "Recent note",
        });
        const journal = await value("journals", "POST", {
          date: "2026-10-05",
        });
        const artifact = await value("artifacts", "POST", {
          text: "Recent artifact body",
        });
        const recentBookmarkId = randomUUID();
        db()
          .insert(bookmarks)
          .values({
            id: recentBookmarkId,
            ownerId: owner,
            url: "https://example.com/recent",
            title: "Recent bookmark",
            description: "",
            siteName: "Example",
            createdAt: now,
            updatedAt: now,
          })
          .run();
        const event = await value("events", "POST", {
          title: "Upcoming timezone event",
          allDay: true,
          start: "2026-10-07",
          end: "2026-10-08",
          timezone: "America/Los_Angeles",
          links: [],
          reminders: [],
        });

        const formId = randomUUID();
        const versionId = randomUUID();
        sqlite()
          .prepare(
            "INSERT INTO forms(id,owner_id,title,description,definition,status,created_at,updated_at) VALUES(?,?,?,'','{}','published',?,?)",
          )
          .run(formId, owner, "Review form", now, now);
        sqlite()
          .prepare(
            "INSERT INTO form_versions(id,form_id,revision,definition,created_at) VALUES(?,?,1,'{}',?)",
          )
          .run(versionId, formId, now);
        sqlite()
          .prepare("UPDATE forms SET published_version_id=? WHERE id=?")
          .run(versionId, formId);
        const insertResponse = sqlite().prepare(
          "INSERT INTO form_responses(id,form_id,version_id,answers,search_text,retry_key,request_hash,created_at) VALUES(?,?,?,'{}','',?,?,?)",
        );
        const responseIds = Array.from({ length: 10 }, () => randomUUID());
        for (const [index, id] of responseIds.entries())
          insertResponse.run(
            id,
            formId,
            versionId,
            `retry-${id}`,
            `hash-${id}`,
            now + index,
          );
        for (const id of responseIds.slice(0, 8))
          sqlite()
            .prepare("UPDATE form_responses SET reviewed=1 WHERE id=?")
            .run(id);
        sqlite()
          .prepare("UPDATE form_responses SET trashed_at=? WHERE id=?")
          .run(now, responseIds[9]);

        const trashedFormId = randomUUID();
        const trashedVersionId = randomUUID();
        const trashedResponseId = randomUUID();
        sqlite()
          .prepare(
            "INSERT INTO forms(id,owner_id,title,description,definition,status,created_at,updated_at) VALUES(?,?,?,'','{}','published',?,?)",
          )
          .run(trashedFormId, owner, "Trashed response source", now, now);
        sqlite()
          .prepare(
            "INSERT INTO form_versions(id,form_id,revision,definition,created_at) VALUES(?,?,1,'{}',?)",
          )
          .run(trashedVersionId, trashedFormId, now);
        sqlite()
          .prepare(
            "INSERT INTO form_responses(id,form_id,version_id,answers,search_text,retry_key,request_hash,created_at) VALUES(?,?,?,'{}','',?,?,?)",
          )
          .run(
            trashedResponseId,
            trashedFormId,
            trashedVersionId,
            `retry-${trashedResponseId}`,
            `hash-${trashedResponseId}`,
            now + 20,
          );
        sqlite()
          .prepare("UPDATE forms SET trashed_at=? WHERE id=?")
          .run(now + 21, trashedFormId);

        const suggestedNote = await value("notes", "POST", {
          title: "Tag review target",
        });
        const assignedNote = await value("notes", "POST", {
          title: "Already tagged target",
        });
        const staleNote = await value("notes", "POST", {
          title: "Stale proposal target",
        });
        const tagId = randomUUID();
        sqlite()
          .prepare(
            "INSERT INTO tags(id,name,color,aliases) VALUES(?,?,'gray','[]')",
          )
          .run(tagId, "Overview review tag");
        sqlite()
          .prepare("INSERT INTO note_tags(note_id,tag_id) VALUES(?,?)")
          .run(assignedNote.id, tagId);
        const attachmentId = randomUUID();
        sqlite()
          .prepare(
            "INSERT INTO attachments(id,note_id,name,mime,size,storage_key,created_at) VALUES(?,?,?,'text/plain',1,?,?)",
          )
          .run(attachmentId, suggestedNote.id, "source.txt", randomUUID(), now);
        sqlite()
          .prepare("UPDATE notes SET document=? WHERE id=?")
          .run(JSON.stringify({ attachment: attachmentId }), suggestedNote.id);
        sqlite()
          .prepare("UPDATE ai_configuration SET enabled=1 WHERE id=1")
          .run();
        const configuration = sqlite()
          .prepare(
            "SELECT vocabulary_generation AS generation FROM ai_configuration WHERE id=1",
          )
          .get() as { generation: number };
        const sourceKeys = [
          `note:${suggestedNote.id}`,
          `attachment:${attachmentId}`,
          `note:${assignedNote.id}`,
          `note:${staleNote.id}`,
        ];
        for (const sourceKey of sourceKeys) {
          const indexed = sqlite()
            .prepare("SELECT generation FROM ai_content WHERE source_key=?")
            .get(sourceKey) as { generation: number };
          sqlite()
            .prepare(
              "UPDATE ai_content SET state='indexed',model_version=?,indexed_generation=? WHERE source_key=?",
            )
            .run(modelVersion, indexed.generation, sourceKey);
        }
        const insertSuggestion = sqlite().prepare(
          "INSERT INTO ai_suggestions(source_key,id,generation,fingerprint,score,model_version,vocabulary_generation,tag_id,created_at) SELECT source_key,?,?,?,0.9,?,?,?,? FROM ai_content WHERE source_key=?",
        );
        for (const [index, sourceKey] of sourceKeys.entries()) {
          const indexed = sqlite()
            .prepare("SELECT generation FROM ai_content WHERE source_key=?")
            .get(sourceKey) as { generation: number };
          insertSuggestion.run(
            randomUUID(),
            index === sourceKeys.length - 1
              ? indexed.generation - 1
              : indexed.generation,
            "fingerprint",
            modelVersion,
            index === sourceKeys.length - 1
              ? configuration.generation - 1
              : configuration.generation,
            tagId,
            now,
            sourceKey,
          );
        }
        const recentClock = Date.now();
        for (const [id, timestamp] of [
          [recentNote.id, recentClock + 5000],
          [journal.id, recentClock + 4000],
          [artifact.id, recentClock + 3000],
          [recentBookmarkId, recentClock + 2000],
        ])
          sqlite()
            .prepare(
              "UPDATE " +
                (id === recentBookmarkId
                  ? "bookmarks"
                  : id === artifact.id
                    ? "artifacts"
                    : "notes") +
                " SET updated_at=? WHERE id=?",
            )
            .run(timestamp, id);
        const overview = await value(
          "overview?date=2026-10-05&timezone=America%2FLos_Angeles",
        );
        assert.deepEqual(overview.review, {
          formResponses: 1,
          tagSuggestions: 1,
        });
        assert.deepEqual(
          overview.calendar.map((item: { sourceId: string }) => item.sourceId),
          [event.id],
        );
        assert.deepEqual(
          overview.recentItems
            .slice(0, 4)
            .map((item: { type: string }) => item.type),
          ["note", "journal", "artifact", "bookmark"],
        );
        assert.deepEqual(
          overview.recentContent
            .slice(0, 3)
            .map((item: { type: string }) => item.type),
          ["note", "journal", "artifact"],
        );
        assert.equal(overview.recentContent.length, 8);
        assert.ok(
          overview.recentContent.every(
            (item: { type: string }) => item.type !== "bookmark",
          ),
        );
        assert.ok(
          overview.recentContent.some(
            (item: { id: string }) =>
              !overview.recentItems.some(
                (legacy: { id: string }) => legacy.id === item.id,
              ),
          ),
          "recentContent can fill its bound with non-bookmark items while legacy mixed recents retain their original bound",
        );
        assert.equal(
          overview.recentItems[1].date,
          "2026-10-05",
          "journal summaries carry their journal date and type",
        );
        assert.ok(
          overview.recentItems.length <= 8 && overview.calendar.length <= 5,
        );
        assert.equal(overview.recentResponses.length, 5);
        assert.deepEqual(
          overview.recentResponses,
          responseIds
            .slice(4, 9)
            .reverse()
            .map((id, index) => ({
              id,
              formId,
              formTitle: "Review form",
              createdAt: now + 8 - index,
              reviewed: index !== 0,
            })),
        );
        assert.ok(
          !overview.recentResponses.some(
            (response: { id: string }) =>
              response.id === responseIds[9] ||
              response.id === trashedResponseId,
          ),
          "trashed responses and responses under trashed forms are omitted",
        );
        assert.ok(
          overview.recentResponses.every(
            (response: object) =>
              Object.keys(response).sort().join(",") ===
              "createdAt,formId,formTitle,id,reviewed",
          ),
          "recent form metadata excludes answers, files, and other private response content",
        );
        const { extraOutputs } =
          await import("../src/lib/server/api-extra-schemas");
        assert.deepEqual(extraOutputs.overview.parse(overview), overview);
        assert.equal(
          extraOutputs.overview.safeParse({
            ...overview,
            recentResponses: [
              ...overview.recentResponses,
              overview.recentResponses[0],
            ],
          }).success,
          false,
          "the overview response schema caps recent form metadata at five items",
        );
        const emptyOwnerOverview = workspaceOverview(
          randomUUID(),
          "2026-10-05",
          "UTC",
          true,
        );
        assert.deepEqual(emptyOwnerOverview.recentResponses, []);
        assert.equal(
          Object.hasOwn(
            workspaceOverview(owner, "2026-10-05"),
            "recentResponses",
          ),
          false,
          "direct callers keep the previous default owner-only metadata behavior",
        );
        assert.ok(!("suggestions" in overview));
        const agentOverview = await executeContent({
          ownerId: owner,
          principal: {
            ownerId: owner,
            connectionId: "test-read-agent",
            scopes: ["nivra:read"],
          },
          origin: "http://localhost:3000",
          path: ["overview"],
          method: "GET",
          query: new URLSearchParams(
            "date=2026-10-05&timezone=America%2FLos_Angeles",
          ),
        });
        assert.ok("data" in agentOverview);
        assert.ok(
          !("review" in (agentOverview.data as object)),
          "review counts stay out of the agent-visible overview DTO",
        );
        assert.ok(
          !("recentResponses" in (agentOverview.data as object)),
          "recent response metadata stays out of the agent-visible overview DTO",
        );
        assert.ok(
          !(
            (agentOverview.data as { recentContent: unknown[] })
              .recentContent ?? []
          ).some(
            (item) =>
              typeof item === "object" &&
              item !== null &&
              "type" in item &&
              item.type === "bookmark",
          ),
          "agent recentContent contains no duplicate bookmark entries",
        );
        assert.equal(
          (await call("overview?date=2026-10-05&timezone=Invalid%2FZone"))
            .status,
          400,
        );
      },
    );
  } finally {
    sqlite().close();
    await rm(directory, { recursive: true, force: true });
  }
});
