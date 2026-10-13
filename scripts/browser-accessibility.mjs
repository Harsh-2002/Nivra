import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { chromium, firefox, webkit, request } from "playwright";

const base = process.env.NIVRA_BROWSER_TEST_URL ?? "http://localhost:3015";
assert.equal(new URL(base).port, "3015", "Use the disposable audit instance");
assert.ok(
  process.env.NIVRA_BROWSER_SESSION,
  "Synthetic owner session required",
);
const output =
  process.env.NIVRA_BROWSER_REVIEW_DIR ?? ".impeccable/review/accessibility";
await mkdir(output, { recursive: true });
const owner = await request.newContext({
  baseURL: base,
  storageState: process.env.NIVRA_BROWSER_SESSION,
  extraHTTPHeaders: { origin: base },
});
async function api(path, data, method = data === undefined ? "GET" : "POST") {
  const response = await owner.fetch(`/api/v1/${path}`, {
    method,
    data,
    maxRetries: method === "GET" ? 1 : 0,
  });
  assert.ok(response.ok(), `Fixture ${method} ${path}: ${response.status()}`);
  const body = await response.json();
  await response.dispose();
  return body;
}
const status = await api("status");
assert.match(
  status.owner?.name ?? "",
  /review|test|audit/i,
  "Synthetic owner required",
);
function auditEditorDocument() {
  return {
    schemaVersion: 1,
    blocks: [
      {
        type: "heading",
        props: { level: 1 },
        content: [{ type: "text", text: "Accessible writing", styles: {} }],
      },
      ...[2, 3, 4, 5, 6].map((level) => ({
        type: "heading",
        props: { level },
        content: [
          {
            type: "text",
            text: `Editor heading level ${level}`,
            styles: {},
          },
        ],
      })),
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text: "Synthetic content for responsive and keyboard checks.",
            styles: {},
          },
        ],
      },
      {
        type: "bulletListItem",
        content: [
          { type: "text", text: "Keep useful ideas together", styles: {} },
        ],
        children: [
          {
            type: "numberedListItem",
            content: [
              {
                type: "text",
                text: "Nested items stay readable",
                styles: {},
              },
            ],
          },
        ],
      },
      {
        type: "codeBlock",
        props: { language: "typescript" },
        content: [
          {
            type: "text",
            text: "const reviewReady = true;",
            styles: {},
          },
        ],
      },
      {
        type: "diagram",
        props: {},
        content: [
          {
            type: "text",
            text: "graph TD\n  A[Capture] --> B[Review]",
            styles: {},
          },
        ],
        children: [],
      },
    ],
  };
}
const fixturePath =
  process.env.NIVRA_AUDIT_FIXTURES ?? `${output}/fixtures.json`;
