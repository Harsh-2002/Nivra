import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod } from "node:fs/promises";
import { chromium, firefox, webkit, request } from "playwright";

const base = process.env.NIVRA_BROWSER_TEST_URL ?? "http://localhost:3015";
if (new URL(base).port !== "3015")
  throw new Error("Use the disposable Forms test server on port 3015.");
const sessionFile = process.env.NIVRA_BROWSER_SESSION;
const owner = await request.newContext({
  ...(sessionFile && existsSync(sessionFile)
    ? { storageState: sessionFile }
    : {}),
  baseURL: base,
  extraHTTPHeaders: { origin: base },
  timeout: 60000,
});
async function api(path, data, method = data === undefined ? "GET" : "POST") {
  const response = await owner.fetch(`/api/v1/${path}`, { method, data });
  const value = await response.json();
  assert.ok(response.ok(), `${response.status()} ${JSON.stringify(value)}`);
  return value;
}
const status = await api("status");
if (status.setup) {
  await api("setup", {
    name: "Forms Reviewer",
    username: "formsreview",
    password: `Forms-${randomUUID()}`,
  });
  await api("settings", { onboardingStep: "complete" }, "PATCH");
  if (sessionFile) {
    await owner.storageState({ path: sessionFile });
    await chmod(sessionFile, 0o600);
  }
} else if (!sessionFile || !existsSync(sessionFile)) {
  throw new Error("Use fresh disposable test data or its saved test session.");
}
const ids = Object.fromEntries(
  [
    "name",
    "email",
    "amount",
    "rating",
    "choice",
    "multiple",
    "dropdown",
    "yes",
    "date",
    "time",
    "file",
    "consent",
    "number",
    "details",
    "phone",
    "website",
  ].map((name) => [name, randomUUID()]),
);
const choices = [
  { id: randomUUID(), label: "Design" },
  { id: randomUUID(), label: "Research" },
  { id: randomUUID(), label: "VeryLongOption".repeat(20) },
];
const definition = {
  schemaVersion: 1,
  title: "Project feedback",
  description: "Tell us about your next project.",
  confirmation: `Thanks {{field:${ids.name}}}. Email: {{field:${ids.email}}}. Focus: {{field:${ids.choice}}}. Budget: {{field:${ids.amount}}}.`,
  fields: [
    { id: randomUUID(), type: "section", label: "Your project" },
    { id: randomUUID(), type: "heading", label: "Project information" },
    {
      id: randomUUID(),
      type: "description",
      label: "Only synthetic data is used for this test.",
    },
    { id: ids.name, type: "short_text", label: "Project name", required: true },
    { id: ids.email, type: "email", label: "Email", required: true },
    { id: ids.details, type: "long_text", label: "Details" },
    { id: ids.phone, type: "phone", label: "Phone" },
    { id: ids.website, type: "url", label: "Website" },
    {
      id: ids.number,
      type: "number",
      label: "Team size",
      minimum: 1,
      maximum: 10,
    },
    { id: ids.amount, type: "amount", label: "Budget", currency: "USD" },
    { id: ids.rating, type: "rating", label: "Confidence" },
    { id: ids.choice, type: "single_choice", label: "Focus", choices },
    { id: ids.multiple, type: "multiple_choice", label: "Interests", choices },
    { id: ids.dropdown, type: "dropdown", label: "Category", choices },
    { id: ids.yes, type: "yes_no", label: "Ready to start" },
    { id: ids.date, type: "date", label: "Start date" },
    { id: ids.time, type: "time", label: "Preferred time" },
    { id: ids.file, type: "file", label: "Brief", fileTypes: ["document"] },
    { id: ids.consent, type: "consent", label: "Consent", required: true },
  ],
};
let form = await api("forms", { definition });
form = await api(`forms/${form.id}/publish`, { revision: form.revision });
const results = [];
try {
  for (const [engineName, engine] of Object.entries({
    chromium,
    firefox,
    webkit,
  })) {
    const browser = await engine.launch(
      engineName === "chromium" ? { channel: "chrome" } : {},
    );
    try {
      for (const width of engineName === "chromium"
        ? [320, 390, 768, 844, 1024, 1440]
        : [390, 1440])
        for (const colorScheme of ["light", "dark"]) {
          console.log(`Checking public ${engineName} ${width} ${colorScheme}`);
          const context = await browser.newContext({
            serviceWorkers: "block",
            viewport: {
              width,
              height:
                width === 320
                  ? 568
                  : width === 768
                    ? 1024
                    : width === 844
                      ? 390
                      : width === 1024
                        ? 768
                        : 900,
            },
            colorScheme,
          });
          await context.addInitScript(
            (saved) => localStorage.setItem("nivra-theme", saved),
            colorScheme === "dark" ? "light" : "dark",
          );
          const page = await context.newPage();
          page.setDefaultNavigationTimeout(60000);
          const failures = [];
          page.on("pageerror", (error) => failures.push(error.message));
          const response = await page.goto(`${base}/form/${form.publicToken}`);
          await page
            .getByRole("textbox", { name: "Project name", exact: true })
            .waitFor();
          const targets = await page
            .locator(
              '.form-renderer [data-slot="input"], .form-renderer [data-slot="textarea"], .form-renderer [data-slot="select-trigger"], .form-renderer [data-slot="button"]',
            )
            .evaluateAll((elements) =>
              elements.map((element) => ({
                slot: element.getAttribute("data-slot"),
                height: element.getBoundingClientRect().height,
              })),
            );
          assert.ok(
            targets.every((target) => target.height >= 44),
            `Public answer controls stay at least 44px: ${JSON.stringify(targets)}`,
          );
          const longChoice = page.getByRole("button", {
            name: choices[2].label,
            exact: true,
          });
          assert.ok(
            await longChoice.evaluate(
              (element) => element.scrollWidth <= element.clientWidth + 1,
            ),
            "Long choice labels wrap inside their button",
          );
          await page.emulateMedia({ colorScheme });
          assert.equal(
            await page.evaluate(
              () => matchMedia("(prefers-color-scheme: dark)").matches,
            ),
            colorScheme === "dark",
            "The browser must actually emulate the requested device preference",
          );
          assert.equal(response.status(), 200);
          assert.match(
            response.headers()["cache-control"],
            /no-store|no-cache/,
          );
          if (process.env.NODE_ENV === "production")
            assert.match(response.headers()["cache-control"], /no-store/);
          await page
            .getByRole("heading", { name: "Project feedback" })
            .waitFor();
          await page.waitForFunction(
            (dark) =>
              document.documentElement.classList.contains("dark") === dark,
            colorScheme === "dark",
          );
          assert.equal(
            await page.evaluate(() =>
              document.documentElement.classList.contains("dark"),
            ),
            colorScheme === "dark",
          );
          assert.equal(
            await page.evaluate(() => localStorage.getItem("nivra-theme")),
            colorScheme === "dark" ? "light" : "dark",
          );
          await page.mouse.move(width / 2, page.viewportSize().height / 2);
          await page.mouse.wheel(0, 650);
          await page.waitForFunction(
            () => document.querySelector(".bn-scroll-container")?.scrollTop > 0,
          );
          assert.equal(
            await page.locator('select[aria-hidden="true"]').count(),
            1,
          );
          for (const hidden of await page
            .locator('.form-renderer :is(input,select)[aria-hidden="true"]')
            .all()) {
            assert.equal(
              await hidden.evaluate(
                (element) => getComputedStyle(element).clipPath,
              ),
              "inset(50%)",
              "Native form bridges stay visually clipped under CSP",
            );
          }
          await page
            .getByRole("button", { name: "Submit", exact: true })
            .click();
          await page
            .getByText("This field is required.", { exact: true })
            .first()
            .waitFor();
          await page.waitForFunction(
            (id) => document.activeElement?.id === `input-${id}`,
            ids.name,
          );
          await page.emulateMedia({
            colorScheme: colorScheme === "dark" ? "light" : "dark",
          });
          await page.waitForFunction(
            (dark) =>
              document.documentElement.classList.contains("dark") === dark,
            colorScheme !== "dark",
          );
          await page.emulateMedia({ colorScheme });
          await page.waitForFunction(
            (dark) =>
              document.documentElement.classList.contains("dark") === dark,
            colorScheme === "dark",
          );
          if (process.env.NIVRA_BROWSER_REVIEW_DIR && engineName === "chromium")
            await page.screenshot({
              path: `${process.env.NIVRA_BROWSER_REVIEW_DIR}/forms-validation-${width}-${colorScheme}.png`,
            });
          const projectName =
            engineName === "chromium" &&
            width === 390 &&
            colorScheme === "light"
              ? '<img src=x onerror="window.formConfirmationInjection=true">'
              : "Readable forms";
          await page.getByLabel("Project name").fill(projectName);
          await page
            .getByRole("textbox", { name: "Email", exact: true })
            .fill("reviewer@example.test");
          await page
            .getByRole("textbox", { name: "Details", exact: true })
            .fill("A longer answer\nwith a second line.");
          await page
            .getByRole("textbox", { name: "Phone", exact: true })
            .fill("+1 555 0123");
          await page
            .getByRole("textbox", { name: "Website", exact: true })
            .fill("https://example.com/project");
          await page.getByLabel("Team size").fill("3");
          await page.getByLabel("Budget").fill("19.95");
          await page
            .getByRole("group", { name: "Confidence" })
            .getByRole("button", { name: "4", exact: true })
            .click();
          await page
            .getByRole("group", { name: "Focus", exact: true })
            .getByRole("button", { name: "Design", exact: true })
            .click();
          await page
            .getByRole("group", { name: "Interests" })
            .getByRole("checkbox")
            .first()
            .click();
          await page.getByRole("combobox", { name: "Category" }).click();
          await page
            .getByRole("option", { name: "Research", exact: true })
            .click();
          await page
            .getByRole("group", { name: "Ready to start" })
            .getByRole("button", { name: "Yes", exact: true })
            .click();
          await page.getByLabel("Start date").fill("2026-10-10");
          await page.getByLabel("Preferred time").fill("09:30");
          await page.locator('input[type="file"]').setInputFiles({
            name: "brief.txt",
            mimeType: "text/plain",
            buffer: Buffer.from("Synthetic project brief"),
          });
          await page.getByText("brief.txt", { exact: true }).waitFor();
          await page.getByRole("checkbox", { name: "Consent" }).click();
          if (
            engineName === "chromium" &&
            width === 320 &&
            colorScheme === "light"
          ) {
            for (const [id, invalid, valid] of [
              [ids.email, "invalid-email", "reviewer@example.test"],
              [ids.phone, "not-a-phone", "+1 555 0123"],
              [ids.website, "ftp://example.com", "https://example.com/project"],
              [ids.number, "11", "3"],
              [ids.amount, "19.955", "19.95"],
            ]) {
              const input = page.locator(`#input-${id}`);
              await input.fill(invalid);
              await page
                .getByRole("button", { name: "Submit", exact: true })
                .click();
              await page
                .getByText("Enter a valid answer.", { exact: true })
                .waitFor();
              await page.waitForFunction(
                (fieldId) => document.activeElement?.id === `input-${fieldId}`,
                id,
              );
              assert.equal((await api(`forms/${form.id}`)).total, 0);
              await input.fill(valid);
            }
          }
          const overflow = await page.evaluate(
            () => document.documentElement.scrollWidth > innerWidth + 1,
          );
          assert.equal(
            overflow,
            false,
            `${engineName} ${width} ${colorScheme}: horizontal overflow`,
          );
          let lost = false;
          await page.route(
            `**/api/v1/public/forms/${form.publicToken}/responses`,
            async (route) => {
              if (!lost) {
                lost = true;
                await route.fetch();
                await route.abort();
              } else await route.continue();
            },
          );
          await page
            .getByRole("button", { name: "Submit", exact: true })
            .click();
          await page.getByRole("alert").filter({ hasText: /\S/ }).waitFor();
          assert.equal(lost, true, "The server accepted the intercepted retry");
          assert.equal(
            await page.getByLabel("Project name").inputValue(),
            projectName,
          );
          await page
            .getByRole("button", { name: "Submit", exact: true })
            .click();
          await page
            .getByRole("heading", { name: "Response submitted" })
            .waitFor();
          await page
            .getByText(
              `Thanks ${projectName}. Email: reviewer@example.test. Focus: Design. Budget: 19.95 USD.`,
              { exact: true },
            )
            .waitFor();
          assert.equal(
            await page.evaluate(() => window.formConfirmationInjection),
            undefined,
            "Confirmation answers remain plain text",
          );
          assert.deepEqual(failures, []);
          const detail = await api(`forms/${form.id}/responses?limit=1`);
          const submission = await api(
            `forms/${form.id}/responses/${detail.items[0].id}`,
          );
          assert.equal(submission.answers[ids.amount], "19.95");
          assert.equal(submission.answers[ids.yes], true);
          assert.equal(submission.files.length, 1);
          results.push(`${engineName} ${width} ${colorScheme}`);
          assert.equal(
            detail.total,
            results.length,
            "Retry must not duplicate a submission",
          );
          const missing = await page.goto(`${base}/form/${"a".repeat(32)}`);
          assert.equal(missing.status(), 404);
          await page
            .getByRole("heading", { name: "Form not available" })
            .waitFor();
          await context.close();
        }
    } finally {
      await browser.close();
    }
  }
  console.log(
    `Public Forms passed ${results.length} browser/viewport/theme combinations: validation, uploads, retry safety, response integrity, no overflow and unavailable links.`,
  );
} finally {
  await owner.dispose();
}
