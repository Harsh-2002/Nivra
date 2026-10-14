import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, realpath } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, firefox, request, webkit } from "playwright";
import { classifyConsoleMessage } from "./browser-diagnostics.mjs";
import { installBrowserCspDiagnostics } from "./browser-csp-diagnostics.mjs";
import {
  installBrowserFetchDiagnostics,
  verifyWebKitFetchDiagnosticControls,
} from "./browser-fetch-diagnostics.mjs";
import verifyPlanning from "./browser-planning.mjs";

const base = process.env.NIVRA_BROWSER_TEST_URL ?? "http://localhost:3015";
const baseUrl = new URL(base);
assert.equal(baseUrl.protocol, "http:", "Use the local disposable HTTP server");
assert.equal(baseUrl.port, "3015", "Use the disposable server on port 3015");
assert.ok(
  ["localhost", "127.0.0.1", "::1"].includes(baseUrl.hostname),
  "Browser tests are restricted to localhost",
);

const sessionFile = process.env.NIVRA_BROWSER_SESSION;
assert.ok(
  sessionFile,
  "Set NIVRA_BROWSER_SESSION to a private temp session path",
);
const sessionPath = path.resolve(sessionFile);
assert.ok(
  sessionPath.startsWith("/tmp/nivra-foundations."),
  "Keep the synthetic owner session under /tmp/nivra-foundations.*",
);
const sessionDirectory = path.dirname(sessionPath);
assert.equal(path.dirname(sessionDirectory), "/tmp");
assert.ok(path.basename(sessionDirectory).startsWith("nivra-foundations."));
await mkdir(sessionDirectory, { recursive: true, mode: 0o700 });
await chmod(sessionDirectory, 0o700);
assert.ok(
  process.env.NIVRA_DATA_DIR,
  "Set NIVRA_DATA_DIR to the isolated disposable data directory",
);
const isolatedRoot = await realpath(sessionDirectory);
const dataDirectoryInput = path.resolve(process.env.NIVRA_DATA_DIR);
assert.equal(path.dirname(dataDirectoryInput), sessionDirectory);
assert.equal(path.basename(dataDirectoryInput), "data");
await mkdir(dataDirectoryInput, { recursive: true, mode: 0o700 });
const dataDirectory = await realpath(dataDirectoryInput);
assert.equal(
  dataDirectory,
  dataDirectoryInput,
  "NIVRA_DATA_DIR must not resolve through a symlink",
);
const dataRelativePath = path.relative(isolatedRoot, dataDirectory);
assert.ok(
  dataRelativePath &&
    !dataRelativePath.startsWith("..") &&
    !path.isAbsolute(dataRelativePath),
  "NIVRA_DATA_DIR must be inside the same /tmp/nivra-foundations.* run directory",
);
const engineName = process.env.NIVRA_AUDIT_ENGINE ?? "chromium";
const engines = { chromium, firefox, webkit };
assert.ok(engines[engineName], "Choose chromium, firefox, or webkit");

const stamp = randomUUID().replaceAll("-", "").slice(0, 10);
const password = `${randomUUID()}${randomUUID()}`;
const username = `review${stamp}`;
let owner;
const unauthenticated = await request.newContext({
  baseURL: base,
  extraHTTPHeaders: { origin: base },
  timeout: 15_000,
});
const setupStatusResponse = await unauthenticated.get("/api/v1/status");
assert.ok(
  setupStatusResponse.ok(),
  `Local server is not ready: ${setupStatusResponse.status()}`,
);
const setupStatus = await setupStatusResponse.json();
if (setupStatus.setup) {
  const setup = await unauthenticated.post("/api/v1/setup", {
    data: { name: "Review Owner", username, password },
  });
  assert.ok(setup.ok(), `Synthetic owner setup failed: ${setup.status()}`);
  const complete = await unauthenticated.patch("/api/v1/settings", {
    data: { onboardingStep: "complete" },
  });
  assert.ok(
    complete.ok(),
    `Could not finish synthetic onboarding: ${complete.status()}`,
  );
  await unauthenticated.storageState({ path: sessionPath });
  await chmod(sessionPath, 0o600);
  owner = unauthenticated;
} else {
  await unauthenticated.dispose();
  assert.ok(
    existsSync(sessionPath),
    "The existing Review Owner server requires its saved synthetic session",
  );
  owner = await request.newContext({
    baseURL: base,
    storageState: sessionPath,
    extraHTTPHeaders: { origin: base },
    timeout: 15_000,
  });
}