let fixtures;
try {
  fixtures = JSON.parse(await readFile(fixturePath, "utf8"));
} catch {
  const stamp = randomUUID().slice(0, 8);
  const tag = await api("tags", { name: `Audit ${stamp}`, color: "gray" });
  const note = await api("notes", {
    title: `Audit writing ${stamp}`,
    document: auditEditorDocument(),
  });
  await api(
    `notes/${note.id}`,
    { revision: note.revision, favorite: true },
    "PATCH",
  );
  const current = await api(`notes/${note.id}`);
  await api(
    `item-tags/note/${note.id}`,
    { revision: current.revision, tags: [tag.id] },
    "PATCH",
  );
  const journal = await api("journals", {
    date: new Date().toISOString().slice(0, 10),
  });
  const board = await api("boards", { name: `Audit project ${stamp}` });
  const task = await api("tasks", {
    title: `Audit task ${stamp}`,
    boardId: board.id,
    dueDate: new Date().toISOString().slice(0, 10),
  });
  const bookmark = await api("bookmarks", {
    url: `https://example.invalid/${stamp}`,
    collection: "Audit",
  });
  const artifact = await api("artifacts", {
    text: `Audit artifact ${stamp}\nSynthetic searchable text.`,
  });
  const event = await api("events", {
    title: `Audit event ${stamp}`,
    start: new Date().toISOString().slice(0, 10),
    end: new Date(Date.now() + 86400000).toISOString().slice(0, 10),
    timezone: "UTC",
  });
  const form = await api("forms", {
    definition: {
      schemaVersion: 1,
      title: `Audit form ${stamp}`,
      fields: [
        { id: randomUUID(), type: "short_text", label: "Name" },
        { id: randomUUID(), type: "email", label: "Email", required: true },
      ],
    },
  });
  const trashed = await api("tasks", { title: `Audit deleted item ${stamp}` });
  await api(`tasks/${trashed.id}`, { revision: trashed.revision }, "DELETE");
  fixtures = {
    note,
    journal,
    board,
    task,
    bookmark,
    artifact,
    event,
    form,
    tag,
  };
  await writeFile(fixturePath, JSON.stringify(fixtures));
}
const existingEditorNote = await api(`notes/${fixtures.note.id}`);
if (
  !JSON.stringify(existingEditorNote.document).includes(
    "Editor heading level 6",
  )
) {
  fixtures.note = await api(
    `notes/${fixtures.note.id}`,
    { revision: existingEditorNote.revision, document: auditEditorDocument() },
    "PATCH",
  );
  await writeFile(fixturePath, JSON.stringify(fixtures));
}
if (!fixtures.template) {
  fixtures.template = await api("templates", {
    name: `Audit journal template ${fixtures.note.id.slice(0, 8)}`,
    description: "Synthetic template for the interface audit.",
    kind: "journal",
    document: {
      schemaVersion: 1,
      blocks: [
        {
          type: "heading",
          props: { level: 2 },
          content: [{ type: "text", text: "What happened?", styles: {} }],
        },
        {
          type: "paragraph",
          content: [{ type: "text", text: "{{date}} · {{time}}", styles: {} }],
        },
      ],
    },
  });
  await writeFile(fixturePath, JSON.stringify(fixtures));
}
const axe = await readFile("node_modules/axe-core/axe.min.js", "utf8");
const reports = [];
const routes = [
  "overview",
  "notes",
  "journal",
  "tasks",
  "calendar",
  "bookmarks",
  "artifacts",
  "forms",
  "favorites",
  "trash",
  "capture",
  "search",
  "settings",
];
const baselineWidths = (
  process.env.NIVRA_AUDIT_WIDTHS ?? "320,390,640,768,1024,1440,2560"
)
  .split(",")
  .map(Number);
const mode = process.env.NIVRA_AUDIT_MODE ?? "scan";
const selectedRoutes = process.env.NIVRA_AUDIT_SECTIONS?.split(",") ?? routes;
assert.ok(
  selectedRoutes.length &&
    selectedRoutes.every((route) =>
      [...routes, "search", "settings"].includes(route),
    ),
  "Supported sections required",
);
assert.ok(
  ["scan", "verify", "layout"].includes(mode),
  "Supported audit mode required",
);
assert.ok(
  baselineWidths.length &&
    baselineWidths.every((width) => Number.isFinite(width) && width >= 320),
  "Valid viewport widths required",
);
assert.ok(
  ["chromium", "firefox", "webkit"].includes(
    process.env.NIVRA_AUDIT_ENGINE ?? "chromium",
  ),
  "Supported browser engine required",
);
if (!fixtures.longTag) {
  fixtures.longTag = await api("tags", {
    name: `Audit${"LongTag".repeat(6)}`,
    color: "gray",
  });
  const note = await api(`notes/${fixtures.note.id}`);
  await api(
    `item-tags/note/${note.id}`,
    { revision: note.revision, tags: [fixtures.tag.id, fixtures.longTag.id] },
    "PATCH",
  );
  await writeFile(fixturePath, JSON.stringify(fixtures));
}
for (const [key, start, end] of [
  ["timedEvent", "09:00", "09:05"],
  ["timedNext", "09:05", "09:10"],
])
  if (!fixtures[key]) {
    const date = new Date().toISOString().slice(0, 10);
    fixtures[key] = await api("events", {
      title: `Audit ${key} ${fixtures.note.id.slice(0, 8)}`,
      allDay: false,
      start: `${date}T${start}`,
      end: `${date}T${end}`,
      timezone: "UTC",
    });
    await writeFile(fixturePath, JSON.stringify(fixtures));
  }
