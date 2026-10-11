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
async function api(context, path, method = "GET", data) {
  const response = await context.request.fetch(`${base}/api/v1/${path}`, {
    method,
    data,
    headers: { origin: base },
  });
  assert.ok(response.ok(), `${method} ${path}: ${response.status()}`);
  return response.json();
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
  await page.getByRole("heading", { name: tagsHeading, exact: true }).waitFor();
  assert.equal(
    (await api(context, "tags")).items.length,
    0,
    "Never create starter tags automatically",
  );
  await page.getByRole("checkbox", { name: "Work", exact: true }).check();
  await page.getByRole("button", { name: "Add Meetings", exact: true }).click();
  await page
    .getByRole("status")
    .filter({ hasText: "Added “Meetings”" })
    .waitFor();
  await page.reload();
  await page.getByRole("heading", { name: tagsHeading, exact: true }).waitFor();
  await page.getByText(/Already added:.*Meetings/).waitFor();
  await page.getByLabel("Tag name", { exact: true }).fill(" meetings ");
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

for (const [engine, launcher] of Object.entries({
  chromium,
  firefox,
  webkit,
})) {
  const browser = await launcher.launch();
  try {
    for (const width of [320, 390, 768, 1440])
      for (const theme of ["light", "dark"]) {
        const context = await browser.newContext({
          storageState: session,
          viewport: { width, height: width === 320 ? 568 : 900 },
          colorScheme: theme,
          hasTouch: width < 1024,
          serviceWorkers: "block",
        });
        await api(context, "settings", "PATCH", { onboardingStep: "tags" });
        const page = await context.newPage();
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(base);
        await page
          .getByRole("heading", { name: tagsHeading, exact: true })
          .waitFor();
        await page
          .getByRole("checkbox", { name: "Personal", exact: true })
          .check();
        await page
          .getByRole("button", { name: "Add Health", exact: true })
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
        const tag = (await api(context, "tags")).items.find(
          (tag) => tag.name === name,
        );
        assert.deepEqual(tag.aliases, ["sqlite database", "queries indexes"]);
        await inspect(page, `${engine}-${width}-${theme}-tags`);
        await page
          .getByRole("button", { name: "Continue", exact: true })
          .click();
        await page
          .getByRole("heading", { name: installHeading, exact: true })
          .waitFor();
        await page.reload();
        await page
          .getByRole("heading", { name: installHeading, exact: true })
          .waitFor();
        assert.equal(
          (await api(context, "settings")).onboardingStep,
          "install",
        );
        await inspect(page, `${engine}-${width}-${theme}-install`);
        await page
          .getByRole("button", { name: "Finish setup", exact: true })
          .click();
        await page.locator(".workspace").waitFor();
        await page.reload();
        await page.locator(".workspace").waitFor();
        assert.equal(
          (await api(context, "settings")).onboardingStep,
          "complete",
        );
        assert.deepEqual(errors, []);
        console.log(
          `${engine} ${width} ${theme}: recommendations, Enter creation, aliases, progress/reload, completion, accessibility and overflow passed`,
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
