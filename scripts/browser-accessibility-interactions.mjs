import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium, firefox, webkit, request } from "playwright";

const base = process.env.NIVRA_BROWSER_TEST_URL ?? "http://localhost:3015";
assert.equal(new URL(base).port, "3015", "Use the disposable audit server");
assert.ok(process.env.NIVRA_BROWSER_SESSION, "Synthetic session required");
const owner = await request.newContext({
  baseURL: base,
  storageState: process.env.NIVRA_BROWSER_SESSION,
  extraHTTPHeaders: { origin: base },
});
const status = await owner.get("/api/v1/status");
assert.match((await status.json()).owner?.name ?? "", /review|audit|test/i);
const fixtures = JSON.parse(
  await readFile(
    process.env.NIVRA_AUDIT_FIXTURES ??
      ".impeccable/review/accessibility/fixtures.json",
    "utf8",
  ),
);
async function api(path, data, method = data === undefined ? "GET" : "POST") {
  const response = await owner.fetch(`/api/v1/${path}`, { method, data });
  assert.ok(response.ok(), `Fixture ${method} ${path}: ${response.status()}`);
  const value = await response.json();
  await response.dispose();
  return value;
}
const stamp = Date.now().toString(36);
const checklistTask = await api("tasks", {
  title: `Audit checklist ${stamp}`,
});
const firstStepText = `Audit first step ${stamp}`;
const secondStepText = `Audit second step ${stamp}`;
const firstStep = await api(`tasks/${checklistTask.id}/steps`, {
  revision: checklistTask.revision,
  text: firstStepText,
});
const secondStep = await api(`tasks/${checklistTask.id}/steps`, {
  revision: firstStep.task.revision,
  text: secondStepText,
});
const undatedTask = await api("tasks", {
  title: `Audit unscheduled ${stamp}`,
});
const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
const overdueTask = await api("tasks", {
  title: `Audit overdue ${stamp}`,
  dueDate: yesterday,
});
const engines = { chromium, firefox, webkit };
const name = process.env.NIVRA_AUDIT_ENGINE ?? "chromium";
assert.ok(engines[name], "Supported browser engine required");
const browser = await engines[name].launch(
  name === "chromium" ? { args: ["--disable-dev-shm-usage"] } : {},
);
let checked = 0;
async function touchTarget(locator) {
  const bounds = await locator.boundingBox();
  assert.ok(
    bounds &&
      Math.round(bounds.width * 100) / 100 >= 44 &&
      Math.round(bounds.height * 100) / 100 >= 44,
    `Touch target: ${(await locator.getAttribute("aria-label")) ?? (await locator.textContent())}`,
  );
}
async function focusTrap(page, dialog) {
  const controls = dialog.locator(
    'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]',
  );
  const visible = [];
  for (const control of await controls.all())
    if (await control.isVisible()) visible.push(control);
  assert.ok(visible.length, "Dialog has usable controls");
  await visible[0].focus();
  await page.keyboard.press("Shift+Tab");
  await page.waitForFunction(
    () => !!document.activeElement?.closest('[role="dialog"]'),
  );
  await visible.at(-1).focus();
  await page.keyboard.press("Tab");
  await page.waitForFunction(
    () => !!document.activeElement?.closest('[role="dialog"]'),
  );
}
try {
  for (const width of (
    process.env.NIVRA_AUDIT_WIDTHS ?? "320,390,640,768,1024,1440,2560"
  )
    .split(",")
    .map(Number)) {
    const context = await browser.newContext({
      storageState: process.env.NIVRA_BROWSER_SESSION,
      viewport: { width, height: width === 320 ? 568 : 900 },
      hasTouch: width < 1024,
      serviceWorkers: "block",
      reducedMotion: "reduce",
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${base}/overview`);
    await page.locator(".overview-widget").first().waitFor();
    await page.keyboard.press("Tab");
    await page.waitForFunction(() =>
      document.activeElement?.matches(".skip-link"),
    );
    await page.keyboard.press("Enter");
    await page.waitForFunction(() =>
      document.activeElement?.matches(".section-content"),
    );
    assert.equal(
      await page.locator(".overview-widget ul[role=region]").count(),
      0,
    );
    assert.equal(await page.locator(".overview-widget h2").count(), 3);
    if (width < 1024) {
      const navigation = page
        .getByRole("button", { name: "Open navigation", exact: true })
        .first();
      await navigation.tap();
      await page
        .getByRole("dialog", { name: "Navigation", exact: true })
        .waitFor();
      await focusTrap(
        page,
        page.getByRole("dialog", { name: "Navigation", exact: true }),
      );
      await page.keyboard.press("Escape");
      await page.waitForFunction(
        () =>
          document.activeElement?.getAttribute("aria-label") ===
          "Open navigation",
      );
      for (const section of [
        "Notes",
        "Journal",
        "Tasks",
        "Calendar",
        "Bookmarks",
        "Artifacts",
        "Forms",
        "Favorites",
        "Trash",
        "Overview",
      ]) {
        await page
          .getByRole("button", { name: "Open navigation", exact: true })
          .first()
          .click();
        await page
          .getByRole("dialog", { name: "Navigation", exact: true })
          .getByRole("button", { name: section, exact: true })
          .click();
        await page.waitForFunction(
          (path) => location.pathname === path,
          `/${section.toLowerCase()}`,
        );
        await page
          .getByRole("dialog", { name: "Navigation", exact: true })
          .waitFor({ state: "hidden" });
      }
    }
    await page.goto(`${base}/tasks?view=board`);
    const createBoard = page
      .locator(".kanban-empty")
      .getByRole("button", { name: "Create board", exact: true });
    await createBoard.waitFor();
    const iconOffset = await createBoard.evaluate((button) => {
      const bounds = button.getBoundingClientRect();
      const icon = button.querySelector("svg").getBoundingClientRect();
      return Math.abs(
        icon.y + icon.height / 2 - (bounds.y + bounds.height / 2),
      );
    });
    assert.ok(iconOffset <= 1, "Empty-state action icon is centered");
    if (width < 1024) await touchTarget(createBoard);
    await createBoard.click();
    await page
      .getByRole("textbox", { name: "New board", exact: true })
      .waitFor();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await createBoard.waitFor();
    await page.goto(`${base}/calendar`);
    const grid = page.getByRole("grid", { name: "Month", exact: true });
    await grid.waitFor();
    await page.locator(".skip-link").focus();
    await page.keyboard.press("Enter");
    await page.waitForFunction(() =>
      document.activeElement?.matches(".schedule-scroll"),
    );
    assert.equal(await grid.getByRole("row").count(), 6);
    for (const row of await grid.getByRole("row").all())
      assert.equal(await row.getByRole("gridcell").count(), 7);
    assert.equal(
      await grid.locator('.schedule-day-number[tabindex="0"]').count(),
      1,
    );
    const selected = grid.locator('.schedule-day-number[aria-pressed="true"]');
    await selected.focus();
    await page.keyboard.press("ArrowRight");
    await page.waitForFunction(() =>
      document.activeElement?.matches(
        '.schedule-day-number[aria-pressed="true"]',
      ),
    );
    assert.equal(
      await grid.locator('[role="gridcell"][aria-selected="true"]').count(),
      1,
    );
    if (width < 1024)
      for (const label of ["Previous period", "Next period", "Go to date"])
        await touchTarget(
          page.getByRole("button", { name: label, exact: true }),
        );
    let failChecklistLoad = true;
    await page.route(
      `**/api/v1/tasks/${checklistTask.id}/steps`,
      async (route) => {
        if (route.request().method() === "GET" && failChecklistLoad) {
          failChecklistLoad = false;
          return route.fulfill({
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({
              code: "temporarily_unavailable",
              error: "Checklist temporarily unavailable.",
            }),
          });
        }
        return route.continue();
      },
    );
    await page.goto(`${base}/tasks?task=${checklistTask.id}`);
    const steps = page.locator(".planning-steps");
    await steps.waitFor();
    await steps
      .getByRole("button", { name: "Retry loading checklist", exact: true })
      .waitFor();
    await steps
      .getByRole("alert")
      .filter({ hasText: "Checklist temporarily unavailable." })
      .waitFor();
    assert.equal(
      await steps.getByText("No steps yet.", { exact: true }).count(),
      0,
      "A failed checklist load is not displayed as an empty checklist",
    );
    await steps
      .getByRole("button", { name: "Retry loading checklist", exact: true })
      .click();
    const checklist = steps.getByRole("list", {
      name: `${checklistTask.title} checklist`,
    });
    await checklist.waitFor();
    await checklist.getByText(firstStepText, { exact: true }).waitFor();
    await checklist.getByText(secondStepText, { exact: true }).waitFor();
    const removeFirst = steps.getByRole("button", {
      name: `Remove ${firstStepText}`,
      exact: true,
    });
    await removeFirst.click();
    const confirmation = page.getByRole("alertdialog");
    await confirmation.waitFor();
    await confirmation
      .getByRole("button", { name: "Remove step", exact: true })
      .click();
    await checklist.getByText(firstStepText, { exact: true }).waitFor({
      state: "detached",
    });
    await page.waitForFunction(
      (stepId) => document.activeElement?.id === stepId,
      `task-step-text-${checklistTask.id}-${secondStep.step.id}`,
    );
    assert.equal(
      await checklist.getByText(secondStepText, { exact: true }).count(),
      1,
    );

    let calendarTaskResponse = "fail-unscheduled";
    await page.route("**/api/v1/calendar/tasks*", async (route) => {
      const url = new URL(route.request().url());
      if (
        route.request().method() === "GET" &&
        url.searchParams.get("mode") === "unscheduled" &&
        calendarTaskResponse === "fail-unscheduled"
      ) {
        calendarTaskResponse = "normal";
        return route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({
            code: "temporarily_unavailable",
            error: "Calendar tasks temporarily unavailable.",
          }),
        });
      }
      if (
        route.request().method() === "GET" &&
        url.searchParams.get("mode") === "unscheduled" &&
        calendarTaskResponse === "empty-unscheduled"
      )
        return route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({ items: [], next: null }),
        });
      return route.continue();
    });
    await page.goto(`${base}/calendar?view=week`);
    await page.locator(".schedule-summary").waitFor();
    const summary = page.locator(".schedule-summary");
    const agenda = page.getByRole("region", {
      name: "Calendar agenda",
      exact: true,
    });
    const unscheduled = summary
      .getByRole("button")
      .filter({ hasText: "unscheduled tasks" });
    await unscheduled.waitFor();
    await unscheduled.click();
    await agenda.getByRole("heading", { name: "Unscheduled tasks" }).waitFor();
    await agenda
      .getByRole("alert")
      .filter({ hasText: "Calendar tasks temporarily unavailable." })
      .waitFor();
    assert.equal(
      await agenda.getByText("No unscheduled tasks.", { exact: true }).count(),
      0,
      "A failed calendar task request is not displayed as an empty list",
    );
    await agenda.getByRole("button", { name: "Retry", exact: true }).click();
    await agenda
      .locator(".schedule-agenda-entry")
      .filter({ hasText: undatedTask.title })
      .waitFor();
    assert.equal(
      await agenda
        .locator(".schedule-agenda-entry")
        .filter({ hasText: undatedTask.title })
        .count(),
      1,
      "An undated task appears once in the unscheduled list",
    );
    assert.equal(
      await agenda
        .locator(".schedule-agenda-entry")
        .filter({ hasText: overdueTask.title })
        .count(),
      0,
      "An overdue task is not duplicated into unscheduled tasks",
    );
    await agenda
      .getByRole("button", { name: "Back to selected day", exact: true })
      .click();
    calendarTaskResponse = "empty-unscheduled";
    await summary
      .getByRole("button")
      .filter({ hasText: "unscheduled tasks" })
      .click();
    await agenda.getByText("No unscheduled tasks.", { exact: true }).waitFor();
    await agenda
      .getByRole("button", { name: "Back to selected day", exact: true })
      .click();
    calendarTaskResponse = "normal";
    await summary
      .getByRole("button")
      .filter({ hasText: "overdue tasks" })
      .click();
    await agenda.getByRole("heading", { name: "Overdue tasks" }).waitFor();
    await agenda
      .locator(".schedule-agenda-entry")
      .filter({ hasText: overdueTask.title })
      .waitFor();
    assert.equal(
      await agenda
        .locator(".schedule-agenda-entry")
        .filter({ hasText: overdueTask.title })
        .count(),
      1,
      "An overdue task appears once in the overdue list",
    );

    await page.goto(`${base}/notes?note=${fixtures.note.id}`);
    await page.locator(".bn-editor").waitFor();
    await page.locator(".skip-link").focus();
    await page.keyboard.press("Enter");
    await page.waitForFunction(() =>
      document.activeElement?.matches(
        innerWidth < 768 ? ".note-pane" : ".notes-list",
      ),
    );
    if (width < 1024) {
      await touchTarget(
        page.getByRole("button", { name: /^Remove Audit.* tag$/ }).first(),
      );
      await touchTarget(
        page.getByRole("button", { name: "Add tag", exact: true }),
      );
    }
    await page.goto(`${base}/journal?note=${fixtures.journal.id}`);
    const journalView = page.getByRole("group", { name: "Journal view" });
    await journalView.waitFor();
    const activity = journalView.getByRole("button", {
      name: "Activity",
      exact: true,
    });
    await activity.focus();
    await page.keyboard.press("Enter");
    await page.waitForFunction(
      () =>
        document.querySelector(
          '[aria-label="Journal view"] button[aria-pressed="true"]',
        )?.textContent === "Activity",
    );
    await journalView
      .getByRole("button", { name: "Writing", exact: true })
      .focus();
    await page.keyboard.press("Enter");
    await page.waitForFunction(
      () =>
        document.querySelector(
          '[aria-label="Journal view"] button[aria-pressed="true"]',
        )?.textContent === "Writing",
    );

    await page.goto(`${base}/journal`);
    const browseTemplates = page.getByRole("button", {
      name: "Browse templates",
      exact: true,
    });
    await browseTemplates.focus();
    await page.keyboard.press("Enter");
    const templatePicker = page.locator(".writing-template-picker");
    await templatePicker.waitFor();
    const templateRow = templatePicker
      .locator(".writing-template-row")
      .filter({ hasText: fixtures.template.name });
    await templateRow.focus();
    await page.keyboard.press("Enter");
    await templatePicker.locator(".writing-template-detail").waitFor();
    const editTemplate = templatePicker.getByRole("button", {
      name: `Edit ${fixtures.template.name}`,
      exact: true,
    });
    await editTemplate.focus();
    await page.keyboard.press("Enter");
    await page.locator(".writing-template-editor").waitFor();
    await page.getByLabel("Name", { exact: true }).waitFor();
    assert.equal(
      await page.evaluate(() => document.activeElement?.id),
      "template-name",
      "Opening the template editor moves focus into its name field",
    );
    const previewTemplate = page.getByRole("button", {
      name: "Preview",
      exact: true,
    });
    await previewTemplate.focus();
    await page.keyboard.press("Enter");
    await page
      .locator("#template-editor-content .writing-template-preview")
      .waitFor();
    await page.getByRole("button", { name: "Edit content" }).waitFor();

    await page.goto(`${base}/capture`);
    await page.locator(".capture-page").waitFor();
    const captureType = page.getByRole("combobox", {
      name: "Save as",
      exact: true,
    });
    await captureType.waitFor();
    if (width < 1024) await touchTarget(captureType);
    await captureType.focus();
    await page.keyboard.press("Enter");
    await page.getByRole("option", { name: "Note", exact: true }).waitFor();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await page.getByLabel("Text", { exact: true }).waitFor();
    assert.equal(await page.locator("#capture-url").count(), 0);
    await captureType.focus();
    await page.keyboard.press("Enter");
    await page.getByRole("option", { name: "Task", exact: true }).waitFor();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await page.getByLabel("Task", { exact: true }).waitFor();
    assert.equal(await page.locator("#capture-text").count(), 0);
    assert.equal(await page.locator("#capture-url").count(), 0);
    await page.goto(`${base}/search`);
    const search = page.getByRole("combobox", {
      name: "Search everything",
      exact: true,
    });
    await search.waitFor();
    await search.fill("Audit");
    await page.getByRole("option").first().waitFor();
    await page.waitForFunction(
      () =>
        document
          .querySelector('[data-slot="command-list"]')
          ?.getAttribute("aria-busy") === "false",
    );
    await search.focus();
    await page.keyboard.press("ArrowDown");
    await page.waitForFunction(
      () =>
        !!document.querySelector(
          '[data-slot="command-item"][aria-selected="true"]',
        ),
    );
    if (width < 1024) {
      assert.equal(await page.locator(".workspace").getAttribute("inert"), "");
      assert.equal(
        await page
          .locator("main:not([inert]),[role=main]:not([inert])")
          .count(),
        1,
      );
      if (name === "chromium") {
        const cdp = await context.newCDPSession(page);
        const tree = await cdp.send("Accessibility.getFullAXTree");
        assert.equal(
          tree.nodes.filter(
            (node) => !node.ignored && node.role?.value === "main",
          ).length,
          1,
        );
        await cdp.detach();
      }
      await page
        .locator('.workspace button[aria-label="Open navigation"]')
        .first()
        .focus();
      assert.equal(
        await page.evaluate(
          () => !!document.activeElement?.closest(".workspace"),
        ),
        false,
        "Background remains unfocusable",
      );
      await touchTarget(search);
      await page
        .getByRole("button", { name: "Back from Search", exact: true })
        .click();
      await page.waitForFunction(() => location.pathname !== "/search");
    } else {
      await focusTrap(page, page.getByRole("dialog"));
      await page.keyboard.press("Escape");
      await page.getByRole("dialog").waitFor({ state: "hidden" });
    }
    await page.goto(`${base}/settings`);
    const tab = page.getByRole("tab", { name: "Account", exact: true });
    await tab.waitFor();
    const surface = page.locator(".settings-dialog");
    const height = (await surface.boundingBox()).height;
    await tab.focus();
    await page.keyboard.press("End");
    await page.getByRole("tab", { name: "MCP", exact: true }).waitFor();
    await page.waitForFunction(
      () =>
        document.activeElement?.getAttribute("aria-selected") === "true" &&
        document.activeElement?.textContent === "MCP",
    );
    if (width >= 1024) await focusTrap(page, page.getByRole("dialog"));
    if (width < 1024)
      for (const label of ["Account", "Import & export", "System", "MCP"])
        await touchTarget(page.getByRole("tab", { name: label, exact: true }));
    for (const label of ["Import & export", "System", "Account"]) {
      await page.getByRole("tab", { name: label, exact: true }).click();
      assert.ok(
        Math.abs((await surface.boundingBox()).height - height) < 1,
        "Settings height stays fixed between tabs",
      );
    }
    for (const [path, action] of [
      [`/calendar?event=${fixtures.event.id}`, null],
      ["/artifacts", `Open ${fixtures.artifact.title}`],
    ]) {
      await page.goto(base + path);
      if (action)
        await page.getByRole("button", { name: action, exact: true }).click();
      const dialog = page.getByRole("dialog");
      await dialog.waitFor();
      await focusTrap(page, dialog);
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "hidden" });
    }
    await page.goto(`${base}/overview`);
    if (width < 1024)
      await page
        .getByRole("button", { name: "Open navigation", exact: true })
        .first()
        .click();
    await page
      .getByRole("button", { name: "Quick", exact: true })
      .first()
      .click();
    const quick = page.getByRole("dialog", { name: "Quick", exact: true });
    await quick.waitFor();
    await focusTrap(page, quick);
    await page.keyboard.press("Escape");
    await quick.waitFor({ state: "hidden" });
    assert.equal(
      await page
        .locator("html")
        .evaluate((element) => element.scrollWidth > innerWidth + 1),
      false,
    );
    assert.deepEqual(errors, [], `${name} ${width}: browser errors`);
    await context.close();
    checked++;
    console.log(
      `${name} ${width}: navigation, skip link, calendar keys, tags, search, Settings keys and fixed height passed`,
    );
  }
  console.log(
    `Passed ${checked} keyboard/touch/reduced-motion viewport cases.`,
  );
} finally {
  await browser.close();
  await owner.dispose();
}
