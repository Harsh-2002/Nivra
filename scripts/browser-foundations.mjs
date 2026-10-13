import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, realpath } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, firefox, request, webkit } from "playwright";
import { classifyConsoleMessage } from "./browser-diagnostics.mjs";
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

async function seedBookmarkReader() {
  const script = fileURLToPath(
    new URL("./seed-foundations-reader.ts", import.meta.url),
  );
  const { output } = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", script], {
      cwd: process.cwd(),
      env: { ...process.env, NIVRA_DATA_DIR: dataDirectory },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let errorOutput = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => (output += chunk));
    child.stderr
      .setEncoding("utf8")
      .on("data", (chunk) => (errorOutput += chunk));
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve({ output });
      else
        reject(
          new Error(
            `Reader fixture seeder failed${signal ? ` (${signal})` : ` with exit code ${code}`}: ${errorOutput.trim()}`,
          ),
        );
    });
  });
  const fixture = JSON.parse(output.trim());
  assert.equal(fixture.schemaVersion, 1);
  assert.equal(fixture.currentVersion, 2);
  assert.equal(fixture.bookmark?.id, fixture.bookmarkId);
  assert.equal(new URL(fixture.url).hostname, "example.test");
  assert.ok(fixture.olderVersionText && fixture.articleText);
  assert.ok(fixture.selectionQuote && fixture.highlightQuote);
  assert.ok(fixture.highlights.some((item) => item.articleVersion === 1));
  assert.ok(fixture.highlights.some((item) => item.articleVersion === 2));
  assert.equal(
    path.resolve(fixture.manifestPath),
    path.join(dataDirectory, "browser-reader-fixture.json"),
    "Fixture manifest must stay in the isolated app data directory",
  );
  return fixture;
}

const readerFixture = await seedBookmarkReader();

const browser = await engines[engineName].launch();
const errors = [];
const context = await browser.newContext({
  storageState: sessionPath,
  serviceWorkers: "block",
  viewport: { width: 1440, height: 900 },
});
const page = await context.newPage();
page.setDefaultTimeout(15_000);
const unsupportedBrowserWarnings = [];
page.on("pageerror", (error) =>
  errors.push(`pageerror at ${page.url()}: ${error.stack ?? error.message}`),
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
    errors.push(`console at ${page.url()}: ${message.text()}`);
});

const owned = { tasks: [], bookmarks: [], notes: [] };
const checks = [];
function check(condition, label) {
  assert.ok(condition, label);
  checks.push(label);
}

async function openBookmarks() {
  if (new URL(page.url()).pathname !== "/bookmarks") {
    const tagsResponse = page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/api/v1/tags",
      { timeout: 30_000 },
    );
    await page.goto(`${base}/bookmarks`);
    const response = await tagsResponse;
    assert.ok(
      response.ok(),
      `Bookmark workspace tags failed: ${response.status()}`,
    );
  }
  await page.locator(".bookmark-toolbar").waitFor();
}

