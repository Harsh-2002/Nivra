import { chromium, firefox, webkit, request } from "playwright";
import {
  existsSync,
  readFileSync,
  mkdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const root = realpathSync(process.argv[2]);
assert.ok(
  root.startsWith("/tmp/nivra-layout-review-"),
  "Disposable data required",
);
const base = "http://localhost:3004";
const output = path.join(root, "captures");
mkdirSync(output, { recursive: true });
const api = await request.newContext({
  baseURL: base,
  storageState: existsSync(path.join(root, "session.json"))
    ? path.join(root, "session.json")
    : undefined,
  extraHTTPHeaders: { Origin: base },
  timeout: 30000,
});
const status = await (await api.get("/api/v1/status")).json();
if (status.setup) {
  const setup = await api.post("/api/v1/setup", {
    data: {
      name: "Layout Review Owner",
      username: "layoutreview",
      password: randomUUID() + randomUUID(),
    },
  });
  assert.ok(setup.ok());
}
assert.equal(
  (await (await api.get("/api/v1/status")).json()).owner?.name,
  "Layout Review Owner",
);
assert.ok(
  (
    await api.patch("/api/v1/settings", {
      data: { theme: "system", onboardingStep: "complete" },
    })
  ).ok(),
);
for (const item of (await (await api.get("/api/v1/artifacts?limit=100")).json())
  .items) {
  assert.ok(
    (
      await api.delete(`/api/v1/artifacts/${item.id}`, {
        data: { revision: item.revision },
      })
    ).ok(),
  );
}
const session = await api.storageState();
writeFileSync(path.join(root, "session.json"), JSON.stringify(session), {
  mode: 0o600,
});
writeFileSync(".playwright-mcp/layout-session.json", JSON.stringify(session), {
  mode: 0o600,
});
const text =
  "Long terminal text\n" +
  Array.from(
    { length: 700 },
    (_, i) => `route ${i} via gateway\n    next hop with preserved indentation`,
  ).join("\n");
const saved = await (
  await api.post("/api/v1/artifacts", { data: { text } })
).json();
const image = await (
  await api.post("/api/v1/artifacts", {
    multipart: {
      file: {
        name: "Rotated invoice.png",
        mimeType: "image/png",
        buffer: readFileSync("tests/fixtures/ocr-90.png"),
      },
    },
  })
).json();
const until = Date.now() + 90000;
while (Date.now() < until) {
  const item = await (await api.get(`/api/v1/artifacts/${image.id}`)).json();
  if (item.extraction === "done") {
    assert.match(item.content, /Northwind/);
    break;
  }
  if (item.extraction === "failed") throw new Error("Review OCR failed");
  await new Promise((r) => setTimeout(r, 500));
}
assert.equal(
  (await (await api.get(`/api/v1/artifacts/${image.id}`)).json()).extraction,
  "done",
);
const daily = await (
  await api.post("/api/v1/journals", { data: { date: "2026-10-06" } })
).json();
const inline = (text) => [{ type: "text", text, styles: {} }];
const document = [
  {
    id: randomUUID(),
    type: "paragraph",
    content: inline("Journal body alignment check"),
    children: [],
  },
  ...[1, 2, 3, 4, 5, 6].map((level) => ({
    id: randomUUID(),
    type: "heading",
    props: { level },
    content: inline(`Heading level ${level}`),
    children: [],
  })),
  {
    id: randomUUID(),
    type: "bulletListItem",
    content: inline("A list item"),
    children: [
      {
        id: randomUUID(),
        type: "paragraph",
        content: inline("Nested content"),
        children: [],
      },
    ],
  },
  {
    id: randomUUID(),
    type: "codeBlock",
    props: { language: "text" },
    content: inline("route via gateway\n    next hop"),
    children: [],
  },
];
const patched = await api.patch(`/api/v1/notes/${daily.id}`, {
  data: {
    revision: daily.revision,
    document: { schemaVersion: 1, blocks: document },
  },
});
assert.ok(patched.ok(), await patched.text());
const axe = readFileSync("node_modules/axe-core/axe.min.js", "utf8");
const reports = [],
  failures = [];
const engines = process.argv.slice(3);
const check = (condition, label) => {
  if (!condition) failures.push(label);
};
async function navigate(page, section, width) {
  const back = page.getByRole("button", { name: "Back to notes", exact: true });
  if (await back.isVisible()) await back.click();
  if (width < 1024)
    await page
      .getByRole("button", { name: "Open navigation", exact: true })
      .first()
      .click();
  await page
    .getByRole("button", { name: section, exact: true })
    .first()
    .click();
  if (width < 1024)
    await page.locator(".mobile-navigation").waitFor({ state: "hidden" });
}
async function inspectViewer(page, label) {
  const fit = await page.evaluate(() => {
    const dialog = document.querySelector(".artifact-viewer"),
      body = dialog.querySelector(".artifact-viewer-body"),
      header = dialog.querySelector(".artifact-viewer-header"),
      footer = dialog.querySelector(".artifact-viewer-footer");
    const r = dialog.getBoundingClientRect(),
      buttons = [...footer.children].map((e) => e.getBoundingClientRect());
    const initial = header.getBoundingClientRect().top;
    body.scrollTop = body.scrollHeight;
    return {
      contained:
        r.x >= -1 &&
        r.right <= innerWidth + 1 &&
        r.y >= -1 &&
        r.bottom <= innerHeight + 1,
      noOverflow:
        dialog.scrollWidth <= dialog.clientWidth + 1 &&
        body.scrollWidth <= body.clientWidth + 1,
      fixedHeader: Math.abs(initial - header.getBoundingClientRect().top) < 1,
      fixedFooter: footer.getBoundingClientRect().bottom <= r.bottom + 1,
      alignedActions: buttons.every(
        (b) =>
          Math.abs(b.top - buttons[0].top) <= 1 &&
          Math.abs(b.height - buttons[0].height) <= 1,
      ),
      closeVisible:
        header
          .querySelector('[data-slot="dialog-close"]')
          .getBoundingClientRect().bottom <= r.bottom,
      textareaBounded:
        !dialog.querySelector("textarea") ||
        dialog.querySelector("textarea").clientHeight < innerHeight,
    };
  });
  for (const [key, passed] of Object.entries(fit))
    check(passed, label + " " + key);
  return fit;
}
for (const [name, engine] of Object.entries({ chromium, firefox, webkit })) {
  if (engines.length && !engines.includes(name)) continue;
  const browser = await engine.launch(
    name === "chromium" ? { channel: "chrome" } : {},
  );
  const sizes =
    name === "chromium"
      ? [
          [320, 700],
          [390, 844],
          [768, 1024],
          [1440, 900],
          [844, 390],
        ]
      : [
          [390, 844],
          [1440, 900],
        ];
  try {
    for (const [width, height] of sizes)
      for (const theme of ["light", "dark"]) {
        const context = await browser.newContext({
          viewport: { width, height },
          colorScheme: theme,
          storageState: session,
          hasTouch: width < 1024,
          serviceWorkers: "block",
        });
        const page = await context.newPage();
        await page.addInitScript((theme) => {
          localStorage.setItem("nivra-theme", theme);
        }, theme);
        page.setDefaultTimeout(15000);
        const errors = [];
        page.on("pageerror", (e) => errors.push(e.message));
        try {
          await page.goto(base, { waitUntil: "domcontentloaded" });
          await page
            .getByRole("button", { name: "Settings", exact: true })
            .count();
          await page.waitForFunction(
            (theme) =>
              document.documentElement.classList.contains("dark") ===
              (theme === "dark"),
            theme,
          );
          const label = `${name}-${width}-${height}-${theme}`;
          const sections = [];
          for (const section of [
            "Overview",
            "Tasks",
            "Bookmarks",
            "Artifacts",
          ]) {
            await navigate(page, section, width);
            await page
              .getByRole("heading", { name: section, exact: true })
              .waitFor();
            const metrics = await page.evaluate(() => {
              const e = document.querySelector(".section-content"),
                h = e.querySelector("h1"),
                r = e.getBoundingClientRect();
              return {
                headingX: Math.round(h.getBoundingClientRect().x),
                contentX: Math.round(
                  r.x + parseFloat(getComputedStyle(e).paddingLeft),
                ),
                overflow: document.documentElement.scrollWidth > innerWidth,
                oldBar: !!document.querySelector(".tasks-header"),
                refresh: !!document.querySelector(
                  'button[aria-label^="Refresh "]',
                ),
              };
            });
            check(
              metrics.headingX === metrics.contentX,
              label + " " + section + " heading alignment",
            );
            check(
              !metrics.overflow && !metrics.oldBar && !metrics.refresh,
              label + " " + section + " no redundant bar or overflow",
            );
            sections.push({ section, ...metrics });
            if (section === "Overview") {
              const overview = await page.evaluate(() => {
                const header = document.querySelector(".overview-header");
                const heading = header
                  .querySelector(".section-heading")
                  .getBoundingClientRect();
                const clock = header
                  .querySelector(".overview-clock")
                  .getBoundingClientRect();
                const content = document.querySelector(".overview-content");
                const bounds = content.getBoundingClientRect();
                return {
                  heading: {
                    x: heading.x,
                    y: heading.y,
                    right: heading.right,
                    bottom: heading.bottom,
                  },
                  clock: { x: clock.x, y: clock.y, right: clock.right },
                  edge:
                    bounds.right -
                    parseFloat(getComputedStyle(content).paddingRight),
                  columns: getComputedStyle(
                    document.querySelector(".overview-grid"),
                  ).gridTemplateColumns.split(" ").length,
                };
              });
              check(
                width >= 1024
                  ? Math.abs(overview.clock.y - overview.heading.y) < 1 &&
                      Math.abs(overview.clock.right - overview.edge) < 1
                  : Math.abs(overview.clock.x - overview.heading.x) < 1 &&
                      overview.clock.y >= overview.heading.bottom,
                label + " overview responsive clock placement",
              );
              check(
                overview.columns ===
                  (width >= 1280 ? 3 : width >= 1024 ? 2 : 1),
                label + " overview card columns",
              );
              await page.screenshot({
                path: path.join(output, label + "-overview.png"),
              });
            }
            if ([390, 1440].includes(width) && section === "Artifacts")
              await page.screenshot({
                path: path.join(output, label + "-artifacts.png"),
              });
          }
          await page
            .getByRole("button", {
              name: "Open Long terminal text",
              exact: true,
            })
            .click();
          await page
            .getByRole("textbox", { name: "Text", exact: true })
            .waitFor();
          const textViewer = await inspectViewer(page, label + " text viewer");
          if ([390, 1440].includes(width))
            await page.screenshot({
              path: path.join(output, label + "-long-text.png"),
            });
          if (name === "chromium" && width === 1440 && theme === "light") {
            const field = page.getByRole("textbox", {
              name: "Text",
              exact: true,
            });
            await field.fill(text + "\nUnfinished text draft", {
              timeout: 60000,
            });
            await page
              .getByRole("textbox", { name: "Title", exact: true })
              .fill("Renamed terminal");
            const renamedResponse = page.waitForResponse(
              (r) =>
                r.url().endsWith(`/artifacts/${saved.id}`) &&
                r.request().method() === "PATCH",
            );
            await field.focus();
            await renamedResponse;
            check(
              (await field.inputValue()).endsWith("Unfinished text draft"),
              label + " rename preserves draft",
            );

            const savedResponse = page.waitForResponse(
              (r) =>
                r.url().endsWith(`/artifacts/${saved.id}`) &&
                r.request().method() === "PATCH",
            );
            await page
              .getByRole("button", { name: "Save changes", exact: true })
              .click();
            await savedResponse;
          }
          await page
            .getByRole("button", { name: "Close", exact: true })
            .click();
          const savedTitle = (
            await (await api.get(`/api/v1/artifacts/${saved.id}`)).json()
          ).title;
          if (savedTitle !== "Long terminal text")
            await api.patch(`/api/v1/artifacts/${saved.id}`, {
              data: {
                revision: (
                  await (await api.get(`/api/v1/artifacts/${saved.id}`)).json()
                ).revision,
                title: "Long terminal text",
              },
            });
          await page
            .getByRole("button", {
              name: "Open Rotated invoice.png",
              exact: true,
            })
            .click();
          await page
            .locator(".artifact-text")
            .filter({ hasText: "Northwind" })
            .waitFor();
          const imageViewer = await inspectViewer(
            page,
            label + " image viewer",
          );
          if ([390, 1440].includes(width))
            await page.screenshot({
              path: path.join(output, label + "-image.png"),
            });
          await page
            .getByRole("button", { name: "Close", exact: true })
            .click();
          await navigate(page, "Journal", width);
          check(
            await page
              .locator(".list-header")
              .evaluate(
                (e) =>
                  Math.abs(
                    e.querySelector("h1").getBoundingClientRect().x -
                      e.getBoundingClientRect().x -
                      parseFloat(getComputedStyle(e).paddingLeft),
                  ) <= 1,
              ),
            label + " list heading alignment",
          );
          await page.getByText("2026-10-06", { exact: true }).first().click();
          await page.locator(".bn-editor").waitFor();
          await page
            .getByText("Journal body alignment check", { exact: true })
            .waitFor();
          const journal = await page.evaluate(() => {
            const title = document.querySelector(".note-title"),
              date = document.querySelector(".note-date"),
              tags = document.querySelector(".note-tags"),
              p = document.querySelector(
                '.writing-surface .bn-block-content[data-content-type="paragraph"]',
              );
            return {
              aligned: [date, tags, p].every(
                (e) =>
                  Math.abs(
                    e.getBoundingClientRect().x -
                      title.getBoundingClientRect().x,
                  ) <= 1,
              ),
              bodyOverflow: document.documentElement.scrollWidth > innerWidth,
              oldTopbar: !!document.querySelector(".note-topbar"),
              levels: [
                ...document.querySelectorAll(
                  ".bn-editor h1, .bn-editor h2, .bn-editor h3, .bn-editor h4, .bn-editor h5, .bn-editor h6",
                ),
              ].map((e) => ({
                level: Number(e.tagName.slice(1)),
                size: parseFloat(getComputedStyle(e).fontSize),
              })),
            };
          });
          check(
            journal.aligned && !journal.bodyOverflow && !journal.oldTopbar,
            label + " journal alignment",
          );
          check(journal.levels.length === 6, label + " real heading hierarchy");
          check(
            JSON.stringify(journal.levels.map((h) => h.size)) ===
              JSON.stringify(
                width <= 767
                  ? [24, 20, 18, 16, 16, 16]
                  : [24, 20, 18, 16, 15, 14],
              ),
            label + " heading sizes",
          );
          await page.addScriptTag({ content: axe });
          const violations = await page.evaluate(() =>
            window.axe
              .run(document, {
                runOnly: {
                  type: "tag",
                  values: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"],
                },
              })
              .then((r) => r.violations.map((v) => v.id)),
          );
          check(
            violations.length === 0,
            label + " axe " + violations.join(","),
          );
          check(
            errors.length === 0,
            label + " page errors " + errors.join(","),
          );
          if ([390, 1440].includes(width))
            await page.screenshot({
              path: path.join(output, label + "-journal.png"),
            });
          reports.push({
            label,
            sections,
            textViewer,
            imageViewer,
            journal,
            violations,
            errors,
          });
          console.log(label + " checked");
        } finally {
          await context.close();
        }
      }
  } finally {
    await browser.close();
  }
}
await api.dispose();
writeFileSync(
  path.join(root, "layout-results.json"),
  JSON.stringify({ reports, failures }, null, 2),
);
assert.deepEqual(failures, []);
console.log(
  `${reports.length} viewport/theme cases passed; captures: ${output}`,
);
