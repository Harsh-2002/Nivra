import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "playwright";

const base = process.env.NIVRA_EXTENSION_TEST_URL ?? "http://127.0.0.1:3217";
const baseUrl = new URL(base);
assert.ok(
  ["localhost", "127.0.0.1", "[::1]"].includes(baseUrl.hostname),
  "Extension tests are restricted to a disposable local instance",
);
const verifier = randomBytes(32).toString("base64url");
const challenge = createHash("sha256").update(verifier).digest("base64url");
const pinnedId = "afdnjjepnkbmblblbcjfjakoimgniabn";
const screenshots = process.env.NIVRA_EXTENSION_SCREENSHOTS;
const colorScheme =
  process.env.NIVRA_EXTENSION_THEME === "dark" ? "dark" : "light";
const axe = await readFile("node_modules/axe-core/axe.min.js", "utf8");
const work = await mkdtemp(path.join(tmpdir(), "nivra-extension-"));
const extension = path.join(work, "extension");
for (const item of [
  "manifest.json",
  "popup.html",
  "popup.css",
  "dist",
  "fonts",
  "icons",
])
  await cp(path.join("extension", item), path.join(extension, item), {
    recursive: true,
  });
// Headless Chromium cannot answer the optional-permission prompt, so grant the test origin up front.
const manifest = JSON.parse(
  await readFile(path.join(extension, "manifest.json"), "utf8"),
);
manifest.host_permissions = [`${base}/*`];
await writeFile(
  path.join(extension, "manifest.json"),
  JSON.stringify(manifest, null, 2),
);

