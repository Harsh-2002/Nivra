import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";

const base = process.env.NIVRA_ONBOARDING_TEST_URL ?? "http://localhost:3016";
assert.equal(
  new URL(base).port,
  "3016",
  "An empty disposable onboarding server is required",
);
const output = ".impeccable/review/accessibility-onboarding";
await mkdir(output, { recursive: true });
const axe = await readFile("node_modules/axe-core/axe.min.js", "utf8");
const browser = await chromium.launch({ args: ["--disable-dev-shm-usage"] });
const results = [];
async function inspect(page, step, width, theme) {
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(async () => {
    await Promise.allSettled(
      document
        .getAnimations()
        .filter((a) => a.effect?.getTiming().iterations !== Infinity)
        .map((a) => a.finished),
    );
  });
  await page.evaluate(axe);
  const result = await page.evaluate(async () => {
    const result = await window.axe.run(document, {
      runOnly: {
        type: "tag",
        values: [
          "wcag2a",
          "wcag2aa",
          "wcag21a",
          "wcag21aa",
          "wcag22aa",
          "best-practice",
        ],
      },
    });
    return {
      violations: result.violations.map((v) => ({
        id: v.id,
        nodes: v.nodes.map((n) => ({
          target: n.target,
          failure: n.failureSummary,
        })),
      })),
      incomplete: result.incomplete.map((v) => ({
        id: v.id,
        targets: v.nodes.map((n) => n.target),
      })),
      overflow: document.documentElement.scrollWidth > innerWidth + 1,
    };
  });
  results.push({ step, width, theme, ...result });
  await page.screenshot({
    path: `${output}/${width}-${theme}-${step}.png`,
    mask: await page.locator(".recovery-code").all(),
  });
  await writeFile(`${output}/report.json`, JSON.stringify(results, null, 2));
  console.log(
    `${width} ${theme} ${step}: axe=${result.violations.length}, overflow=${result.overflow}`,
  );
}
try {
  const context = await browser.newContext({
    serviceWorkers: "block",
    hasTouch: true,
  });
  const page = await context.newPage();
  const status = await page.request.get(`${base}/api/v1/status`);
  assert.equal(
    (await status.json()).setup,
    true,
    "Do not change an existing account",
  );
  const username = `audit${randomUUID().slice(0, 8)}`;
  const password = `Audit-${randomUUID()}`;
  for (const width of [320, 390, 768, 1440])
    for (const theme of ["light", "dark"]) {
      await page.setViewportSize({ width, height: width === 320 ? 568 : 900 });
      await page.emulateMedia({ colorScheme: theme });
      await page.goto(base);
      await page.getByLabel("Your name", { exact: true }).waitFor();
      await inspect(page, "identity", width, theme);
      await page
        .getByLabel("Your name", { exact: true })
        .fill("Accessibility Audit Owner");
      await page
        .getByLabel("Username or email", { exact: true })
        .fill(username);
      await page.getByRole("button", { name: "Continue", exact: true }).click();
      await page
        .getByRole("heading", { name: "Choose how to sign in.", exact: true })
        .waitFor();
      await inspect(page, "credentials", width, theme);
      await page.getByLabel("Password", { exact: true }).fill(password);
      await page.getByLabel("Confirm password", { exact: true }).fill(password);
      await page.getByRole("button", { name: "Continue", exact: true }).click();
      await page
        .getByRole("heading", { name: "Protect your data.", exact: true })
        .waitFor();
      await inspect(page, "encryption", width, theme);
    }
  await page
    .getByRole("button", { name: "Create your space", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Make it yours", exact: true })
    .waitFor();
  for (const step of ["recovery", "configuration"]) {
    for (const width of [320, 390, 768, 1440])
      for (const theme of ["light", "dark"]) {
        await page.setViewportSize({
          width,
          height: width === 320 ? 568 : 900,
        });
        await page.emulateMedia({ colorScheme: theme });
        await inspect(page, step, width, theme);
      }
    if (step === "recovery") {
      await page.getByRole("checkbox").check();
      await page
        .getByRole("button", { name: "Make it yours", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Continue", exact: true })
        .waitFor();
    }
  }
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page
    .getByRole("heading", { name: "Choose your starting tags", exact: true })
    .waitFor();
  for (const step of ["tags", "install"]) {
    for (const width of [320, 390, 768, 1440])
      for (const theme of ["light", "dark"]) {
        await page.setViewportSize({
          width,
          height: width === 320 ? 568 : 900,
        });
        await page.emulateMedia({ colorScheme: theme });
        await inspect(page, step, width, theme);
      }
    await page
      .getByRole("button", {
        name: step === "tags" ? "Skip tag setup" : "Finish setup",
        exact: true,
      })
      .click();
    if (step === "tags")
      await page
        .getByRole("heading", {
          name: "Install Nivra on this device",
          exact: true,
        })
        .waitFor();
  }
  await page.locator(".workspace").waitFor();
  assert.equal(
    results.filter((r) => r.violations.length || r.overflow).length,
    0,
    "Onboarding accessibility findings; inspect the private report",
  );
  console.log(
    `Passed ${results.length} onboarding step/viewport/theme cases and account creation.`,
  );
  await context.close();
} finally {
  await browser.close();
}
