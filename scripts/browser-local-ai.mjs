import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
import { chromium, firefox, webkit, request } from "playwright";
const base = process.env.NIVRA_BROWSER_TEST_URL ?? "http://localhost:3015";
assert.equal(new URL(base).port, "3015", "Disposable server required");
const session = process.env.NIVRA_BROWSER_SESSION;
assert.ok(session, "Synthetic owner session required");
const owner = await request.newContext({
  baseURL: base,
  ...(existsSync(session) ? { storageState: session } : {}),
  extraHTTPHeaders: { origin: base, "content-type": "application/json" },
});
async function api(path, method = "GET", data) {
  const response = await owner
    .fetch(`/api/v1/${path}`, {
      method,
      data,
      maxRetries: method === "GET" ? 2 : 0,
    })
    .catch((error) => {
      throw new Error(`${method} ${path}: ${error.message.split("\n")[0]}`);
    });
  assert.ok(response.ok(), `${method} ${path}: ${response.status()}`);
  return response.json();
}
if ((await api("status")).setup) {
  await api("setup", "POST", {
    name: "Smart features test",
    username: "local_ai_test",
    password: `AI-${randomUUID()}`,
  });
  await api("settings", "PATCH", { onboardingStep: "complete" });
  await owner.storageState({ path: session });
  await chmod(session, 0o600);
}
assert.match((await api("status")).owner?.name ?? "", /review|audit|test/i);
const originalTheme = (await api("settings")).theme;
const originalAiStatus = await api("ai");
let status = originalAiStatus;
if (!status.enabled || status.taggingMode !== "manual")
  status = await api("ai", "PATCH", {
    enabled: true,
    revision: status.revision,
    taggingMode: "manual",
  });
const name = process.env.NIVRA_AUDIT_ENGINE ?? "chromium",
  engines = { chromium, firefox, webkit };
