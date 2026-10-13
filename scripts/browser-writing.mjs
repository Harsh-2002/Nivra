import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chromium, firefox, webkit, request } from "playwright";
import { classifyConsoleMessage } from "./browser-diagnostics.mjs";

const base = process.env.NIVRA_BROWSER_TEST_URL ?? "http://localhost:3015";
const baseUrl = new URL(base);
assert.equal(baseUrl.port, "3015", "Use the disposable writing test server");
assert.ok(
  ["localhost", "127.0.0.1", "::1"].includes(baseUrl.hostname),
  "Writing UI tests are restricted to localhost",
);
assert.ok(process.env.NIVRA_BROWSER_SESSION, "Synthetic session required");
assert.ok(
  existsSync(process.env.NIVRA_BROWSER_SESSION),
  "A saved synthetic owner session file is required",
);

const owner = await request.newContext({
  baseURL: base,
  storageState: process.env.NIVRA_BROWSER_SESSION,
  extraHTTPHeaders: { origin: base, "content-type": "application/json" },
});

async function api(path, method = "GET", data) {
  const response = await owner.fetch(`/api/v1/${path}`, { method, data });
  const body = await response.json().catch(() => ({}));
  assert.ok(
    response.ok(),
    `${method} ${path.split("?")[0]}: ${response.status()} ${body.error || ""}`,
  );
  return body;
}

const status = await api("status");
assert.match(
  status.owner?.name ?? "",
  /audit|review|test/i,
  "A disposable synthetic owner is required; this harness will not run on a personal account",
);

const engineName = process.env.NIVRA_AUDIT_ENGINE ?? "chromium";
const engines = { chromium, firefox, webkit };
assert.ok(engines[engineName], "Supported browser engine required");
const widths = (process.env.NIVRA_AUDIT_WIDTHS ?? "390,1440")
  .split(",")
  .map(Number);
assert.ok(widths.every((width) => width >= 320 && width <= 2560));

const stamp = randomUUID().slice(0, 8);
const sourceText = `Replace seasonal filter ${stamp}`;
let reviewDate = new Date(Date.UTC(2090, 0, 1 + (parseInt(stamp, 16) % 3652)))
  .toISOString()
  .slice(0, 10);