async function api(pathname, method = "GET", data) {
  const response = await owner.fetch(`/api/v1/${pathname}`, { method, data });
  const body = await response.json().catch(() => null);
  assert.ok(
    response.ok(),
    `${method} ${pathname.split("?")[0]} failed: ${response.status()} ${body?.error ?? ""}`,
  );
  return body;
}

const status = await api("status");
assert.equal(
  status.owner?.name,
  "Review Owner",
  "Only the synthetic Review Owner is allowed to run this suite",
);

const browser = await engines[engineName].launch();
const errors = [];
let fetchControl = {
  deferredCount: 0,
  notesPreviewAttempts: 0,
  journalAttempts: 0,
  calendarAttempts: 0,
  uncaughtControls: 0,
  strictConsoleControls: 0,
};
if (engineName === "webkit") {
  try {
    fetchControl = await verifyWebKitFetchDiagnosticControls(browser);
  } catch (error) {
    await browser.close();
    throw error;
  }
}
const context = await browser.newContext({
  storageState: sessionPath,
  serviceWorkers: "block",
  viewport: { width: 1440, height: 900 },
});
const page = await context.newPage();
page.setDefaultTimeout(15_000);
const cspDiagnostics = await installBrowserCspDiagnostics(page, {
  engine: engineName,
  origin: baseUrl.origin,
});
const fetchDiagnostics = await installBrowserFetchDiagnostics(page, {
  engine: engineName,
  origin: baseUrl.origin,
});
const unsupportedBrowserWarnings = [];
const pendingConsoleDetails = new Set();
let expectedNativeSelectCspWarningCount = 0;
let expectedNativeFetchCancellationCount = 0;
let cspDiagnosticsFinalized = false;
page.on(
  "pageerror",
  (error) =>
    fetchDiagnostics.deferPageError(error) ||
    errors.push(`pageerror at ${page.url()}: ${error.stack ?? error.message}`),
);
page.on("console", (message) => {
  if (
    cspDiagnostics.deferConsole({
      type: message.type(),
      text: message.text(),
      locationUrl: message.location().url,
    })
  )
    return;
  const classification = classifyConsoleMessage(
    engineName,
    message.type(),
    message.text(),
  );
  if (classification === "unsupported-feature-warning")
    unsupportedBrowserWarnings.push(message.text());
  else if (classification === "error") {
    const eventUrl = page.url();
    const errorIndex =
      errors.push(`console at ${eventUrl}: ${message.text()}`) - 1;
    const location = message.location();
    const detailPromise = Promise.all(
      message.args().map((handle) =>
        handle
          .evaluate((value) => {
            if (!value || typeof value !== "object")
              return { type: typeof value };
            const detail = {
              type: value.constructor?.name ?? "object",
            };
            try {
              if (typeof value.name === "string") detail.name = value.name;
              if (typeof value.message === "string")
                detail.message = value.message.slice(0, 300);
              if (typeof value.stack === "string")
                detail.stack = value.stack.split("\n").slice(0, 6).join("\n");
            } catch {}
            return detail;
          })
          .catch((error) => ({
            type: "unavailable",
            reason:
              error instanceof Error ? error.message.slice(0, 200) : "unknown",
          })),
      ),
    )
      .then((consoleArguments) => {
        errors[errorIndex] =
          `console at ${eventUrl}: ${JSON.stringify({ text: message.text(), location, arguments: consoleArguments })}`;
      })
      .catch(() => {});
    pendingConsoleDetails.add(detailPromise);
    void detailPromise.finally(() =>
      pendingConsoleDetails.delete(detailPromise),
    );
  }
});

const owned = { tasks: [], bookmarks: [], notes: [] };
const checks = [];
function check(condition, label) {
  assert.ok(condition, label);
  checks.push(label);
}

async function finalizeCspDiagnostics() {
  await cspDiagnostics.flush();
  await fetchDiagnostics.flush();
  await context.close().catch(() => {});
  if (cspDiagnosticsFinalized) return;
  const result = cspDiagnostics.result();
  const fetchResult = fetchDiagnostics.result();
  errors.push(...result.errors);
  errors.push(...fetchResult.errors);
  expectedNativeSelectCspWarningCount += result.matchedCount;
  if (fetchResult.deferredCount > 0)
    expectedNativeFetchCancellationCount += fetchResult.deferredCount;
  cspDiagnosticsFinalized = true;
}

