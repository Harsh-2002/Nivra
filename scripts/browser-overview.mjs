import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";

export default async function verifyOverview(page, phase, options = {}) {
  const base = options.base ?? new URL(page.url()).origin;
  if (new URL(base).port !== "3015")
    throw new Error("Use the synthetic optimized instance on port 3015.");
  const pageErrors = options.pageErrors ?? [];
  if (!options.pageErrors)
    page.on("pageerror", (error) =>
      pageErrors.push({ message: error.message, stack: error.stack }),
    );
  const api = async (path, method = "GET", data) => {
    const response = await page.request.fetch(`${base}/api/v1/${path}`, {
      method,
      data,
    });
    if (!response.ok())
      throw new Error(`Fixture request failed: ${path} (${response.status()})`);
    return response.json();
  };
  if (!/review|audit|test/i.test((await api("status")).owner?.name ?? ""))
    throw new Error("Use a disposable synthetic test owner.");
  page.setDefaultTimeout(15000);
  await page.setViewportSize({ width: 1440, height: 900 });
  if (phase === "live") await page.goto("about:blank");
  else await page.goto(base);
  const overview = page.getByRole("region", { name: "Overview", exact: true });
  const ready = () =>
    overview.locator(".overview-grid[data-card-count]").waitFor();
  const passed = [];
  const check = (condition, name) => {
    if (!condition) throw new Error(name);
    passed.push(name);
  };
  const navigation = page.getByRole("navigation", {
    name: "Workspace navigation",
  });
  const back = async () => {
    await navigation
      .getByRole("button", { name: "Overview", exact: true })
      .click();
    await ready();
  };
  if (phase === "live") {
    const browser = page.context().browser();
    assert.ok(browser, "A browser context is required for the second session");
    const timezone = await page.evaluate(
      () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    );
    const actor = await browser.newContext({
      storageState: await page.context().storageState(),
      timezoneId: timezone,
      serviceWorkers: "block",
      extraHTTPHeaders: { origin: base },
    });
    const actorPage = await actor.newPage();
    const actorPageErrors = [];
    actorPage.on("pageerror", (error) =>
      actorPageErrors.push({ message: error.message, stack: error.stack }),
    );
    const actorApi = async (path, method = "GET", data) => {
      const response = await actorPage.request.fetch(`${base}/api/v1/${path}`, {
        method,
        data,
        maxRetries: method === "GET" ? 2 : 0,
      });
      assert.ok(
        response.ok(),
        `${method} ${path}: ${response.status()} ${await response.text()}`,
      );
      return response.json();
    };
    const overviewPath = "**/api/v1/overview?*";
    const emptyOverview = {
      counts: { open: 0, today: 0, overdue: 0 },
      tasks: [],
      notes: [],
      bookmarks: [],
      calendar: [],
      recentItems: [],
      refreshedAt: Date.now(),
    };
    const firstUseRoute = (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(emptyOverview),
      });
    let revealReview = false;
    let activeHold = null;
    let overviewCalls = 0;
    const overviewRoute = async (route) => {
      overviewCalls++;
      const response = await route.fetch();
      const data = await response.json();
      if (!revealReview) delete data.review;
      if (activeHold) {
        const hold = activeHold;
        hold.enter();
        await hold.gate;
      }
      try {
        await route.fulfill({ response, body: JSON.stringify(data) });
      } catch {
        // The client can abort an older refresh when another event arrives.
      }
    };
    const dateAt = (offset) =>
      actorPage.evaluate((days) => {
        const date = new Date();
        date.setDate(date.getDate() + days);
        return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
      }, offset);
    try {
      await page.route(overviewPath, firstUseRoute);
      const completionStream = page.waitForRequest(
        (request) => new URL(request.url()).pathname === "/api/v1/completions",
      );
      await page.goto(base);
      await ready();
      await completionStream;
      await overview.locator('.overview-grid[data-card-count="1"]').waitFor();
      check(
        await overview.getByText("Your workspace is ready").isVisible(),
        "First use presents a single concise welcome state",
      );
      check(
        (await overview
          .locator(".overview-grid > .overview-widget")
          .count()) === 1,
        "First use avoids repeated empty-card prompts",
      );
      await page.unroute(overviewPath, firstUseRoute);
      await page.route(overviewPath, overviewRoute);

      const ai = await actorApi("ai");
      await page.evaluate(() => {
        window.__overviewAiEvents = 0;
        window.addEventListener("nivra:ai-completion", () => {
          window.__overviewAiEvents++;
        });
      });
      const beforeAiRefresh = overviewCalls;
      await actorApi("ai", "PATCH", {
        enabled: false,
        revision: ai.revision,
      });
      await page.waitForFunction(
        () => window.__overviewAiEvents > 0,
        undefined,
        { timeout: 10000 },
      );
      for (
        let attempt = 0;
        overviewCalls <= beforeAiRefresh && attempt < 100;
        attempt++
      )
        await new Promise((resolve) => setTimeout(resolve, 50));
      check(
        overviewCalls > beforeAiRefresh,
        "The live AI completion event refreshes the visible Overview",
      );
      passed.push(
        "AI stays disabled during synthetic content writes so the browser check does not load a model",
      );

      const stamp = `${Date.now()}-${randomUUID().slice(0, 8)}`;
      const taskTitle = `Live overview task ${stamp}`;
      const task = await actorApi("tasks", "POST", {
        title: taskTitle,
        dueDate: await dateAt(1),
      });
      await overview
        .getByRole("button", { name: new RegExp(taskTitle) })
        .waitFor();
      await overview.locator('.overview-grid[data-card-count="2"]').waitFor();
      check(
        true,
        "Session B sees Session A's task creation over SSE without reload",
      );

      const renamedTaskTitle = `Updated overview task ${stamp}`;
      const taskRow = overview
        .getByRole("checkbox", { name: `Complete ${taskTitle}`, exact: true })
        .locator("xpath=ancestor::li[1]");
      await taskRow.evaluate((element, id) => {
        element.dataset.liveTask = id;
        element.querySelector('[role="checkbox"]').dataset.liveCheckbox =
          "kept";
      }, task.id);
      const stableTaskRow = overview.locator(`li[data-live-task="${task.id}"]`);
      let enterHold;
      let releaseHold;
      const holdEntered = new Promise((resolve) => (enterHold = resolve));
      const holdGate = new Promise((resolve) => (releaseHold = resolve));
      activeHold = { enter: enterHold, gate: holdGate };
      await actorApi(`tasks/${task.id}`, "PATCH", {
        revision: task.revision,
        title: renamedTaskTitle,
      });
      await Promise.race([
        holdEntered,
        new Promise((_, reject) =>
          setTimeout(
            () =>
              reject(new Error("No Overview refresh followed the task update")),
            10000,
          ),
        ),
      ]);
      check(
        await stableTaskRow.getByText(taskTitle, { exact: true }).isVisible(),
        "The previous task remains visible during a delayed refresh",
      );
      check(
        (await stableTaskRow.getAttribute("data-live-task")) === task.id &&
          (await stableTaskRow
            .getByRole("checkbox")
            .getAttribute("data-live-checkbox")) === "kept",
        "The task row and completion control retain their DOM identity while refreshing",
      );
      activeHold = null;
      releaseHold();
      await stableTaskRow
        .getByText(renamedTaskTitle, { exact: true })
        .waitFor();
      check(
        (await stableTaskRow.getAttribute("data-live-task")) === task.id &&
          (await stableTaskRow
            .getByRole("checkbox")
            .getAttribute("data-live-checkbox")) === "kept",
        "The task row and completion control survive the refreshed snapshot",
      );

      const eventTitle = `Live overview event ${stamp}`;
      const updatedEventTitle = `Updated overview event ${stamp}`;
      const eventInput = {
        title: eventTitle,
        description: "",
        location: "",
        allDay: true,
        start: await dateAt(2),
        end: await dateAt(3),
        timezone,
        recurrence: null,
        links: [],
        reminders: [],
      };
      const event = await actorApi("events", "POST", eventInput);
      await overview.getByText(eventTitle, { exact: true }).waitFor();
      await actorApi(`events/${event.id}`, "PATCH", {
        input: { ...eventInput, title: updatedEventTitle },
        revision: event.revision,
      });
      await overview.getByText(updatedEventTitle, { exact: true }).waitFor();
      check(
        true,
        "Overview refreshes for a created and updated calendar event",
      );

      const artifactTitle = `Live overview artifact ${stamp}`;
      const updatedArtifactTitle = `Updated overview artifact ${stamp}`;
      const artifact = await actorApi("artifacts", "POST", {
        text: `${artifactTitle}\nSynthetic overview content.`,
      });
      await actorApi(`artifacts/${artifact.id}`, "PATCH", {
        revision: artifact.revision,
        title: updatedArtifactTitle,
      });
      await overview.getByText(updatedArtifactTitle, { exact: true }).waitFor();
      check(true, "Overview refreshes for a created and updated artifact");

      const originalTheme = (await api("settings")).theme;
      async function setTheme(theme) {
        const label = theme[0].toUpperCase() + theme.slice(1);
        await page.getByRole("button", { name: /Color theme:/ }).click();
        await page.getByRole("menuitemradio", { name: label }).click();
        await page.waitForFunction(
          (value) => document.documentElement.classList.contains(value),
          theme,
        );
        await ready();
      }
      for (const theme of ["light", "dark"]) {
        await setTheme(theme);
        for (const width of [320, 768, 1100, 1440]) {
          await page.setViewportSize({
            width,
            height: width < 768 ? 844 : 900,
          });
          await page.waitForTimeout(100);
          const layout = await page.evaluate(() => ({
            cards: Number(
              document
                .querySelector(".overview-grid")
                ?.getAttribute("data-card-count"),
            ),
            overflow: document.documentElement.scrollWidth > innerWidth + 1,
          }));
          assert.equal(
            layout.cards,
            2,
            `${theme} ${width}px should show two cards`,
          );
          assert.equal(
            layout.overflow,
            false,
            `${theme} ${width}px should not overflow`,
          );
          passed.push(
            `${theme} ${width}px two-card overview remains responsive`,
          );
          if (options.captureDirectory && [320, 1100, 1440].includes(width)) {
            await page
              .locator(".overview-scroll")
              .evaluate((element) => (element.scrollTop = 0));
            await page.screenshot({
              path: join(
                options.captureDirectory,
                `overview-two-${theme}-${width}.png`,
              ),
            });
          }
        }
      }
      await page.setViewportSize({ width: 1440, height: 900 });

      await overview
        .getByRole("button", { name: new RegExp(updatedEventTitle) })
        .click();
      const eventDialog = page.getByRole("dialog");
      await eventDialog
        .getByRole("heading", { name: updatedEventTitle })
        .waitFor();
      check(
        new URL(page.url()).searchParams.get("event") === event.id,
        "Upcoming event opens the matching read-only event view by canonical id",
      );
      await eventDialog
        .getByRole("button", { name: "Back to calendar" })
        .click();
      await back();

      await overview
        .getByRole("button", { name: new RegExp(updatedArtifactTitle) })
        .click();
      const artifactDialog = page.getByRole("dialog", {
        name: updatedArtifactTitle,
      });
      await artifactDialog.waitFor();
      assert.equal(
        await artifactDialog
          .getByRole("textbox", { name: "Title" })
          .inputValue(),
        updatedArtifactTitle,
      );
      check(
        true,
        "Recent artifact opens the matching artifact viewer directly",
      );
      await page.keyboard.press("Escape");
      await back();

      const fieldId = randomUUID();
      const form = await actorApi("forms", "POST", {
        definition: {
          schemaVersion: 1,
          title: `Live overview form ${stamp}`,
          confirmation: "Received",
          fields: [
            {
              id: fieldId,
              type: "short_text",
              label: "Feedback",
              required: true,
            },
          ],
        },
      });
      const published = await actorApi(`forms/${form.id}/publish`, "POST", {
        revision: form.revision,
      });
      const privateAnswer = `Private response ${stamp}`;
      revealReview = true;
      await actorApi(
        `public/forms/${published.publicToken}/responses`,
        "POST",
        {
          versionId: published.publishedVersionId,
          retryKey: randomUUID(),
          answers: { [fieldId]: privateAnswer },
        },
      );
      await overview
        .locator('.overview-grid[data-card-count="3"]')
        .waitFor({ timeout: 10000 });
      await overview.getByText(/unreviewed form response/).waitFor();
      check(
        true,
        "A public form response adds the conditional review card over SSE",
      );
      assert.equal(
        (await page.locator("body").innerText()).includes(privateAnswer),
        false,
        "Overview shows the review count without exposing response text",
      );

      for (const theme of ["light", "dark"]) {
        await setTheme(theme);
        for (const width of [320, 768, 1100, 1440]) {
          await page.setViewportSize({
            width,
            height: width < 768 ? 844 : 900,
          });
          await page.waitForTimeout(100);
          const layout = await page.evaluate(() => ({
            cards: Number(
              document
                .querySelector(".overview-grid")
                ?.getAttribute("data-card-count"),
            ),
            overflow: document.documentElement.scrollWidth > innerWidth + 1,
          }));
          assert.equal(
            layout.cards,
            3,
            `${theme} ${width}px should show three cards`,
          );
          assert.equal(
            layout.overflow,
            false,
            `${theme} ${width}px should not overflow`,
          );
          passed.push(
            `${theme} ${width}px three-card overview remains responsive`,
          );
          if (options.captureDirectory && [320, 1100, 1440].includes(width)) {
            await page
              .locator(".overview-scroll")
              .evaluate((element) => (element.scrollTop = 0));
            await page.screenshot({
              path: join(
                options.captureDirectory,
                `overview-three-${theme}-${width}.png`,
              ),
            });
          }
        }
      }
      await setTheme(originalTheme);
      assert.deepEqual(pageErrors, [], "Overview page raised browser errors");
      assert.deepEqual(
        actorPageErrors,
        [],
        "Second browser context raised browser errors",
      );
    } finally {
      await actor.close();
    }
  } else if (phase === "functional") {
    check(
      (await navigation.getByRole("button").first().innerText()) === "Overview",
      "Overview is the first navigation section",
    );
    check(
      await overview.isVisible(),
      "Overview is the default landing section",
    );
    check(
      (await overview.getByLabel("Today's date").getAttribute("datetime"))
        .length === 10,
      "Full local date and year are present",
    );
    check(
      (await overview.getByLabel("Current time").innerText()).length > 0,
      "Local clock is displayed",
    );
    check(
      await overview.getByText("Your workspace is ready").isVisible(),
      "A first-use workspace gets one concise introductory state",
    );
    check(
      (await overview.locator(".overview-grid > .overview-widget").count()) ===
        1,
      "First use avoids duplicate empty-card prompts",
    );
    check(
      await page.getByRole("group", { name: "Quick actions" }).isVisible(),
      "Existing quick actions remain available in the introductory state",
    );
    const stamp = Date.now();
    const title = `Overview scheduled ${stamp}`;
    const date = await page.evaluate(() => {
      const d = new Date();
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    });
    const task = await api("tasks", "POST", {
      title,
      dueDate: date,
      recurrence: "daily",
    });
    const note = await api("notes", "POST", {
      title: `Overview thought ${stamp}`,
    });
    const bookmark = await api("bookmarks", "POST", {
      url: `https://example.com/?overview=${stamp}`,
    });
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await overview
      .getByRole("checkbox", { name: `Complete ${title}`, exact: true })
      .waitFor();
    check(true, "Refresh shows externally created workspace items");
    await overview
      .getByRole("checkbox", { name: `Complete ${title}`, exact: true })
      .click();
    await page
      .getByText("Task completed. Next occurrence created.", { exact: true })
      .waitFor();
    const tasks = await api("tasks");
    check(
      tasks.some((t) => t.parentTaskId === task.id && !t.completedAt),
      "Inline completion creates the recurring successor",
    );
    check(
      tasks.find((t) => t.id === task.id).completedAt !== null,
      "Inline completion persists",
    );
    const link = overview.locator(`a[href="${bookmark.url}"]`);
    check(
      (await link.getAttribute("target")) === "_blank" &&
        (await link.getAttribute("rel")).includes("noopener"),
      "Bookmark quick access is a safe external link",
    );
    await overview
      .getByRole("button", { name: new RegExp(note.title) })
      .click();
    await page
      .getByRole("textbox", { name: "Note title", exact: true })
      .waitFor();
    check(
      (await page
        .getByRole("textbox", { name: "Note title", exact: true })
        .inputValue()) === note.title,
      "Recent note opens the exact note",
    );
    await back();
    await overview
      .getByRole("button", { name: "View all tasks", exact: true })
      .click();
    await page
      .getByRole("textbox", { name: "Search tasks", exact: true })
      .waitFor();
    check(
      (await page
        .getByRole("textbox", { name: "Search tasks", exact: true })
        .inputValue()) === "",
      "View all tasks clears previous search targets",
    );
    await back();
    await overview
      .locator(".overview-task-link")
      .filter({ hasText: title })
      .click();
    await page
      .getByRole("textbox", { name: "Search tasks", exact: true })
      .waitFor();
    check(
      (await page
        .getByRole("textbox", { name: "Search tasks", exact: true })
        .inputValue()) === title,
      "Task quick access locates the selected task",
    );
    await back();
    await overview
      .getByRole("button", { name: "Add task", exact: true })
      .click();
    await page.waitForFunction(
      () => document.activeElement?.getAttribute("aria-label") === "New task",
    );
    check(true, "Add task focuses the existing creation field");
    await back();
    await overview
      .getByRole("button", { name: "Save link", exact: true })
      .click();
    await page.waitForFunction(
      () => document.activeElement?.id === "bookmark-url",
    );
    check(true, "Save link focuses the existing URL field");
    await back();
    await overview
      .getByRole("button", { name: "Journal", exact: true })
      .click();
    await page.getByText("Journal", { exact: false }).waitFor();
    check(true, "Today's note opens the daily note");
    await back();
    await overview
      .getByRole("button", { name: "New note", exact: true })
      .click();
    await page
      .getByRole("textbox", { name: "Note title", exact: true })
      .waitFor();
    check(true, "New note opens the editor");
    await back();
    await page.keyboard.press("Control+k");
    await page
      .getByRole("combobox", { name: "Search everything", exact: true })
      .waitFor();
    check(true, "Unified search works from Overview");
    await page.keyboard.press("Escape");
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    await page.route("**/api/v1/overview?*", (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "Test server unavailable" }),
      }),
    );
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await overview.getByRole("alert").waitFor();
    check(
      await overview.getByText("Recent items", { exact: true }).isVisible(),
      "Refresh failure keeps the last snapshot visible",
    );
    await page.unroute("**/api/v1/overview?*");
    await overview
      .getByRole("button", { name: "Try again", exact: true })
      .click();
    await overview.getByRole("alert").waitFor({ state: "hidden" });
    check(true, "Retry recovers the failed refresh");
    await page.reload();
    await ready();
    check(
      await overview.isVisible(),
      "Reload returns to Overview with persisted items",
    );
  } else if (phase === "polling") {
    const note = await api("notes", "POST", {
      title: `Live overview ${Date.now()}`,
    });
    await overview
      .getByRole("button", { name: new RegExp(note.title) })
      .waitFor({ timeout: 35000 });
    check(
      true,
      "Visible Overview automatically refreshes external changes within 30 seconds",
    );
  } else if (phase === "hidden") {
    let requests = 0;
    const listener = (request) => {
      if (request.url().includes("/api/v1/overview?")) requests++;
    };
    page.on("request", listener);
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        value: "hidden",
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await page.waitForTimeout(31000);
    check(requests === 0, "Hidden tabs stop summary polling");
    await page.evaluate(() => {
      delete document.visibilityState;
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await overview.locator(".overview-grid[data-card-count]").waitFor();
    await page.waitForTimeout(200);
    check(requests > 0, "Returning to the tab refreshes immediately");
    page.off("request", listener);
  } else if (phase === "responsive") {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page
      .getByRole("button", {
        name: options.theme === "dark" ? "Dark" : "Light",
        exact: true,
      })
      .click();
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    await page.addScriptTag({ path: options.axePath });
    for (const width of options.widths || [1440, 768, 390, 320]) {
      await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 });
      await page.waitForTimeout(250);
      const report = await page.evaluate(async () => ({
        overflow: document.documentElement.scrollWidth > innerWidth,
        cardCount: Number(
          document
            .querySelector(".overview-grid")
            ?.getAttribute("data-card-count"),
        ),
        gridColumns: getComputedStyle(
          document.querySelector(".overview-grid"),
        ).gridTemplateColumns.split(" ").length,
        smallCompletionTargets:
          innerWidth < 768
            ? [...document.querySelectorAll(".overview-check > button")].filter(
                (e) => {
                  const hit = getComputedStyle(e, "::after");
                  return (
                    e.getBoundingClientRect().height -
                      parseFloat(hit.top) -
                      parseFloat(hit.bottom) <
                    44
                  );
                },
              ).length
            : 0,
        violations: (
          await window.axe.run(document, {
            runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] },
          })
        ).violations.map((v) => ({
          id: v.id,
          targets: v.nodes.map((n) => n.target),
        })),
        nativeSelects: [...document.querySelectorAll("select")].filter(
          (e) =>
            e.getBoundingClientRect().width > 1 &&
            getComputedStyle(e).opacity !== "0",
        ).length,
      }));
      const expectedColumns =
        width < 1024 || report.cardCount === 1
          ? 1
          : report.cardCount === 3 && width >= 1280
            ? 3
            : 2;
      check(
        !report.overflow &&
          !report.nativeSelects &&
          !report.violations.length &&
          !report.smallCompletionTargets &&
          report.gridColumns === expectedColumns,
        `${options.theme} ${width}px layout and accessibility: ${JSON.stringify(report)}`,
      );
      await overview
        .locator(".overview-scroll")
        .evaluate((e) => (e.scrollTop = 0));
      await page.screenshot({
        path: `${options.captureDirectory}/overview-${options.theme}-${width}.png`,
        fullPage: true,
      });
    }
  }
  return { phase, passed };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const base = process.env.NIVRA_BROWSER_TEST_URL ?? "http://localhost:3015";
  const session = process.env.NIVRA_BROWSER_SESSION;
  const captureDirectory = process.env.NIVRA_AUDIT_OUTPUT;
  assert.equal(new URL(base).port, "3015", "Disposable server required");
  assert.ok(session && existsSync(session), "Synthetic owner session required");
  if (captureDirectory) await mkdir(captureDirectory, { recursive: true });
  const browser = await chromium.launch();
  const context = await browser.newContext({
    storageState: session,
    viewport: { width: 1440, height: 900 },
    serviceWorkers: "block",
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) =>
    pageErrors.push({ message: error.message, stack: error.stack }),
  );
  try {
    const result = await verifyOverview(
      page,
      process.env.NIVRA_OVERVIEW_PHASE ?? "live",
      { base, pageErrors, captureDirectory },
    );
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await context.close();
    await browser.close();
  }
}