function weekStart(dateString) {
  const date = new Date(`${dateString}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() || 7) - 1));
  return date.toISOString().slice(0, 10);
}
const occupiedWeeks = new Set();
let after;
do {
  const params = new URLSearchParams({ period: "weekly", limit: "50" });
  if (after) params.set("after", after);
  const journalPage = await api(`journals?${params}`);
  for (const item of journalPage.items) {
    occupiedWeeks.add(item.journalPeriodStart ?? item.periodStart);
  }
  after = journalPage.next;
} while (after);
while (occupiedWeeks.has(weekStart(reviewDate))) {
  reviewDate = new Date(`${reviewDate}T12:00:00.000Z`);
  reviewDate.setUTCDate(reviewDate.getUTCDate() + 7);
  reviewDate = reviewDate.toISOString().slice(0, 10);
}
const reviewWeekStart = weekStart(reviewDate);
const note = await api("notes", "POST", {
  title: `Writing check ${stamp}`,
  document: {
    schemaVersion: 1,
    blocks: [
      {
        id: `writing_${stamp}`,
        type: "paragraph",
        content: [{ type: "text", text: sourceText, styles: {} }],
      },
    ],
  },
});
const noteIds = [note.id];
const taskIds = [];
const templateIds = [];
const reviewTaskTitle = `Pay annual registration ${stamp}`;
const reviewTask = await api("tasks", "POST", {
  title: reviewTaskTitle,
  dueDate: reviewDate,
});
taskIds.push(reviewTask.id);

let browser;
let checked = 0;
const errors = [];
const unsupportedBrowserWarnings = [];
let unsupportedWarningCountReported = false;
let expectedTemplateConflict = false;
let expectedConflictNoteId = null;
let expectedConflictTemplatePostStarted = false;
let expected409ConsoleWarningCount = 0;

async function openMenuAction(page, label) {
  await page.getByRole("button", { name: "Note actions", exact: true }).click();
  await page.getByRole("menuitem", { name: label, exact: true }).click();
}

async function settle(page) {
  await page.waitForFunction(
    () => !document.querySelector(".loading-state, .schedule-skeleton"),
  );
}

try {
  browser = await engines[engineName].launch();
  let linkedTaskId = null;
  let templateName = `Weekly reset ${stamp}`;
  let templateId = null;
  let templateNoteId = null;
  let journalId = null;
  let journalTitle = null;

  for (const width of widths) {
    const context = await browser.newContext({
      storageState: process.env.NIVRA_BROWSER_SESSION,
      viewport: { width, height: 900 },
      hasTouch: width < 1024,
      serviceWorkers: "block",
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    const writeRequests = new WeakMap();
    const writeEvents = [];
    const trackedNoteIds = new Set([note.id]);
    let writeOrder = 0;
    page.on("request", (request) => {
      const url = new URL(request.url());
      const isSourcePatch =
        request.method() === "PATCH" &&
        [...trackedNoteIds].some(
          (id) => url.pathname === `/api/v1/notes/${id}`,
        );
      const isTemplateCreate =
        request.method() === "POST" && url.pathname === "/api/v1/templates";
      if (
        isTemplateCreate &&
        expectedTemplateConflict &&
        expectedConflictNoteId &&
        request.postDataJSON()?.sourceNoteId === expectedConflictNoteId
      ) {
        expectedConflictTemplatePostStarted = true;
      }
      if (!isSourcePatch && !isTemplateCreate) return;
      const event = {
        method: request.method(),
        path: url.pathname,
        startOrder: writeOrder++,
        finishOrder: null,
        status: null,
      };
      writeRequests.set(request, event);
      writeEvents.push(event);
    });
    page.on("response", (response) => {
      const event = writeRequests.get(response.request());
      if (event) event.status = response.status();
    });
    page.on("requestfinished", (request) => {
      const event = writeRequests.get(request);
      if (event) event.finishOrder = writeOrder++;
    });
    let delayedSourcePatch = null;
    let delayedTemplatePost = null;
    if (width === widths[0]) {
      let releasePatch;
      let notifyPatch;
      const gate = new Promise((resolve) => {
        releasePatch = resolve;
      });
      const requestSeen = new Promise((resolve) => {
        notifyPatch = resolve;
      });
      let holdNextPatch = true;
      await page.route(`**/api/v1/notes/${note.id}`, async (route) => {
        if (holdNextPatch && route.request().method() === "PATCH") {
          holdNextPatch = false;
          notifyPatch(route.request());
          await gate;
        }
        await route.continue();
      });
      delayedSourcePatch = { requestSeen, release: releasePatch };

      let releasePost;
      let notifyPost;
      const postGate = new Promise((resolve) => {
        releasePost = resolve;
      });
      const postRequestSeen = new Promise((resolve) => {
        notifyPost = resolve;
      });
      let holdNextPost = true;
      await page.route("**/api/v1/templates", async (route) => {
        if (holdNextPost && route.request().method() === "POST") {
          holdNextPost = false;
          notifyPost(route.request());
          await postGate;
        }
        await route.continue();
      });
      delayedTemplatePost = {
        requestSeen: postRequestSeen,
        release: releasePost,
      };
    }
    const taskCreateRequests = [];
    page.on("request", (request) => {
      if (
        request.method() === "POST" &&
        new URL(request.url()).pathname === `/api/v1/notes/${note.id}/tasks`
      ) {
        taskCreateRequests.push(request.url());
      }
    });
    page.on("pageerror", (error) =>
      errors.push(`${width}px: ${error.message}`),
    );
    page.on("console", (message) => {
      const classification = classifyConsoleMessage(
        engineName,
        message.type(),
        message.text(),
      );
      const locationUrl = message.location().url;
      let locationPath = "";
      if (locationUrl) {
        try {
          locationPath = new URL(locationUrl).pathname;
        } catch {}
      }
      if (classification === "unsupported-feature-warning")
        unsupportedBrowserWarnings.push(message.text());
      else if (
        expectedTemplateConflict &&
        expectedConflictTemplatePostStarted &&
        expected409ConsoleWarningCount === 0 &&
        expectedConflictNoteId &&
        new URL(page.url()).searchParams.get("note") ===
          expectedConflictNoteId &&
        (!locationUrl || locationPath === "/api/v1/templates") &&
        /^Failed to load resource: the server responded with a status of 409 \(Conflict\)$/i.test(
          message.text(),
        )
      ) {
        expected409ConsoleWarningCount += 1;
        expectedTemplateConflict = false;
      } else if (classification === "error")
        errors.push(`${width}px console: ${message.text()}`);
    });

    try {
      await page.goto(
        `${base}/journal?period=daily&date=${encodeURIComponent(reviewDate)}`,
      );
      await page.getByRole("combobox", { name: "Journal period" }).waitFor();
      await settle(page);
      await page
        .getByRole("heading", { name: "Your journal is empty" })
        .waitFor();
      await page
        .getByRole("button", { name: "Write a journal entry" })
        .waitFor();
      assert.equal(
        await page.locator(".note-list-scroll [role=alert]").count(),
        0,
        "An empty daily journal should load without a list error",
      );
      for (const [label, period] of [
        ["Week", "weekly"],
        ["Month", "monthly"],
        ["Day", "daily"],
      ]) {
        await page.getByRole("combobox", { name: "Journal period" }).click();
        const journalResponse = page.waitForResponse((response) => {
          const url = new URL(response.url());
          return (
            url.pathname === "/api/v1/journals" &&
            url.searchParams.get("period") === period
          );
        });
        await page.getByRole("option", { name: label, exact: true }).click();
        await page.waitForURL(
          new RegExp(`/journal\\?period=${period}&date=${reviewDate}$`),
        );
        const response = await journalResponse;
        assert.ok(response.ok(), `${period} journal list should load`);
        assert.equal(
          await page
            .getByRole("combobox", { name: "Journal period" })
            .innerText(),
          label,
          `${period} should remain selected after the URL transition`,
        );
        await settle(page);
        const expectedJournalPage = await api(
          `journals?period=${period}&limit=50`,
        );
        const expectedTitles = expectedJournalPage.items.map(
          (item) => item.title,
        );
        if (expectedTitles.length > 0) {
          const visibleTitles = page.locator(".note-list-item strong");
          await visibleTitles.first().waitFor();
          assert.deepEqual(
            await visibleTitles.allTextContents(),
            expectedTitles,
            `The ${period} journal list should match its canonical API results`,
          );
          if (journalTitle && expectedTitles.includes(journalTitle)) {
            await page
              .locator(".note-list-scroll")
              .getByText(journalTitle, { exact: true })
              .waitFor();
          }
        } else {
          await page
            .getByRole("heading", { name: "Your journal is empty" })
            .waitFor();
        }
        assert.equal(
          await page.locator(".note-list-scroll [role=alert]").count(),
          0,
          `The ${period} journal should load without a list error`,
        );
      }
      checked += 3;

      await page.goto(`${base}/notes?note=${note.id}`);
      await page.getByRole("textbox", { name: "Note title" }).waitFor();
      await settle(page);
      const currentSourceNote = await api(`notes/${note.id}`);
      assert.equal(
        await page.getByRole("textbox", { name: "Note title" }).inputValue(),
        currentSourceNote.title,
      );

      if (!linkedTaskId) {
        const requestsBeforeInvalidSelection = taskCreateRequests.length;
        await page
          .locator(".bn-editor")
          .getByText(sourceText, { exact: true })
          .click();
        await openMenuAction(page, "Create linked task");
        await page
          .getByRole("alert")
          .getByText("Select text, or place the cursor in a checklist item.")
          .waitFor();
        assert.equal(
          await page.getByRole("textbox", { name: "Task title" }).count(),
          0,
          "A cursor in an ordinary paragraph should not open task creation",
        );
        await page.waitForTimeout(100);
        assert.equal(
          taskCreateRequests.length,
          requestsBeforeInvalidSelection,
          "An unsupported cursor-only conversion should not send a task request",
        );

        await page
          .locator(".bn-editor")
          .getByText(sourceText, { exact: true })
          .click({ clickCount: 3 });
        assert.equal(
          await page.evaluate(() => String(window.getSelection())),
          sourceText,
          "Creating a linked task requires a selected passage",
        );
        await openMenuAction(page, "Create linked task");
        const taskTitle = page.getByRole("textbox", { name: "Task title" });
        await taskTitle.waitFor();
        assert.equal(await taskTitle.inputValue(), sourceText);
        const createTaskResponse = page.waitForResponse((response) => {
          const url = new URL(response.url());
          return (
            response.request().method() === "POST" &&
            url.pathname === `/api/v1/notes/${note.id}/tasks`
          );
        });
        await page
          .getByRole("button", { name: "Create task", exact: true })
          .click();
        assert.ok(
          (await createTaskResponse).ok(),
          "A valid selected passage should create its linked task successfully",
        );
        assert.equal(
          taskCreateRequests.length,
          requestsBeforeInvalidSelection + 1,
          "A valid selected passage should create exactly one linked task",
        );
        const link = page.locator(".writing-task-link");
        await link.waitFor();
        const linkedNote = await api(`notes/${note.id}`);
        const block = linkedNote.document.blocks.find(
          (item) => item.type === "taskLink",
        );
        assert.ok(block, "Creating a linked task must insert a taskLink block");
        linkedTaskId = block.props.taskId;
        taskIds.push(linkedTaskId);
        assert.ok(linkedTaskId);
        assert.equal(
          await link.locator(".writing-task-link-title").innerText(),
          sourceText,
        );

        await link.getByRole("checkbox").click();
        await page.waitForFunction(async (taskId) => {
          const response = await fetch(`/api/v1/tasks/${taskId}`);
          return response.ok && (await response.json()).completedAt !== null;
        }, linkedTaskId);
        checked += 1;
      } else {
        await page.locator(".writing-task-link").waitFor();
      }

      templateName = `Weekly reset ${stamp} ${width}`;
      if (delayedSourcePatch) {
        const title = page.getByRole("textbox", { name: "Note title" });
        await title.fill(`Prepared source ${stamp}`);
        const heldPatch = await delayedSourcePatch.requestSeen;
        assert.equal(heldPatch.method(), "PATCH");
        await openMenuAction(page, "Save as template");
        await page.evaluate(
          () =>
            new Promise((resolve) =>
              requestAnimationFrame(() => requestAnimationFrame(resolve)),
            ),
        );
        assert.equal(
          await page.locator(".writing-template-editor").count(),
          0,
          "The template editor waits for the pending source save",
        );
        assert.equal(
          writeEvents.filter(
            (event) =>
              event.method === "POST" && event.path === "/api/v1/templates",
          ).length,
          0,
          "The template request must wait until the source save finishes",
        );
        const heldPatchResponse = page.waitForResponse(
          (response) =>
            response.request().url() === heldPatch.url() &&
            response.request().method() === "PATCH",
        );
        delayedSourcePatch.release();
        assert.ok(
          (await heldPatchResponse).ok(),
          "The delayed owner save should complete before template creation",
        );
        await page.getByLabel("Name", { exact: true }).waitFor();
      } else {
        await openMenuAction(page, "Save as template");
      }
      await page.getByLabel("Name", { exact: true }).fill(templateName);
      const writesBeforeTemplateSave = writeEvents.length;
      const templateResponse = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return (
          response.request().method() === "POST" &&
          url.pathname === "/api/v1/templates"
        );
      });
      await page
        .getByRole("button", { name: "Save template", exact: true })
        .click();
      if (delayedTemplatePost) {
        await delayedTemplatePost.requestSeen;
        await page.evaluate(
          () =>
            new Promise((resolve) =>
              requestAnimationFrame(() => requestAnimationFrame(resolve)),
            ),
        );
        const closeTemplate = page.getByRole("button", {
          name: "Close template editor",
        });
        assert.ok(
          await closeTemplate.isDisabled(),
          "The template editor cannot close while its save is in flight",
        );
        assert.equal(
          await page.getByLabel("Name", { exact: true }).inputValue(),
          templateName,
          "The template draft remains visible while the save is pending",
        );
        delayedTemplatePost.release();
      }
      assert.equal(
        (await templateResponse).status(),
        201,
        "The source-backed template should save successfully",
      );
      await page.locator(".writing-template-picker").waitFor();
      const templatePost = writeEvents
        .slice(writesBeforeTemplateSave)
        .find(
          (event) =>
            event.method === "POST" && event.path === "/api/v1/templates",
        );
      assert.ok(templatePost, "Saving a template should send its API request");
      if (delayedSourcePatch) {
        const sourcePatchesBeforeTemplate = writeEvents.filter(
          (event) =>
            event.method === "PATCH" &&
            event.path === `/api/v1/notes/${note.id}` &&
            event.startOrder < templatePost.startOrder,
        );
        assert.ok(sourcePatchesBeforeTemplate.length > 0);
        assert.ok(
          sourcePatchesBeforeTemplate.every(
            (event) =>
              event.finishOrder !== null &&
              event.finishOrder < templatePost.startOrder,
          ),
          "Every owner save already in flight must finish before template creation starts",
        );
      }
      const templates = await api("templates?kind=note&limit=100");
      templateId = templates.items.find(
        (item) => item.name === templateName,
      )?.id;
      assert.ok(
        templateId,
        "The saved template should be available in the picker",
      );
      templateIds.push(templateId);
      await page
        .locator(".writing-template-row")
        .filter({ hasText: templateName })
        .click();

      await page.getByRole("button", { name: "Close templates" }).click();
      await page.getByRole("textbox", { name: "Note title" }).waitFor();
      await settle(page);
      await page.locator(".save-status").filter({ hasText: "Saved" }).waitFor();
      const postLeaseTitle = `Saved after template ${stamp} ${width}`;
      const postLeaseSave = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return (
          response.request().method() === "PATCH" &&
          url.pathname === `/api/v1/notes/${note.id}` &&
          response.request().postDataJSON()?.title === postLeaseTitle
        );
      });
      await page
        .getByRole("textbox", { name: "Note title" })
        .fill(postLeaseTitle);
      assert.ok(
        (await postLeaseSave).ok(),
        "Ordinary note saves should resume in the same note pane after the template source lease releases",
      );
      await page.locator(".save-status").filter({ hasText: "Saved" }).waitFor();
      assert.equal(
        (await api(`notes/${note.id}`)).title,
        postLeaseTitle,
        "The post-template title should persist normally",
      );
      checked += 1;

      await openMenuAction(page, "Start from template");
      await page
        .locator(".writing-template-row")
        .filter({ hasText: templateName })
        .click();
      await page
        .getByRole("button", { name: "Create new note", exact: true })
        .click();
      await page.waitForFunction((existingId) => {
        const noteId = new URL(location.href).searchParams.get("note");
        return Boolean(noteId && noteId !== existingId);
      }, note.id);
      templateNoteId = new URL(page.url()).searchParams.get("note");
      assert.ok(templateNoteId && templateNoteId !== note.id);
      noteIds.push(templateNoteId);
      const copied = await api(`notes/${templateNoteId}`);
      const checklist = copied.document.blocks.find(
        (item) => item.type === "checkListItem",
      );
      assert.ok(
        checklist,
        "A template converts linked tasks into checklist items",
      );
      assert.equal(
        checklist.props.checked,
        false,
        "Template checklist items start unchecked",
      );
      checked += 1;

      if (width === widths[0]) {
        const conflictNote = await api("notes", "POST", {
          title: `Conflict source ${stamp}`,
          document: {
            schemaVersion: 1,
            blocks: [
              {
                id: `conflict_${stamp}`,
                type: "paragraph",
                content: [{ type: "text", text: sourceText, styles: {} }],
              },
            ],
          },
        });
        noteIds.push(conflictNote.id);
        trackedNoteIds.add(conflictNote.id);
        await page.route("**/api/v1/completions", (route) =>
          route.fulfill({
            status: 200,
            headers: { "content-type": "text/event-stream" },
            body: ": idle\n\n",
          }),
        );
        await page.goto(`${base}/notes?note=${conflictNote.id}`);
        await page.getByRole("textbox", { name: "Note title" }).waitFor();
        await settle(page);
        await page
          .locator(".save-status")
          .filter({ hasText: "Saved" })
          .waitFor();
        const conflictWarmupName = `Conflict warmup ${stamp}`;
        await openMenuAction(page, "Save as template");
        await page.getByLabel("Name", { exact: true }).fill(conflictWarmupName);
        const warmupResponse = page.waitForResponse((response) => {
          const url = new URL(response.url());
          return (
            response.request().method() === "POST" &&
            url.pathname === "/api/v1/templates"
          );
        });
        await page
          .getByRole("button", { name: "Save template", exact: true })
          .click();
        assert.equal(
          (await warmupResponse).status(),
          201,
          "A clean warmup template save drains initial editor normalization",
        );
        const warmupTemplate = (
          await api("templates?kind=note&limit=100")
        ).items.find((item) => item.name === conflictWarmupName);
        assert.ok(warmupTemplate, "The warmup template should be persisted");
        templateIds.push(warmupTemplate.id);
        await page.getByRole("button", { name: "Close templates" }).click();
        await page.getByRole("textbox", { name: "Note title" }).waitFor();
        await settle(page);
        await page
          .locator(".save-status")
          .filter({ hasText: "Saved" })
          .waitFor();

        const conflictCleanTitle = `Clean local source ${stamp}`;
        const cleanSourceSave = page.waitForResponse((response) => {
          const url = new URL(response.url());
          return (
            response.request().method() === "PATCH" &&
            url.pathname === `/api/v1/notes/${conflictNote.id}` &&
            response.request().postDataJSON()?.title === conflictCleanTitle
          );
        });
        await page
          .getByRole("textbox", { name: "Note title" })
          .fill(conflictCleanTitle);
        assert.ok(
          (await cleanSourceSave).ok(),
          "The conflict fixture must have a saved local source before the remote mutation",
        );
        await page
          .locator(".save-status")
          .filter({ hasText: "Saved" })
          .waitFor();
        assert.equal(
          (await api(`notes/${conflictNote.id}`)).title,
          conflictCleanTitle,
          "The clean local source must be persisted before introducing a remote revision",
        );

        const conflictTemplateName = `Keep draft ${stamp}`;
        await openMenuAction(page, "Save as template");
        await page
          .getByLabel("Name", { exact: true })
          .fill(conflictTemplateName);
        const latestConflictNote = await api(`notes/${conflictNote.id}`);
        const writeCountBeforeRemoteMutation = writeEvents.length;
        const remoteConflictNote = await api(
          `notes/${conflictNote.id}`,
          "PATCH",
          {
            revision: latestConflictNote.revision,
            title: `Remote edit ${stamp}`,
          },
        );
        const conflictResponse = page.waitForResponse((response) => {
          const url = new URL(response.url());
          return (
            response.request().method() === "POST" &&
            url.pathname === "/api/v1/templates"
          );
        });
        expectedConflictNoteId = conflictNote.id;
        expectedTemplateConflict = true;
        await page
          .getByRole("button", { name: "Save template", exact: true })
          .click();
        const staleWriteResponse = await conflictResponse;
        assert.equal(staleWriteResponse.status(), 409);
        assert.ok(
          expectedConflictTemplatePostStarted,
          "The expected source-backed template POST should be the request that conflicts",
        );
        assert.equal(
          new URL(staleWriteResponse.url()).pathname,
          "/api/v1/templates",
          "A real remote source edit must still be rejected by the revision guard",
        );
        const attemptedTemplate = staleWriteResponse.request().postDataJSON();
        assert.equal(
          attemptedTemplate.sourceRevision,
          latestConflictNote.revision,
          "The template request should carry the last clean local source revision",
        );
        assert.ok(
          remoteConflictNote.revision > attemptedTemplate.sourceRevision,
          "The remote edit should create a newer source revision than the submitted template snapshot",
        );
        assert.equal(
          writeEvents
            .slice(writeCountBeforeRemoteMutation)
            .filter(
              (event) =>
                event.method === "PATCH" &&
                event.path === `/api/v1/notes/${conflictNote.id}`,
            ).length,
          0,
          "A clean source save should not race with the remote edit during template creation",
        );
        const templateConflict = page.locator(
          ".writing-inline-error[role=alert]",
        );
        await templateConflict.waitFor();
        assert.match(
          await templateConflict.innerText(),
          /This note changed\. Reload it before saving the template\./,
          "A genuine remote edit should produce the actionable template conflict message",
        );
        expectedTemplateConflict = false;
        assert.equal(
          await page.getByLabel("Name", { exact: true }).inputValue(),
          conflictTemplateName,
          "A source conflict must preserve the user's template draft",
        );
        expectedTemplateConflict = false;
        expectedConflictNoteId = null;
        expectedConflictTemplatePostStarted = false;
        checked += 3;
      }

      await page.goto(`${base}/journal`);
      await page.getByRole("combobox", { name: "Journal period" }).click();
      await page.getByRole("option", { name: "Week", exact: true }).click();
      await page.getByRole("button", { name: "Journal date" }).click();
      assert.equal(
        await page.getByRole("button", { name: "No date" }).count(),
        0,
        "The required journal date picker must not offer a blank date",
      );
      await page
        .getByLabel("Enter journal date", { exact: true })
        .fill(reviewDate);
      await page.getByRole("button", { name: "Set date", exact: true }).click();
      await page.waitForURL(
        new RegExp(`/journal\\?period=weekly&date=${reviewDate}$`),
      );
      if (journalId && journalTitle) {
        await page
          .locator(".note-list-item")
          .filter({ hasText: journalTitle })
          .click();
        await page.waitForFunction(
          (expectedId) =>
            new URL(location.href).searchParams.get("note") === expectedId,
          journalId,
        );
      } else {
        const createJournalResponse = page.waitForResponse((response) => {
          const url = new URL(response.url());
          return (
            response.request().method() === "POST" &&
            url.pathname === "/api/v1/journals"
          );
        });
        await page
          .getByRole("button", { name: "Write a journal entry" })
          .click();
        assert.ok(
          (await createJournalResponse).ok(),
          "The selected weekly journal should be created successfully",
        );
      }
      await page.getByRole("textbox", { name: "Note title" }).waitFor();
      if (!journalId) {
        await page.waitForFunction(() =>
          new URL(location.href).searchParams.has("note"),
        );
        journalId = new URL(page.url()).searchParams.get("note");
        assert.ok(journalId);
        noteIds.push(journalId);
      }
      const journal = await api(`notes/${journalId}`);
      journalTitle = journal.title;
      assert.equal(journal.journalPeriod, "weekly");
      assert.equal(journal.journalPeriodStart, reviewWeekStart);
      assert.equal(new URL(page.url()).searchParams.get("period"), "weekly");
      assert.equal(
        new URL(page.url()).searchParams.get("date"),
        reviewWeekStart,
      );
      if (width >= 1024) {
        await page.locator(".journal-review").waitFor();
        await page.getByText(reviewTaskTitle, { exact: true }).waitFor();
      } else {
        await page
          .getByRole("button", { name: "Activity", exact: true })
          .click();
        await page.locator(".journal-review").waitFor();
        await page.getByText(reviewTaskTitle, { exact: true }).waitFor();
        await page
          .getByRole("button", { name: "Writing", exact: true })
          .click();
        await page.getByRole("textbox", { name: "Note title" }).waitFor();
      }
      const overflow = await page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      );
      assert.ok(
        overflow <= 1,
        `${width}px journal editor should not overflow horizontally`,
      );
      checked += 1;
    } finally {
      await context.close();
    }
  }

  assert.deepEqual(
    errors,
    [],
    "Writing workflows should not raise browser errors",
  );
  console.log(
    `Writing workflows passed ${checked} checks at ${widths.join(", ")}px in ${engineName}: linked tasks, template save ordering/conflicts, unchecked template snapshots, normalized weekly journals and review activity. Fixtures were created only on the guarded disposable server.`,
  );
  console.log(
    `Unsupported ${engineName} browser warnings: ${unsupportedBrowserWarnings.length}.`,
  );
  console.log(
    `Expected template-conflict 409 browser warnings: ${expected409ConsoleWarningCount}.`,
  );
  unsupportedWarningCountReported = true;
} finally {
  await browser?.close();
  for (const id of noteIds.reverse()) {
    try {
      const item = await api(`notes/${id}`);
      await api(`notes/${id}`, "DELETE", { revision: item.revision });
    } catch {}
  }
  for (const id of taskIds) {
    try {
      const item = await api(`tasks/${id}`);
      await api(`tasks/${id}`, "DELETE", { revision: item.revision });
    } catch {}
  }
  for (const id of templateIds) {
    try {
      const item = await api(`templates/${id}`);
      await api(`templates/${id}`, "DELETE", { revision: item.revision });
    } catch {}
  }
  await owner.dispose();
  if (!unsupportedWarningCountReported)
    console.log(
      `Unsupported ${engineName} browser warnings before exit: ${unsupportedBrowserWarnings.length}.`,
    );
}