async function waitForSettledBounds(locator, expectedViewport, timeout = 1500) {
  const deadline = Date.now() + timeout;
  let bounds = null;
  let viewport = null;
  let previous = null;
  let stableSamples = 0;
  while (Date.now() < deadline) {
    bounds = await locator.boundingBox();
    viewport = await page.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
    }));
    if (
      bounds &&
      viewport.width === expectedViewport.width &&
      viewport.height === expectedViewport.height
    ) {
      const stable =
        previous &&
        bounds.x === previous.x &&
        bounds.y === previous.y &&
        bounds.width === previous.width &&
        bounds.height === previous.height;
      stableSamples = stable ? stableSamples + 1 : 0;
      if (stableSamples >= 2)
        return { bounds, viewport, stable: true, stableSamples };
      previous = bounds;
    } else {
      previous = null;
      stableSamples = 0;
    }
    await page.waitForTimeout(40);
  }
  return { bounds, viewport, stable: false, stableSamples };
}

async function openBookmarks() {
  if (new URL(page.url()).pathname !== "/bookmarks") {
    await navigateSection("bookmarks", "Bookmarks");
  }
  await page.locator(".bookmark-toolbar").waitFor();
}

async function navigateSection(section, label) {
  if (new URL(page.url()).pathname === `/${section}`) return;
  await page.keyboard.press("Escape");
  const navigation = page.getByRole("button", {
    name: "Open navigation",
    exact: true,
  });
  if (await navigation.isVisible()) await navigation.click();
  await page
    .getByRole("navigation", { name: "Workspace navigation" })
    .getByRole("button", { name: label, exact: true })
    .click();
  await page.waitForURL((url) => url.pathname === `/${section}`);
}

async function verifyBookmarkOpenAndReadState(bookmark, width) {
  const height = width === 390 ? 844 : 900;
  await page.setViewportSize({ width, height });
  await openBookmarks();
  const card = page
    .locator(".bookmark-card")
    .filter({ hasText: bookmark.title });
  await card.waitFor();
  const originalLink = card.locator("a.bookmark-link");
  assert.equal(await originalLink.getAttribute("target"), "_blank");
  assert.match(await originalLink.getAttribute("rel"), /noopener/);
  await context.route("https://example.invalid/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Local bookmark target</title>",
    }),
  );
  const popupPromise = page.waitForEvent("popup");
  await originalLink.click();
  const popup = await popupPromise;
  await popup.waitForLoadState("domcontentloaded");
  assert.equal(popup.url(), bookmark.url);
  await popup.close();
  await context.unroute("https://example.invalid/**");
  assert.equal(await page.getByRole("dialog").count(), 0);

  const changeReadState = async (read) => {
    const responsePromise = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/v1/bookmarks/read-state" &&
        response.request().method() === "POST",
    );
    await card
      .getByRole("button", { name: `Actions for ${bookmark.title}` })
      .click();
    await page
      .getByRole("menuitem", { name: `Mark ${read ? "read" : "unread"}` })
      .click();
    const response = await responsePromise;
    assert.ok(
      response.ok(),
      `Bookmark read-state update failed: ${response.status()}`,
    );
    bookmark = await api(`bookmarks/${bookmark.id}`);
    assert.equal(bookmark.readAt !== null, read);
    check(
      true,
      `${width}px bookmark ${read ? "read" : "unread"} state persists`,
    );
  };

  if (bookmark.readAt !== null) await changeReadState(false);
  await changeReadState(true);
  await changeReadState(false);
}