if (!fixtures.shortSlotEvent) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + 1);
  fixtures.shortSlotDate = date.toISOString().slice(0, 10);
  fixtures.shortSlotEvent = await api("events", {
    title: `Audit short slot ${fixtures.note.id.slice(0, 8)}`,
    allDay: false,
    start: `${fixtures.shortSlotDate}T09:00`,
    end: `${fixtures.shortSlotDate}T09:05`,
    timezone: "UTC",
  });
  await writeFile(fixturePath, JSON.stringify(fixtures));
}
if (mode !== "layout") {
  const current = await api(`forms/${fixtures.form.id}`);
  const published = current.publicToken
    ? current
    : await api(`forms/${current.id}/publish`, { revision: current.revision });
  fixtures.formUrl = published.url;
  const note = await api(`notes/${fixtures.note.id}`);
  const publication =
    (await api(`notes/${note.id}/publication`)) ??
    (await api(`notes/${note.id}/publication`, { revision: note.revision }));
  fixtures.shareUrl = publication.url;
  await writeFile(fixturePath, JSON.stringify(fixtures));
}
if (mode !== "layout") {
  const wav = Buffer.alloc(16044);
  wav.write("RIFF");
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24);
  wav.writeUInt32LE(16000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(16000, 40);
  for (const [key, extension, mimeType, buffer] of [
    ["image", "png", "image/png", await readFile("public/icons/icon-192.png")],
    [
      "binary",
      "bin",
      "application/octet-stream",
      Buffer.from([0, 1, 2, 3, 0, 255]),
    ],
    ["audio", "wav", "audio/wav", wav],
  ])
    if (!fixtures[key]) {
      const response = await owner.post("/api/v1/artifacts", {
        multipart: {
          file: {
            name: `Audit ${key} ${fixtures.note.id.slice(0, 8)}.${extension}`,
            mimeType,
            buffer,
          },
        },
      });
      assert.ok(response.ok(), `Synthetic ${key} upload: ${response.status()}`);
      fixtures[key] = await response.json();
      await response.dispose();
      await writeFile(fixturePath, JSON.stringify(fixtures));
    }
}
async function inspect(page, surface, width, theme, engine, full = true) {
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(async () => {
    await Promise.allSettled(
      document
        .getAnimations()
        .filter(
          (animation) => animation.effect?.getTiming().iterations !== Infinity,
        )
        .map((animation) => animation.finished),
    );
  });
  const geometry = await page.evaluate(() => {
    const visible = (e) => {
      const r = e.getBoundingClientRect(),
        s = getComputedStyle(e);
      return (
        r.width > 0 &&
        r.height > 0 &&
        s.visibility !== "hidden" &&
        s.display !== "none" &&
        !e.closest("[inert],[aria-hidden='true']")
      );
    };
    const controls = [
      ...document.querySelectorAll(
        "button,a[href],input:not([type=hidden]),textarea,[role=tab],[role=option],[role=menuitem]",
      ),
    ].filter(visible);
    const name = (e) =>
      e.getAttribute("aria-label") ??
      e.labels?.[0]?.textContent?.trim() ??
      e.textContent?.trim().slice(0, 70) ??
      e.id;
    const small = controls
      .filter(
        (e) =>
          !e.disabled &&
          !e.closest(".bn-editor") &&
          !["checkbox", "radio"].includes(e.getAttribute("role")) &&
          !["checkbox", "radio"].includes(e.getAttribute("type")),
      )
      .map((e) => {
        const r = e.getBoundingClientRect();
        return {
          name: name(e),
          slot: e.dataset.slot,
          className: String(e.className),
          width: Math.round(r.width * 100) / 100,
          height: Math.round(r.height * 100) / 100,
        };
      })
      .filter((e) => e.width < 44 || e.height < 44);
    const yearControls = [...document.querySelectorAll(".schedule-year button")]
      .filter(visible)
      .map((element) => element.getBoundingClientRect())
      .sort((a, b) => a.top - b.top);
    const overlappingCalendar = yearControls.some((rect, index) => {
      for (
        let next = index + 1;
        next < yearControls.length && yearControls[next].top < rect.bottom - 1;
        next++
      ) {
        const other = yearControls[next];
        if (
          Math.min(rect.right, other.right) >
            Math.max(rect.left, other.left) + 1 &&
          Math.min(rect.bottom, other.bottom) >
            Math.max(rect.top, other.top) + 1
        )
          return true;
      }
      return false;
    });
    return {
      overlappingCalendar,
      overlappingTimedEvents: [
        ...document.querySelectorAll(".schedule-time-hours"),
      ].some((day) => {
        const cards = [...day.querySelectorAll(".schedule-time-entry")]
          .filter(visible)
          .map((e) => e.getBoundingClientRect());
        return cards.some((a, i) =>
          cards
            .slice(i + 1)
            .some(
              (b) =>
                Math.min(a.right, b.right) > Math.max(a.left, b.left) + 1 &&
                Math.min(a.bottom, b.bottom) > Math.max(a.top, b.top) + 1,
            ),
        );
      }),
      clippedTimedEvents: [...document.querySelectorAll(".schedule-time-entry")]
        .filter(visible)
        .some((e) => e.scrollHeight > e.clientHeight + 1),
      overflow: document.documentElement.scrollWidth > innerWidth + 1,
      clippedTags: [...document.querySelectorAll(".note-tags")]
        .filter(visible)
        .some((element) => element.scrollWidth > element.clientWidth + 1),
      small,
      smallInputs: controls
        .filter(
          (e) =>
            e.matches("input,textarea") &&
            innerWidth < 768 &&
            parseFloat(getComputedStyle(e).fontSize) < 16,
        )
        .map(name),
      unnamed: controls
        .filter((e) => e.matches("button,a") && !name(e))
        .map((e) => e.outerHTML.slice(0, 250)),
    };
  });
  let violations = [],
    incomplete = [];
  if (full && (mode !== "layout" || surface === "calendar-year")) {
    await page.evaluate(axe);
    const result = await page.evaluate(async (yearOnly) => {
      const result = await window.axe.run(document, {
        runOnly: yearOnly
          ? { type: "rule", values: ["target-size"] }
          : {
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
      const summarize = (items) =>
        items.map((v) => ({
          id: v.id,
          impact: v.impact,
          description: v.description,
          nodes: v.nodes.map((n) => ({
            target: n.target,
            failure: n.failureSummary,
          })),
        }));
      return {
        violations: summarize(result.violations),
        incomplete: summarize(result.incomplete),
      };
    }, mode === "layout");
    ({ violations, incomplete } = result);
  }
  reports.push({
    surface,
    width,
    height: page.viewportSize().height,
    theme,
    engine,
    ...geometry,
    violations,
    incomplete,
  });
  if ([320, 390, 768, 1440].includes(width))
    await page.screenshot({
      path: `${output}/${engine}-${width}-${theme}-${surface.replaceAll(" ", "-")}.png`,
    });
  await writeFile(
    `${output}/report-${engine}-${mode}.json`,
    JSON.stringify(reports, null, 2),
  );
  console.log(
    `${engine} ${width} ${theme} ${surface}: axe=${violations.length}, small=${geometry.small.length}, overflow=${geometry.overflow}`,
  );
}
async function ready(page, path) {
  await page.goto(base + path);
  await page
    .locator(path === "/capture" ? ".capture-page" : ".workspace")
    .waitFor();
  if (path === "/capture")
    await page
      .getByRole("combobox", { name: "Save as", exact: true })
      .waitFor();
  else
    await page
      .locator('[data-slot="skeleton"]')
      .first()
      .waitFor({ state: "detached" });
  await page.evaluate(async () => {
    await Promise.allSettled(
      document
        .getAnimations()
        .filter((a) => a.effect?.getTiming().iterations !== Infinity)
        .map((a) => a.finished),
    );
  });
}
try {
  for (const [engineName, engine] of Object.entries({
    chromium,
    firefox,
    webkit,
  })) {
    if (engineName !== (process.env.NIVRA_AUDIT_ENGINE ?? "chromium")) continue;
    const browser = await engine.launch(
      engineName === "chromium" ? { args: ["--disable-dev-shm-usage"] } : {},
    );
    try {
      for (const width of baselineWidths)
        for (const theme of (
          process.env.NIVRA_AUDIT_THEMES ?? "light,dark"
        ).split(",")) {
          await api("settings", { theme }, "PATCH");
          const context = await browser.newContext({
            storageState: await owner.storageState(),
            viewport: {
              width,
              height:
                Number(process.env.NIVRA_AUDIT_HEIGHT) ||
                (width === 320
                  ? 568
                  : width === 844
                    ? 390
                    : width === 768
                      ? 1024
                      : 900),
            },
            colorScheme: theme,
            hasTouch: width < 1024 || process.env.NIVRA_AUDIT_TOUCH === "1",
            serviceWorkers: "block",
          });
          let page;
          const errors = [];
          async function navigate(path) {
            if (page) await page.close();
            page = await context.newPage();
            page.on("pageerror", (e) => errors.push(e.message));
            await ready(page, path);
          }
          for (const route of selectedRoutes) {
            await navigate(`/${route}`);
            await inspect(page, route, width, theme, engineName);
            if (route === "bookmarks" && [390, 1440].includes(width)) {
              const originalLink = page.locator(
                `a.bookmark-link[href=${JSON.stringify(fixtures.bookmark.url)}]`,
              );
              await originalLink.waitFor();
              assert.equal(
                await originalLink.getAttribute("target"),
                "_blank",
                "A bookmark opens its original URL in a new tab",
              );
              assert.match(
                await originalLink.getAttribute("rel"),
                /noopener/,
                "A new bookmark tab is isolated from its opener",
              );
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
              assert.equal(
                popup.url(),
                fixtures.bookmark.url,
                "The new tab opens the saved original URL",
              );
              await popup.close();
              await context.unroute("https://example.invalid/**");
              assert.equal(
                await page.getByRole("dialog").count(),
                0,
                "Opening a bookmark does not launch an in-app reader dialog",
              );
            }
          }
          if (mode === "layout") {
            await navigate("/calendar?view=year");
            await inspect(page, "calendar-year", width, theme, engineName);
            assert.deepEqual(
              errors,
              [],
              `${engineName} ${width} ${theme}: browser errors`,
            );
            await context.close();
            continue;
          }
          for (const [surface, path] of [
            ["tag", `/notes?tag=${fixtures.tag.id}`],
            ["editor", `/notes?note=${fixtures.note.id}`],
            ["board", `/tasks?view=board&board=${fixtures.board.id}`],
            ["form-builder", `/forms/${fixtures.form.id}/build`],
            ["form-share", `/forms/${fixtures.form.id}/share`],
            ["form-responses", `/forms/${fixtures.form.id}/responses`],
            ["task-details", `/tasks?task=${fixtures.task.id}`],
            ["artifact-details", "/artifacts"],
            ["event", `/calendar?event=${fixtures.event.id}`],
          ]) {
            await navigate(path);
            if (surface === "editor") {
              await page.locator(".bn-editor").waitFor();
              for (const level of [1, 2, 3, 4, 5, 6])
                assert.ok(
                  (await page.locator(`.bn-editor h${level}`).count()) >= 1,
                  `Editor fixture renders an H${level} heading`,
                );
              assert.ok(
                (await page.locator(".bn-editor pre code").count()) >= 1,
                "Editor fixture renders its source/code block",
              );
            }
            if (surface === "artifact-details")
              await page
                .getByRole("button", {
                  name: `Open ${fixtures.artifact.title}`,
                  exact: true,
                })
                .click();
            if (surface === "task-details")
              await page
                .getByRole("dialog", { name: "Task details", exact: true })
                .waitFor();
            if (["event", "artifact-details"].includes(surface))
              await page.getByRole("dialog").waitFor();
            await inspect(page, surface, width, theme, engineName);
            if (surface === "form-builder" && [390, 1440].includes(width)) {
              await page
                .getByRole("button", { name: "Preview", exact: true })
                .click();
              await page.getByRole("dialog").waitFor();
              await inspect(page, "form-preview", width, theme, engineName);
            }
          }
          await navigate(`/journal?note=${fixtures.journal.id}`);
          const review = page.locator(".journal-review");
          if (!(await review.isVisible().catch(() => false))) {
            await page
              .getByRole("group", { name: "Journal view" })
              .getByRole("button", { name: "Activity", exact: true })
              .click();
          }
          await review.waitFor();
          await page
            .getByRole("heading", { name: "Journal review", exact: true })
            .waitFor();
          await page.waitForFunction(() => {
            const panel = document.querySelector(".journal-review");
            return (
              !!panel &&
              ![...panel.querySelectorAll('[role="status"]')].some((node) =>
                node.textContent?.includes("Loading this period"),
              )
            );
          });
          assert.equal(
            await review.getByRole("alert").count(),
            0,
            "Journal review fixture loads without an API error",
          );
          await inspect(page, "journal-review", width, theme, engineName);

          await navigate("/journal");
          await page
            .getByRole("button", { name: "Browse templates", exact: true })
            .click();
          await page.locator(".writing-template-picker").waitFor();
          const templateRow = page
            .locator(".writing-template-row")
            .filter({ hasText: fixtures.template.name });
          await templateRow.waitFor();
          await templateRow.click();
          await page.locator(".writing-template-detail").waitFor();
          await inspect(page, "template-picker", width, theme, engineName);
          await page
            .getByRole("button", {
              name: `Edit ${fixtures.template.name}`,
              exact: true,
            })
            .click();
          await page.locator(".writing-template-editor").waitFor();
          await page.getByLabel("Name", { exact: true }).waitFor();
          await page.locator(".bn-editor").waitFor();
          await inspect(page, "template-editor", width, theme, engineName);
          await page
            .getByRole("button", { name: "Preview", exact: true })
            .click();
          await page
            .locator("#template-editor-content .writing-template-preview")
            .waitFor();
          await inspect(page, "template-preview", width, theme, engineName);

          if ([390, 1440, 1536].includes(width)) {
            for (const [kind, artifact] of [
              ["image", fixtures.image],
              ["binary", fixtures.binary],
              ["audio", fixtures.audio],
            ]) {
              await navigate("/artifacts");
              await page
                .getByRole("button", {
                  name: `Open ${artifact.name}`,
                  exact: true,
                })
                .click();
              await page.getByRole("dialog").waitFor();
              await inspect(page, `artifact-${kind}`, width, theme, engineName);
              if (kind === "audio") {
                await page
                  .getByRole("button", { name: "Volume", exact: true })
                  .click();
                await page.locator(".media-volume").waitFor();
                await inspect(page, "media-volume", width, theme, engineName);
              }
            }
            for (const view of ["week", "day", "year"]) {
              await navigate(`/calendar?view=${view}`);
              if (["week", "day"].includes(view))
                await page
                  .locator("button:visible")
                  .filter({ hasText: fixtures.timedEvent.title })
                  .first()
                  .waitFor();
              await inspect(page, `calendar-${view}`, width, theme, engineName);
              if (view === "day" && [390, 1440].includes(width)) {
                await navigate(
                  `/calendar?view=day&date=${fixtures.shortSlotDate}`,
                );
                await page
                  .locator("button:visible")
                  .filter({ hasText: fixtures.shortSlotEvent.title })
                  .first()
                  .waitFor();
                if (width === 1440) {
                  assert.equal(
                    await page.locator(".schedule-time-slot-0-18").count(),
                    0,
                    "A five-minute event hides only its covered 09:00 slot",
                  );
                  const adjacentSlot = page.locator(".schedule-time-slot-0-19");
                  await adjacentSlot.waitFor({ state: "visible" });
                  assert.ok(
                    await adjacentSlot.evaluate(
                      (element) =>
                        element.getBoundingClientRect().height >= 23.9,
                    ),
                    "The free 09:30 slot keeps a 24px target height",
                  );
                  const precedingSlot = page.locator(
                    ".schedule-time-slot-0-17",
                  );
                  await precedingSlot.focus();
                  await precedingSlot.press("ArrowDown");
                  assert.ok(
                    await adjacentSlot.evaluate(
                      (element) => document.activeElement === element,
                    ),
                    "ArrowDown skips the occupied 09:00 slot and focuses 09:30",
                  );
                  await adjacentSlot.focus();
                  assert.ok(
                    await adjacentSlot.evaluate(
                      (element) => document.activeElement === element,
                    ),
                    "The free 09:30 slot remains focusable",
                  );
                }
                await inspect(
                  page,
                  "calendar-short-slot",
                  width,
                  theme,
                  engineName,
                );
              }
            }
            await navigate("/calendar?mode=activity");
            await inspect(page, "calendar-activity", width, theme, engineName);
            await navigate("/tasks");
            await page
              .getByRole("combobox", { name: "Select board", exact: true })
              .click();
            await page
              .getByRole("combobox", { name: "Find a board", exact: true })
              .fill("No-board-matches-audit");
            await page
              .getByRole("status")
              .filter({ hasText: "No boards." })
              .waitFor();
            await inspect(page, "board-picker-empty", width, theme, engineName);
            await navigate("/calendar");
            await page
              .getByRole("button", { name: "Go to date", exact: true })
              .click();
            await page.locator(".date-picker-popover").waitFor();
            await inspect(page, "date-picker", width, theme, engineName);
            await navigate(`/forms/${fixtures.form.id}/build`);
            await page.getByRole("button", { name: /^Edit tags for/ }).click();
            await page.locator(".item-tag-options").waitFor();
            await inspect(page, "tag-picker", width, theme, engineName);
          }
          await navigate("/search");
          await page
            .getByRole("combobox", { name: "Search everything", exact: true })
            .waitFor();
          await page
            .getByRole("combobox", { name: "Search everything", exact: true })
            .fill("Audit");
          await page.getByRole("option").first().waitFor();
          await inspect(page, "search", width, theme, engineName);
          const searchHeight = (
            await page.locator(".global-search-dialog").boundingBox()
          ).height;
          await page
            .getByRole("combobox", { name: "Search everything", exact: true })
            .fill("No-search-matches-audit");
          await page
            .getByRole("status")
            .filter({ hasText: "No matching items." })
            .waitFor();
          await inspect(page, "search-empty", width, theme, engineName);
          assert.ok(
            Math.abs(
              (await page.locator(".global-search-dialog").boundingBox())
                .height - searchHeight,
            ) <= 1,
            "Search empty state retains its height",
          );
          await page.route("**/api/v1/search?*", (route) =>
            route.fulfill({
              status: 503,
              contentType: "application/json",
              body: JSON.stringify({
                code: "unavailable",
                error: "Search temporarily unavailable.",
              }),
            }),
          );
          await page
            .getByRole("combobox", { name: "Search everything", exact: true })
            .fill("Unavailable audit search");
          await page.getByRole("alert").filter({ hasText: "retry" }).waitFor();
          await page
            .getByRole("alert")
            .filter({ hasText: "Search temporarily unavailable." })
            .waitFor();
          assert.equal(
            await page.getByText("[object Object]", { exact: false }).count(),
            0,
            "API errors remain readable",
          );
          await inspect(page, "search-error", width, theme, engineName);
          assert.ok(
            Math.abs(
              (await page.locator(".global-search-dialog").boundingBox())
                .height - searchHeight,
            ) <= 1,
            "Search error state retains its height",
          );
          await navigate("/settings");
          await page
            .getByRole("tab", { name: "Account", exact: true })
            .waitFor();
          for (const tab of ["Account", "Import & export", "System", "MCP"]) {
            await page.getByRole("tab", { name: tab, exact: true }).click();
            await page.locator(".settings-content").waitFor();
            await page
              .locator('[data-slot="skeleton"]')
              .first()
              .waitFor({ state: "detached" });
            await inspect(
              page,
              `settings-${tab.replaceAll(" & ", "-")}`,
              width,
              theme,
              engineName,
            );
            if (tab === "MCP") {
              await page
                .getByRole("button", { name: "New key", exact: true })
                .click();
              await page.getByLabel("Name", { exact: true }).waitFor();
              await inspect(page, "mcp-key-form", width, theme, engineName);
            }
          }
          await navigate("/overview");
          if (width < 1024) {
            await page
              .getByRole("button", { name: "Open navigation", exact: true })
              .first()
              .click();
            await page.locator(".mobile-navigation").waitFor();
            await inspect(page, "navigation", width, theme, engineName);
          }
          await page
            .getByRole("button", { name: "Quick", exact: true })
            .first()
            .click();
          await page
            .getByRole("dialog", { name: "Quick", exact: true })
            .waitFor();
          await inspect(page, "quick", width, theme, engineName);
          assert.deepEqual(
            errors,
            [],
            `${engineName} ${width} ${theme}: browser errors`,
          );
          await context.close();
          const anonymous = await browser.newContext({
            viewport: {
              width,
              height:
                Number(process.env.NIVRA_AUDIT_HEIGHT) ||
                (width === 320
                  ? 568
                  : width === 844
                    ? 390
                    : width === 768
                      ? 1024
                      : 900),
            },
            colorScheme: theme,
            hasTouch: width < 1024 || process.env.NIVRA_AUDIT_TOUCH === "1",
            serviceWorkers: "block",
          });
          const publicPage = await anonymous.newPage();
          publicPage.on("pageerror", (error) => errors.push(error.message));
          await publicPage.goto(base);
          await publicPage.locator(".auth-panel").waitFor();
          await inspect(publicPage, "login", width, theme, engineName);
          await publicPage
            .getByRole("button", { name: "Use recovery code", exact: true })
            .click();
          await inspect(publicPage, "recovery", width, theme, engineName);
          for (const [surface, url] of [
            ["public-note", fixtures.shareUrl],
            ["public-form", fixtures.formUrl],
            ["not-found", `${base}/missing-audit-page`],
            ["unavailable-share", `${base}/share/${"0".repeat(48)}`],
          ]) {
            await publicPage.goto(url);
            await inspect(publicPage, surface, width, theme, engineName);
          }
          assert.deepEqual(
            errors,
            [],
            `${engineName} ${width} ${theme}: public browser errors`,
          );
          await anonymous.close();
        }
    } finally {
      await browser.close();
    }
  }
  if (mode === "layout")
    assert.equal(
      reports.filter(
        (r) =>
          r.overflow ||
          r.clippedTags ||
          r.overlappingCalendar ||
          r.overlappingTimedEvents ||
          r.clippedTimedEvents ||
          r.violations.length,
      ).length,
      0,
      "Section overflow at a breakpoint; inspect the report",
    );
  if (mode === "verify") {
    assert.equal(
      reports.filter(
        (r) =>
          r.overflow ||
          r.clippedTags ||
          r.overlappingCalendar ||
          r.overlappingTimedEvents ||
          r.clippedTimedEvents ||
          r.violations.length ||
          r.unnamed.length ||
          r.smallInputs.length,
      ).length,
      0,
      "Unresolved accessibility or layout defects; inspect the report",
    );
  }
  console.log(
    `Audited ${reports.length} surfaces; ${reports.filter((r) => r.violations.length).length} with axe findings, ${reports.filter((r) => r.overflow).length} with document overflow.`,
  );
} finally {
  await owner.dispose();
}
