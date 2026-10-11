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
let status = await api("ai");
if (!status.enabled)
  await api("ai", "PATCH", { enabled: true, revision: status.revision });
const name = process.env.NIVRA_AUDIT_ENGINE ?? "chromium",
  engines = { chromium, firefox, webkit };
assert.ok(engines[name]);
const browser = await engines[name].launch();
const axe = await readFile("node_modules/axe-core/axe.min.js", "utf8");
const output = process.env.NIVRA_AUDIT_OUTPUT;
if (output) await mkdir(output, { recursive: true });
try {
  for (const width of (process.env.NIVRA_AUDIT_WIDTHS ?? "320,390,768,1440")
    .split(",")
    .map(Number))
    for (const theme of ["light", "dark"]) {
      const context = await browser.newContext({
        storageState: session,
        viewport: { width, height: 900 },
        colorScheme: theme,
        hasTouch: width < 1024,
        serviceWorkers: "block",
      });
      const page = await context.newPage(),
        errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      const title = `report-${randomUUID().slice(0, 8)}.pdf SQLite recovery`;
      const tag = await api("tags", "POST", {
        name: "Database checks",
        color: "gray",
        aliases: ["sqlite database queries indexes"],
      });
      const note = await api("notes", "POST", { title });
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
            .locator(".local-ai-suggestion-actions button")
            .evaluateAll((elements) =>
              elements.map((e) => e.getBoundingClientRect().height),
            );
          assert.ok(
            sizes.every((h) => h >= 43),
            "Touch actions must remain 44px",
          );
        }
      }
      async function waitForStableAiIndex(suggestionItemId) {
        let previous = "";
        let stable = 0;
        let latestStatus;
        let latestSuggestions = [];
        for (let n = 0; n < 100; n++) {
          latestStatus = await api("ai");
          if (suggestionItemId)
            latestSuggestions = (await api("ai/suggestions")).items;
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
          )
            return { status: latestStatus, suggestions: latestSuggestions };
          await setTimeout(250);
        }
        throw new Error(
          `Indexed demo fixture did not stabilize; AI status=${JSON.stringify(latestStatus)}; matching suggestion=${latestSuggestions.some((item) => item.itemId === suggestionItemId)}`,
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
      try {
        await page.goto(`${base}/overview`, { waitUntil: "domcontentloaded" });
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
        await (
          await nav()
        )
          .getByRole("button", { name: "Settings", exact: true })
          .click();
        let settings = await surface("Settings");
        await settings
          .getByRole("tab", { name: "System", exact: true })
          .click();
        let local = settings.locator(".local-ai-settings");
        await local
          .getByRole("heading", {
            name: "Smart tagging and search",
            exact: true,
          })
          .waitFor();
        await local
          .getByRole("checkbox", {
            name: "Enable smart features",
            exact: true,
          })
          .waitFor();
        let approve = local.getByRole("button", {
          name: `Approve ${tag.name} for ${title}`,
          exact: true,
        });
        await approve.waitFor();
        await approve.scrollIntoViewIfNeeded();
        const evidence =
          "SQLite database queries and indexes verify encrypted backup restore.";
        await local.getByText(evidence, { exact: true }).waitFor();
        await audit(settings, "settings");
        await local
          .getByRole("button", { name: `Open ${title}`, exact: true })
          .click();
        await page.locator('[aria-label="Note content"]').waitFor();
        await (
          await nav()
        )
          .getByRole("button", { name: "Settings", exact: true })
          .click();
        settings = await surface("Settings");
        await settings
          .getByRole("tab", { name: "System", exact: true })
          .click();
        local = settings.locator(".local-ai-settings");
        approve = local.getByRole("button", {
          name: `Approve ${tag.name} for ${title}`,
          exact: true,
        });
        await approve.waitFor();
        await approve.click();
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
        const semanticQuery =
          "recover stored information after restoring a protected safety copy";
        await waitForStableAiIndex();
        await waitForSemanticResult(semanticQuery, note.id);
        if (width < 1024)
          await settings
            .getByRole("button", { name: "Back from Settings", exact: true })
            .click();
        else await page.keyboard.press("Escape");
        await (
          await nav()
        )
          .getByRole("button", { name: /^Search/ })
          .first()
          .click();
        const search = await surface("Search");
        await search
          .getByRole("checkbox", { name: "Search by meaning", exact: true })
          .check();
        const semanticResponsePromise = page.waitForResponse((response) => {
          const url = new URL(response.url());
          return (
            url.pathname === "/api/v1/search" &&
            url.searchParams.get("mode") === "suggest" &&
            url.searchParams.get("strategy") === "semantic" &&
            url.searchParams.get("q") === semanticQuery
          );
        });
        await search
          .getByRole("combobox", { name: "Search everything", exact: true })
          .fill(semanticQuery);
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
        await search.getByRole("option").filter({ hasText: title }).click();
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
          await page.goto(`${base}/overview`, {
            waitUntil: "domcontentloaded",
          });
          await (
            await nav()
          )
            .getByRole("button", { name: "Settings", exact: true })
            .click();
          const errorSettings = await surface("Settings");
          await errorSettings
            .getByRole("tab", { name: "System", exact: true })
            .click();
          if (width < 1024)
            await errorSettings
              .getByRole("button", { name: "Back from Settings", exact: true })
              .click();
          else await page.keyboard.press("Escape");
          await (
            await nav()
          )
            .getByRole("button", { name: /^Search/ })
            .first()
            .click();
          const fallbackSearch = await surface("Search");
          const fallbackResponsePromise = page.waitForResponse((response) => {
            const url = new URL(response.url());
            return (
              url.pathname === "/api/v1/search" &&
              url.searchParams.get("mode") === "suggest" &&
              url.searchParams.get("strategy") === "semantic" &&
              url.searchParams.get("q") === fallbackQuery
            );
          });
          await fallbackSearch
            .getByRole("checkbox", { name: "Search by meaning", exact: true })
            .check();
          await fallbackSearch
            .getByRole("combobox", { name: "Search everything", exact: true })
            .fill(fallbackQuery);
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
          await fallbackSearch
            .getByRole("option")
            .filter({ hasText: title })
            .click();
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
          await page.goto(`${base}/overview`, {
            waitUntil: "domcontentloaded",
          });
          await (
            await nav()
          )
            .getByRole("button", { name: "Settings", exact: true })
            .click();
          const errorSettingsAgain = await surface("Settings");
          await errorSettingsAgain
            .getByRole("tab", { name: "System", exact: true })
            .click();
          const errorLocal = errorSettingsAgain.locator(".local-ai-settings"),
            errorToggle = errorLocal.getByRole("checkbox", {
              name: "Enable smart features",
              exact: true,
            });
          await errorLocal
            .getByText("Could not load tag suggestions.", { exact: false })
            .waitFor();
          assert.equal(
            await errorToggle.isDisabled(),
            false,
            "Suggestion-list failure must not disable the smart-feature toggle",
          );
          assert.deepEqual(errors, []);
          console.log(
            `${name} ${width} ${theme}: suggestion failure leaves smart-feature toggle usable`,
          );
        }
      } finally {
        await context.close();
        await api(`tags/${tag.id}`, "DELETE");
        const current = await api(`notes/${note.id}`);
        await api(`notes/${note.id}`, "DELETE", { revision: current.revision });
      }
    }
} finally {
  await browser.close();
  await owner.dispose();
}