async function verifyBookmarkFilters(width) {
  await page.setViewportSize({ width, height: width <= 390 ? 844 : 900 });
  await openBookmarks();
  const toolbar = page.locator(".bookmark-toolbar");
  await toolbar.waitFor();
  const measurements = await toolbar.evaluate((root) =>
    [
      ...root.querySelectorAll(
        ".bookmark-filters button[aria-pressed], .bookmark-filters [data-slot='select-trigger']",
      ),
    ].map((control) => {
      const value =
        control.querySelector("[data-slot='select-value']") ?? control;
      const rect = control.getBoundingClientRect();
      const valueRect = value.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(value);
      const textRect = range.getBoundingClientRect();
      return {
        label:
          control.getAttribute("aria-label") ||
          control.textContent?.trim() ||
          "bookmark filter",
        width: rect.width,
        height: rect.height,
        valueWidth: valueRect.width,
        textWidth: textRect.width,
        textLeft: textRect.left,
        textRight: textRect.right,
        left: rect.left,
        right: rect.right,
        isSelect: control.matches("[data-slot='select-trigger']"),
        valueScrollWidth: value.scrollWidth,
        valueClientWidth: value.clientWidth,
      };
    }),
  );
  assert.equal(
    measurements.length,
    3,
    `${width}px bookmark toolbar should expose Favorites and both filters`,
  );
  for (const item of measurements) {
    check(
      item.width > 0 && item.height > 0 && item.textWidth > 0,
      `${width}px ${item.label} filter label has measurable visible space`,
    );
    check(
      item.textLeft >= item.left + 3 &&
        item.textRight <= item.right - (item.isSelect ? 24 : 3) &&
        item.valueScrollWidth <= item.valueClientWidth + 1,
      `${width}px ${item.label} filter label fits without clipping`,
    );
    if (width < 768)
      check(
        item.height >= 44,
        `${width}px ${item.label} filter control meets the touch target`,
      );
  }
  check(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    `${width}px bookmark filters do not overflow horizontally`,
  );
}

