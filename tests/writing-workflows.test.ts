import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { canonicalizeTaskLinks } from "../src/lib/writing";
import type { Document } from "../src/lib/types";

test("writing workflows preserve task links, templates, and journal periods", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "nivra-writing-"));
  const previousDirectory = process.env.NIVRA_DATA_DIR;
  process.env.NIVRA_DATA_DIR = directory;
  const { sqlite } = await import("../src/lib/server/db");
  const { createNote, getNote } = await import("../src/lib/server/notes");
  const { createTask, deleteTask, getTask, updateTask } =
    await import("../src/lib/server/tasks");
  const { createEvent } = await import("../src/lib/server/calendar");
  const { apiOutputs } = await import("../src/lib/server/api-schemas");
  const {
    canonicalizeExistingTaskLinks,
    executeWriting,
    materializeTaskLinks,
  } = await import("../src/lib/server/writing-service");
  const database = sqlite();
  const owner = randomUUID();
  database
    .prepare(
      "INSERT INTO user(id,name,email,username,created_at,updated_at) VALUES(?,?,?,?,?,?)",
    )
    .run(owner, "Writing Owner", `${owner}@example.test`, `u-${owner}`, 1, 1);
  const command = async (
    method: string,
    pathParts: string[],
    input?: unknown,
    query?: string,
  ) => {
    const result = await executeWriting({
      ownerId: owner,
      origin: "http://localhost",
      path: pathParts,
      method,
      input,
      query: query ? new URLSearchParams(query) : undefined,
    });
    assert.ok(result && "data" in result);
    return result;
  };
  const document = (...blocks: Record<string, unknown>[]) => ({
    schemaVersion: 1 as const,
    blocks,
  });
  const textBlock = (id: string, text: string) => ({
    id,
    type: "paragraph",
    content: [{ type: "text", text, styles: {} }],
  });

  try {
    await t.test(
      "task conversion is revision-safe, idempotent, and unlinkable",
      async () => {
        const note = createNote(
          owner,
          "Weekend plans",
          document({
            id: "check-1",
            type: "checkListItem",
            props: { checked: false },
            content: [
              { type: "text", text: "Replace the air filter", styles: {} },
            ],
          }),
        );
        const input = {
          revision: note.revision,
          blockId: "check-1",
          idempotencyKey: "air-filter-task-01",
        };
        const created = await command(
          "POST",
          ["notes", note.id, "tasks"],
          input,
        );
        assert.ok(created);
        assert.equal(created.status, 201);
        const result = created.data as {
          note: typeof note;
          task: ReturnType<typeof getTask>;
          created: boolean;
        };
        assert.equal(result.created, true);
        assert.equal(result.task.title, "Replace the air filter");
        assert.equal(result.task.noteId, note.id);
        assert.equal(result.note.revision, note.revision + 1);

        const replay = await command(
          "POST",
          ["notes", note.id, "tasks"],
          input,
        );
        assert.ok(replay);
        assert.equal(replay.status, 200);
        assert.equal((replay.data as typeof result).created, false);
        await assert.rejects(
          command("POST", ["notes", note.id, "tasks"], {
            ...input,
            title: "Different request",
          }),
          /idempotency key/,
        );

        let current = getNote(note.id)!;
        const live = materializeTaskLinks(current.document, owner, note.id);
        assert.equal(live.blocks[0].type, "taskLink");
        assert.equal(
          (live.blocks[0].props as Record<string, unknown>).taskAvailable,
          true,
        );
        assert.equal(
          (live.blocks[0].props as Record<string, unknown>).taskTitle,
          "Replace the air filter",
        );
        const forged = structuredClone(current.document);
        forged.blocks[0].props = {
          ...(forged.blocks[0].props as Record<string, unknown>),
          taskId: randomUUID(),
        };
        const canonicalLinked = canonicalizeExistingTaskLinks(
          forged,
          owner,
          note.id,
        );
        assert.equal(
          (canonicalLinked.blocks[0].props as Record<string, unknown>).taskId,
          result.task.id,
        );
        const forgedBlock = structuredClone(current.document);
        forgedBlock.blocks[0].id = "forged-task-block";
        assert.throws(
          () => canonicalizeExistingTaskLinks(forgedBlock, owner, note.id),
          /Create linked tasks/,
        );
        current = getNote(note.id)!;
        const completed = updateTask(owner, result.task.id, {
          revision: result.task.revision,
          completed: true,
        });
        assert.ok(completed.completedAt);
        const updatedLive = materializeTaskLinks(
          current.document,
          owner,
          note.id,
        );
        assert.equal(
          (updatedLive.blocks[0].props as Record<string, unknown>)
            .taskCompleted,
          true,
        );
        assert.equal(
          (updatedLive.blocks[0].props as Record<string, unknown>)
            .fallbackChecked,
          false,
        );
        assert.equal(
          typeof (updatedLive.blocks[0].props as Record<string, unknown>)
            .taskRevision,
          "number",
        );
        const canonical = canonicalizeTaskLinks(updatedLive) as Document;
        const canonicalProps = canonical.blocks[0].props as Record<
          string,
          unknown
        >;
        assert.equal(canonicalProps.fallbackChecked, false);
        assert.equal("taskTitle" in canonicalProps, false);
        assert.equal("taskCompleted" in canonicalProps, false);
        assert.equal("taskRevision" in canonicalProps, false);
        assert.equal("taskAvailable" in canonicalProps, false);
        const template = await command("POST", ["templates"], {
          name: "Air filter checklist",
          kind: "note",
          sourceNoteId: note.id,
          sourceRevision: current.revision,
        });
        assert.ok(template);
        const templateBlock = (template.data as { document: Document }).document
          .blocks[0];
        assert.equal(templateBlock.type, "checkListItem");
        assert.equal(
          (templateBlock.props as Record<string, unknown>).checked,
          false,
        );

        const unlink = await command(
          "DELETE",
          ["notes", note.id, "tasks", "check-1"],
          { revision: current.revision },
        );
        assert.ok(unlink);
        const unlinked = (unlink.data as { note: typeof note }).note;
        assert.equal(unlinked.document.blocks[0].type, "checkListItem");
        assert.equal(getTask(owner, result.task.id).noteId, null);
        assert.equal(getTask(owner, result.task.id).completedAt !== null, true);
        deleteTask(
          owner,
          result.task.id,
          getTask(owner, result.task.id).revision,
        );
        await assert.rejects(
          command("POST", ["notes", note.id, "tasks"], input),
          /no longer available/,
        );

        const checkedNote = createNote(
          owner,
          "Completed linked task",
          document({
            id: "checked-task",
            type: "checkListItem",
            props: { checked: true },
            content: [
              { type: "text", text: "Keep this completed", styles: {} },
            ],
          }),
        );
        const completedLink = await command(
          "POST",
          ["notes", checkedNote.id, "tasks"],
          {
            revision: checkedNote.revision,
            blockId: "checked-task",
            idempotencyKey: "completed-link-01",
          },
        );
        assert.ok(completedLink);
        const completedTask = (
          completedLink.data as {
            task: NonNullable<ReturnType<typeof getTask>>;
          }
        ).task;
        assert.ok(completedTask.completedAt);
        database
          .prepare("DELETE FROM tasks WHERE id=? AND owner_id=?")
          .run(completedTask.id, owner);
        const detached = await command(
          "DELETE",
          ["notes", checkedNote.id, "tasks", "checked-task"],
          {
            revision: checkedNote.revision + 1,
          },
        );
        assert.ok(detached);
        const detachedNote = (detached.data as { note: typeof checkedNote })
          .note;
        assert.equal(detachedNote.document.blocks[0]?.type, "checkListItem");
        assert.equal(
          (detachedNote.document.blocks[0]?.props as { checked?: boolean })
            .checked,
          true,
        );
      },
    );

    await t.test(
      "selected text is preserved and duplicate selections are rejected",
      async () => {
        const note = createNote(
          owner,
          "Selection",
          document(textBlock("paragraph-1", "Before task after")),
        );
        const response = await command("POST", ["notes", note.id, "tasks"], {
          revision: note.revision,
          blockId: "paragraph-1",
          selectedText: "task",
          idempotencyKey: "selection-task-01",
        });
        assert.ok(response);
        const updated = (response.data as { note: typeof note }).note;
        assert.deepEqual(
          updated.document.blocks.map((block) => block.type),
          ["paragraph", "taskLink", "paragraph"],
        );
        assert.equal(JSON.stringify(updated.document).includes("Before"), true);
        assert.equal(JSON.stringify(updated.document).includes("after"), true);

        const ambiguous = createNote(
          owner,
          "Ambiguous",
          document(textBlock("paragraph-2", "again and again")),
        );
        await assert.rejects(
          command("POST", ["notes", ambiguous.id, "tasks"], {
            revision: ambiguous.revision,
            blockId: "paragraph-2",
            selectedText: "again",
            idempotencyKey: "selection-task-02",
          }),
          /unique text range/,
        );
        assert.equal(getNote(ambiguous.id)?.revision, ambiguous.revision);
      },
    );

    await t.test(
      "templates apply idempotently and journal periods remain distinct",
      async () => {
        const template = await command("POST", ["templates"], {
          name: "Meeting notes",
          description: "A small agenda",
          kind: "note",
          document: document(
            textBlock("template-text", "{{date}} — {{title}}"),
          ),
        });
        assert.ok(template);
        assert.equal(template.status, 201);
        const templateValue = template.data as {
          id: string;
          revision: number;
        };
        const applicationInput = {
          revision: templateValue.revision,
          title: "Planning",
          idempotencyKey: "meeting-template-01",
          timezone: "UTC",
        };
        const applied = await command(
          "POST",
          ["templates", templateValue.id, "apply"],
          applicationInput,
        );
        assert.ok(applied);
        assert.equal(applied.status, 201);
        const appliedValue = applied.data as {
          note: { document: Document };
          created: boolean;
        };
        assert.equal(appliedValue.created, true);
        assert.match(JSON.stringify(appliedValue.note.document), /Planning/);
        const replay = await command(
          "POST",
          ["templates", templateValue.id, "apply"],
          applicationInput,
        );
        assert.ok(replay);
        assert.equal(replay.status, 200);
        assert.equal((replay.data as typeof appliedValue).created, false);

        const journalTemplate = await command("POST", ["templates"], {
          name: "Daily reflection",
          kind: "journal",
          document: document(textBlock("journal-prompt", "How was {{date}}?")),
        });
        assert.ok(journalTemplate);
        const journalTemplateValue = journalTemplate.data as {
          id: string;
          revision: number;
        };
        const preference = await command("PATCH", ["writing", "preferences"], {
          revision: 0,
          defaultJournalTemplateId: journalTemplateValue.id,
        });
        assert.ok(preference);
        const weekly = await command("POST", ["journals"], {
          date: "2026-10-13",
          period: "weekly",
        });
        assert.ok(weekly);
        const weeklyNote = weekly.data as {
          id: string;
          journalPeriod: string;
          dailyDate: string | null;
        };
        assert.equal(weeklyNote.journalPeriod, "weekly");
        assert.equal(weeklyNote.dailyDate, null);
        const secondWeekly = await command("POST", ["journals"], {
          date: "2026-10-14",
          period: "weekly",
        });
        assert.ok(secondWeekly);
        assert.equal(secondWeekly.status, 200);
        assert.equal((secondWeekly.data as { id: string }).id, weeklyNote.id);

        const defaultJournal = await command("POST", ["journals"], {
          date: "2026-10-13",
          period: "daily",
        });
        assert.ok(defaultJournal);
        assert.match(
          JSON.stringify(
            (defaultJournal.data as { document: object }).document,
          ),
          /How was 2026-10-13/,
        );
        createTask(owner, "Review the garden plan", {
          dueDate: "2026-10-13",
        });
        createEvent(owner, {
          title: "Planning session",
          allDay: true,
          start: "2026-10-13",
          end: "2026-10-14",
          timezone: "UTC",
        });
        const blankJournal = await command("POST", ["journals"], {
          date: "2026-10-14",
          period: "daily",
          templateId: null,
        });
        assert.ok(blankJournal);
        assert.doesNotMatch(
          JSON.stringify((blankJournal.data as { document: object }).document),
          /How was/,
        );
        const deletedDefault = await command(
          "DELETE",
          ["templates", journalTemplateValue.id],
          { revision: journalTemplateValue.revision },
        );
        assert.ok(deletedDefault);
        const preferencesAfterDelete = await command("GET", [
          "writing",
          "preferences",
        ]);
        assert.ok(preferencesAfterDelete);
        assert.deepEqual(preferencesAfterDelete.data, {
          revision: 2,
          defaultJournalTemplateId: null,
        });

        const page = await command(
          "GET",
          ["journals"],
          undefined,
          "period=weekly",
        );
        assert.ok(page);
        assert.equal(
          (page.data as { items: { id: string }[] }).items[0]?.id,
          weeklyNote.id,
        );
        const review = await command(
          "GET",
          ["journals", "review"],
          undefined,
          "period=daily&date=2026-10-13&timezone=UTC",
        );
        assert.ok(review);
        assert.deepEqual(Object.keys(review.data as object).sort(), [
          "entries",
          "entry",
          "events",
          "period",
          "periodStart",
          "tasks",
        ]);
        const validatedReview = apiOutputs.journalReview.parse(review.data);
        assert.ok(
          validatedReview !== null &&
            typeof validatedReview === "object" &&
            "tasks" in validatedReview &&
            "events" in validatedReview,
        );
        assert.ok(Array.isArray(validatedReview.tasks));
        assert.ok(Array.isArray(validatedReview.events));
        const reviewTask: unknown = validatedReview.tasks[0];
        const reviewEvent: unknown = validatedReview.events[0];
        assert.ok(
          reviewTask !== null &&
            typeof reviewTask === "object" &&
            "title" in reviewTask,
        );
        assert.ok(
          reviewEvent !== null &&
            typeof reviewEvent === "object" &&
            "title" in reviewEvent,
        );
        assert.equal(reviewTask.title, "Review the garden plan");
        assert.equal(reviewEvent.title, "Planning session");
        assert.equal(
          (review.data as { entry: { id: string } }).entry.id,
          (defaultJournal.data as { id: string }).id,
        );
        const onThisDay = await command(
          "GET",
          ["journals", "on-this-day"],
          undefined,
          "date=2026-10-13",
        );
        assert.ok(onThisDay);
        assert.ok(
          Array.isArray((onThisDay.data as { items: unknown[] }).items),
        );
      },
    );
  } finally {
    if (database.open) database.close();
    if (previousDirectory === undefined) delete process.env.NIVRA_DATA_DIR;
    else process.env.NIVRA_DATA_DIR = previousDirectory;
    await rm(directory, { recursive: true, force: true });
  }
});