assert.ok(engines[name]);
const browser = await engines[name].launch();
const axe = await readFile("node_modules/axe-core/axe.min.js", "utf8");
const output = process.env.NIVRA_AUDIT_OUTPUT;
if (output) await mkdir(output, { recursive: true });
let primaryRunError;
try {
  for (const width of (process.env.NIVRA_AUDIT_WIDTHS ?? "320,390,768,1440")
    .split(",")
    .map(Number))
    for (const theme of ["light", "dark"]) {
      const updatedSettings = await api("settings", "PATCH", { theme });
      assert.equal(updatedSettings.theme, theme);
      const context = await browser.newContext({
        storageState: session,
        viewport: { width, height: 900 },
        colorScheme: theme,
        hasTouch: width < 1024,
        serviceWorkers: "block",
      });
      await context.addInitScript(() => {
        class IsolatedEventSource extends EventTarget {
          static CONNECTING = 0;
          static OPEN = 1;
          static CLOSED = 2;

          constructor(url) {
            super();
            this.url = new URL(url, window.location.href).href;
            this.withCredentials = false;
            this.readyState = IsolatedEventSource.CONNECTING;
            this.heartbeat = setInterval(
              () => this.dispatchEvent(new Event("heartbeat")),
              5000,
            );
            queueMicrotask(() => {
              this.readyState = IsolatedEventSource.OPEN;
              this.dispatchEvent(new Event("open"));
            });
          }

          close() {
            this.readyState = IsolatedEventSource.CLOSED;
            clearInterval(this.heartbeat);
          }
        }

        Object.defineProperty(window, "EventSource", {
          configurable: true,
          value: IsolatedEventSource,
        });
      });
      const page = await context.newPage(),
        errors = [],
        failedApiRequests = [],
        cancelledSearchRequests = [],
        pendingApiRequests = new Set();
      let lastWorkspaceApiActivity = Date.now();
      let lastIndexWaitDiagnostics = null;
      const isWorkspaceApi = (request) =>
        ["fetch", "xhr"].includes(request.resourceType()) &&
        request.url().includes("/api/v1/");
      page.on("pageerror", (error) =>
        errors.push({ message: error.message, stack: error.stack }),
      );
      page.on("request", (request) => {
        if (isWorkspaceApi(request)) {
          lastWorkspaceApiActivity = Date.now();
          pendingApiRequests.add(request);
        }
      });
      page.on("requestfinished", (request) => {
        if (!isWorkspaceApi(request)) return;
        lastWorkspaceApiActivity = Date.now();
        pendingApiRequests.delete(request);
      });
      page.on("requestfailed", (request) => {
        if (!isWorkspaceApi(request)) return;
        lastWorkspaceApiActivity = Date.now();
        pendingApiRequests.delete(request);
        const url = new URL(request.url());
        const failure = {
          method: request.method(),
          path: url.pathname,
          error: request.failure()?.errorText,
        };
        if (
          failure.path === "/api/v1/search" &&
          failure.error === "net::ERR_ABORTED"
        )
          cancelledSearchRequests.push({
            ...failure,
            strategy: url.searchParams.get("strategy"),
            queryLength: url.searchParams.get("q")?.length ?? null,
          });
        else failedApiRequests.push(failure);
      });
      const title = `report-${randomUUID().slice(0, 8)}.pdf SQLite recovery`;
      const tagName = `Database checks ${randomUUID().slice(0, 6)}`;
      let tag = null;
      let note = null;
      async function cleanupFixture() {
        const failures = [];
        if (note) {
          try {
            const current = await api(`notes/${note.id}`);
            await api(`notes/${note.id}`, "DELETE", {
              revision: current.revision,
            });
            note = null;
          } catch (error) {
            failures.push(error);
          }
        }
        if (tag) {
          try {
            await api(`tags/${tag.id}`, "DELETE");
            tag = null;
          } catch (error) {
            failures.push(error);
          }
        }
        if (failures.length === 1) throw failures[0];
        if (failures.length)
          throw new AggregateError(failures, "Browser fixture cleanup failed");
      }
      try {
        tag = await api("tags", "POST", {
          name: tagName,
          color: "gray",
          aliases: ["sqlite database queries indexes"],
        });
        note = await api("notes", "POST", { title });
        await api(`notes/${note.id}`, "PATCH", {
          title,
          revision: note.revision,
          document: {
            schemaVersion: 1,
            blocks: [
              {
                id: randomUUID(),
                type: "paragraph",
                props: {},
                content: [
                  {
                    type: "text",
                    text: "SQLite database queries and indexes verify encrypted backup restore.",
                    styles: {},
                  },
                ],
                children: [],
              },
            ],
          },
        });
      } catch (error) {
        try {
          await cleanupFixture();
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            "Fixture creation and cleanup both failed",
          );
        }
        throw error;
      }
      async function nav() {
        if (width < 1024) {
          if (await page.locator(".mobile-back").isVisible())
            await page.locator(".mobile-back").click();
          await page
            .getByRole("button", { name: "Open navigation", exact: true })
            .first()
            .click();
          return page.getByRole("dialog", { name: "Navigation", exact: true });
        }
        return page.locator(".desktop-navigation");
      }
      async function verifyDesktopSidebarCollapse() {
        if (width < 1024) return;
        const desktopNavigation = page.locator(".desktop-navigation");
        await desktopNavigation.waitFor({ state: "visible" });
        const waitForRailWidth = (expectedWidth) =>
          page.waitForFunction((expected) => {
            const rail = document.querySelector(".desktop-navigation");
            return (
              rail &&
              Math.abs(rail.getBoundingClientRect().width - expected) < 1
            );
          }, expectedWidth);
        const assertTargetSize = async (button, label) => {
          const bounds = await button.boundingBox();
          assert.ok(bounds, `${label} must have a visible target`);
          assert.ok(
            bounds.width >= 44 - 1e-4 && bounds.height >= 44 - 1e-4,
            `${label} target must be at least 44×44px; got ${bounds.width}×${bounds.height}px`,
          );
        };
        const collapse = desktopNavigation.getByRole("button", {
          name: "Collapse sidebar",
          exact: true,
        });
        await assertTargetSize(collapse, "Collapse sidebar");
        await collapse.focus();
        await collapse.click();
        await waitForRailWidth(64);
        assert.equal(
          await desktopNavigation.evaluate((element) =>
            element.classList.contains("is-collapsed"),
          ),
          true,
          "Collapsing the sidebar must retain its compact navigation rail",
        );
        const activeNavigationItem = desktopNavigation
          .locator(".navigation-scroll .nav-item.active")
          .first();
        assert.equal(
          await activeNavigationItem.getAttribute("aria-current"),
          "page",
          "The compact rail must keep its current-page semantics",
        );
        assert.equal(
          await activeNavigationItem.evaluate(
            (element) => getComputedStyle(element).boxShadow,
          ),
          "none",
          "The compact current-page icon must not add an inset selection bar",
        );
        const expand = desktopNavigation.getByRole("button", {
          name: "Expand sidebar",
          exact: true,
        });
        await expand.waitFor({ state: "visible" });
        await assertTargetSize(expand, "Expand sidebar");
        assert.equal(
          await expand.locator("svg.lucide-chevron-right").count(),
          1,
          "The compact rail should use a right-chevron expansion control",
        );
        assert.equal(
          await page
            .getByRole("button", { name: "Open navigation", exact: true })
            .count(),
          0,
          "Desktop expansion should not add a floating header control",
        );
        assert.equal(
          await expand.evaluate(
            (element) => element === document.activeElement,
          ),
          true,
          "Keyboard focus should remain on the sidebar control after collapsing",
        );
        const selectedTagButton = desktopNavigation.getByRole("button", {
          name: tag.name,
          exact: true,
        });
        await selectedTagButton.click();
        const selectedTagRow = selectedTagButton.locator("xpath=..");
        assert.equal(
          await selectedTagButton.getAttribute("aria-pressed"),
          "true",
          "The compact selected tag must retain its pressed state",
        );
        const selectedTagDecoration = await selectedTagRow.evaluate((row) => {
          const dot = row.querySelector(".tag-dot");
          const style = getComputedStyle(row);
          const before = getComputedStyle(row, "::before");
          const dotStyle = dot ? getComputedStyle(dot) : null;
          return {
            boxShadow: style.boxShadow,
            beforeContent: before.content,
            dotOutline: dotStyle?.outlineStyle,
            dotWidth: dotStyle?.width,
            backgroundColor: style.backgroundColor,
            railBackgroundColor: getComputedStyle(
              row.closest(".desktop-navigation"),
            ).backgroundColor,
          };
        });
        assert.equal(
          selectedTagDecoration.boxShadow,
          "none",
          "The compact selected tag must not have a border outline",
        );
        assert.ok(
          ["none", "normal"].includes(selectedTagDecoration.beforeContent),
          "The compact selected tag must not have a left indicator bar",
        );
        assert.equal(
          selectedTagDecoration.dotOutline,
          "none",
          "The compact selected tag dot must not have a halo outline",
        );
        assert.equal(
          selectedTagDecoration.dotWidth,
          "14px",
          "The compact selected tag uses a modest size cue",
        );
        assert.notEqual(
          selectedTagDecoration.backgroundColor,
          selectedTagDecoration.railBackgroundColor,
          "The compact selected tag keeps its tinted background cue",
        );
        await expand.click();
        await waitForRailWidth(216);
        const restoredCollapse = desktopNavigation.getByRole("button", {
          name: "Collapse sidebar",
          exact: true,
        });
        await restoredCollapse.waitFor({ state: "visible" });
        await assertTargetSize(restoredCollapse, "Collapse sidebar");
        assert.equal(
          await restoredCollapse.locator("svg.lucide-chevron-left").count(),
          1,
          "The expanded rail should use a left-chevron collapse control",
        );
        assert.equal(
          await restoredCollapse.evaluate(
            (element) => element === document.activeElement,
          ),
          true,
          "Keyboard focus should remain on the sidebar control after expanding",
        );
      }
      async function sidebarLabelStarts(suggestionsLocator, tagLocator) {
        const tagElement = await tagLocator.elementHandle();
        if (!tagElement) return null;
        return suggestionsLocator.evaluate((suggestions, tag) => {
          const icon = suggestions.querySelector("svg");
          const tagLabel = tag.querySelector(".tag-dot + span");
          if (!icon || !tagLabel) return null;
          const style = getComputedStyle(suggestions);
          return {
            suggestions:
              icon.getBoundingClientRect().right +
              Number.parseFloat(style.columnGap),
            tag: tagLabel.getBoundingClientRect().left,
          };
        }, tagElement);
      }
      async function surface(label) {
        const s =
          width < 1024
            ? page.getByRole("main", { name: label, exact: true })
            : page.getByRole("dialog", {
                name: label === "Search" ? "Search Nivra" : label,
                exact: true,
              });
        await s.waitFor();
        return s;
      }
      async function audit(s, label) {
        assert.equal(
          await page.evaluate(() =>
            document.documentElement.classList.contains("dark"),
          ),
          theme === "dark",
          `${name} ${width} ${theme} ${label}: rendered theme must match the test case`,
        );
        await page.evaluate(axe);
        const findings = await page.evaluate(async () =>
          (
            await window.axe.run(document, {
              runOnly: {
                type: "tag",
                values: ["wcag2a", "wcag2aa", "wcag21aa"],
              },
            })
          ).violations.map((v) => ({ id: v.id, impact: v.impact })),
        );
        assert.deepEqual(findings, [], `${label}: accessibility`);
        assert.equal(
          await page.evaluate(
            () => document.documentElement.scrollWidth > innerWidth + 1,
          ),
          false,
          `${label}: overflow`,
        );
        if (output)
          await page.screenshot({
            path: `${output}/${name}-${width}-${theme}-${label}.png`,
          });
        if (width < 1024) {
          const sizes = await s
            .locator(".tag-suggestion-card button, .tag-proposal-card button")
            .evaluateAll((elements) =>
              elements.map((e) => e.getBoundingClientRect().height),
            );
          assert.ok(
            sizes.every((h) => h >= 43),
            "Touch actions must remain 44px",
          );
        }
      }
      async function verifySuggestionCardActions(suggestions, title, name) {
        const source = suggestions.getByRole("button", {
          name: `Open ${title}`,
          exact: true,
        });
        const card = source.locator("xpath=ancestor::li[1]");
        const dismiss = card.getByRole("button", {
          name: `Dismiss suggestion for ${name} on ${title}`,
          exact: true,
        });
        const add = card.getByRole("button", {
          name: `Add ${name} to ${title}`,
          exact: true,
        });
        await source.waitFor({ state: "visible" });
        assert.equal(await source.count(), 1);
        assert.equal(await dismiss.count(), 1);
        assert.equal(await add.count(), 1);
        assert.equal(
          await card.locator(".tag-suggestion-actions button").count(),
          1,
          "Each card should expose one footer action for adding the tag",
        );
        const addPresentation = await add.evaluate((button) => {
          const { width, height } = button.getBoundingClientRect();
          return {
            text: button.innerText.trim(),
            icons: button.querySelectorAll("svg").length,
            width,
            height,
          };
        });
        assert.equal(
          addPresentation.text,
          "",
          "The Add action should be icon-only while keeping its accessible name",
        );
        assert.equal(
          addPresentation.icons,
          1,
          "The icon-only Add action should show one plus icon",
        );
        assert.ok(
          addPresentation.width >= 43 &&
            addPresentation.height >= 43 &&
            Math.abs(addPresentation.width - addPresentation.height) <= 1,
          `The Add icon should have a square 44px target; size=${JSON.stringify(addPresentation)}`,
        );
        const bounds = await card.evaluate((element) => {
          const rect = (selector) => {
            const { top, right, bottom, left, width, height } = element
              .querySelector(selector)
              .getBoundingClientRect();
            return { top, right, bottom, left, width, height };
          };
          const article = element.querySelector(".tag-collection-card");
          const border = getComputedStyle(article);
          return {
            card: rect(".tag-collection-card"),
            source: rect("button.tag-suggestion-open"),
            dismiss: rect("button.tag-suggestion-dismiss"),
            actions: rect(".tag-suggestion-actions"),
            chip: rect(".tag-suggestion-chip"),
            add: rect("button.tag-suggestion-approve"),
            footer: rect("footer"),
            border: {
              top: Number.parseFloat(border.borderTopWidth),
              right: Number.parseFloat(border.borderRightWidth),
              bottom: Number.parseFloat(border.borderBottomWidth),
              left: Number.parseFloat(border.borderLeftWidth),
            },
          };
        });
        assert.ok(
          Math.abs(bounds.source.top - bounds.card.top - bounds.border.top) <=
            1 &&
            Math.abs(
              bounds.source.left - bounds.card.left - bounds.border.left,
            ) <= 1 &&
            Math.abs(
              bounds.source.width -
                (bounds.card.width - bounds.border.left - bounds.border.right),
            ) <= 1 &&
            Math.abs(
              bounds.source.height -
                (bounds.card.height - bounds.border.top - bounds.border.bottom),
            ) <= 1,
          `The source button should cover the card's full padding box; bounds=${JSON.stringify(bounds)}`,
        );
        assert.ok(
          bounds.dismiss.top >= bounds.card.top - 1 &&
            bounds.dismiss.top <= bounds.card.top + 12 &&
            bounds.card.right - bounds.dismiss.right >= -1 &&
            bounds.card.right - bounds.dismiss.right <= 12,
          `Dismiss should remain in the card's top-right corner; bounds=${JSON.stringify(bounds)}`,
        );
        assert.ok(
          bounds.actions.top >= bounds.footer.top - 1 &&
            bounds.actions.bottom <= bounds.footer.bottom + 1 &&
            bounds.chip.top >= bounds.actions.top - 1 &&
            bounds.chip.bottom <= bounds.actions.bottom + 1 &&
            bounds.add.top >= bounds.actions.top - 1 &&
            bounds.add.bottom <= bounds.actions.bottom + 1 &&
            bounds.chip.right <= bounds.add.left + 1 &&
            Math.min(bounds.chip.bottom, bounds.add.bottom) >
              Math.max(bounds.chip.top, bounds.add.top),
          `The suggested-tag chip and Add icon should share one footer row; bounds=${JSON.stringify(bounds)}`,
        );
      }
      async function verifyProposalCards(
        suggestions,
        title,
        createName,
        dismissName,
      ) {
        const section = suggestions.locator(".tag-proposal-section");
        await section
          .getByRole("heading", { name: "New tag ideas", exact: true })
          .waitFor();
        const cards = section.locator(".tag-proposal-card");
        assert.equal(
          await cards.count(),
          2,
          "Both tag ideas should be visible",
        );
        const createCard = cards.filter({ hasText: createName }).first();
        const dismissCard = cards.filter({ hasText: dismissName }).first();
        await createCard
          .getByRole("heading", { name: createName, exact: true })
          .waitFor();
        await dismissCard
          .getByRole("heading", { name: dismissName, exact: true })
          .waitFor();
        await createCard
          .getByText("Suggested new tag", { exact: true })
          .waitFor();
        await createCard
          .getByText("Suggested for 3 items", { exact: true })
          .waitFor();
        await createCard
          .getByRole("button", { name: `Open ${title} (Note)`, exact: true })
          .waitFor();
        await createCard
          .getByRole("button", {
            name: `Create ${createName} and tag 3 items`,
            exact: true,
          })
          .waitFor();
        assert.equal(
          await createCard
            .locator(".tag-proposal-footer > button")
            .evaluate((element) => element.innerText.trim()),
          "Create tag",
          "New tag creation should have concise, consistent visible copy",
        );
        await dismissCard
          .getByRole("button", {
            name: `Dismiss new tag idea ${dismissName}`,
            exact: true,
          })
          .waitFor();
        await dismissCard
          .getByRole("button", { name: `Open ${title} (Note)`, exact: true })
          .waitFor();
        return { createCard, dismissCard };
      }
      async function assertScreenReaderStatus(root, message) {
        const status = root.getByRole("status").filter({ hasText: message });
        await status.waitFor({ state: "attached" });
        const rendered = await status.evaluate((element) => {
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          const clipped =
            style.position === "absolute" &&
            rect.width <= 1 &&
            rect.height <= 1 &&
            style.overflow === "hidden" &&
            (style.clip !== "auto" || style.clipPath !== "none");
          const hidden =
            clipped ||
            style.display === "none" ||
            style.visibility === "hidden" ||
            Number(style.opacity) === 0;
          return {
            hidden,
            className: element.className,
            width: rect.width,
            height: rect.height,
          };
        });
        assert.equal(
          rendered.hidden,
          true,
          `Status should remain available to assistive technology without visible copy; status=${JSON.stringify(rendered)}`,
        );
        const visibleFeedback = await root
          .locator(
            '.inline-feedback, .tag-suggestions-message, .banner, [role="status"]',
          )
          .evaluateAll((elements) =>
            elements.some((element) => {
              const style = getComputedStyle(element);
              const rect = element.getBoundingClientRect();
              const clipped =
                style.position === "absolute" &&
                rect.width <= 1 &&
                rect.height <= 1 &&
                style.overflow === "hidden" &&
                (style.clip !== "auto" || style.clipPath !== "none");
              const hidden =
                clipped ||
                style.display === "none" ||
                style.visibility === "hidden" ||
                Number(style.opacity) === 0;
              return (
                Boolean(element.textContent?.trim()) &&
                !hidden &&
                rect.width > 1 &&
                rect.height > 1
              );
            }),
          );
        assert.equal(
          visibleFeedback,
          false,
          "Suggestion progress and success messages must not render a visible banner",
        );
        return status;
      }
      async function waitForSuggestionsBusy(root, busy) {
        const region = root.locator(
          `[role="region"][aria-label="Tag suggestions"][aria-busy="${busy}"]`,
        );
        await region.waitFor({ state: "visible" });
        return region;
      }
      async function assertNoVisibleSuggestionRefreshCopy(root) {
        assert.equal(
          await root
            .getByText("Updating tag suggestions…", { exact: true })
            .count(),
          0,
          "Background refresh must not add redundant Updating copy",
        );
        const visibleFeedback = await root
          .locator(
            '.inline-feedback, .tag-suggestions-message, .banner, [role="status"]',
          )
          .evaluateAll((elements) =>
            elements.some((element) => {
              const style = getComputedStyle(element);
              const rect = element.getBoundingClientRect();
              const clipped =
                style.position === "absolute" &&
                rect.width <= 1 &&
                rect.height <= 1 &&
                style.overflow === "hidden" &&
                (style.clip !== "auto" || style.clipPath !== "none");
              const hidden =
                clipped ||
                style.display === "none" ||
                style.visibility === "hidden" ||
                Number(style.opacity) === 0;
              return (
                Boolean(element.textContent?.trim()) &&
                !hidden &&
                rect.width > 1 &&
                rect.height > 1
              );
            }),
          );
        assert.equal(
          visibleFeedback,
          false,
          "Suggestion progress and success messages must not render a visible banner",
        );
      }
      async function waitForWorkspaceApiIdle(stage) {
        const idleWindow = 250;
        const deadline = Date.now() + 5000;
        for (; Date.now() < deadline; await setTimeout(25)) {
          if (
            pendingApiRequests.size === 0 &&
            Date.now() - lastWorkspaceApiActivity >= idleWindow
          )
            break;
        }
        assert.equal(
          pendingApiRequests.size,
          0,
          `${stage}: workspace API requests still pending: ${[...pendingApiRequests].map((request) => request.url()).join(", ")}`,
        );
        assert.ok(
          Date.now() - lastWorkspaceApiActivity >= idleWindow,
          `${stage}: workspace API did not remain idle for ${idleWindow}ms`,
        );
        assert.deepEqual(
          failedApiRequests,
          [],
          `${stage}: workspace API requests failed`,
        );
      }
      async function waitForAiCompletionQuiet(targetPage = page) {
        await targetPage.evaluate(
          () =>
            new Promise((resolve) => {
              let timer;
              const finish = () => {
                clearTimeout(timer);
                window.removeEventListener("nivra:ai-completion", reset);
                resolve();
              };
              const reset = () => {
                clearTimeout(timer);
                timer = window.setTimeout(finish, 250);
              };
              timer = window.setTimeout(finish, 250);
              window.addEventListener("nivra:ai-completion", reset);
            }),
        );
      }
      async function waitForStableAiIndex(suggestionItemId) {
        const startedAt = Date.now();
        const vocabularyPendingSamples = [];
        let previousPending;
        let lastSampleAt = 0;
        let previous = "";
        let stable = 0;
        let latestStatus;
        let latestSuggestions = [];
        for (let n = 0; n < 100; n++) {
          latestStatus = await api("ai");
          if (suggestionItemId)
            latestSuggestions = (await api("ai/suggestions")).items;
          const elapsedMs = Date.now() - startedAt;
          const pendingSample = {
            elapsedMs,
            total: latestStatus.total,
            indexed: latestStatus.indexed,
            failed: latestStatus.failed,
            capacity: latestStatus.capacity,
            vocabularyPending: latestStatus.vocabularyPending ?? null,
            pending: latestStatus.pending ?? null,
            retryAfter: latestStatus.retryAfter ?? null,
            semanticJobs: latestStatus.semanticJobs ?? null,
          };
          if (
            previousPending !== pendingSample.vocabularyPending ||
            elapsedMs - lastSampleAt >= 3000
          ) {
            vocabularyPendingSamples.push(pendingSample);
            previousPending = pendingSample.vocabularyPending;
            lastSampleAt = elapsedMs;
          }
          const snapshot = JSON.stringify({
            total: latestStatus.total,
            indexed: latestStatus.indexed,
            failed: latestStatus.failed,
            capacity: latestStatus.capacity,
          });
          stable = snapshot === previous ? stable + 1 : 0;
          previous = snapshot;
          if (
            latestStatus.enabled &&
            latestStatus.total > 0 &&
            latestStatus.indexed === latestStatus.total &&
            latestStatus.failed === 0 &&
            latestStatus.capacity === 0 &&
            stable >= 2 &&
            (!suggestionItemId ||
              latestSuggestions.some(
                (item) => item.itemId === suggestionItemId,
              ))
          ) {
            lastIndexWaitDiagnostics = {
              elapsedMs,
              vocabularyPendingSamples,
            };
            return { status: latestStatus, suggestions: latestSuggestions };
          }
          await setTimeout(250);
        }
        lastIndexWaitDiagnostics = {
          elapsedMs: Date.now() - startedAt,
          vocabularyPendingSamples,
        };
        throw new Error(
          `Indexed demo fixture did not stabilize; AI status=${JSON.stringify(latestStatus)}; vocabulary pending samples=${JSON.stringify(vocabularyPendingSamples)}; matching suggestion=${latestSuggestions.some((item) => item.itemId === suggestionItemId)}`,
        );
      }
      async function createSuggestionNote(title) {
        const created = await api("notes", "POST", { title });
        await api(`notes/${created.id}`, "PATCH", {
          title,
          revision: created.revision,
          document: {
            schemaVersion: 1,
            blocks: [
              {
                id: randomUUID(),
                type: "paragraph",
                props: {},
                content: [
                  {
                    type: "text",
                    text: "SQLite database queries and indexes verify encrypted backup restore.",
                    styles: {},
                  },
                ],
                children: [],
              },
            ],
          },
        });
        return created;
      }
      async function runLiveSuggestionsRefresh() {
        const liveNotes = [];
        const liveErrors = [];
        const liveFailedApiRequests = [];
        const livePendingApiRequests = new Set();
        const routeFailures = [];
        const activeRoutes = new Set();
        let liveContext;
        let livePage;
        let holdNextGet = true;
        let releaseHeldGet = () => {};
        let enterHeldGet = () => {};
        const heldGetEntered = new Promise((resolve) => {
          enterHeldGet = resolve;
        });
        const heldGetGate = new Promise((resolve) => {
          releaseHeldGet = resolve;
        });
        let lastLiveApiActivity = Date.now();
        async function waitForLiveApiIdle(stage) {
          const idleWindow = 250;
          const deadline = Date.now() + 5000;
          for (; Date.now() < deadline; await setTimeout(25))
            if (
              livePendingApiRequests.size === 0 &&
              Date.now() - lastLiveApiActivity >= idleWindow
            )
              break;
          assert.equal(
            livePendingApiRequests.size,
            0,
            `${stage}: live workspace API requests still pending: ${[...livePendingApiRequests].map((request) => request.url()).join(", ")}`,
          );
          assert.ok(
            Date.now() - lastLiveApiActivity >= idleWindow,
            `${stage}: live workspace API did not remain idle for ${idleWindow}ms`,
          );
          assert.deepEqual(
            liveFailedApiRequests,
            [],
            `${stage}: live workspace API requests failed`,
          );
        }
        const liveApiRequest = (request) =>
          ["fetch", "xhr"].includes(request.resourceType()) &&
          request.url().includes("/api/v1/");
        const routeHandler = (route) => {
          const task = (async () => {
            const request = route.request();
            if (
              holdNextGet &&
              request.method() === "GET" &&
              new URL(request.url()).pathname === "/api/v1/ai/suggestions"
            ) {
              holdNextGet = false;
              enterHeldGet();
              await heldGetGate;
            }
            await route.continue();
          })();
          activeRoutes.add(task);
          void task.then(
            () => activeRoutes.delete(task),
            (error) => {
              activeRoutes.delete(task);
              routeFailures.push(error);
            },
          );
          return task;
        };
        let testError = null;
        let cleanupError = null;
        try {
          liveContext = await browser.newContext({
            storageState: session,
            viewport: { width: 320, height: 900 },
            colorScheme: "light",
            hasTouch: true,
            serviceWorkers: "block",
          });
          livePage = await liveContext.newPage();
          livePage.on("pageerror", (error) =>
            liveErrors.push({ message: error.message, stack: error.stack }),
          );
          livePage.on("request", (request) => {
            if (!liveApiRequest(request)) return;
            lastLiveApiActivity = Date.now();
            livePendingApiRequests.add(request);
          });
          livePage.on("requestfinished", (request) => {
            if (!liveApiRequest(request)) return;
            lastLiveApiActivity = Date.now();
            livePendingApiRequests.delete(request);
          });
          livePage.on("requestfailed", (request) => {
            if (!liveApiRequest(request)) return;
            lastLiveApiActivity = Date.now();
            livePendingApiRequests.delete(request);
            liveFailedApiRequests.push({
              path: new URL(request.url()).pathname,
              error: request.failure()?.errorText,
            });
          });
          livePage.setDefaultTimeout(60000);
          const streamResponsePromise = livePage.waitForResponse(
            (response) =>
              new URL(response.url()).pathname === "/api/v1/completions",
            { timeout: 30000 },
          );
          await livePage.goto(`${base}/tag-suggestions`, {
            waitUntil: "domcontentloaded",
          });
          const streamResponse = await streamResponsePromise;
          assert.equal(
            streamResponse.status(),
            200,
            "The focused refresh check must use the authenticated live completion stream",
          );
          await livePage.evaluate(() => {
            window.__liveAiCompletionEvents = [];
            window.addEventListener("nivra:ai-completion", (event) => {
              const detail = event.detail ?? {};
              window.__liveAiCompletionEvents.push({
                kind: detail.kind,
                target: detail.target,
                status: detail.status,
                at: Math.round(performance.now()),
              });
            });
          });
          const panel = livePage.locator(".tag-suggestions-panel");
          const firstTitle = `Live SSE seed ${randomUUID().slice(0, 8)}`;
          const firstNote = await createSuggestionNote(firstTitle);
          liveNotes.push(firstNote);
          await waitForStableAiIndex(firstNote.id);
          await panel
            .getByRole("button", {
              name: `Add ${tagName} to ${firstTitle}`,
              exact: true,
            })
            .waitFor();
          await waitForAiCompletionQuiet(livePage);
          await waitForLiveApiIdle("seed suggestions settled");
          const grid = panel.locator(".tag-suggestion-grid");
          const initialBounds = await grid.evaluate((element) => {
            const { top, height } = element.getBoundingClientRect();
            return { top, height };
          });
          const baselineEventCount = await livePage.evaluate(
            () => window.__liveAiCompletionEvents.length,
          );
          await livePage.route("**/api/v1/ai/suggestions**", routeHandler);
          const secondTitle = `Live SSE refresh ${randomUUID().slice(0, 8)}`;
          const eventPromise = livePage.waitForFunction(
            (count) => window.__liveAiCompletionEvents.length > count,
            baselineEventCount,
            { timeout: 60000 },
          );
          const heldRequestPromise = livePage.waitForRequest(
            (request) =>
              request.method() === "GET" &&
              new URL(request.url()).pathname === "/api/v1/ai/suggestions",
            { timeout: 60000 },
          );
          const secondNote = await createSuggestionNote(secondTitle);
          liveNotes.push(secondNote);
          await Promise.all([
            eventPromise,
            heldRequestPromise,
            heldGetEntered,
            waitForStableAiIndex(secondNote.id),
          ]);
          const liveEvents = await livePage.evaluate(
            () => window.__liveAiCompletionEvents,
          );
          assert.ok(
            liveEvents.length > baselineEventCount &&
              liveEvents.some((event) => event.kind === "ai"),
            `The new indexed item must arrive over the live AI completion stream; events=${JSON.stringify(liveEvents)}`,
          );
          await waitForSuggestionsBusy(panel, true);
          await assertNoVisibleSuggestionRefreshCopy(panel);
          const refreshBounds = await grid.evaluate((element) => {
            const { top, height } = element.getBoundingClientRect();
            return { top, height };
          });
          assert.ok(
            Math.abs(refreshBounds.top - initialBounds.top) <= 1 &&
              Math.abs(refreshBounds.height - initialBounds.height) <= 1,
            `A live completion refresh must preserve the suggestion grid position; before=${JSON.stringify(initialBounds)} after=${JSON.stringify(refreshBounds)}`,
          );
          await panel
            .getByRole("button", {
              name: `Add ${tagName} to ${firstTitle}`,
              exact: true,
            })
            .waitFor();
          assert.equal(
            await panel
              .getByRole("button", {
                name: `Add ${tagName} to ${secondTitle}`,
                exact: true,
              })
              .count(),
            0,
            "The pending live response must not replace the existing suggestion cards",
          );
          assert.ok(
            (await api("ai/suggestions")).items.some(
              (item) => item.itemId === secondNote.id,
            ),
            "The second suggestion must exist in the server response before releasing the held browser refresh",
          );
          const liveResponsePromise = livePage.waitForResponse(
            (response) =>
              new URL(response.url()).pathname === "/api/v1/ai/suggestions" &&
              response.request().method() === "GET",
            { timeout: 30000 },
          );
          releaseHeldGet();
          const liveResponse = await liveResponsePromise;
          assert.equal(liveResponse.status(), 200);
          await panel
            .getByRole("button", {
              name: `Add ${tagName} to ${secondTitle}`,
              exact: true,
            })
            .waitFor();
          await waitForSuggestionsBusy(panel, false);
          await assertNoVisibleSuggestionRefreshCopy(panel);
          await waitForLiveApiIdle("live suggestions refreshed");
          assert.deepEqual(liveErrors, [], "Live SSE refresh page errors");
          assert.deepEqual(
            liveFailedApiRequests,
            [],
            "Live SSE refresh API failures",
          );
          console.log(
            `${name} live SSE: completion refresh retained the existing suggestion grid until a successful API refresh`,
          );
        } catch (error) {
          testError = error;
        } finally {
          releaseHeldGet();
          const finalCleanupErrors = [];
          while (activeRoutes.size) await Promise.allSettled([...activeRoutes]);
          try {
            if (livePage)
              await livePage.unroute(
                "**/api/v1/ai/suggestions**",
                routeHandler,
              );
          } catch (error) {
            finalCleanupErrors.push(error);
          }
          try {
            await liveContext?.close();
          } catch (error) {
            finalCleanupErrors.push(error);
          }
          for (const item of liveNotes.reverse()) {
            try {
              const current = await api(`notes/${item.id}`);
              await api(`notes/${item.id}`, "DELETE", {
                revision: current.revision,
              });
            } catch (error) {
              finalCleanupErrors.push(error);
            }
          }
          if (finalCleanupErrors.length === 1)
            cleanupError = finalCleanupErrors[0];
          else if (finalCleanupErrors.length)
            cleanupError = new AggregateError(
              finalCleanupErrors,
              "Live SSE fixture cleanup failed",
            );
        }
        const failures = [testError, cleanupError, ...routeFailures].filter(
          Boolean,
        );
        if (failures.length === 1) throw failures[0];
        if (failures.length)
          throw new AggregateError(
            failures,
            "Live SSE suggestions check failed",
          );
      }
      async function waitForSemanticResult(query, itemId) {
        const attempts = [];
        const requestPath = `search?mode=suggest&strategy=semantic&q=${encodeURIComponent(query)}`;
        for (let n = 0; n < 4; n++) {
          const result = await api(requestPath);
          const itemIds = (result.items ?? []).map((item) => item.id);
          attempts.push({ strategyUsed: result.strategyUsed ?? null, itemIds });
          if (result.strategyUsed === "semantic" && itemIds.includes(itemId))
            return result;
          await setTimeout(250);
        }
        const status = await api("ai");
        throw new Error(
          `Semantic search did not return the indexed demo note; query=${query}; attempts=${JSON.stringify(attempts)}; AI status=${JSON.stringify(status)}`,
        );
      }
      let contextRunError;
      const contextCleanupErrors = [];
      try {
        await page.goto(`${base}/overview`, { waitUntil: "domcontentloaded" });
        await verifyDesktopSidebarCollapse();
        await (
          await nav()
        )
          .getByRole("button", { name: `Actions for ${tag.name}`, exact: true })
          .click();
        await page
          .getByRole("menuitem", { name: "Edit tag", exact: true })
          .click();
        const edit = page.getByRole("dialog", {
          name: "Edit tag",
          exact: true,
        });
        const aliases = edit.getByRole("textbox", { name: /Matching words/ });
        await aliases.fill("");
        await aliases.pressSequentially("sqlite database, queries indexes", {
          delay: 20,
        });
        assert.equal(
          await aliases.inputValue(),
          "sqlite database, queries indexes",
        );
        await audit(edit, "aliases");
        await edit
          .getByRole("button", { name: "Save tag", exact: true })
          .click();
        await waitForStableAiIndex(note.id);
        await waitForAiCompletionQuiet();
        await waitForWorkspaceApiIdle("overview settled before suggestions");
        const suggestionsNavigation = await nav();
        const suggestionsLink = suggestionsNavigation.getByRole("button", {
          name: "Tag suggestions",
          exact: true,
        });
        assert.equal(
          await suggestionsLink.evaluate(
            (element) => element.closest(".tags-heading") !== null,
          ),
          false,
          "Tag suggestions must have its own sidebar row below the Tags heading",
        );
        const tagLabel = suggestionsNavigation
          .locator(".tag-nav-row > button:first-child")
          .filter({ hasText: tag.name })
          .first();
        const sidebarLabelPositions = await sidebarLabelStarts(
          suggestionsLink,
          tagLabel,
        );
        const suggestionsTextX = sidebarLabelPositions?.suggestions ?? null;
        const assignedTagTextX = sidebarLabelPositions?.tag ?? null;
        assert.ok(
          suggestionsTextX !== null &&
            assignedTagTextX !== null &&
            Math.abs(suggestionsTextX - assignedTagTextX) <= 1,
          `Sidebar Suggestions and tag labels should align within 1px; suggestions x=${suggestionsTextX}, tag x=${assignedTagTextX}`,
        );
        if (output)
          await page.screenshot({
            path: `${output}/${name}-${width}-${theme}-tag-navigation.png`,
          });
        await page.evaluate(() => {
          const snapshot = (event) => ({
            event,
            at: Date.now(),
            hasFocus: document.hasFocus(),
            visibilityState: document.visibilityState,
          });
          window.__tagSuggestionFocusTrace = [snapshot("before-navigation")];
          window.addEventListener("focus", () => {
            window.__tagSuggestionFocusTrace.push(snapshot("focus"));
          });
          window.addEventListener("blur", () => {
            window.__tagSuggestionFocusTrace.push(snapshot("blur"));
          });
          document.addEventListener("visibilitychange", () => {
            window.__tagSuggestionFocusTrace.push(snapshot("visibilitychange"));
          });
        });
        const proposalNames = {
          create: `Workflow idea ${randomUUID().slice(0, 6)}`,
          dismiss: `Reference idea ${randomUUID().slice(0, 6)}`,
        };
        const proposalIds = {
          create: randomUUID(),
          dismiss: randomUUID(),
        };
        let proposalFixtureItems = [
          {
            id: proposalIds.create,
            name: proposalNames.create,
            color: "gray",
            itemCount: 3,
            items: [{ itemId: note.id, type: "note", title }],
            createdAt: Date.now(),
          },
          {
            id: proposalIds.dismiss,
            name: proposalNames.dismiss,
            color: "gray",
            itemCount: 4,
            items: [{ itemId: note.id, type: "note", title }],
            createdAt: Date.now() - 1,
          },
        ];
        const proposalDecisions = [];
        const proposalFixtureRoute = async (route) => {
          const request = route.request();
          const path = new URL(request.url()).pathname;
          if (request.method() === "GET" && path === "/api/v1/ai/tag-proposals")
            return route.fulfill({
              status: 200,
              contentType: "application/json",
              body: JSON.stringify({ items: proposalFixtureItems }),
            });
          const decision = path.match(
            /^\/api\/v1\/ai\/tag-proposals\/([^/]+)\/(accept|reject)$/,
          );
          if (request.method() === "POST" && decision) {
            const [, id, action] = decision;
            if (!proposalFixtureItems.some((item) => item.id === id))
              return route.fulfill({
                status: 404,
                contentType: "application/json",
                body: JSON.stringify({ error: "Unknown fixture proposal" }),
              });
            proposalDecisions.push({ id, action });
            proposalFixtureItems = proposalFixtureItems.filter(
              (item) => item.id !== id,
            );
            return route.fulfill({
              status: 200,
              contentType: "application/json",
              body: JSON.stringify({ ok: true }),
            });
          }
          return route.continue();
        };
        await page.route("**/api/v1/ai/tag-proposals**", proposalFixtureRoute);
        await suggestionsLink.click();
        let suggestions = page.locator(".tag-suggestions-panel");
        await suggestions
          .getByRole("heading", { name: "Tag suggestions", exact: true })
          .waitFor();
        const approve = suggestions.getByRole("button", {
          name: `Add ${tag.name} to ${title}`,
          exact: true,
        });
        try {
          await approve.waitFor();
        } catch (error) {
          const diagnostics = {
            expected: { title, tag: tag.name, itemId: note.id },
            indexWait: lastIndexWaitDiagnostics,
            failedApiRequests,
            pendingApiRequests: pendingApiRequests.size,
          };
          for (const path of ["ai", "ai/suggestions", "ai/tag-proposals"]) {
            try {
              const result = await api(path);
              if (path === "ai")
                diagnostics.ai = {
                  enabled: result.enabled,
                  total: result.total,
                  indexed: result.indexed,
                  failed: result.failed,
                  capacity: result.capacity,
                  vocabularyPending: result.vocabularyPending,
                };
              else if (path === "ai/suggestions")
                diagnostics.suggestions = {
                  count: result.items?.length,
                  matching: result.items
                    ?.filter(
                      (item) => item.itemId === note.id || item.title === title,
                    )
                    .map((item) => ({
                      itemId: item.itemId,
                      title: item.title,
                      tag: item.tag?.name,
                    })),
                };
              else diagnostics.proposals = { count: result.items?.length };
            } catch (diagnosticError) {
              diagnostics[path] =
                diagnosticError instanceof Error
                  ? diagnosticError.message
                  : String(diagnosticError);
            }
          }
          diagnostics.document = await page
            .evaluate(() => {
              const active = document.activeElement;
              return {
                hasFocus: document.hasFocus(),
                visibilityState: document.visibilityState,
                activeElement: active
                  ? {
                      tagName: active.tagName,
                      id: active.id,
                      role: active.getAttribute("role"),
                      ariaLabel: active.getAttribute("aria-label"),
                      className:
                        typeof active.className === "string"
                          ? active.className
                          : "",
                    }
                  : null,
              };
            })
            .catch((diagnosticError) => ({
              error:
                diagnosticError instanceof Error
                  ? diagnosticError.message
                  : String(diagnosticError),
            }));
          diagnostics.focusTrace = await page
            .evaluate(() => window.__tagSuggestionFocusTrace ?? [])
            .catch((diagnosticError) => ({
              error:
                diagnosticError instanceof Error
                  ? diagnosticError.message
                  : String(diagnosticError),
            }));
          diagnostics.panel = await suggestions
            .evaluate((element) => ({
              ariaBusy: element
                .querySelector('[role="region"][aria-label="Tag suggestions"]')
                ?.getAttribute("aria-busy"),
              suggestionCards: element.querySelectorAll(".tag-suggestion-card")
                .length,
              proposalCards:
                element.querySelectorAll(".tag-proposal-card").length,
              messages: Array.from(
                element.querySelectorAll("h1, h2, [role=alert], [role=status]"),
              )
                .map((node) => node.textContent?.trim())
                .filter(Boolean),
            }))
            .catch((diagnosticError) => ({
              error:
                diagnosticError instanceof Error
                  ? diagnosticError.message
                  : String(diagnosticError),
            }));
          console.error(
            "Tag suggestion render diagnostics:",
            JSON.stringify(diagnostics),
          );
          throw error;
        }
        await approve.scrollIntoViewIfNeeded();
        await suggestions
          .getByRole("button", {
            name: `Dismiss suggestion for ${tag.name} on ${title}`,
            exact: true,
          })
          .waitFor();
        const evidence =
          "SQLite database queries and indexes verify encrypted backup restore.";
        await suggestions.getByText(evidence, { exact: true }).waitFor();
        await suggestions
          .locator(".tag-suggestion-card")
          .getByText("Note", { exact: true })
          .waitFor();
        await suggestions
          .locator(".tag-suggestion-chip")
          .getByText(tag.name, { exact: true })
          .waitFor();
        await verifySuggestionCardActions(suggestions, title, tag.name);
        let proposalCards = await verifyProposalCards(
          suggestions,
          title,
          proposalNames.create,
          proposalNames.dismiss,
        );
        await audit(suggestions, "tag-suggestions");
        if (name === "chromium" && width === 320 && theme === "light") {
          const sourceButton = proposalCards.createCard.getByRole("button", {
            name: `Open ${title} (Note)`,
            exact: true,
          });
          await sourceButton.click();
          await page.locator('[aria-label="Note content"]').waitFor();
          await waitForWorkspaceApiIdle("open proposed tag source");
          const assignedTags = (await api(`item-tags/note/${note.id}`)).tags;
          assert.equal(
            assignedTags.some(
              (assigned) => assigned.name === proposalNames.create,
            ),
            false,
            "Opening a representative item must not create or assign a proposed tag",
          );
          await (
            await nav()
          )
            .getByRole("button", { name: "Tag suggestions", exact: true })
            .click();
          suggestions = page.locator(".tag-suggestions-panel");
          await suggestions
            .getByRole("heading", { name: "Tag suggestions", exact: true })
            .waitFor();
          proposalCards = await verifyProposalCards(
            suggestions,
            title,
            proposalNames.create,
            proposalNames.dismiss,
          );
          const dismissResponsePromise = page.waitForResponse((response) => {
            const url = new URL(response.url());
            return (
              response.request().method() === "POST" &&
              url.pathname ===
                `/api/v1/ai/tag-proposals/${proposalIds.dismiss}/reject`
            );
          });
          await proposalCards.dismissCard
            .getByRole("button", {
              name: `Dismiss new tag idea ${proposalNames.dismiss}`,
              exact: true,
            })
            .click();
          const dismissResponse = await dismissResponsePromise;
          assert.equal(dismissResponse.status(), 200);
          await assertScreenReaderStatus(
            suggestions,
            `Suggestion for ${proposalNames.dismiss} dismissed.`,
          );
          await proposalCards.dismissCard.waitFor({ state: "detached" });
          assert.deepEqual(proposalDecisions, [
            { id: proposalIds.dismiss, action: "reject" },
          ]);
          await waitForWorkspaceApiIdle("dismissed new tag idea");
          const suggestionGrid = suggestions
            .locator(".tag-suggestion-grid")
            .first();
          const gridTopBeforeCreate = await suggestionGrid.evaluate(
            (element) => element.getBoundingClientRect().top,
          );
          const createResponsePromise = page.waitForResponse((response) => {
            const url = new URL(response.url());
            return (
              response.request().method() === "POST" &&
              url.pathname ===
                `/api/v1/ai/tag-proposals/${proposalIds.create}/accept`
            );
          });
          await proposalCards.createCard
            .getByRole("button", {
              name: `Create ${proposalNames.create} and tag 3 items`,
              exact: true,
            })
            .click();
          const createResponse = await createResponsePromise;
          assert.equal(createResponse.status(), 200);
          await waitForSuggestionsBusy(suggestions, true);
          const gridTopDuringRefresh = await suggestionGrid.evaluate(
            (element) => element.getBoundingClientRect().top,
          );
          assert.ok(
            Math.abs(gridTopDuringRefresh - gridTopBeforeCreate) < 1,
            `Accepting a tag idea must not shift the loaded suggestion grid; before=${gridTopBeforeCreate}, during=${gridTopDuringRefresh}`,
          );
          await assertScreenReaderStatus(
            suggestions,
            `Created ${proposalNames.create} and assigned it to 3 items.`,
          );
          await proposalCards.createCard.waitFor({ state: "detached" });
          assert.deepEqual(proposalDecisions, [
            { id: proposalIds.dismiss, action: "reject" },
            { id: proposalIds.create, action: "accept" },
          ]);
          await waitForWorkspaceApiIdle("created proposed tag");
        }
        await waitForAiCompletionQuiet();
        await waitForWorkspaceApiIdle("suggestions settled before navigation");
        await (
          await nav()
        )
          .getByRole("button", { name: tag.name, exact: true })
          .click();
        await page
          .getByRole("button", {
            name: "Review tag suggestions",
            exact: true,
          })
          .waitFor();
        await waitForWorkspaceApiIdle(
          "tag collection settled before suggestions",
        );
        await page
          .getByRole("button", {
            name: "Review tag suggestions",
            exact: true,
          })
          .click();
        suggestions = page.locator(".tag-suggestions-panel");
        await waitForWorkspaceApiIdle(
          "suggestions settled before opening source",
        );
        const sourceTitle = suggestions.getByRole("heading", {
          name: title,
          exact: true,
        });
        const titleBounds = await sourceTitle.boundingBox();
        assert.ok(
          titleBounds,
          "The source title should be visible and clickable",
        );
        await page.mouse.click(
          titleBounds.x + Math.min(12, titleBounds.width / 2),
          titleBounds.y + titleBounds.height / 2,
        );
        await page.locator('[aria-label="Note content"]').waitFor();
        await waitForWorkspaceApiIdle("open suggestion source");
        await (
          await nav()
        )
          .getByRole("button", { name: "Tag suggestions", exact: true })
          .click();
        suggestions = page.locator(".tag-suggestions-panel");
        const review = suggestions.getByRole("button", {
          name: `Add ${tag.name} to ${title}`,
          exact: true,
        });
        await review.waitFor();
        await review.click();
        await assertScreenReaderStatus(
          suggestions,
          `${tag.name} added to ${title}.`,
        );
        assert.equal(await review.count(), 0);
        for (let n = 0; n < 40; n++) {
          if (
            (await api(`item-tags/note/${note.id}`)).tags.some(
              (t) => t.id === tag.id,
            )
          )
            break;
          await setTimeout(100);
          if (n === 39) throw new Error("Approval was not persisted");
        }
        assert.deepEqual(errors, []);
        await waitForWorkspaceApiIdle("approved tag suggestion");
        if (width === 320 && theme === "light") {
          await waitForAiCompletionQuiet();
          const firstBatch = Array.from({ length: 30 }, (_, index) => ({
            id: randomUUID(),
            itemId: note.id,
            type: "note",
            title: `Refresh sample ${index + 1}`,
            excerpt: "A stable suggestion remains visible during refresh.",
            tag: {
              id: randomUUID(),
              name: `Fixture tag ${index + 1}`,
              color: "gray",
            },
            createdAt: Date.now() - index,
          }));
          const nextBatch = [
            {
              id: randomUUID(),
              itemId: note.id,
              type: "note",
              title: "Queued suggestion sample",
              excerpt: "This item follows the current suggestion batch.",
              tag: { id: randomUUID(), name: "Queued tag", color: "gray" },
              createdAt: Date.now(),
            },
          ];
          let getCount = 0;
          const pendingSuggestionHolds = [];
          const allSuggestionHolds = [];
          const pendingFixtureRoutes = new Set();
          const fixtureRouteErrors = [];
          const fixtureGets = [];
          let acceptCommitted = false;
          let pendingAcceptance = null;
          const rejectedIds = new Set();
          await page.evaluate(() => {
            window.__tagSuggestionCompletionEvents = [];
            window.addEventListener(
              "nivra:ai-completion",
              (event) => {
                window.__tagSuggestionCompletionEvents.push({
                  at: Math.round(performance.now()),
                  source: event.detail?.source ?? "stream",
                });
              },
              { capture: true },
            );
          });
          const holdSuggestionsGet = (items) => {
            let enter;
            let release;
            const hold = {
              items,
              entered: new Promise((resolve) => (enter = resolve)),
              gate: new Promise((resolve) => (release = resolve)),
              enter: () => enter(),
              release: () => release(),
            };
            pendingSuggestionHolds.push(hold);
            allSuggestionHolds.push(hold);
            return hold;
          };
          const holdNextAcceptance = () => {
            let enter;
            let release;
            const hold = {
              entered: new Promise((resolve) => (enter = resolve)),
              gate: new Promise((resolve) => (release = resolve)),
              enter: () => enter(),
              release: () => release(),
            };
            pendingAcceptance = hold;
            allSuggestionHolds.push(hold);
            return hold;
          };
          const fulfillSuggestions = (route, items) =>
            route.fulfill({
              status: 200,
              contentType: "application/json",
              body: JSON.stringify({ items }),
            });
          const handleFixtureRoute = async (route) => {
            const request = route.request();
            const path = new URL(request.url()).pathname;
            if (
              request.method() === "GET" &&
              path === "/api/v1/ai/suggestions"
            ) {
              getCount++;
              const hold = pendingSuggestionHolds.shift();
              const held = Boolean(hold);
              const currentBatch = firstBatch.filter(
                (item) => !rejectedIds.has(item.id),
              );
              const responseItems = held
                ? hold.items
                : acceptCommitted
                  ? nextBatch
                  : currentBatch;
              fixtureGets.push({
                count: getCount,
                held,
                itemCount: responseItems.length,
                accepted: acceptCommitted,
                at: Date.now(),
              });
              if (hold) {
                hold.enter();
                await hold.gate;
                return fulfillSuggestions(route, responseItems);
              }
              return fulfillSuggestions(route, responseItems);
            }
            if (
              request.method() === "POST" &&
              /^\/api\/v1\/ai\/suggestions\/[^/]+\/(accept|reject)$/.test(path)
            ) {
              const [, itemId, decision] = path.match(
                /^\/api\/v1\/ai\/suggestions\/([^/]+)\/(accept|reject)$/,
              );
              if (decision === "accept") {
                acceptCommitted = true;
                if (pendingAcceptance) {
                  const hold = pendingAcceptance;
                  pendingAcceptance = null;
                  hold.enter();
                  await hold.gate;
                }
              } else rejectedIds.add(itemId);
              return route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({ ok: true }),
              });
            }
            return route.continue();
          };
          const fixtureRoute = (route) => {
            const pending = handleFixtureRoute(route);
            pendingFixtureRoutes.add(pending);
            void pending.then(
              () => pendingFixtureRoutes.delete(pending),
              (error) => {
                pendingFixtureRoutes.delete(pending);
                fixtureRouteErrors.push(error);
              },
            );
            return pending;
          };
          await page.route("**/api/v1/ai/suggestions**", fixtureRoute);
          let freshnessError = null;
          let fixtureTeardownError = null;
          try {
            const firstRefresh = page.waitForResponse((response) => {
              const url = new URL(response.url());
              return (
                url.pathname === "/api/v1/ai/suggestions" &&
                response.request().method() === "GET"
              );
            });
            await page.evaluate(() =>
              Array.from({ length: 5 }, () =>
                window.dispatchEvent(
                  new CustomEvent("nivra:ai-completion", {
                    detail: { kind: "ai", source: "freshness-fixture" },
                  }),
                ),
              ),
            );
            await firstRefresh;
            assert.equal(
              getCount,
              1,
              "A completion burst should coalesce into one suggestions refresh",
            );
            await suggestions
              .getByRole("button", {
                name: "Add Fixture tag 1 to Refresh sample 1",
                exact: true,
              })
              .waitFor();
            assert.equal(
              await suggestions.locator(".tag-suggestion-card").count(),
              30,
              "The initial suggestions batch should be complete",
            );
            await waitForAiCompletionQuiet();
            const dismissedTitle = "Refresh sample 2";
            const dismissedItem = firstBatch[1];
            const sourceAction = suggestions.getByRole("button", {
              name: `Open ${dismissedTitle}`,
              exact: true,
            });
            const dismissAction = suggestions.getByRole("button", {
              name: `Dismiss suggestion for ${dismissedItem.tag.name} on ${dismissedTitle}`,
              exact: true,
            });
            const dismissedCard = dismissAction.locator(
              "xpath=ancestor::li[1]",
            );
            const dismissedResponse = page.waitForResponse((response) => {
              const url = new URL(response.url());
              return (
                url.pathname === "/api/v1/ai/suggestions" &&
                response.request().method() === "GET"
              );
            });
            await sourceAction.focus();
            await page.keyboard.press("Tab");
            assert.equal(
              await dismissAction.evaluate(
                (element) => element === document.activeElement,
              ),
              true,
              "Tab should move from the stretched source button to the card dismiss action",
            );
            const focusOutline = await dismissAction.evaluate((element) => {
              const style = getComputedStyle(element);
              return {
                style: style.outlineStyle,
                width: Number.parseFloat(style.outlineWidth),
              };
            });
            assert.ok(
              focusOutline.style !== "none" && focusOutline.width >= 2,
              `The focused dismiss action should have a visible focus outline; style=${JSON.stringify(focusOutline)}`,
            );
            await page.keyboard.press("Enter");
            const dismissedListResponse = await dismissedResponse;
            assert.equal(dismissedListResponse.status(), 200);
            await assertScreenReaderStatus(
              suggestions,
              `Suggestion for ${dismissedTitle} dismissed.`,
            );
            await dismissedCard.waitFor({ state: "detached" });
            assert.equal(
              getCount,
              2,
              "Dismissal should trigger one explicit suggestions refresh",
            );
            assert.equal(
              await suggestions.locator(".tag-suggestion-card").count(),
              29,
              "Dismissing from the card corner should remove only that suggestion",
            );
            await waitForWorkspaceApiIdle("dismissed suggestion refresh");
            const grid = suggestions.locator(".tag-suggestion-grid");
            const initialGridBounds = await grid.evaluate((element) => {
              const { top, height } = element.getBoundingClientRect();
              return { top, height };
            });

            const backgroundHold = holdSuggestionsGet(
              firstBatch.filter((item) => !rejectedIds.has(item.id)),
            );
            const heldRefresh = page.waitForRequest(
              (request) => {
                const url = new URL(request.url());
                return (
                  url.pathname === "/api/v1/ai/suggestions" &&
                  request.method() === "GET"
                );
              },
              { timeout: 10000 },
            );
            await page.evaluate(() =>
              window.dispatchEvent(
                new CustomEvent("nivra:ai-completion", {
                  detail: { kind: "ai", source: "freshness-fixture" },
                }),
              ),
            );
            await heldRefresh;
            await backgroundHold.entered;
            await waitForSuggestionsBusy(suggestions, true);
            await assertNoVisibleSuggestionRefreshCopy(suggestions);
            const refreshingGridBounds = await grid.evaluate((element) => {
              const { top, height } = element.getBoundingClientRect();
              return { top, height };
            });
            assert.ok(
              Math.abs(refreshingGridBounds.top - initialGridBounds.top) <= 1 &&
                Math.abs(
                  refreshingGridBounds.height - initialGridBounds.height,
                ) <= 1,
              `A background refresh must preserve the suggestion grid bounds; before=${JSON.stringify(initialGridBounds)} after=${JSON.stringify(refreshingGridBounds)}`,
            );
            assert.equal(
              await suggestions.locator(".tag-suggestion-card").count(),
              29,
              `A background refresh must keep the current batch visible; GETs=${JSON.stringify(fixtureGets)}; completion events=${JSON.stringify(await page.evaluate(() => window.__tagSuggestionCompletionEvents))}`,
            );
            assert.equal(
              await suggestions
                .getByRole("button", {
                  name: "Add Fixture tag 1 to Refresh sample 1",
                  exact: true,
                })
                .isVisible(),
              true,
              "The current suggestion remains actionable while refreshing",
            );

            await page.evaluate(() =>
              Array.from({ length: 5 }, () =>
                window.dispatchEvent(
                  new CustomEvent("nivra:ai-completion", {
                    detail: { kind: "ai", source: "freshness-fixture" },
                  }),
                ),
              ),
            );
            await waitForAiCompletionQuiet();
            assert.equal(
              getCount,
              3,
              "Completions during one pending refresh should queue a single trailing GET",
            );

            const acceptHold = holdNextAcceptance();
            const acceptResponsePromise = page.waitForResponse((response) => {
              const url = new URL(response.url());
              return (
                response.request().method() === "POST" &&
                /\/api\/v1\/ai\/suggestions\/[^/]+\/accept$/.test(url.pathname)
              );
            });
            await suggestions
              .getByRole("button", {
                name: "Add Fixture tag 1 to Refresh sample 1",
                exact: true,
              })
              .click();
            await acceptHold.entered;
            await waitForSuggestionsBusy(suggestions, true);
            await assertNoVisibleSuggestionRefreshCopy(suggestions);
            assert.equal(
              await suggestions.locator(".tag-suggestion-card").count(),
              29,
              "A pending approval must leave its card in place until the response succeeds",
            );
            await page.evaluate(() =>
              Array.from({ length: 5 }, () =>
                window.dispatchEvent(
                  new CustomEvent("nivra:ai-completion", {
                    detail: { kind: "ai", source: "freshness-fixture" },
                  }),
                ),
              ),
            );
            await waitForAiCompletionQuiet();
            assert.equal(
              getCount,
              3,
              "Completions during a pending review must not start parallel refreshes",
            );
            acceptHold.release();
            const acceptResponse = await acceptResponsePromise;
            assert.equal(acceptResponse.status(), 200);
            await assertScreenReaderStatus(
              suggestions,
              "Fixture tag 1 added to Refresh sample 1.",
            );
            await waitForSuggestionsBusy(suggestions, true);
            await assertNoVisibleSuggestionRefreshCopy(suggestions);
            assert.equal(
              await suggestions.locator(".tag-suggestion-card").count(),
              28,
              "Removing a reviewed suggestion must keep the remaining cards visible",
            );
            assert.equal(
              await suggestions
                .getByRole("heading", {
                  name: "No tag suggestions to review",
                  exact: true,
                })
                .count(),
              0,
              "The next batch must not appear empty while loading",
            );
            const afterDecisionGridBounds = await grid.evaluate((element) => {
              const { top, height } = element.getBoundingClientRect();
              return { top, height };
            });
            const queuedHold = holdSuggestionsGet(nextBatch);
            const staleResponsePromise = page.waitForResponse((response) => {
              const url = new URL(response.url());
              return (
                url.pathname === "/api/v1/ai/suggestions" &&
                response.request().method() === "GET"
              );
            });
            const queuedRequestPromise = page.waitForRequest((request) => {
              const url = new URL(request.url());
              return (
                url.pathname === "/api/v1/ai/suggestions" &&
                request.method() === "GET"
              );
            });
            backgroundHold.release();
            const staleResponse = await staleResponsePromise;
            assert.equal(staleResponse.status(), 200);
            await queuedRequestPromise;
            await queuedHold.entered;
            await waitForSuggestionsBusy(suggestions, true);
            await assertNoVisibleSuggestionRefreshCopy(suggestions);
            assert.equal(
              await suggestions.locator(".tag-suggestion-card").count(),
              28,
              "A stale GET arriving after review must not restore the reviewed card",
            );
            assert.equal(
              await suggestions
                .getByRole("button", {
                  name: "Add Fixture tag 1 to Refresh sample 1",
                  exact: true,
                })
                .count(),
              0,
              "The reviewed suggestion must stay absent after the stale response",
            );
            const afterStaleGridBounds = await grid.evaluate((element) => {
              const { top, height } = element.getBoundingClientRect();
              return { top, height };
            });
            assert.ok(
              Math.abs(
                afterStaleGridBounds.top - afterDecisionGridBounds.top,
              ) <= 1 &&
                Math.abs(
                  afterStaleGridBounds.height - afterDecisionGridBounds.height,
                ) <= 1,
              `The stale response must leave the reviewed grid unchanged; before=${JSON.stringify(afterDecisionGridBounds)} after=${JSON.stringify(afterStaleGridBounds)}`,
            );
            queuedHold.release();
            await suggestions
              .getByRole("button", {
                name: "Add Queued tag to Queued suggestion sample",
                exact: true,
              })
              .waitFor();
            await waitForSuggestionsBusy(suggestions, false);
            await assertNoVisibleSuggestionRefreshCopy(suggestions);
            await assertScreenReaderStatus(
              suggestions,
              "Fixture tag 1 added to Refresh sample 1.",
            );
            assert.equal(
              await suggestions.locator(".tag-suggestion-card").count(),
              1,
              "Reviewing a suggestion explicitly loads the queued next batch",
            );
            assert.equal(
              await suggestions
                .getByRole("heading", {
                  name: "No tag suggestions to review",
                  exact: true,
                })
                .count(),
              0,
              "A queued batch must not appear falsely empty after review",
            );
            assert.equal(
              getCount,
              4,
              `Reviewing a card must explicitly fetch the next suggestions batch; GETs=${JSON.stringify(fixtureGets)}; completion events=${JSON.stringify(await page.evaluate(() => window.__tagSuggestionCompletionEvents))}`,
            );
            await waitForWorkspaceApiIdle("suggestion freshness fixture");
          } catch (error) {
            freshnessError = error;
          } finally {
            for (const hold of allSuggestionHolds) hold.release();
            try {
              while (pendingFixtureRoutes.size)
                await Promise.allSettled([...pendingFixtureRoutes]);
              await waitForWorkspaceApiIdle("suggestion fixture teardown");
            } catch (error) {
              fixtureTeardownError = error;
            }
            try {
              await page.unroute("**/api/v1/ai/suggestions**", fixtureRoute);
            } catch (error) {
              fixtureTeardownError = fixtureTeardownError
                ? new AggregateError(
                    [fixtureTeardownError, error],
                    "Suggestion fixture teardown failed",
                  )
                : error;
            }
          }
          const fixtureFailures = [
            freshnessError,
            fixtureTeardownError,
            ...fixtureRouteErrors,
          ].filter(Boolean);
          if (fixtureFailures.length === 1) throw fixtureFailures[0];
          if (fixtureFailures.length)
            throw new AggregateError(
              fixtureFailures,
              "Suggestions freshness fixture failed",
            );
          assert.deepEqual(errors, []);
          console.log(
            `${name} ${width} ${theme}: background refresh keeps existing suggestions visible and explicit review loads the next batch`,
          );
        }
        if (
          name === "chromium" &&
          theme === "light" &&
          [390, 1440].includes(width)
        ) {
          const raceTag = (suffix) => ({
            id: randomUUID(),
            itemId: note.id,
            type: "note",
            title: `Mixed approval sample ${suffix}`,
            excerpt:
              "A stable suggestion remains visible during vocabulary rebuild.",
            tag: {
              id: randomUUID(),
              name: `Mixed tag ${suffix}`,
              color: "gray",
            },
            createdAt: Date.now(),
          });
          const raceInitial = [
            raceTag("one"),
            raceTag("two"),
            raceTag("three"),
          ];
          const racePrePost = raceTag("pre-post");
          const raceFinal = raceTag("four");
          const acceptedIds = new Set();
          let raceSuggestions = [...raceInitial, racePrePost];
          let raceVocabularyPending = 0;
          let staleReadHeld = false;
          let releaseStaleRead;
          let staleReadEntered;
          const staleReadGate = new Promise((resolve) => {
            releaseStaleRead = resolve;
          });
          const staleReadEnteredPromise = new Promise((resolve) => {
            staleReadEntered = resolve;
          });
          let holdPrePostGet = false;
          let releasePrePostGet;
          let prePostGetEntered;
          const prePostGetGate = new Promise((resolve) => {
            releasePrePostGet = resolve;
          });
          const prePostGetEnteredPromise = new Promise((resolve) => {
            prePostGetEntered = resolve;
          });
          let holdPrePostPost = false;
          let releasePrePostPost;
          let prePostPostEntered;
          const prePostPostGate = new Promise((resolve) => {
            releasePrePostPost = resolve;
          });
          const prePostPostEnteredPromise = new Promise((resolve) => {
            prePostPostEntered = resolve;
          });
          let raceProposal = proposalFixtureItems.find(
            (proposal) => proposal.id === proposalIds.create,
          );
          assert.ok(raceProposal, "The synthetic new-tag proposal exists");
          proposalFixtureItems = [raceProposal];
          let failedRejectOnce = true;
          let raceSuggestionGets = 0;
          const statusRoute = async (route) => {
            if (route.request().method() !== "GET") return route.continue();
            const current = await api("ai");
            return route.fulfill({
              status: 200,
              contentType: "application/json",
              body: JSON.stringify({
                ...current,
                enabled: true,
                vocabularyPending: raceVocabularyPending,
              }),
            });
          };
          const suggestionsRoute = async (route) => {
            const request = route.request();
            const path = new URL(request.url()).pathname;
            if (
              request.method() === "GET" &&
              path === "/api/v1/ai/suggestions"
            ) {
              raceSuggestionGets++;
              let responseItems = [...raceSuggestions];
              if (holdPrePostGet) {
                holdPrePostGet = false;
                responseItems = [];
                prePostGetEntered();
                await prePostGetGate;
              } else if (staleReadHeld) {
                staleReadHeld = false;
                responseItems = [...raceInitial];
                staleReadEntered();
                await staleReadGate;
              }
              return route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({ items: responseItems }),
              });
            }
            const action = path.match(
              /^\/api\/v1\/ai\/suggestions\/([^/]+)\/(accept|reject)$/,
            );
            if (request.method() === "POST" && action) {
              const [, id, decision] = action;
              if (decision === "accept") acceptedIds.add(id);
              if (
                decision === "reject" &&
                failedRejectOnce &&
                id === raceFinal.id
              ) {
                failedRejectOnce = false;
                return route.fulfill({
                  status: 500,
                  contentType: "application/json",
                  body: JSON.stringify({
                    error: "Synthetic rejection failure",
                  }),
                });
              }
              if (decision === "reject") acceptedIds.add(id);
              raceSuggestions = raceSuggestions.filter(
                (item) => item.id !== id,
              );
              if (decision === "accept" && id === racePrePost.id) {
                prePostPostEntered();
                if (holdPrePostPost) await prePostPostGate;
              }
              return route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({ ok: true }),
              });
            }
            return route.continue();
          };
          const proposalsRoute = async (route) => {
            const request = route.request();
            const path = new URL(request.url()).pathname;
            if (
              request.method() === "GET" &&
              path === "/api/v1/ai/tag-proposals"
            )
              return route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({ items: proposalFixtureItems }),
              });
            const action = path.match(
              /^\/api\/v1\/ai\/tag-proposals\/([^/]+)\/(accept|reject)$/,
            );
            if (request.method() === "POST" && action) {
              const [, id, decision] = action;
              if (id !== raceProposal.id)
                return route.fulfill({
                  status: 404,
                  contentType: "application/json",
                  body: JSON.stringify({ error: "Unknown race-test proposal" }),
                });
              proposalFixtureItems = [];
              if (decision === "accept") raceVocabularyPending = 4;
              return route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({ ok: true }),
              });
            }
            return route.continue();
          };
          await page.route("**/api/v1/ai", statusRoute);
          await page.route("**/api/v1/ai/suggestions**", suggestionsRoute);
          await page.route("**/api/v1/ai/tag-proposals**", proposalsRoute);
          const waitForGate = async (promise, label) => {
            let timer;
            try {
              await Promise.race([
                promise,
                new Promise((_, reject) => {
                  timer = globalThis.setTimeout(
                    () => reject(new Error(`Timed out waiting for ${label}`)),
                    15_000,
                  );
                }),
              ]);
            } finally {
              if (timer) globalThis.clearTimeout(timer);
            }
          };
          let raceError = null;
          let raceCleanupError = null;
          try {
            await page.goto(`${base}/tag-suggestions`, {
              waitUntil: "domcontentloaded",
            });
            let racePanel = page.locator(".tag-suggestions-panel");
            await racePanel
              .getByRole("button", {
                name: `Add ${raceInitial[0].tag.name} to ${raceInitial[0].title}`,
                exact: true,
              })
              .waitFor();
            const prePostPanel = racePanel;
            const prePostGrid = prePostPanel.locator(".tag-suggestion-grid");
            const prePostButton = prePostPanel.getByRole("button", {
              name: `Add ${racePrePost.tag.name} to ${racePrePost.title}`,
              exact: true,
            });
            await prePostButton.waitFor({ state: "visible" });
            assert.equal(
              await prePostPanel.locator(".tag-suggestion-card").count(),
              4,
              "The pre-response fence fixture starts with four suggestions",
            );
            await prePostButton.scrollIntoViewIfNeeded();
            const prePostInitialBounds = await prePostGrid.evaluate(
              (element) => {
                const { top, height } = element.getBoundingClientRect();
                return {
                  documentTop: top + window.scrollY,
                  viewportTop: top,
                  scrollY: window.scrollY,
                  height,
                };
              },
            );
            holdPrePostGet = true;
            const prePostGetResponsePromise = page.waitForResponse(
              (response) =>
                response.request().method() === "GET" &&
                new URL(response.url()).pathname === "/api/v1/ai/suggestions",
              { timeout: 15_000 },
            );
            await page.evaluate(() =>
              window.dispatchEvent(
                new CustomEvent("nivra:ai-completion", {
                  detail: { kind: "ai", source: "pre-post-response-fence" },
                }),
              ),
            );
            await waitForGate(
              prePostGetEnteredPromise,
              "the pre-POST stale suggestions GET",
            );
            holdPrePostPost = true;
            const prePostDecisionResponsePromise = page.waitForResponse(
              (response) =>
                response.request().method() === "POST" &&
                new URL(response.url()).pathname ===
                  `/api/v1/ai/suggestions/${racePrePost.id}/accept`,
              { timeout: 15_000 },
            );
            await prePostButton.click();
            await waitForGate(
              prePostPostEnteredPromise,
              "the committed approval with its response held",
            );
            releasePrePostGet();
            const prePostGetResponse = await prePostGetResponsePromise;
            assert.equal(prePostGetResponse.status(), 200);
            assert.deepEqual(
              (await prePostGetResponse.json()).items,
              [],
              "The stale pre-response request simulates an empty result after the server commits the review",
            );
            await setTimeout(100);
            assert.equal(
              await prePostPanel.locator(".tag-suggestion-card").count(),
              4,
              "A stale empty GET must not clear cards while the approval response is pending",
            );
            await prePostButton.waitFor({ state: "visible" });
            assert.equal(
              await prePostPanel
                .getByRole("region", { name: "Tag suggestions" })
                .getAttribute("aria-busy"),
              "true",
              "The review remains visibly busy while its response is held",
            );
            const prePostPendingBounds = await prePostGrid.evaluate(
              (element) => {
                const { top, height } = element.getBoundingClientRect();
                return {
                  documentTop: top + window.scrollY,
                  viewportTop: top,
                  scrollY: window.scrollY,
                  height,
                };
              },
            );
            assert.ok(
              Math.abs(
                prePostPendingBounds.documentTop -
                  prePostInitialBounds.documentTop,
              ) <= 1 &&
                Math.abs(
                  prePostPendingBounds.height - prePostInitialBounds.height,
                ) <= 1,
              `A pre-response stale GET must not shift the suggestion grid; before=${JSON.stringify(prePostInitialBounds)} after=${JSON.stringify(prePostPendingBounds)}`,
            );
            const postReviewGetCount = raceSuggestionGets;
            const postReviewCanonicalResponsePromise = page.waitForResponse(
              (response) =>
                response.request().method() === "GET" &&
                new URL(response.url()).pathname === "/api/v1/ai/suggestions",
              { timeout: 15_000 },
            );
            releasePrePostPost();
            const prePostDecisionResponse =
              await prePostDecisionResponsePromise;
            assert.equal(prePostDecisionResponse.status(), 200);
            const postReviewCanonicalResponse =
              await postReviewCanonicalResponsePromise;
            assert.equal(postReviewCanonicalResponse.status(), 200);
            await prePostPanel
              .getByRole("button", {
                name: `Add ${raceInitial[0].tag.name} to ${raceInitial[0].title}`,
                exact: true,
              })
              .waitFor({ state: "visible" });
            await waitForSuggestionsBusy(prePostPanel, false);
            assert.equal(
              await prePostPanel.locator(".tag-suggestion-card").count(),
              3,
              "A canonical refresh after the review keeps the three unrelated suggestions",
            );
            assert.equal(
              await prePostButton.count(),
              0,
              "The reviewed suggestion disappears after the canonical refresh",
            );
            assert.ok(
              raceSuggestionGets > postReviewGetCount,
              "Settling the review queues a canonical suggestions GET after the stale pre-response GET",
            );
            raceSuggestions = [...raceInitial];
            acceptedIds.clear();
            await page.goto(`${base}/tag-suggestions`, {
              waitUntil: "domcontentloaded",
            });
            racePanel = page.locator(".tag-suggestions-panel");
            await racePanel
              .getByRole("button", {
                name: `Add ${raceInitial[0].tag.name} to ${raceInitial[0].title}`,
                exact: true,
              })
              .waitFor({ state: "visible" });
            assert.equal(
              await racePanel.locator(".tag-suggestion-card").count(),
              3,
              "The next race starts from an isolated three-card snapshot",
            );
            staleReadHeld = true;
            const firstAcceptResponse = page.waitForResponse((response) => {
              const url = new URL(response.url());
              return (
                response.request().method() === "POST" &&
                url.pathname ===
                  `/api/v1/ai/suggestions/${raceInitial[0].id}/accept`
              );
            });
            await racePanel
              .getByRole("button", {
                name: `Add ${raceInitial[0].tag.name} to ${raceInitial[0].title}`,
                exact: true,
              })
              .click();
            assert.equal((await firstAcceptResponse).status(), 200);
            let staleReadWaitTimer;
            try {
              await Promise.race([
                staleReadEnteredPromise,
                new Promise((_, reject) => {
                  staleReadWaitTimer = globalThis.setTimeout(
                    () =>
                      reject(
                        new Error(
                          "Timed out waiting for the held suggestions refresh",
                        ),
                      ),
                    15_000,
                  );
                }),
              ]);
            } finally {
              if (staleReadWaitTimer)
                globalThis.clearTimeout(staleReadWaitTimer);
            }
            await racePanel
              .getByRole("button", {
                name: `Add ${raceInitial[1].tag.name} to ${raceInitial[1].title}`,
                exact: true,
              })
              .waitFor({ state: "visible" });
            await racePanel
              .getByRole("button", {
                name: `Add ${raceInitial[0].tag.name} to ${raceInitial[0].title}`,
                exact: true,
              })
              .waitFor({ state: "detached" });
            await page.evaluate(
              (titles) => {
                window.__acceptedSuggestionTitles = new Set(titles);
                window.__suggestionResurrections = [];
                const panel = document.querySelector(".tag-suggestions-panel");
                const recordAdded = (node) => {
                  if (!(node instanceof Element)) return;
                  const titles = [];
                  if (node.matches(".tag-suggestion-title")) titles.push(node);
                  titles.push(
                    ...node.querySelectorAll(".tag-suggestion-title"),
                  );
                  for (const title of titles) {
                    const value = title.textContent?.trim();
                    if (value && window.__acceptedSuggestionTitles.has(value))
                      window.__suggestionResurrections.push(value);
                  }
                };
                window.__suggestionResurrectionObserver = new MutationObserver(
                  (records) => {
                    for (const record of records)
                      for (const node of record.addedNodes) recordAdded(node);
                  },
                );
                if (panel)
                  window.__suggestionResurrectionObserver.observe(panel, {
                    childList: true,
                    subtree: true,
                  });
              },
              [raceInitial[0].title],
            );
            const secondAcceptResponse = page.waitForResponse((response) => {
              const url = new URL(response.url());
              return (
                response.request().method() === "POST" &&
                url.pathname ===
                  `/api/v1/ai/suggestions/${raceInitial[1].id}/accept`
              );
            });
            await racePanel
              .getByRole("button", {
                name: `Add ${raceInitial[1].tag.name} to ${raceInitial[1].title}`,
                exact: true,
              })
              .click();
            assert.equal((await secondAcceptResponse).status(), 200);
            await racePanel
              .getByRole("button", {
                name: `Add ${raceInitial[1].tag.name} to ${raceInitial[1].title}`,
                exact: true,
              })
              .waitFor({ state: "detached" });
            await page.evaluate((title) => {
              window.__acceptedSuggestionTitles.add(title);
            }, raceInitial[1].title);
            const staleResponsePromise = page.waitForResponse((response) => {
              const url = new URL(response.url());
              return (
                response.request().method() === "GET" &&
                url.pathname === "/api/v1/ai/suggestions"
              );
            });
            releaseStaleRead();
            const staleResponse = await staleResponsePromise;
            assert.equal(staleResponse.status(), 200);
            raceSuggestions = raceInitial.filter(
              (item) => !acceptedIds.has(item.id),
            );
            await racePanel
              .getByRole("button", {
                name: `Add ${raceInitial[2].tag.name} to ${raceInitial[2].title}`,
                exact: true,
              })
              .waitFor();
            await waitForSuggestionsBusy(racePanel, false);
            assert.equal(
              await racePanel
                .getByRole("button", {
                  name: new RegExp(
                    `Add (?:${raceInitial[0].tag.name}|${raceInitial[1].tag.name})`,
                  ),
                })
                .count(),
              0,
              "Accepted suggestions must not be restored by a delayed list response",
            );
            assert.deepEqual(
              await page.evaluate(() => window.__suggestionResurrections),
              [],
              "Accepted suggestion cards must never reappear during a stale response",
            );

            const createProposalButton = racePanel.getByRole("button", {
              name: `Create ${raceProposal.name} and tag ${raceProposal.itemCount} items`,
              exact: true,
            });
            await createProposalButton.waitFor();
            const createProposalResponse = page.waitForResponse((response) => {
              const url = new URL(response.url());
              return (
                response.request().method() === "POST" &&
                url.pathname ===
                  `/api/v1/ai/tag-proposals/${raceProposal.id}/accept`
              );
            });
            await createProposalButton.click();
            assert.equal((await createProposalResponse).status(), 200);
            const vocabularyStatus = racePanel
              .locator('[role="status"].sr-only')
              .filter({
                hasText:
                  "Updating tag suggestions. Existing suggestions are kept while they refresh.",
              });
            await vocabularyStatus.waitFor({ state: "attached" });
            assert.match(
              (await vocabularyStatus.textContent()) ?? "",
              /Updating tag suggestions\. Existing suggestions are kept while they refresh\./,
              "The vocabulary refresh remains announced to assistive technology without adding visible content",
            );
            assert.notEqual(
              await vocabularyStatus.getAttribute("aria-hidden"),
              "true",
              "The refresh announcement stays available to assistive technology",
            );
            const statusBounds = await vocabularyStatus.evaluate((element) => {
              const { width, height } = element.getBoundingClientRect();
              return { width, height };
            });
            assert.ok(
              statusBounds.width <= 1 && statusBounds.height <= 1,
              `The refresh announcement must stay visually clipped; bounds=${JSON.stringify(statusBounds)}`,
            );
            assert.equal(
              await racePanel
                .locator('[role="status"]:not(.sr-only)')
                .filter({
                  hasText:
                    "Updating tag suggestions. Existing suggestions are kept while they refresh.",
                })
                .count(),
              0,
              "The vocabulary refresh must not add a visible banner above the suggestions",
            );
            assert.equal(
              await racePanel
                .getByRole("button", {
                  name: `Add ${raceInitial[2].tag.name} to ${raceInitial[2].title}`,
                  exact: true,
                })
                .isDisabled(),
              true,
              "Stale approvals stay disabled while tag vocabulary is rebuilding",
            );
            assert.equal(
              await racePanel
                .getByRole("button", {
                  name: `Open ${raceInitial[2].title}`,
                  exact: true,
                })
                .isEnabled(),
              true,
              "Opening a source remains available during vocabulary rebuilding",
            );
            assert.equal(
              await racePanel.locator(".tag-suggestion-card").count(),
              1,
              "The remaining valid card stays visible during vocabulary rebuilding",
            );
            const readsBeforeCompletionBurst = raceSuggestionGets;
            await page.evaluate(() =>
              Array.from({ length: 6 }, () =>
                window.dispatchEvent(
                  new CustomEvent("nivra:ai-completion", {
                    detail: { kind: "ai", source: "mixed-approval-race" },
                  }),
                ),
              ),
            );
            await setTimeout(250);
            assert.equal(
              raceSuggestionGets,
              readsBeforeCompletionBurst,
              "SSE completion bursts must not replace cards with partial vocabulary results",
            );

            await (
              await nav()
            )
              .getByRole("button", { name: "Overview", exact: true })
              .click();
            await waitForWorkspaceApiIdle("leave pending vocabulary rebuild");
            await (
              await nav()
            )
              .getByRole("button", { name: "Tag suggestions", exact: true })
              .click();
            racePanel = page.locator(".tag-suggestions-panel");
            await racePanel
              .getByRole("status", { name: "Updating tag suggestions" })
              .waitFor();
            assert.equal(
              await racePanel.locator(".tag-suggestion-card").count(),
              0,
              "A fresh visit during rebuilding must show progress, not stale accepted cards",
            );
            raceSuggestions = [...raceSuggestions, raceFinal];
            raceVocabularyPending = 0;
            await racePanel
              .getByRole("button", {
                name: `Add ${raceFinal.tag.name} to ${raceFinal.title}`,
                exact: true,
              })
              .waitFor({ timeout: 15_000 });
            await waitForSuggestionsBusy(racePanel, false);
            assert.equal(
              await racePanel
                .getByRole("button", {
                  name: new RegExp(
                    `Add (?:${raceInitial[0].tag.name}|${raceInitial[1].tag.name})`,
                  ),
                })
                .count(),
              0,
              "Canonical refresh after rebuilding must not restore accepted cards",
            );
            await racePanel
              .getByRole("button", {
                name: `Dismiss suggestion for ${raceFinal.tag.name} on ${raceFinal.title}`,
                exact: true,
              })
              .click();
            await racePanel
              .getByRole("alert")
              .getByText(
                "Could not update this suggestion. Refresh and try again.",
                {
                  exact: true,
                },
              )
              .waitFor();
            assert.equal(
              await racePanel.locator(".tag-suggestion-card").count(),
              2,
              "A failed action keeps its card and unrelated suggestions visible",
            );
            await racePanel
              .getByRole("button", {
                name: `Dismiss suggestion for ${raceFinal.tag.name} on ${raceFinal.title}`,
                exact: true,
              })
              .click();
            await racePanel
              .getByRole("button", {
                name: `Add ${raceInitial[2].tag.name} to ${raceInitial[2].title}`,
                exact: true,
              })
              .waitFor();
            assert.equal(
              await racePanel.locator(".tag-suggestion-card").count(),
              1,
              "Retrying the failed action removes only the dismissed card",
            );
            await waitForWorkspaceApiIdle("mixed tag-approval race fixture");
            await page.evaluate(() => {
              window.__suggestionResurrectionObserver?.disconnect();
            });
            assert.deepEqual(errors, []);
            console.log(
              `${name} ${width} ${theme}: mixed tag approvals, stale-response fencing, vocabulary rebuild and partial failure passed`,
            );
          } catch (error) {
            raceError = error;
          } finally {
            releasePrePostGet();
            releasePrePostPost();
            releaseStaleRead();
            try {
              await page.unroute("**/api/v1/ai", statusRoute);
              await page.unroute(
                "**/api/v1/ai/suggestions**",
                suggestionsRoute,
              );
              await page.unroute(
                "**/api/v1/ai/tag-proposals**",
                proposalsRoute,
              );
            } catch (error) {
              raceCleanupError = error;
            }
            await page
              .evaluate(() => {
                window.__suggestionResurrectionObserver?.disconnect();
              })
              .catch(() => {});
          }
          const raceFailures = [raceError, raceCleanupError].filter(Boolean);
          if (raceFailures.length === 1) throw raceFailures[0];
          if (raceFailures.length)
            throw new AggregateError(
              raceFailures,
              "Mixed tag-approval race fixture failed",
            );
        }
        console.log(
          `${name} ${width} ${theme}: tag navigation, contextual review, source opening, explicit tag approval, focus, accessibility and overflow passed`,
        );
        const semanticQuery =
          "recover stored information after restoring a protected safety copy";
        await waitForStableAiIndex();
        await waitForSemanticResult(semanticQuery, note.id);
        await waitForWorkspaceApiIdle("before search navigation");
        let search;
        if (width === 320 && theme === "light") {
          let availabilityWasChecked = false;
          await page.route("**/api/v1/ai", async (route) => {
            const current = await api("ai");
            availabilityWasChecked = true;
            await route.fulfill({
              status: 200,
              contentType: "application/json",
              body: JSON.stringify({ ...current, enabled: false }),
            });
          });
          const disabledQuery = "SQLite database queries";
          try {
            const disabledStatusPromise = page.waitForResponse((response) => {
              const url = new URL(response.url());
              return (
                url.pathname === "/api/v1/ai" &&
                response.request().method() === "GET"
              );
            });
            const disabledRecentPromise = page.waitForResponse((response) => {
              const url = new URL(response.url());
              return (
                url.pathname === "/api/v1/search" &&
                url.searchParams.get("mode") === "suggest" &&
                url.searchParams.get("strategy") === "keyword" &&
                url.searchParams.get("q") === ""
              );
            });
            const disabledQueryPromise = page.waitForResponse((response) => {
              const url = new URL(response.url());
              return (
                url.pathname === "/api/v1/search" &&
                url.searchParams.get("mode") === "suggest" &&
                url.searchParams.get("q") === disabledQuery
              );
            });
            await (
              await nav()
            )
              .getByRole("button", { name: /^Search/ })
              .first()
              .click();
            const disabledSearch = await surface("Search");
            search = disabledSearch;
            const disabledStatus = await disabledStatusPromise;
            assert.equal(disabledStatus.status(), 200);
            assert.equal((await disabledStatus.json()).enabled, false);
            const disabledRecent = await disabledRecentPromise;
            assert.equal(disabledRecent.status(), 200);
            await disabledSearch
              .getByRole("combobox", {
                name: "Search everything",
                exact: true,
              })
              .fill(disabledQuery);
            const disabledQueryResponse = await disabledQueryPromise;
            assert.equal(disabledQueryResponse.status(), 200);
            assert.equal(
              new URL(disabledQueryResponse.url()).searchParams.get("strategy"),
              "keyword",
              "Search must stay lexical when the shared smart-features setting is off",
            );
            await disabledSearch
              .getByText("Search results", { exact: true })
              .waitFor();
            assert.equal(
              await disabledSearch
                .getByText("Related matches", { exact: true })
                .count(),
              0,
              "Disabled smart features must not label keyword results as semantic",
            );
            assert.equal(
              availabilityWasChecked,
              true,
              "Search must read the shared smart-features setting",
            );
            await page.unroute("**/api/v1/ai");
            const enabledStatusPromise = page.waitForResponse((response) => {
              const url = new URL(response.url());
              return (
                url.pathname === "/api/v1/ai" &&
                response.request().method() === "GET"
              );
            });
            const enabledSemanticPromise = page.waitForResponse((response) => {
              const url = new URL(response.url());
              return (
                url.pathname === "/api/v1/search" &&
                url.searchParams.get("mode") === "suggest" &&
                url.searchParams.get("strategy") === "semantic" &&
                url.searchParams.get("q") === disabledQuery
              );
            });
            await page.evaluate(() => {
              window.dispatchEvent(
                new CustomEvent("nivra:ai-completion", {
                  detail: {
                    kind: "ai",
                    target: "settings",
                    status: "changed",
                  },
                }),
              );
            });
            const enabledStatus = await enabledStatusPromise;
            assert.equal(enabledStatus.status(), 200);
            assert.equal((await enabledStatus.json()).enabled, true);
            const enabledSemantic = await enabledSemanticPromise;
            assert.equal(enabledSemantic.status(), 200);
            assert.equal(
              (await enabledSemantic.json()).strategyUsed,
              "semantic",
              "A settings completion event must switch the open search to semantic strategy",
            );
            await waitForWorkspaceApiIdle("settings-driven search settled");
            console.log(
              `${name} ${width} ${theme}: smart-feature setting and live settings changes control semantic search`,
            );
          } finally {
            await page.unroute("**/api/v1/ai");
          }
        }
        if (!search) {
          const recentSearchResponsePromise = page.waitForResponse(
            (response) => {
              const url = new URL(response.url());
              return (
                url.pathname === "/api/v1/search" &&
                response.request().method() === "GET" &&
                url.searchParams.get("mode") === "suggest" &&
                url.searchParams.get("strategy") === "keyword" &&
                url.searchParams.get("q") === ""
              );
            },
          );
          await (
            await nav()
          )
            .getByRole("button", { name: /^Search/ })
            .first()
            .click();
          search = await surface("Search");
          const recentSearchResponse = await recentSearchResponsePromise;
          assert.equal(recentSearchResponse.status(), 200);
          await waitForWorkspaceApiIdle("recent search settled");
        }
        const searchInput = search.getByRole("combobox", {
          name: "Search everything",
          exact: true,
        });
        const semanticResponsePromise = page.waitForResponse((response) => {
          const url = new URL(response.url());
          return (
            url.pathname === "/api/v1/search" &&
            url.searchParams.get("mode") === "suggest" &&
            url.searchParams.get("strategy") === "semantic" &&
            url.searchParams.get("q") === semanticQuery
          );
        });
        assert.equal(
          await search
            .getByRole("checkbox", { name: "Search by meaning", exact: true })
            .count(),
          0,
          "Meaning search must follow the System setting instead of a per-query checkbox",
        );
        await searchInput.fill(semanticQuery);
        let semanticResponse;
        try {
          semanticResponse = await semanticResponsePromise;
        } catch {
          const status = await api("ai");
          throw new Error(
            `Semantic UI response did not arrive; query=${semanticQuery}; AI status=${JSON.stringify(status)}`,
          );
        }
        const semanticPayload = await semanticResponse.json();
        const semanticItems = Array.isArray(semanticPayload.items)
          ? semanticPayload.items
          : [];
        const semanticItemIds = semanticItems.map((item) => item.id);
        const aiStatus = await api("ai");
        assert.equal(
          semanticResponse.status(),
          200,
          `Semantic search HTTP status ${semanticResponse.status()}; AI status=${JSON.stringify(aiStatus)}`,
        );
        assert.equal(
          semanticPayload.strategyUsed,
          "semantic",
          `Expected a semantic response, got ${JSON.stringify({ strategyUsed: semanticPayload.strategyUsed, itemIds: semanticItemIds, aiStatus })}`,
        );
        assert.ok(
          semanticItemIds.includes(note.id),
          `Semantic response omitted the demo note; response=${JSON.stringify({ strategyUsed: semanticPayload.strategyUsed, itemIds: semanticItemIds })}; AI status=${JSON.stringify(aiStatus)}`,
        );
        await search.getByRole("option").filter({ hasText: title }).waitFor();
        await audit(search, "search");
        assert.ok(
          await search.getByText("Related matches", { exact: true }).count(),
          `The UI did not label the verified semantic response as related matches; response=${JSON.stringify({ strategyUsed: semanticPayload.strategyUsed, itemIds: semanticItemIds })}; AI status=${JSON.stringify(aiStatus)}`,
        );
        await waitForWorkspaceApiIdle("search settled before opening result");
        await search.getByRole("option").filter({ hasText: title }).click();
        await page.locator('[aria-label="Note content"]').waitFor();
        await waitForWorkspaceApiIdle("after semantic result selection");
        assert.deepEqual(errors, []);
        console.log(
          `${name} ${width} ${theme}: aliases, approval, semantic results, focus, accessibility and overflow passed`,
        );
        if (width === 320 && theme === "light") {
          const fallbackQuery = `${semanticQuery} synthetic fallback`;
          const fallbackPayload = {
            ...semanticPayload,
            strategyUsed: "keyword",
          };
          await page.route("**/api/v1/search**", async (route) => {
            const url = new URL(route.request().url());
            if (
              url.pathname === "/api/v1/search" &&
              url.searchParams.get("mode") === "suggest" &&
              url.searchParams.get("strategy") === "semantic" &&
              url.searchParams.get("q") === fallbackQuery
            ) {
              await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify(fallbackPayload),
              });
              return;
            }
            await route.continue();
          });
          await waitForWorkspaceApiIdle("before keyword-fallback navigation");
          await page.goto(`${base}/overview`, {
            waitUntil: "domcontentloaded",
          });
          await waitForWorkspaceApiIdle(
            "overview settled before fallback search",
          );
          const fallbackRecentSearchResponsePromise = page.waitForResponse(
            (response) => {
              const url = new URL(response.url());
              return (
                url.pathname === "/api/v1/search" &&
                response.request().method() === "GET" &&
                url.searchParams.get("mode") === "suggest" &&
                url.searchParams.get("strategy") === "keyword" &&
                url.searchParams.get("q") === ""
              );
            },
          );
          await (
            await nav()
          )
            .getByRole("button", { name: /^Search/ })
            .first()
            .click();
          const fallbackSearch = await surface("Search");
          const fallbackRecentSearchResponse =
            await fallbackRecentSearchResponsePromise;
          assert.equal(fallbackRecentSearchResponse.status(), 200);
          await waitForWorkspaceApiIdle("recent fallback search settled");
          const fallbackInput = fallbackSearch.getByRole("combobox", {
            name: "Search everything",
            exact: true,
          });
          const fallbackResponsePromise = page.waitForResponse((response) => {
            const url = new URL(response.url());
            return (
              url.pathname === "/api/v1/search" &&
              response.request().method() === "GET" &&
              url.searchParams.get("mode") === "suggest" &&
              url.searchParams.get("strategy") === "semantic" &&
              url.searchParams.get("q") === fallbackQuery
            );
          });
          assert.equal(
            await fallbackSearch
              .getByRole("checkbox", {
                name: "Search by meaning",
                exact: true,
              })
              .count(),
            0,
            "Meaning search fallback must not expose a per-query checkbox",
          );
          await fallbackInput.fill(fallbackQuery);
          const fallbackResponse = await fallbackResponsePromise;
          const fallbackResult = await fallbackResponse.json();
          assert.equal(fallbackResponse.status(), 200);
          assert.equal(fallbackResult.strategyUsed, "keyword");
          await fallbackSearch
            .getByText(
              "Meaning search is unavailable. Showing keyword results.",
              {
                exact: true,
              },
            )
            .waitFor();
          await fallbackSearch
            .getByText("Search results", { exact: true })
            .waitFor();
          await fallbackSearch
            .getByRole("option")
            .filter({ hasText: title })
            .waitFor();
          await audit(fallbackSearch, "keyword-fallback");
          await waitForWorkspaceApiIdle(
            "fallback search settled before opening result",
          );
          await fallbackSearch
            .getByRole("option")
            .filter({ hasText: title })
            .click();
          await page.locator('[aria-label="Note content"]').waitFor();
          await waitForWorkspaceApiIdle("after keyword-fallback selection");
          assert.deepEqual(errors, []);
          console.log(
            `${name} ${width} ${theme}: deterministic keyword fallback presentation passed`,
          );
          await page.unroute("**/api/v1/search**");
          await page.route("**/api/v1/ai/suggestions", (route) =>
            route.fulfill({
              status: 503,
              contentType: "application/json",
              body: JSON.stringify({ error: "Synthetic suggestions failure" }),
            }),
          );
          await waitForWorkspaceApiIdle("before suggestion-error navigation");
          await page.goto(`${base}/tag-suggestions`, {
            waitUntil: "domcontentloaded",
          });
          const errorSuggestions = page.locator(".tag-suggestions-panel");
          await errorSuggestions
            .getByText("Could not load tag suggestions.", { exact: false })
            .waitFor();
          await waitForWorkspaceApiIdle(
            "suggestion error settled before settings",
          );
          await (
            await nav()
          )
            .getByRole("button", { name: "Settings", exact: true })
            .click();
          const errorSettingsAgain = await surface("Settings");
          await errorSettingsAgain
            .getByRole("tab", { name: "System", exact: true })
            .click();
          await waitForWorkspaceApiIdle(
            "smart feature status loaded after suggestion error",
          );
          const localAiSettings =
            errorSettingsAgain.locator(".local-ai-settings");
          const errorToggle = localAiSettings.getByRole("checkbox", {
            name: "Enable smart features",
            exact: true,
          });
          await errorToggle.waitFor({ state: "visible" });
          await localAiSettings
            .getByText("Loading smart feature settings…", { exact: true })
            .waitFor({ state: "hidden" });
          await localAiSettings
            .getByRole("alert")
            .filter({ hasText: "Could not load smart features." })
            .waitFor({ state: "hidden" });
          await page.waitForFunction(
            (checkbox) => !checkbox.disabled,
            await errorToggle.elementHandle(),
          );
          assert.equal(
            await localAiSettings
              .getByRole("button", { name: /^Add .+ to .+$/ })
              .count(),
            0,
            "Tag suggestions must be reviewed outside System settings",
          );
          assert.equal(
            await errorToggle.isDisabled(),
            false,
            "Tag-suggestion loading failure must not disable the smart-feature toggle",
          );
          const modeControl = localAiSettings.getByRole("combobox", {
            name: "Tagging mode",
            exact: true,
          });
          await modeControl.waitFor({ state: "visible" });
          await localAiSettings
            .getByText(
              "Review each suggestion before assigning it or creating a reusable tag.",
              { exact: true },
            )
            .waitFor();
          assert.equal(
            (await api("ai")).taggingMode,
            "manual",
            "The matrix begins with review mode enabled",
          );
          if (name === "chromium" && width === 320 && theme === "light") {
            await errorToggle.focus();
            await page.keyboard.press("Tab");
            assert.equal(
              await modeControl.evaluate(
                (element) => element === document.activeElement,
              ),
              true,
              "Tab should move from the master opt-in to the tagging-mode control",
            );
            const automaticModeResponsePromise = page
              .waitForResponse(
                (response) =>
                  new URL(response.url()).pathname === "/api/v1/ai" &&
                  response.request().method() === "PATCH",
              )
              .then(
                (response) => ({ response }),
                (error) => ({ error }),
              );
            await page.keyboard.press("Space");
            await page
              .getByRole("option", {
                name: "Automatic tagging",
                exact: true,
              })
              .waitFor();
            const taggingModeKeyboardState = () =>
              page.locator("#local-ai-tagging-mode").evaluate((control) => {
                const active = document.activeElement;
                return {
                  control: {
                    text: control.textContent?.trim(),
                    state: control.getAttribute("data-state"),
                    expanded: control.getAttribute("aria-expanded"),
                    activeDescendant: control.getAttribute(
                      "aria-activedescendant",
                    ),
                  },
                  active: active
                    ? {
                        role: active.getAttribute("role"),
                        label: active.getAttribute("aria-label"),
                        text: active.textContent?.trim(),
                        state: active.getAttribute("data-state"),
                      }
                    : null,
                  options: [
                    ...document.querySelectorAll('[role="option"]'),
                  ].map((option) => ({
                    text: option.textContent?.trim(),
                    state: option.getAttribute("data-state"),
                    selected: option.getAttribute("aria-selected"),
                    highlighted: option.getAttribute("data-highlighted"),
                  })),
                };
              });
            const waitForModeOption = async (
              label,
              { selected = false } = {},
            ) => {
              await page.waitForFunction(
                ({ expectedLabel, mustBeSelected }) => {
                  const option = [
                    ...document.querySelectorAll('[role="option"]'),
                  ].find(
                    (candidate) =>
                      candidate.textContent?.trim() === expectedLabel,
                  );
                  if (
                    !option ||
                    (mustBeSelected &&
                      option.getAttribute("aria-selected") !== "true")
                  )
                    return false;
                  const active = document.activeElement;
                  return (
                    option.hasAttribute("data-highlighted") ||
                    (active?.getAttribute("role") === "option" &&
                      active.textContent?.trim() === expectedLabel)
                  );
                },
                { expectedLabel: label, mustBeSelected: selected },
                { timeout: 3000, polling: "raf" },
              );
            };
            const waitForAiModePatch = () =>
              page
                .waitForResponse(
                  (response) =>
                    new URL(response.url()).pathname === "/api/v1/ai" &&
                    response.request().method() === "PATCH",
                )
                .then(
                  (response) => ({ response }),
                  (error) => ({ error }),
                );
            const requireAiModePatch = async (responsePromise) => {
              const result = await responsePromise;
              if (result.error) throw result.error;
              return result.response;
            };
            await waitForModeOption("Review suggestions", {
              selected: true,
            });
            console.log(
              `${name} ${width} ${theme}: mode menu after open ${JSON.stringify(await taggingModeKeyboardState())}`,
            );
            await page.keyboard.press("ArrowDown");
            await waitForModeOption("Automatic tagging");
            const highlightedMode = await taggingModeKeyboardState();
            console.log(
              `${name} ${width} ${theme}: mode menu after ArrowDown ${JSON.stringify(highlightedMode)}`,
            );
            assert.ok(
              highlightedMode.options.some(
                (option) =>
                  option.text === "Automatic tagging" &&
                  (option.highlighted === "true" ||
                    option.highlighted === "" ||
                    option.selected === "true" ||
                    highlightedMode.active?.text === "Automatic tagging"),
              ),
              "ArrowDown should highlight Automatic tagging before confirming it",
            );
            await page.keyboard.press("Enter");
            let automaticModeResponse;
            try {
              const result = await automaticModeResponsePromise;
              if (result.error) throw result.error;
              automaticModeResponse = result.response;
            } catch (error) {
              console.log(
                `${name} ${width} ${theme}: mode request timed out; state=${JSON.stringify(await taggingModeKeyboardState())}; alerts=${JSON.stringify(await localAiSettings.getByRole("alert").allTextContents())}`,
              );
              if (output)
                await page.screenshot({
                  path: `${output}/${name}-${width}-${theme}-mode-timeout.png`,
                });
              throw error;
            }
            assert.equal(automaticModeResponse.status(), 200);
            await localAiSettings
              .getByText(
                "Reliable matches are assigned automatically, and reusable tags are created for recurring topics.",
                { exact: true },
              )
              .waitFor();
            assert.equal(
              (await api("ai")).taggingMode,
              "automatic",
              "The automatic tagging mode should persist",
            );

            const disableResponsePromise = page.waitForResponse(
              (response) =>
                new URL(response.url()).pathname === "/api/v1/ai" &&
                response.request().method() === "PATCH",
            );
            await errorToggle.click();
            const disableResponse = await disableResponsePromise;
            assert.equal(disableResponse.status(), 200);
            await page.waitForFunction(
              (checkbox) => checkbox.getAttribute("aria-checked") === "false",
              await errorToggle.elementHandle(),
            );
            await modeControl.waitFor({ state: "hidden" });
            let disabledStatus = await api("ai");
            assert.equal(disabledStatus.enabled, false);
            assert.equal(
              disabledStatus.taggingMode,
              "automatic",
              "Turning off smart features should preserve the chosen mode",
            );

            const enableResponsePromise = page.waitForResponse(
              (response) =>
                new URL(response.url()).pathname === "/api/v1/ai" &&
                response.request().method() === "PATCH",
            );
            await errorToggle.click();
            const enableResponse = await enableResponsePromise;
            assert.equal(enableResponse.status(), 200);
            await page.waitForFunction(
              (checkbox) => checkbox.getAttribute("aria-checked") === "true",
              await errorToggle.elementHandle(),
            );
            await modeControl.waitFor({ state: "visible" });
            await localAiSettings
              .getByText(
                "Reliable matches are assigned automatically, and reusable tags are created for recurring topics.",
                { exact: true },
              )
              .waitFor();
            disabledStatus = await api("ai");
            assert.equal(disabledStatus.enabled, true);
            assert.equal(
              disabledStatus.taggingMode,
              "automatic",
              "Re-enabling smart features should retain automatic mode",
            );

            await modeControl.focus();
            await page.keyboard.press("Space");
            await page
              .getByRole("option", {
                name: "Review suggestions",
                exact: true,
              })
              .waitFor();
            await waitForModeOption("Automatic tagging", {
              selected: true,
            });
            await page.keyboard.press("ArrowUp");
            await waitForModeOption("Review suggestions");
            const manualModeResponsePromise = waitForAiModePatch();
            await page.keyboard.press("Enter");
            const manualModeResponse = await requireAiModePatch(
              manualModeResponsePromise,
            );
            assert.equal(manualModeResponse.status(), 200);
            await localAiSettings
              .getByText(
                "Review each suggestion before assigning it or creating a reusable tag.",
                { exact: true },
              )
              .waitFor();
            assert.equal(
              (await api("ai")).taggingMode,
              "manual",
              "The manual review mode should persist when selected by keyboard",
            );
          }
          await waitForWorkspaceApiIdle("tag-suggestion error state");
          assert.deepEqual(errors, []);
          console.log(
            `${name} ${width} ${theme}: tag-suggestion failure leaves smart-feature toggle usable`,
          );
        }
        if (cancelledSearchRequests.length)
          console.log(
            `${name} ${width} ${theme}: ${cancelledSearchRequests.length} superseded search request(s) canceled by the client`,
          );
        if (name === "chromium" && width === 320 && theme === "light")
          await runLiveSuggestionsRefresh();
      } catch (error) {
        contextRunError = error;
      } finally {
        try {
          await context.close();
        } catch (error) {
          contextCleanupErrors.push(error);
        }
        try {
          await cleanupFixture();
        } catch (error) {
          contextCleanupErrors.push(error);
        }
      }
      if (contextRunError) {
        if (contextCleanupErrors.length)
          console.error(
            "Browser fixture cleanup failures:",
            contextCleanupErrors.map((error) =>
              error instanceof Error ? error.message : String(error),
            ),
          );
        throw contextRunError;
      }
      if (contextCleanupErrors.length === 1) throw contextCleanupErrors[0];
      if (contextCleanupErrors.length)
        throw new AggregateError(
          contextCleanupErrors,
          "Browser fixture cleanup failed",
        );
    }
} catch (error) {
  primaryRunError = error;
} finally {
  const cleanupErrors = [];
  const cleanup = async (label, operation) => {
    try {
      await operation();
    } catch (error) {
      cleanupErrors.push(
        new Error(
          `${label}: ${error instanceof Error ? error.message : error}`,
        ),
      );
    }
  };

  await cleanup("Close browser", () => browser.close());
  await cleanup("Restore smart-feature settings", async () => {
    const currentAiStatus = await api("ai");
    if (
      currentAiStatus.enabled !== originalAiStatus.enabled ||
      currentAiStatus.taggingMode !== originalAiStatus.taggingMode
    )
      await api("ai", "PATCH", {
        enabled: originalAiStatus.enabled,
        revision: currentAiStatus.revision,
        taggingMode: originalAiStatus.taggingMode,
      });
  });
  await cleanup("Restore appearance", () =>
    api("settings", "PATCH", { theme: originalTheme }),
  );
  await cleanup("Dispose owner API context", () => owner.dispose());

  if (primaryRunError) {
    if (cleanupErrors.length)
      console.error(
        "Browser audit cleanup failures:",
        cleanupErrors.map((error) => error.message),
      );
    throw primaryRunError;
  }
  if (cleanupErrors.length)
    throw new AggregateError(cleanupErrors, "Browser audit cleanup failed");
}
