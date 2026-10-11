import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile } from "node:fs/promises";
import { chromium, firefox, webkit } from "playwright";

const base = process.env.NIVRA_ONBOARDING_TEST_URL ?? "http://localhost:3016";
assert.equal(
  new URL(base).port,
  "3016",
  "Disposable onboarding server required",
);
const session = process.env.NIVRA_BROWSER_SESSION;
assert.ok(session, "A private synthetic session path is required");
const output = process.env.NIVRA_AUDIT_OUTPUT;
if (output) await mkdir(output, { recursive: true });
const axe = await readFile("node_modules/axe-core/axe.min.js", "utf8");
const tagsHeading = "Choose your starting tags";
const installHeading = "Install Nivra on this device";
const engines = { chromium, firefox, webkit };
const selectedEngine = process.env.NIVRA_AUDIT_ENGINE;
assert.ok(
  !selectedEngine || Object.hasOwn(engines, selectedEngine),
  "NIVRA_AUDIT_ENGINE must be chromium, firefox, or webkit",
);
const widths = (process.env.NIVRA_AUDIT_WIDTHS ?? "320,390,768,1440")
  .split(",")
  .map(Number);
assert.ok(
  widths.length > 0 &&
    widths.every((width) => [320, 390, 768, 1440].includes(width)),
  "NIVRA_AUDIT_WIDTHS must be a comma-separated subset of 320,390,768,1440",
);
const themes = (process.env.NIVRA_AUDIT_THEMES ?? "light,dark").split(",");
assert.ok(
  themes.length > 0 &&
    themes.every((theme) => ["light", "dark"].includes(theme)),
  "NIVRA_AUDIT_THEMES must be a comma-separated subset of light,dark",
);
async function api(context, path, method = "GET", data) {
  const response = await context.request.fetch(`${base}/api/v1/${path}`, {
    method,
    data,
    headers: { origin: base },
  });
  assert.ok(response.ok(), `${method} ${path}: ${response.status()}`);
  return response.json();
}
function waitForApiResponse(page, path) {
  return page.waitForResponse(
    (response) => new URL(response.url()).pathname === `/api/v1/${path}`,
    { timeout: 15_000 },
  );
}
async function waitForCheckbox(page, checkbox, checked) {
  const value = String(checked);
  for (let attempt = 0; attempt < 100; attempt++) {
    if (
      (await checkbox.getAttribute("aria-checked")) === value &&
      !(await checkbox.isDisabled())
    )
      return;
    await page.waitForTimeout(50);
  }
  assert.equal(await checkbox.getAttribute("aria-checked"), value);
  assert.equal(await checkbox.isDisabled(), false);
}
async function inspect(page, name) {
  await page.evaluate(axe);
  const violations = await page.evaluate(async () =>
    (
      await window.axe.run(document, {
        runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] },
      })
    ).violations.map((v) => ({ id: v.id, impact: v.impact })),
  );
  assert.deepEqual(violations, [], `${name}: accessibility`);
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth + 1,
    ),
    false,
    `${name}: overflow`,
  );
  if (page.viewportSize().width < 1024) {
    const sizes = await page
      .locator(".onboarding-actions button, .onboarding-tag-list button")
      .evaluateAll((nodes) =>
        nodes.map((node) => node.getBoundingClientRect().height),
      );
    assert.ok(
      sizes.every((size) => size >= 43),
      `${name}: touch actions`,
    );
  }
  if (output) await page.screenshot({ path: `${output}/${name}.png` });
}