async function verifyBookmarkReader(bookmark, fixture, width) {
  const height = width === 390 ? 844 : 900;
  await page.setViewportSize({ width, height });
  await openBookmarks();
  const card = page
    .locator(".bookmark-card")
    .filter({ hasText: bookmark.title });
  await card.waitFor();
  await card
    .getByRole("button", {
      name: `Read saved article for ${bookmark.title}`,
      exact: true,
    })
    .click();
  const reader = page.getByRole("dialog", {
    name: `Saved article: ${bookmark.title}`,
  });
  await reader.waitFor();
  const articleContent = reader.locator(".bookmark-reader-content");
  await articleContent.waitFor();
  await articleContent
    .getByText("A newer inspection found the cause:")
    .waitFor();
  await reader
    .getByRole("combobox", { name: "Article version", exact: true })
    .waitFor();
  const seededHighlight = reader
    .locator(".bookmark-highlight")
    .filter({ hasText: fixture.highlightQuote });
  const seededAnnotation = seededHighlight.getByRole("textbox", {
    name: `Annotation for highlight: ${fixture.highlightQuote.slice(0, 60)}`,
    exact: true,
  });
  if (width < 768) {
    const bounds = await reader.boundingBox();
    check(
      !!bounds &&
        bounds.x === 0 &&
        bounds.y === 0 &&
        bounds.width === width &&
        bounds.height === height,
      "Mobile article reader fills the viewport",
    );
    const close = await reader
      .getByRole("button", { name: "Close saved article", exact: true })
      .boundingBox();
    check(
      !!close && close.width >= 44 && close.height >= 44,
      "Mobile article reader close action meets the touch target",
    );
    await reader.getByRole("button", { name: /^Highlights/ }).click();
    await seededHighlight.waitFor();
  }
  await seededAnnotation.waitFor();
  assert.equal(await seededAnnotation.inputValue(), fixture.annotation);
  if (width >= 768) {
    await reader
      .locator("[data-highlight-ids]")
      .filter({ hasText: fixture.highlightQuote })
      .first()
      .waitFor();
    check(
      true,
      `${width}px saved article renders the canonical version and existing highlight`,
    );
  }

  if (width < 768) {
    await seededAnnotation.fill("Reviewed from the mobile highlights pane.");
    await seededHighlight
      .getByRole("button", { name: "Save note", exact: true })
      .click();
    await reader.getByText("Annotation saved.", { exact: true }).waitFor();
    const editedHighlight = await api(
      `bookmarks/${bookmark.id}/highlights?version=${fixture.currentVersion}&limit=50`,
    );
    check(
      editedHighlight.items.some(
        (item) =>
          item.quote === fixture.highlightQuote &&
          item.annotation === "Reviewed from the mobile highlights pane.",
      ),
      "Mobile highlight annotation edits persist",
    );
    await seededHighlight
      .getByRole("button", {
        name: `“${fixture.highlightQuote}”`,
        exact: true,
      })
      .click();
    await reader
      .getByRole("button", { name: "Article", exact: true })
      .waitFor();
    await reader.getByRole("button", { name: "Article", exact: true }).click();
    await articleContent
      .locator("[data-highlight-ids]")
      .filter({ hasText: fixture.highlightQuote })
      .first()
      .waitFor();
    check(
      true,
      "Mobile article renders the existing highlight after returning from the highlights pane",
    );
    const selection = await page.evaluate((quote) => {
      const root = document.querySelector(".bookmark-reader-content");
      if (!root) return false;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        const value = node.textContent ?? "";
        const start = value.indexOf(quote);
        if (start < 0) continue;
        const range = document.createRange();
        range.setStart(node, start);
        range.setEnd(node, start + quote.length);
        const current = window.getSelection();
        current?.removeAllRanges();
        current?.addRange(range);
        document.dispatchEvent(new Event("selectionchange"));
        return current?.toString() === quote;
      }
      return false;
    }, fixture.selectionQuote);
    check(
      selection,
      "Reader accepts exact text selection in the mobile article pane",
    );
    await reader.getByRole("button", { name: "Save highlight" }).waitFor();
    await reader
      .getByRole("textbox", { name: "Highlight annotation", exact: true })
      .fill("Keep this maintenance detail with the article.");
    await reader.getByRole("button", { name: "Save highlight" }).click();
    await reader.getByText("Highlight saved.", { exact: true }).waitFor();
    const savedSelection = await api(
      `bookmarks/${bookmark.id}/highlights?version=${fixture.currentVersion}&limit=50`,
    );
    const newHighlight = savedSelection.items.find(
      (item) => item.quote === fixture.selectionQuote,
    );
    check(
      !!newHighlight &&
        newHighlight.startOffset ===
          fixture.articleText.indexOf(fixture.selectionQuote) &&
        newHighlight.endOffset ===
          fixture.articleText.indexOf(fixture.selectionQuote) +
            fixture.selectionQuote.length,
      "Mobile text selection saves precise canonical highlight offsets",
    );
    await articleContent
      .locator("[data-highlight-ids]")
      .filter({ hasText: fixture.selectionQuote })
      .waitFor();

    const versionPicker = reader.getByRole("combobox", {
      name: "Article version",
      exact: true,
    });
    await versionPicker.click();
    await page.getByRole("option").filter({ hasText: `Version 1` }).click();
    await articleContent
      .getByText("The north workshop valve began sticking")
      .waitFor();
    check(
      !(await articleContent
        .getByText("A newer inspection found the cause:")
        .count()),
      "Switching article versions loads the older saved text",
    );
    await versionPicker.click();
    await page
      .getByRole("option")
      .filter({ hasText: `Version ${fixture.currentVersion}` })
      .click();
    await articleContent
      .getByText("A newer inspection found the cause:")
      .waitFor();
    check(
      true,
      "Reader returns to the current version without losing its highlight",
    );
    check(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      "Mobile article reader does not overflow horizontally",
    );
  }

  const clickReadControl = async (name) => {
    const responsePromise = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/v1/bookmarks/read-state" &&
        response.request().method() === "POST",
    );
    await reader.getByRole("button", { name, exact: true }).click();
    const response = await responsePromise;
    assert.ok(
      response.ok(),
      `Bookmark read-state update failed: ${response.status()}`,
    );
  };
  const currentState = await api(`bookmarks/${bookmark.id}`);
  if (currentState.readAt !== null) {
    await clickReadControl(width < 768 ? "Mark bookmark unread" : "Read");
    const unread = await api(`bookmarks/${bookmark.id}`);
    assert.equal(unread.readAt, null);
    check(true, `${width}px reader can clear its read state`);
  }
  await clickReadControl(width < 768 ? "Mark bookmark read" : "Mark read");
  const updated = await api(`bookmarks/${bookmark.id}`);
  check(updated.readAt !== null, `${width}px reader persists read state`);
  await reader
    .getByRole("button", { name: "Close saved article", exact: true })
    .click();
  await reader.waitFor({ state: "hidden" });
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
  await page.goto(base);
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
    const bounds = await capture.boundingBox();
    check(
      !!bounds &&
        bounds.x >= 0 &&
        bounds.y >= 0 &&
        bounds.x + bounds.width <= width &&
        bounds.y + bounds.height <= height,
      "Mobile Quick capture stays within the viewport",
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
  assert.equal((await api(`notes/${noteId}`)).title, noteTitle);
  check(true, "Note capture creates and opens a canonical note");

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
  assert.equal((await api(`tasks/${taskId}`)).title, taskTitle);
  check(true, "Task capture creates and opens a canonical task");
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
  const planning = await verifyPlanning(page);
  check(planning.passed.length > 0, "Planning UI workflow passed");

  const bookmark = await api(`bookmarks/${readerFixture.bookmarkId}`);
  owned.bookmarks.push(bookmark.id);
  await verifyBookmarkFilters(320);
  await verifyBookmarkFilters(390);
  await verifyBookmarkFilters(1440);
  await verifyBookmarkReader(bookmark, readerFixture, 1440);
  await verifyBookmarkReader(bookmark, readerFixture, 390);

  await verifyCapturePage();
  await verifyQuickCapture(1440);
  await verifyQuickCapture(390);
  await context.close();
  await browser.close();

  assert.deepEqual(errors, [], "Planning/reader/capture browser errors");
  await runWritingHarness();

  console.log(
    `Foundations browser checks passed: ${checks.length} wrapper assertions; planning ${planning.passed.length} checks; Review Owner only; localhost:${baseUrl.port}; unsupported WebKit viewport warnings: ${unsupportedBrowserWarnings.length}.`,
  );
} finally {
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