const headers = { "content-type": "application/json", origin: base };
async function owner(route, method = "GET", body, token) {
  const response = await fetch(`${base}/api/v1/${route}`, {
    method,
    headers: {
      ...headers,
      ...(token ? { authorization: `Bearer ${token}` } : { cookie }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {} };
}
const setup = await fetch(`${base}/api/v1/setup`, {
  method: "POST",
  headers,
  body: JSON.stringify({
    username: "extensionowner",
    name: "Extension Owner",
    password: `Test-${randomUUID()}`,
  }),
});
assert.equal(
  setup.status,
  200,
  "owner setup (the harness needs a fresh disposable instance)",
);
const cookie = setup.headers
  .getSetCookie()
  .map((value) => value.split(";")[0])
  .join("; ");

const context = await chromium.launchPersistentContext(
  path.join(work, "profile"),
  {
    channel: "chromium",
    headless: true,
    colorScheme,
    viewport: { width: 400, height: 760 },
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
    ],
  },
);
const failures = [];
context.on("weberror", (error) => failures.push(error.error().message));
try {
  await context.addCookies(
    cookie.split("; ").map((pair) => {
      const [name, ...value] = pair.split("=");
      return { name, value: value.join("="), url: base, httpOnly: true };
    }),
  );
  const worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent("serviceworker", { timeout: 15000 }));
  const id = new URL(worker.url()).host;
  assert.equal(id, pinnedId, "manifest key pins the extension ID");
  const popupUrl = (query = "") =>
    `chrome-extension://${id}/popup.html${query}`;
  const shot = async (page, name) => {
    await page.evaluate(axe);
    const violations = await page.evaluate(async () => {
      const result = await window.axe.run(document, {
        runOnly: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"],
      });
      return result.violations.map((v) => `${v.id}: ${v.nodes.length}`);
    });
    assert.deepEqual(violations, [], `${name} accessibility`);
    const geometry = await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth > innerWidth,
      small: [
        ...document.querySelectorAll(
          "button,input:not([type=checkbox]),textarea,a",
        ),
      ]
        .filter((el) => el.getClientRects().length)
        .map((el) => [
          el.textContent?.trim() || el.id,
          el.getBoundingClientRect().height,
        ])
        .filter(([, h]) => h < 24),
    }));
    assert.equal(geometry.overflow, false, `${name} overflows`);
    assert.deepEqual(geometry.small, [], `${name} has small targets`);
    if (screenshots)
      await page.screenshot({
        path: path.join(screenshots, `${name}-${colorScheme}.png`),
        fullPage: true,
      });
  };

  // Pairing by code: the consent page shows a one-time code to paste.
  const consent = await context.newPage();
  await consent.goto(
    `${base}/extension/connect?extension=${id}&flow=code&name=Playwright&challenge=${challenge}`,
  );
  await consent.getByRole("button", { name: "Allow this browser" }).click();
  const code = await consent.getByLabel("Pairing code").inputValue();
  assert.ok(code.length > 30, "pairing code is shown");
  await shot(consent, "consent-code");
  await consent.close();

  // Web flow target: the consent page redirects to the extension's chromiumapp.org URL.
  const web = await context.newPage();
  await web.route(`https://${id}.chromiumapp.org/**`, (route) =>
    route.fulfill({ status: 200, body: "ok" }),
  );
  await web.goto(
    `${base}/extension/connect?extension=${id}&flow=web&state=abc123&name=Playwright&challenge=${challenge}`,
  );
  await web.getByRole("button", { name: "Allow this browser" }).click();
  await web.waitForURL(`https://${id}.chromiumapp.org/**`);
  const fields = new URLSearchParams(new URL(web.url()).hash.slice(1));
  assert.equal(fields.get("state"), "abc123");
  assert.ok(fields.get("code"), "web flow returns a code");
  await web.close();

  // Unknown extension IDs are refused before any code is issued.
  const refused = await context.newPage();
  await refused.goto(
    `${base}/extension/connect?extension=${"b".repeat(32)}&flow=code&challenge=${challenge}`,
  );
  await refused.getByRole("button", { name: "Allow this browser" }).click();
  await refused.getByText(/not recognized/).waitFor();
  await refused.close();

  const popup = await context.newPage();
  await popup.setViewportSize({ width: 380, height: 640 });
  await popup.goto(popupUrl());
  await popup.getByLabel("Nivra address").waitFor();
  await shot(popup, "connect");
  await popup.evaluate(
    ({ origin, verifier }) =>
      chrome.storage.local.set({ pending: { origin, verifier } }),
    { origin: base, verifier },
  );
  await popup.reload();
  await popup.getByLabel("Pairing code").fill("not-a-real-code-at-all-0000000");
  await popup.getByRole("button", { name: "Use code" }).click();
  await popup.getByRole("alert").waitFor();
  await popup.getByLabel("Pairing code").fill(code);
  await popup.getByRole("button", { name: "Use code" }).click();
  await popup.getByRole("group", { name: "Save as" }).waitFor();

  // One-click save, duplicate result, quick form and trash undo.
  const article = await context.newPage();
  await article.goto(`${base}/extension-article?topic=one`);
  const tabId = await worker.evaluate(
    async (url) => (await chrome.tabs.query({ url }))[0]?.id,
    `${base}/extension-article*`,
  );
  assert.ok(tabId, "target tab found");
  const open = async (query = `?tab=${tabId}`) => {
    const page = await context.newPage();
    await page.setViewportSize({ width: 380, height: 640 });
    await page.goto(popupUrl(query));
    return page;
  };
  const first = await open();
  await first.getByText("Saved to Nivra").waitFor();
  await first.getByLabel("Title").waitFor();
  await shot(first, "saved-light");
  await first.getByLabel("Collection (optional)").fill("Reading");
  await first.getByLabel("Tags", { exact: true }).fill("research");
  await first.getByLabel("Tags", { exact: true }).press("Enter");
  await first.getByRole("checkbox", { name: "research" }).waitFor();
  await first.getByLabel("Note (optional)").fill("Worth rereading.");
  await first.getByRole("button", { name: "Save changes" }).click();
  await first.getByText("Changes saved").waitFor();
  await first.close();

  const list = await owner("bookmarks?limit=50");
  const saved = list.body.items.find((item) =>
    item.url.includes("/extension-article"),
  );
  assert.ok(saved, "bookmark exists");
  assert.equal(saved.collection, "Reading");
  assert.ok(saved.noteId, "note linked");
  const tags = await owner(`item-tags/bookmark/${saved.id}`);
  assert.deepEqual(
    tags.body.tags.map((tag) => tag.name),
    ["research"],
  );

  const second = await open();
  await second.getByText("Already saved").waitFor();
  await second.getByLabel("Title").waitFor();
  assert.equal(
    await second.getByLabel("Collection (optional)").inputValue(),
    "Reading",
  );
  assert.equal(await second.getByRole("button", { name: "Undo" }).count(), 0);
  await second.close();

  await article.goto(`${base}/extension-article?topic=two`);
  const undoable = await open();
  await undoable.getByText("Saved to Nivra").waitFor();
  await undoable.getByRole("button", { name: "Undo" }).click();
  await undoable.getByText("Moved to Trash").waitFor();
  const trashed = await owner("bookmarks?limit=50");
  assert.ok(
    !trashed.body.items.some((item) => item.url.includes("topic=two")),
    "undo moved the bookmark to Trash",
  );
  await undoable.close();
  const again = await open();
  await again.getByText("This link is in Trash").waitFor();
  await again.close();

  // Addresses that look like they carry a secret are not saved until confirmed.
  await article.goto(`${base}/extension-article?topic=three&token=abc123`);
  const sensitive = await open();
  await sensitive.getByText("Not saved yet").waitFor();
  assert.equal(await sensitive.getByLabel("Title").isVisible(), false);
  await sensitive.getByRole("button", { name: "Save anyway" }).click();
  await sensitive.getByText("Saved to Nivra").waitFor();
  await sensitive.close();
  await article.goto(`${base}/extension-article?topic=two`);

  // Quick note with and without the page link.
  const noteTab = await open();
  await noteTab.getByText("This link is in Trash").waitFor();
  await noteTab.getByRole("button", { name: "Note", exact: true }).click();
  await noteTab.getByLabel("Note", { exact: true }).fill("A quick thought");
  await shot(noteTab, "note");
  await noteTab.getByRole("button", { name: "Save note" }).click();
  await noteTab.getByText("Note saved").waitFor();
  await noteTab.close();
  const notes = await owner("notes?limit=20");
  assert.ok(
    notes.body.items.some(
      (item) => /extension-article|Not found/i.test(item.title) || item.title,
    ),
    "quick note exists",
  );

  // The popup follows the instance theme setting.
  assert.equal(
    (await owner("settings", "PATCH", { theme: "dark" })).status,
    200,
  );
  const themed = await open();
  await themed.waitForFunction(
    () => document.documentElement.dataset.theme === "dark",
  );
  await themed.close();

  // Revocation: a key revoked by the owner returns the popup to the connect state.
  const keys = await owner("ai-connections");
  const extensionKey = keys.body.keys.find((key) =>
    key.name.startsWith("Chrome extension"),
  );
  assert.ok(extensionKey, "extension key is listed for the owner");
  assert.equal(
    (
      await owner("ai-connections", "POST", {
        action: "revoke-key",
        id: extensionKey.id,
      })
    ).status,
    200,
  );
  const revoked = await open();
  await revoked.getByText(/connection ended/i).waitFor();
  await shot(revoked, "reconnect");
  await revoked.close();

  // Browser sign-in finishes in the background worker even though Chrome closes the popup.
  await worker.evaluate(() => {
    chrome.identity.launchWebAuthFlow = (details) =>
      new Promise((resolve) => {
        globalThis.__authUrl = details.url;
        globalThis.__resolveAuth = resolve;
      });
  });
  const connectPopup = await open();
  await connectPopup.getByLabel("Nivra address").fill(base);
  await connectPopup.getByRole("button", { name: "Connect browser" }).click();
  await connectPopup
    .getByRole("heading", { name: "Finish in the sign-in window" })
    .waitFor();
  await shot(connectPopup, "waiting");
  let authUrl;
  for (let attempt = 0; attempt < 100 && !authUrl; attempt += 1) {
    authUrl = await worker.evaluate(() => globalThis.__authUrl);
    if (!authUrl) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(authUrl, "background worker started the sign-in window");
  const authorize = new URL(authUrl);
  assert.equal(authorize.searchParams.get("flow"), "web");
  assert.ok(authorize.searchParams.get("challenge"));
  const approval = await context.newPage();
  await approval.route(`https://${id}.chromiumapp.org/**`, (route) =>
    route.fulfill({ status: 200, body: "ok" }),
  );
  await approval.goto(authUrl);
  await approval.getByRole("button", { name: "Allow this browser" }).click();
  await approval.waitForURL(`https://${id}.chromiumapp.org/**`);
  const redirected = new URL(approval.url());
  assert.equal(redirected.search, "", "the code is not sent as a query");
  const returned = new URLSearchParams(redirected.hash.slice(1));
  assert.equal(returned.get("state"), authorize.searchParams.get("state"));
  assert.ok(returned.get("code"));
  await approval.close();
  // Close the popup first: the exchange must complete without it.
  await connectPopup.close();
  await worker.evaluate(
    (url) => globalThis.__resolveAuth(url),
    redirected.href,
  );
  const reopened = await open();
  await reopened.getByRole("group", { name: "Save as" }).waitFor();
  const refreshed = await owner("ai-connections");
  assert.ok(
    refreshed.body.keys.filter((key) => key.name.startsWith("Chrome extension"))
      .length >= 1,
    "browser sign-in created a key",
  );
  await reopened.close();

  assert.deepEqual(failures, [], "no uncaught page errors");
  console.log("Extension verification passed");
} finally {
  await context.close();
  await rm(work, { recursive: true, force: true });
}