if (process.env.NIVRA_SKIP_SETUP !== "1") {
  const first = await chromium.launch();
  try {
    const context = await first.newContext({
      viewport: { width: 390, height: 844 },
      serviceWorkers: "block",
    });
    assert.equal(
      (await api(context, "status")).setup,
      true,
      "Do not use an existing owner",
    );
    const page = await context.newPage();
    await page.goto(base);
    await page
      .getByLabel("Your name", { exact: true })
      .fill("Onboarding test owner");
    await page
      .getByLabel("Username or email", { exact: true })
      .fill("onboarding_test");
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    const password = `Setup-${randomUUID()}`;
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByLabel("Confirm password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page
      .getByRole("button", { name: "Create your space", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Make it yours", exact: true })
      .waitFor();
    assert.equal(
      await page
        .getByRole("button", { name: "Make it yours", exact: true })
        .isDisabled(),
      true,
    );
    await page
      .getByRole("checkbox", { name: "I have saved my recovery code" })
      .check();
    await page
      .getByRole("button", { name: "Make it yours", exact: true })
      .click();
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page
      .getByRole("heading", { name: tagsHeading, exact: true })
      .waitFor();
    const smartFeatures = page.getByRole("checkbox", {
      name: "Enable smart features",
      exact: true,
    });
    await waitForCheckbox(page, smartFeatures, false);
    assert.equal(
      (await api(context, "ai")).enabled,
      false,
      "Smart features must start disabled",
    );
    let releaseSmartFeaturePatch;
    let smartFeaturePatchIntercepted = false;
    let signalSmartFeaturePatchContinued;
    const smartFeaturePatchHold = new Promise((resolve) => {
      releaseSmartFeaturePatch = resolve;
    });
    const smartFeaturePatchContinued = new Promise((resolve) => {
      signalSmartFeaturePatchContinued = resolve;
    });
    const smartFeaturePatchStarted = page.waitForRequest(
      (request) =>
        new URL(request.url()).pathname === "/api/v1/ai" &&
        request.method() === "PATCH",
      { timeout: 15_000 },
    );
    await page.route("**/api/v1/ai", async (route) => {
      if (route.request().method() === "PATCH") {
        smartFeaturePatchIntercepted = true;
        await smartFeaturePatchHold;
        try {
          await route.continue();
        } finally {
          signalSmartFeaturePatchContinued();
        }
      } else {
        await route.continue();
      }
    });
    try {
      await smartFeatures.click();
      await smartFeaturePatchStarted;
      assert.equal(
        await page
          .getByRole("button", { name: "Continue", exact: true })
          .isDisabled(),
        true,
        "Continue stays blocked while the feature choice is saving",
      );
      releaseSmartFeaturePatch();
      await smartFeaturePatchContinued;
    } finally {
      releaseSmartFeaturePatch();
      if (smartFeaturePatchIntercepted) await smartFeaturePatchContinued;
      await page.unroute("**/api/v1/ai");
    }
    await waitForCheckbox(page, smartFeatures, true);
    assert.equal(
      await page
        .getByRole("button", { name: "Continue", exact: true })
        .isDisabled(),
      false,
    );
    assert.equal((await api(context, "ai")).enabled, true);
    await smartFeatures.click();
    await waitForCheckbox(page, smartFeatures, false);
    assert.equal((await api(context, "ai")).enabled, false);
    assert.equal(
      (await api(context, "tags")).items.length,
      0,
      "Never create starter tags automatically",
    );
    const yourTags = page.getByRole("region", { name: "Your tags" });
    await yourTags.getByText("No tags yet.", { exact: true }).waitFor();
    await page.getByRole("heading", { name: "Suggested tags" }).waitFor();
    await page.getByRole("button", { name: "Add Work", exact: true }).click();
    await page
      .getByRole("status")
      .filter({ hasText: "Added “Work”" })
      .waitFor();
    await yourTags.getByText("Work", { exact: true }).waitFor();
    await page.reload();
    await page
      .getByRole("heading", { name: tagsHeading, exact: true })
      .waitFor();
    await page
      .getByRole("region", { name: "Your tags" })
      .getByText("Work", { exact: true })
      .waitFor();
    await page.getByLabel("Tag name", { exact: true }).fill(" work ");
    assert.equal(
      await page
        .getByRole("button", { name: "Add tag", exact: true })
        .isDisabled(),
      true,
      "Normalized duplicates disabled",
    );
    assert.equal((await api(context, "tags")).items.length, 1);
    await context.storageState({ path: session });
    await chmod(session, 0o600);
    console.log(
      "Full password/encryption/recovery/configuration flow and explicit tag creation passed",
    );
    await context.close();
  } finally {
    await first.close();
  }
} else {
  const verify = await chromium.launch();
  try {
    const context = await verify.newContext({ storageState: session });
    const status = await api(context, "status");
    assert.equal(
      status.setup,
      false,
      "An existing synthetic owner is required",
    );
    assert.ok(
      status.owner,
      "The supplied private session must be authenticated",
    );
    await context.close();
  } finally {
    await verify.close();
  }
}

for (const [engine, launcher] of Object.entries(engines).filter(
  ([name]) => !selectedEngine || selectedEngine === name,
)) {
  const browser = await launcher.launch();
  try {
    for (const width of widths)
      for (const theme of themes) {
        const context = await browser.newContext({
          storageState: session,
          viewport: { width, height: width === 320 ? 568 : 900 },
          colorScheme: theme,
          hasTouch: width < 1024,
          serviceWorkers: "block",
        });
        await api(context, "settings", "PATCH", { onboardingStep: "tags" });
        const page = await context.newPage();
        const pageStartedAt = Date.now();
        const requestStarts = new WeakMap();
        const requestEvents = [];
        let phase = "initial tag view";
        const errors = [];
        const requestFailures = [];
        const requestPath = (request) => new URL(request.url()).pathname;
        const relevantRequest = (request) =>
          [
            "/api/v1/tags",
            "/api/v1/completions",
            "/api/v1/overview",
            "/api/v1/status",
          ].includes(requestPath(request));
        page.on("pageerror", (error) =>
          errors.push({
            message: error.message,
            stack: error.stack,
            phase,
            elapsedMs: Date.now() - pageStartedAt,
          }),
        );
        page.on("request", (request) => {
          if (!relevantRequest(request)) return;
          const startedAt = Date.now();
          requestStarts.set(request, startedAt);
          requestEvents.push({
            event: "start",
            method: request.method(),
            url: requestPath(request),
            phase,
            elapsedMs: startedAt - pageStartedAt,
          });
        });
        page.on("requestfinished", (request) => {
          const startedAt = requestStarts.get(request);
          if (startedAt === undefined) return;
          requestEvents.push({
            event: "finish",
            method: request.method(),
            url: requestPath(request),
            phase,
            elapsedMs: Date.now() - pageStartedAt,
            durationMs: Date.now() - startedAt,
          });
        });
        page.on("requestfailed", (request) => {
          const failedAt = Date.now();
          const startedAt = requestStarts.get(request);
          const failure = {
            method: request.method(),
            url: requestPath(request),
            error: request.failure()?.errorText,
            phase,
            elapsedMs: failedAt - pageStartedAt,
            ...(startedAt === undefined
              ? {}
              : { durationMs: failedAt - startedAt }),
          };
          requestFailures.push(failure);
          requestEvents.push({ event: "fail", ...failure });
        });
        await page.goto(base);
        await page
          .getByRole("heading", { name: tagsHeading, exact: true })
          .waitFor();
        await page
          .getByRole("heading", { name: "Your tags", exact: true })
          .waitFor();
        await page
          .getByRole("heading", { name: "Suggested tags", exact: true })
          .waitFor();
        const name = `Review-${randomUUID().slice(0, 8)}`;
        await page.getByLabel("Tag name", { exact: true }).fill(name);
        await page
          .getByLabel("Aliases (optional)", { exact: true })
          .fill("sqlite database, queries indexes");
        await page.getByLabel("Tag name", { exact: true }).press("Enter");
        await page
          .getByRole("status")
          .filter({ hasText: `Added “${name}”` })
          .waitFor();
        await page
          .getByRole("region", { name: "Your tags" })
          .getByText(name, { exact: true })
          .waitFor();
        const tag = (await api(context, "tags")).items.find(
          (tag) => tag.name === name,
        );
        assert.deepEqual(tag.aliases, ["sqlite database", "queries indexes"]);
        await inspect(page, `${engine}-${width}-${theme}-tags`);
        phase = "continue to install";
        await page
          .getByRole("button", { name: "Continue", exact: true })
          .click();
        await page
          .getByRole("heading", { name: installHeading, exact: true })
          .waitFor();
        phase = "install step reload";
        await page.reload();
        await page
          .getByRole("heading", { name: installHeading, exact: true })
          .waitFor();
        assert.equal(
          (await api(context, "settings")).onboardingStep,
          "install",
        );
        await inspect(page, `${engine}-${width}-${theme}-install`);
        const shortcutsPanel = page.locator(".onboarding-shortcuts");
        assert.equal(
          await shortcutsPanel.isVisible(),
          width >= 1024,
          `${engine} ${width} ${theme}: shortcuts are desktop-only`,
        );
        if (width >= 1024)
          assert.equal(
            await shortcutsPanel.locator("dl > div").count(),
            3,
            `${engine} ${width} ${theme}: all three supported shortcuts are shown`,
          );
        await page
          .getByRole("button", { name: "Finish setup", exact: true })
          .waitFor();
        const completionBeforeReload = waitForApiResponse(page, "completions");
        try {
          phase = "finish setup action";
          await page
            .getByRole("button", { name: "Finish setup", exact: true })
            .click();
          await page.locator(".workspace").waitFor();
          assert.equal(
            (await completionBeforeReload).status(),
            200,
            `${engine} ${width} ${theme}: authenticated SSE before reload`,
          );
          const completionAfterReload = waitForApiResponse(page, "completions");
          const statusAfterReload = waitForApiResponse(page, "status");
          phase = "workspace reload";
          await page.reload();
          await page.locator(".workspace").waitFor();
          assert.equal(
            (await completionAfterReload).status(),
            200,
            `${engine} ${width} ${theme}: authenticated SSE after reload`,
          );
          assert.equal(
            (await statusAfterReload).status(),
            200,
            `${engine} ${width} ${theme}: authenticated status after reload`,
          );
          assert.equal(
            (await api(context, "settings")).onboardingStep,
            "complete",
          );
          assert.deepEqual(errors, []);
        } catch (error) {
          console.error(
            `${engine} ${width} ${theme}: reload diagnostics`,
            JSON.stringify({ errors, requestFailures, requestEvents }, null, 2),
          );
          throw error;
        }
        console.log(
          `${engine} ${width} ${theme}: tag suggestions, live tag list, Enter creation, aliases, progress/reload, completion, accessibility and overflow passed`,
        );
        await context.close();
      }
  } finally {
    await browser.close();
  }
}

const platformBrowser = await chromium.launch();
try {
  for (const [platform, userAgent, instruction] of [
    [
      "ios",
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1",
      "On an iPhone or iPad, open Nivra in Safari.",
    ],
    [
      "android",
      "Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 Chrome/140.0.0.0 Mobile Safari/537.36",
      "In Chrome, open the browser menu",
    ],
    [
      "desktop",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36",
      "In a Chromium browser",
    ],
    [
      "standalone",
      "Mozilla/5.0 (iPhone) AppleWebKit/605.1.15",
      "Nivra is already open as an app",
    ],
  ]) {
    const context = await platformBrowser.newContext({
      storageState: session,
      userAgent,
      viewport: { width: 390, height: 844 },
      serviceWorkers: "block",
    });
    await api(context, "settings", "PATCH", { onboardingStep: "install" });
    if (platform === "standalone")
      await context.addInitScript(() =>
        Object.defineProperty(navigator, "standalone", { value: true }),
      );
    const page = await context.newPage();
    await page.goto(base);
    await page
      .getByRole("heading", { name: installHeading, exact: true })
      .waitFor();
    await page.getByText(instruction, { exact: false }).waitFor();
    if (platform === "android") {
      await page.evaluate(() => {
        const event = new Event("beforeinstallprompt");
        event.prompt = async () => {
          window.__installPrompted = true;
        };
        event.userChoice = Promise.resolve({
          outcome: "accepted",
          platform: "web",
        });
        window.dispatchEvent(event);
      });
      await page
        .getByRole("button", { name: "Install Nivra", exact: true })
        .click();
      assert.equal(await page.evaluate(() => window.__installPrompted), true);
      await page.getByText(/browser accepted the install request/).waitFor();
    }
    await page
      .getByRole("button", { name: "Skip install guidance", exact: true })
      .click();
    await page.locator(".workspace").waitFor();
    await context.close();
    console.log(
      `${platform}: install instructions and optional completion passed`,
    );
  }
} finally {
  await platformBrowser.close();
}
