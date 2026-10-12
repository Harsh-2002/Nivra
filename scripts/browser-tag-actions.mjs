import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
import { chromium, firefox, webkit, request } from "playwright";

const base = process.env.NIVRA_BROWSER_TEST_URL ?? "http://localhost:3015";
assert.equal(new URL(base).port, "3015", "Use the disposable test server");
assert.ok(process.env.NIVRA_BROWSER_SESSION, "Synthetic session required");
const owner = await request.newContext({
  baseURL: base,
  ...(existsSync(process.env.NIVRA_BROWSER_SESSION)
    ? { storageState: process.env.NIVRA_BROWSER_SESSION }
    : {}),
  extraHTTPHeaders: { origin: base, "content-type": "application/json" },
});
async function api(path, method = "GET", data) {
  const response = await owner.fetch(`/api/v1/${path}`, { method, data });
  assert.ok(response.ok(), `${method} ${path}: ${response.status()}`);
  return response.json();
}
async function publicHealthHTTPStatus() {
  let healthClient;
  try {
    healthClient = await request.newContext({ timeout: 2500 });
    const response = await healthClient.get(new URL("/health", base).href);
    return response.status();
  } catch {
    return null;
  } finally {
    if (healthClient) await healthClient.dispose().catch(() => {});
  }
}
if ((await api("status")).setup) {
  await api("setup", "POST", {
    name: "Tag actions test",
    username: "tag_actions_test",
    password: `Tag-${randomUUID()}`,
  });
  await api("settings", "PATCH", { onboardingStep: "complete" });
  await owner.storageState({ path: process.env.NIVRA_BROWSER_SESSION });
  await chmod(process.env.NIVRA_BROWSER_SESSION, 0o600);
}
assert.match((await api("status")).owner?.name ?? "", /review|audit|test/i);
const originalTheme = (await api("settings")).theme;
const engines = { chromium, firefox, webkit };
const engine = process.env.NIVRA_AUDIT_ENGINE ?? "chromium";
assert.ok(engines[engine], "Supported browser engine required");
const browser = await engines[engine].launch();
try {
  for (const width of (process.env.NIVRA_AUDIT_WIDTHS ?? "390,768,1440")
    .split(",")
    .map(Number)) {
    for (const colorScheme of ["light", "dark"]) {
      const updatedSettings = await api("settings", "PATCH", {
        theme: colorScheme,
      });
      assert.equal(updatedSettings.theme, colorScheme);
      const context = await browser.newContext({
        storageState: process.env.NIVRA_BROWSER_SESSION,
        viewport: { width, height: 900 },
        hasTouch: width < 1024,
        colorScheme,
        serviceWorkers: "block",
      });
      const page = await context.newPage();
      const errors = [];
      const lifecycleEvents = [];
      const recordLifecycleEvent = (event) =>
        lifecycleEvents.push({ event, at: new Date().toISOString() });
      const onPageCrash = () => recordLifecycleEvent("page-crash");
      const onPageClose = () => recordLifecycleEvent("page-close");
      const onContextClose = () => recordLifecycleEvent("context-close");
      const onBrowserDisconnected = () =>
        recordLifecycleEvent("browser-disconnected");
      page.on("crash", onPageCrash);
      page.on("close", onPageClose);
      context.on("close", onContextClose);
      browser.on("disconnected", onBrowserDisconnected);
      page.on("pageerror", (e) => errors.push(e.message));
      const tag = await api("tags", "POST", {
        name: `Tag test ${randomUUID().slice(0, 8)}`,
        color: "gray",
      });
      await page.route(`**/api/v1/tags/${tag.id}`, async (route) => {
        if (route.request().method() === "DELETE" && colorScheme === "dark")
          await setTimeout(350);
        await route.continue();
      });
      const task = await api("tasks", "POST", {
        title: `Retained task ${randomUUID().slice(0, 8)}`,
      });
      const state = await api(`item-tags/task/${task.id}`);
      await api(`item-tags/task/${task.id}`, "PATCH", {
        revision: state.revision,
        tags: [tag.id],
      });
      async function navigation() {
        if (width < 1024) {
          await page
            .getByRole("button", { name: "Open navigation", exact: true })
            .first()
            .click();
          return page.getByRole("dialog", { name: "Navigation", exact: true });
        }
        return page.locator(".desktop-navigation");
      }
      async function menu(action) {
        const nav = await navigation();
        await nav
          .getByRole("button", { name: `Actions for ${tag.name}`, exact: true })
          .click();
        await page.getByRole("menuitem", { name: action, exact: true }).click();
      }
      async function onlyDialog(role) {
        const dialog = page.locator(`[role="${role}"][data-state="open"]`);
        await dialog.waitFor();
        if (width < 1024)
          await page
            .getByRole("dialog", { name: "Navigation", exact: true })
            .waitFor({ state: "hidden" });
        assert.equal(
          await page
            .locator(
              '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]',
            )
            .count(),
          1,
        );
        return dialog;
      }
      async function restoredFocus() {
        if (width < 1024)
          await page.waitForFunction(
            () =>
              document.activeElement?.getAttribute("aria-label") ===
              "Open navigation",
          );
      }
      try {
        await page.goto(`${base}/overview`, { waitUntil: "domcontentloaded" });
        await page.waitForFunction(
          (expectedTheme) =>
            document.documentElement.classList.contains("dark") ===
            (expectedTheme === "dark"),
          colorScheme,
        );
        assert.equal(
          await page.evaluate(() =>
            document.documentElement.classList.contains("dark"),
          ),
          colorScheme === "dark",
          `${engine} ${width} ${colorScheme}: rendered theme must match the test case`,
        );
        await menu("Delete tag");
        await (
          await onlyDialog("alertdialog")
        )
          .getByRole("button", { name: "Cancel", exact: true })
          .click();
        await restoredFocus();
        assert.ok((await api("tags")).items.some((item) => item.id === tag.id));
        await menu("Edit tag");
        const edit = await onlyDialog("dialog");
        assert.equal(
          await edit.getByRole("textbox", { name: "Tag name" }).inputValue(),
          tag.name,
        );
        await page.keyboard.press("Escape");
        await restoredFocus();
        const nav = await navigation();
        await nav
          .getByRole("button", { name: "Create tag", exact: true })
          .click();
        const create = await onlyDialog("dialog");
        await create
          .getByRole("textbox", { name: "Tag name" })
          .fill("Draft only");
        await page.keyboard.press("Escape");
        await restoredFocus();
        await (
          await navigation()
        )
          .getByRole("button", { name: tag.name, exact: true })
          .click();
        await page.waitForURL((url) => url.searchParams.get("tag") === tag.id);
        await page
          .getByRole("heading", { name: tag.name, exact: true })
          .waitFor();
        await menu("Delete tag");
        const confirm = await onlyDialog("alertdialog");
        await confirm
          .getByRole("button", { name: "Cancel", exact: true })
          .focus();
        await page.keyboard.press("Shift+Tab");
        assert.ok(
          await page.evaluate(
            () => !!document.activeElement?.closest('[role="alertdialog"]'),
          ),
        );
        await confirm
          .getByRole("button", { name: "Delete tag", exact: true })
          .click();
        await page.waitForURL((url) => !url.searchParams.has("tag"));
        await page.getByRole("alertdialog").waitFor({ state: "hidden" });
        await restoredFocus();
        assert.ok(
          !(await api("tags")).items.some((item) => item.id === tag.id),
        );
        const retained = await api(`tasks/${task.id}`);
        assert.equal(retained.title, task.title);
        assert.equal((await api(`item-tags/task/${task.id}`)).tags.length, 0);
        assert.deepEqual(errors, []);
        assert.equal(
          await page.evaluate(
            () => document.documentElement.scrollWidth > innerWidth + 1,
          ),
          false,
        );
        console.log(
          `${engine} ${width} ${colorScheme}: tag create/edit/cancel/delete/focus/content preservation passed`,
        );
      } catch (error) {
        console.error(
          `${engine} ${width} ${colorScheme}: UI interaction failed`,
        );
        console.error(error);
        console.error(
          JSON.stringify({
            diagnostic: "browser-lifecycle",
            capturedAt: new Date().toISOString(),
            engine,
            viewportWidth: width,
            colorScheme,
            browserConnected: browser.isConnected(),
            pageClosed: page.isClosed(),
            lifecycleEvents,
            publicHealthHTTPStatus: await publicHealthHTTPStatus(),
          }),
        );
        throw error;
      } finally {
        page.off("crash", onPageCrash);
        page.off("close", onPageClose);
        context.off("close", onContextClose);
        browser.off("disconnected", onBrowserDisconnected);
        await context.close();
        const remaining = await api("tags");
        if (remaining.items.some((item) => item.id === tag.id))
          await api(`tags/${tag.id}`, "DELETE");
        const retained = await api(`tasks/${task.id}`);
        await api(`tasks/${task.id}`, "DELETE", {
          revision: retained.revision,
        });
      }
    }
  }
} finally {
  try {
    await browser.close();
  } finally {
    try {
      await api("settings", "PATCH", { theme: originalTheme });
    } finally {
      await owner.dispose();
    }
  }
}
