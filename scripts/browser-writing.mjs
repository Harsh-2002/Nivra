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
      if (classification === "unsupported-feature-warning")
        unsupportedBrowserWarnings.push(message.text());
      else if (classification === "error")
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
      assert.equal(
        await page.getByRole("textbox", { name: "Note title" }).inputValue(),
        note.title,
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

      if (!templateNoteId) {
        await openMenuAction(page, "Save as template");
        await page.getByLabel("Name", { exact: true }).fill(templateName);
        await page
          .getByRole("button", { name: "Save template", exact: true })
          .click();
        await page.locator(".writing-template-picker").waitFor();
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
      }

      await page.goto(`${base}/journal`);
      await page.getByRole("combobox", { name: "Journal period" }).click();
      await page.getByRole("option", { name: "Week", exact: true }).click();
      await page.getByLabel("Journal date", { exact: true }).fill(reviewDate);
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
    `Writing workflows passed ${checked} checks at ${widths.join(", ")}px in ${engineName}: linked tasks, unchecked template snapshots, normalized weekly journals and review activity. Fixtures were created only on the guarded disposable server.`,
  );
  console.log(
    `Unsupported ${engineName} browser warnings: ${unsupportedBrowserWarnings.length}.`,
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