async function verifyQuickCapture(width) {
  const height = width === 390 ? 844 : 900;
  const title = `Foundation capture ${width} ${stamp}`;
  await page.setViewportSize({ width, height });
  await navigateSection("overview", "Overview");
  await page.locator(".overview-grid").waitFor();
  await page.getByRole("button", { name: "Add task", exact: true }).waitFor();
  await page.keyboard.press("Control+Shift+Enter");
  const capture = page.getByRole("dialog", { name: "Quick", exact: true });
  const input = capture.getByRole("textbox", {
    name: "Quick text",
    exact: true,
  });
  await input.waitFor();
  check(
    await input.evaluate((element) => element === document.activeElement),
    `${width}px Quick capture opens focused`,
  );
  await input.fill(`${title}\nSaved through the disposable foundation runner.`);
  if (width < 768) {
    const settled = await waitForSettledBounds(capture, { width, height });
    const bounds = settled.bounds;
    check(
      settled.stable &&
        !!bounds &&
        bounds.x >= 0 &&
        bounds.y >= 0 &&
        bounds.x + bounds.width <= width &&
        bounds.y + bounds.height <= height,
      `Mobile Quick capture stays within the viewport after layout settles (${JSON.stringify(settled)})`,
    );
    const buttons = await capture
      .locator("button:visible")
      .evaluateAll((nodes) =>
        nodes.map((node) => {
          const rect = node.getBoundingClientRect();
          return { width: rect.width, height: rect.height };
        }),
      );
    check(
      buttons.every((button) => button.width >= 44 && button.height >= 44),
      "Mobile Quick capture buttons meet 44px touch targets",
    );
  }
  await capture.getByRole("button", { name: "Save note", exact: true }).click();
  await capture.waitFor({ state: "hidden" });
  let results = [];
  for (let attempt = 0; attempt < 20; attempt++) {
    const resultPage = await api(`search?q=${encodeURIComponent(title)}`);
    results = resultPage.items;
    if (results.some((item) => item.title === title && item.type === "note"))
      break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const result = results.find(
    (item) => item.title === title && item.type === "note",
  );
  check(!!result, `${width}px Quick note is searchable after saving`);
  if (result) owned.notes.push(result.id);
}

async function verifyCapturePage() {
  const width = 320;
  await page.setViewportSize({ width, height: 780 });
  await page.goto(`${base}/capture`);
  await page.getByRole("heading", { name: "Capture", exact: true }).waitFor();
  const urlField = page.getByRole("textbox", { name: "Link", exact: true });
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page
    .getByRole("alert")
    .filter({ hasText: "complete HTTP or HTTPS link" })
    .waitFor();
  const invalidState = await urlField.evaluate((element) => {
    const style = getComputedStyle(element);
    const normalFieldStyle = getComputedStyle(
      document.getElementById("capture-title"),
    );
    return {
      invalid: element.getAttribute("aria-invalid"),
      describedBy: element.getAttribute("aria-describedby"),
      focused: element === document.activeElement,
      borderColor: style.borderColor,
      normalBorderColor: normalFieldStyle.borderColor,
      borderWidth: style.borderWidth,
    };
  });
  check(
    invalidState.invalid === "true" &&
      invalidState.describedBy === "capture-error" &&
      invalidState.focused &&
      invalidState.borderColor !== invalidState.normalBorderColor &&
      Number.parseFloat(invalidState.borderWidth) > 0,
    "Capture validation focuses the invalid field with an accessible visible error state",
  );
  check(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    "Capture form fits a 320px viewport",
  );
  const touchTargets = await page
    .locator(
      ".capture-page button:visible, .capture-page [role=combobox]:visible",
    )
    .evaluateAll((nodes) =>
      nodes.map((node) => {
        const bounds = node.getBoundingClientRect();
        return { width: bounds.width, height: bounds.height };
      }),
    );
  check(
    touchTargets.every((target) => target.width >= 44 && target.height >= 44),
    "Capture primary controls meet mobile touch target sizes at 320px",
  );

  const stamp = randomUUID().replaceAll("-", "").slice(0, 10);
  const title = `Capture passage ${stamp}`;
  const sourceUrl = `https://example.test/articles/capture-${stamp}`;
  const passage = "Inspect the north handle after the second cold test.";
  const draftTitle = `Keep this draft ${stamp}`;
  const draftUrl = `https://example.test/articles/draft-${stamp}`;
  const draftPassage = `A draft that must survive replacement ${stamp}.`;
  const fields = new URLSearchParams({
    title,
    text: passage,
    url: sourceUrl,
  });
  const draftFields = new URLSearchParams({
    title: draftTitle,
    text: draftPassage,
    url: draftUrl,
  });
  const capturePosts = [];
  const capturePayloads = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname === "/api/v1/capture"
    ) {
      capturePosts.push(request.url());
      capturePayloads.push(request.postDataJSON());
    }
  });
  await page.setViewportSize({ width: 390, height: 844 });
  const titleField = page.getByRole("textbox", {
    name: "Title (optional)",
    exact: true,
  });
  const passageField = page.getByRole("textbox", {
    name: "Selected passage (optional)",
    exact: true,
  });
  const urlFieldForReplacement = page.getByRole("textbox", {
    name: "Link",
    exact: true,
  });
  await page.evaluate((fragment) => {
    location.hash = fragment;
  }, draftFields.toString());
  await titleField.waitFor();
  await passageField.waitFor();
  await page.waitForFunction(() => location.hash === "");
  await page.waitForFunction(
    ({ expectedTitle, expectedPassage, expectedUrl }) =>
      document.getElementById("capture-title")?.value === expectedTitle &&
      document.getElementById("capture-text")?.value === expectedPassage &&
      document.getElementById("capture-url")?.value === expectedUrl,
    {
      expectedTitle: draftTitle,
      expectedPassage: draftPassage,
      expectedUrl: draftUrl,
    },
  );
  assert.equal(await titleField.inputValue(), draftTitle);
  assert.equal(await passageField.inputValue(), draftPassage);
  assert.equal(await urlFieldForReplacement.inputValue(), draftUrl);
  assert.equal(
    await page.getByRole("combobox").innerText(),
    "Bookmark",
    "Shared content with a source URL defaults to bookmark capture",
  );
  await titleField.fill(`${draftTitle} edited`);
  await urlFieldForReplacement.fill(`${draftUrl}/edited`);
  await passageField.fill(`${draftPassage} Keep these edits.`);
  await page.evaluate((fragment) => {
    location.hash = fragment;
  }, fields.toString());
  const replaceDialog = page.getByRole("alertdialog");
  await replaceDialog
    .getByRole("heading", { name: "Replace this capture?" })
    .waitFor();
  await page.waitForFunction(() => location.hash === "");
  await replaceDialog.getByRole("button", { name: "Cancel" }).click();
  assert.equal(await titleField.inputValue(), `${draftTitle} edited`);
  assert.equal(await urlFieldForReplacement.inputValue(), `${draftUrl}/edited`);
  assert.equal(
    await passageField.inputValue(),
    `${draftPassage} Keep these edits.`,
  );
  assert.equal(
    capturePosts.length,
    0,
    "Rejecting replacement must preserve the draft without saving it",
  );
  check(
    true,
    "Rejecting shared-content replacement preserves the current draft",
  );

  await urlFieldForReplacement.fill("not a valid link");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page
    .getByRole("alert")
    .filter({ hasText: "complete HTTP or HTTPS link" })
    .waitFor();
  assert.equal(
    await urlFieldForReplacement.getAttribute("aria-invalid"),
    "true",
    "The replacement scenario starts with an invalid field",
  );
  await page.evaluate((fragment) => {
    location.hash = fragment;
  }, fields.toString());
  const secondReplaceDialog = page.getByRole("alertdialog");
  await secondReplaceDialog
    .getByRole("heading", { name: "Replace this capture?" })
    .waitFor();
  await page.waitForFunction(() => location.hash === "");
  await secondReplaceDialog.getByRole("button", { name: "Replace" }).click();
  await page.waitForFunction(
    ({ expectedTitle, expectedPassage, expectedUrl }) =>
      document.getElementById("capture-title")?.value === expectedTitle &&
      document.getElementById("capture-text")?.value === expectedPassage &&
      document.getElementById("capture-url")?.value === expectedUrl,
    { expectedTitle: title, expectedPassage: passage, expectedUrl: sourceUrl },
  );
  await page.waitForFunction(() => location.hash === "");
  assert.equal(await titleField.getAttribute("aria-invalid"), "false");
  assert.equal(
    await urlFieldForReplacement.getAttribute("aria-invalid"),
    "false",
  );
  assert.equal(await passageField.getAttribute("aria-invalid"), "false");
  assert.equal(
    await page.locator("#capture-error").count(),
    0,
    "Accepted replacement should clear the capture validation error",
  );
  assert.equal(
    capturePosts.length,
    0,
    "Accepting replacement must not save until the owner explicitly submits",
  );
  check(
    true,
    "Accepting replacement consumes the fragment, resets validation, and waits for explicit save",
  );
  let releaseCaptureRequest;
  let markCaptureRequestStarted;
  const captureRequestStarted = new Promise((resolve) => {
    markCaptureRequestStarted = resolve;
  });
  const captureRequestGate = new Promise((resolve) => {
    releaseCaptureRequest = resolve;
  });
  const captureRoute = "**/api/v1/capture";
  await page.route(captureRoute, async (route) => {
    markCaptureRequestStarted();
    await captureRequestGate;
    await route.continue();
  });
  const saveResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      response.request().method() === "POST" &&
      url.pathname === "/api/v1/capture"
    );
  });
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await captureRequestStarted;
  await page.getByRole("button", { name: "Saving…", exact: true }).waitFor();
  const whileSavingFields = new URLSearchParams({
    title: `Do not replace while saving ${stamp}`,
    text: "A share that arrives while the save is in flight.",
    url: `https://example.test/articles/busy-${stamp}`,
  });
  await page.evaluate((fragment) => {
    location.hash = fragment;
  }, whileSavingFields.toString());
  await page
    .getByRole("alert")
    .filter({ hasText: "Finish saving this capture" })
    .waitFor();
  await page.waitForFunction(() => location.hash === "");
  assert.equal(await titleField.inputValue(), title);
  assert.equal(await passageField.inputValue(), passage);
  assert.equal(await urlFieldForReplacement.inputValue(), sourceUrl);
  assert.equal(
    await page.getByRole("alertdialog").count(),
    0,
    "A shared link must not replace a draft while capture is saving",
  );
  check(
    true,
    "A share arriving during save is consumed safely without replacing the in-flight capture",
  );
  releaseCaptureRequest();
  const completedSaveResponse = await saveResponse;
  assert.ok(completedSaveResponse.ok());
  await page.unroute(captureRoute);
  await page
    .getByRole("status")
    .filter({ hasText: "Capture saved. Your passage is saved as a note." })
    .waitFor();
  assert.equal(capturePosts.length, 1);
  assert.deepEqual(capturePayloads, [
    {
      type: "bookmark",
      title,
      text: passage,
      url: sourceUrl,
      collection: "",
    },
  ]);
  assert.equal(await titleField.inputValue(), title);
  assert.equal(await passageField.inputValue(), passage);
  assert.equal(await urlFieldForReplacement.inputValue(), sourceUrl);
  const bookmarks = await api(
    `bookmarks?limit=100&q=${encodeURIComponent(title)}`,
  );
  const bookmark = bookmarks.items.find((item) => item.url === sourceUrl);
  check(!!bookmark, "Shared capture creates the canonical bookmark");
  if (!bookmark) return;
  owned.bookmarks.push(bookmark.id);

  const duplicatePayload = {
    type: "bookmark",
    title,
    text: passage,
    url: sourceUrl,
    collection: "",
  };
  const retryKey = randomUUID();
  async function captureRetry() {
    const response = await owner.fetch("/api/v1/capture", {
      method: "POST",
      headers: { "Idempotency-Key": retryKey },
      data: duplicatePayload,
    });
    const result = await response.json();
    assert.ok(response.ok(), `Idempotent capture failed: ${response.status()}`);
    return result;
  }
  const firstDuplicate = await captureRetry();
  const retriedDuplicate = await captureRetry();
  assert.equal(firstDuplicate.id, bookmark.id);
  assert.equal(firstDuplicate.type, "bookmark");
  assert.equal(firstDuplicate.alreadySaved, true);
  assert.ok(firstDuplicate.noteId);
  assert.deepEqual(retriedDuplicate, firstDuplicate);
  owned.notes.push(firstDuplicate.noteId);
  const oneBookmark = await api(
    `bookmarks?limit=100&q=${encodeURIComponent(title)}`,
  );
  check(
    oneBookmark.items.filter((item) => item.url === sourceUrl).length === 1,
    "Duplicate capture reuses one bookmark and an identical retry replays its result",
  );

  await page
    .getByRole("button", { name: "Open saved passage", exact: true })
    .click();
  await page.waitForURL(
    (url) => url.pathname === "/notes" && url.searchParams.has("note"),
  );
  const capturedNoteId = new URL(page.url()).searchParams.get("note");
  assert.ok(capturedNoteId);
  owned.notes.push(capturedNoteId);
  const capturedPassageTitle = page.getByRole("textbox", {
    name: "Note title",
    exact: true,
  });
  const capturedPassageEditor = page.locator('[aria-label="Note content"]');
  await capturedPassageTitle.waitFor();
  await capturedPassageEditor.waitFor();
  assert.ok(
    (await capturedPassageEditor.innerText()).includes(passage),
    "The selected passage is visible in the canonical note editor",
  );
  const capturedNote = await api(`notes/${capturedNoteId}`);
  const serializedNote = JSON.stringify(capturedNote.document);
  check(
    serializedNote.includes(passage) &&
      serializedNote.includes(`Source: ${sourceUrl}`),
    "Selected passage opens its canonical note URL with the source link preserved",
  );

  const noteTitle = `Captured thought ${stamp}`;
  await page.goto(`${base}/capture`);
  const type = page.getByRole("combobox");
  await type.click();
  await page.getByRole("option", { name: "Note", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Title (optional)", exact: true })
    .fill(noteTitle);
  await page
    .getByRole("textbox", { name: "Text", exact: true })
    .fill("A thought saved through the capture form.");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByText("Capture saved.", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Open note", exact: true }).click();
  await page.waitForURL(
    (url) => url.pathname === "/notes" && url.searchParams.has("note"),
  );
  const noteId = new URL(page.url()).searchParams.get("note");
  assert.ok(noteId);
  owned.notes.push(noteId);
  const openedNoteTitle = page.getByRole("textbox", {
    name: "Note title",
    exact: true,
  });
  const openedNoteEditor = page.locator('[aria-label="Note content"]');
  await openedNoteTitle.waitFor();
  await openedNoteEditor.waitFor();
  assert.equal(await openedNoteTitle.inputValue(), noteTitle);
  assert.ok(
    (await openedNoteEditor.innerText()).includes(
      "A thought saved through the capture form.",
    ),
    "The captured thought is visible in the canonical note editor",
  );
  assert.equal((await api(`notes/${noteId}`)).title, noteTitle);
  check(true, "Note capture creates and opens its canonical editor");

  const taskTitle = `Captured action ${stamp}`;
  await page.goto(`${base}/capture`);
  await page.getByRole("combobox").click();
  await page.getByRole("option", { name: "Task", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Task", exact: true })
    .fill(taskTitle);
  check(
    (await page.getByRole("textbox", { name: "Task", exact: true }).count()) ===
      1 &&
      (await page
        .getByRole("textbox", { name: "Text", exact: true })
        .count()) === 0,
    "Task capture exposes a single action field without note text controls",
  );
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByText("Capture saved.", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Open task", exact: true }).click();
  await page.waitForURL(
    (url) => url.pathname === "/tasks" && url.searchParams.has("task"),
  );
  const taskId = new URL(page.url()).searchParams.get("task");
  assert.ok(taskId);
  owned.tasks.push(taskId);
  const taskDetails = page.getByRole("dialog", {
    name: "Task details",
    exact: true,
  });
  await taskDetails.waitFor();
  await taskDetails.locator(".task-details-title").waitFor();
  assert.equal(
    await taskDetails.locator(".task-details-title").innerText(),
    taskTitle,
    "The created task is visible in its canonical details dialog",
  );
  assert.equal((await api(`tasks/${taskId}`)).title, taskTitle);
  check(true, "Task capture creates and opens its canonical details");
}

async function runWritingHarness() {
  await new Promise((resolve, reject) => {
    const script = fileURLToPath(
      new URL("./browser-writing.mjs", import.meta.url),
    );
    const child = spawn(process.execPath, [script], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NIVRA_BROWSER_TEST_URL: base,
        NIVRA_BROWSER_SESSION: sessionPath,
        NIVRA_AUDIT_ENGINE: engineName,
        NIVRA_AUDIT_WIDTHS: "390,1440",
      },
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `Writing harness failed${signal ? ` (${signal})` : ` with exit code ${code}`}`,
          ),
        );
    });
  });
}

try {
  await page.goto(`${base}/tasks`);
  await page.locator(".tasks-panel").waitFor();
  const planning = await verifyPlanning(page);
  check(planning.passed.length > 0, "Planning UI workflow passed");

  const createdBookmark = await api("bookmarks", "POST", {
    url: `https://example.invalid/foundations-${stamp}`,
    collection: "Foundations",
  });
  const bookmark = await api(`bookmarks/${createdBookmark.id}`, "PATCH", {
    revision: createdBookmark.revision,
    title: `Foundation link ${stamp}`,
  });
  owned.bookmarks.push(bookmark.id);
  await verifyBookmarkFilters(320);
  await verifyBookmarkFilters(390);
  await verifyBookmarkFilters(1440);
  await verifyBookmarkOpenAndReadState(bookmark, 390);
  await verifyBookmarkOpenAndReadState(bookmark, 1440);

  await verifyCapturePage();
  await verifyQuickCapture(1440);
  await verifyQuickCapture(390);
  await Promise.all(pendingConsoleDetails);
  await finalizeCspDiagnostics();
  await browser.close();

  assert.deepEqual(errors, [], "Planning/bookmark/capture browser errors");
  await runWritingHarness();

  console.log(
    `Foundations browser checks passed: ${checks.length} wrapper assertions; planning ${planning.passed.length} checks; Review Owner only; localhost:${baseUrl.port}; unsupported WebKit viewport warnings: ${unsupportedBrowserWarnings.length}.`,
  );
  console.log(
    `Matched trusted WebKit native-select CSP diagnostics: ${expectedNativeSelectCspWarningCount}.`,
  );
  if (engineName === "webkit")
    console.log(
      `WebKit fetch diagnostics: ${expectedNativeFetchCancellationCount} narrowly matched app pageerrors; control ${fetchControl.deferredCount} native cancellations (notes preview after ${fetchControl.notesPreviewAttempts} attempt(s), journal list after ${fetchControl.journalAttempts}, calendar range after ${fetchControl.calendarAttempts}), ${fetchControl.uncaughtControls} uncaught-event cases, ${fetchControl.strictConsoleControls} strict console cases.`,
    );
} finally {
  await finalizeCspDiagnostics().catch((error) =>
    errors.push(
      `CSP diagnostic flush failed: ${error instanceof Error ? error.message : "unknown error"}`,
    ),
  );
  await context.close().catch(() => {});
  await browser.close().catch(() => {});
  for (const id of owned.notes) {
    try {
      const note = await api(`notes/${id}`);
      await api(`notes/${id}`, "DELETE", { revision: note.revision });
    } catch {}
  }
  for (const id of owned.tasks) {
    try {
      const task = await api(`tasks/${id}`);
      await api(`tasks/${id}`, "DELETE", { revision: task.revision });
    } catch {}
  }
  for (const id of owned.bookmarks) {
    try {
      const bookmark = await api(`bookmarks/${id}`);
      await api(`bookmarks/${id}`, "DELETE", { revision: bookmark.revision });
    } catch {}
  }
  await owner.dispose();
}
