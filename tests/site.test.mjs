import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
const html = readFileSync("dist/index.html", "utf8");
test("all local page assets exist under the project base", () => {
  for (const match of html.matchAll(
    /(?:data-(?:desktop|mobile)-href|src|href)="(\/Nivra\/[^"?#]+)"/g,
  )) {
    const path = decodeURIComponent(match[1]).slice("/Nivra/".length);
    assert.ok(existsSync(`dist/${path}`), `Missing asset ${path}`);
  }
  for (const match of html.matchAll(/srcset="([^"]+)"/g))
    for (const candidate of match[1].split(",")) {
      const path = decodeURIComponent(candidate.trim().split(/\s+/)[0]).slice(
        "/Nivra/".length,
      );
      assert.ok(existsSync(`dist/${path}`), `Missing srcset asset ${path}`);
    }
  const screenshotIds = [
    "overview",
    "notes",
    "journals",
    "quick",
    "drawing",
    "published-note",
    "tasks",
    "kanban",
    "calendar",
    "bookmarks",
    "artifacts",
    "forms",
    "public-form",
    "form-responses",
    "trash",
    "tags",
    "favorites",
    "account-security",
    "mcp",
    "import-export",
    "settings-system",
    "smart-tags",
    "semantic-search",
  ];
  const variants = [
    ["desktop", 1440, 1440, 900],
    ["desktop", 2880, 2880, 1800],
    ["mobile", 390, 390, 844],
    ["mobile", 780, 780, 1688],
    ["mobile", 1170, 1170, 2532],
  ];
  const provenance = JSON.parse(
    readFileSync("dist/screenshots/provenance.json", "utf8"),
  );
  for (const id of screenshotIds) {
    assert.match(
      html,
      new RegExp(`data-screenshot-id="${id}"|data-workflow-feature="${id}"`),
      id,
    );
    for (const theme of ["light", "dark"])
      for (const [device, width, pixelWidth, pixelHeight] of variants) {
        const filename = `${id}-${device}-${theme}-${width}.webp`;
        assert.ok(existsSync(`dist/screenshots/${filename}`), filename);
        assert.ok(
          statSync(`dist/screenshots/${filename}`).size > 5000,
          `Empty screenshot ${filename}`,
        );
        const item = provenance.assets.find((asset) => asset.file === filename);
        assert.equal(item?.width, pixelWidth, `Wrong width: ${filename}`);
        assert.equal(item?.height, pixelHeight, `Wrong height: ${filename}`);
      }
  }
  assert.match(html, /aria-label="Explore Nivra features"/);
  assert.match(
    html,
    /<noscript>[\s\S]*overview-mobile-dark-1170\.webp[\s\S]*<\/noscript>/,
  );
  assert.match(html, /overview-desktop-dark-2880\.webp/);
  for (const image of html.matchAll(/<img\b[^>]*data-screenshot-id[^>]*>/g))
    assert.doesNotMatch(image[0], /\s(?:src|srcset)=/);
  assert.match(html, /class="pending-screenshot" data-screenshot-picture/);
  assert.match(html, /role="tablist" aria-label="Write features"/);
  assert.match(html, /id="workflow-panel" role="tabpanel"/);
  assert.equal((html.match(/data-screenshot-id=/g) ?? []).length, 4);
  assert.doesNotMatch(html, /overview-dark-960|notes-light-960|board-light/);
});
test("public links and metadata target the website or application repository", () => {
  const allowed = new Set(["github.com", "harsh-2002.github.io"]);
  for (const match of html.matchAll(/https:\/\/[^\s"'<>]+/g))
    assert.ok(
      allowed.has(new URL(match[0]).hostname),
      "Unexpected public destination",
    );
  assert.match(
    html,
    /rel="canonical" href="https:\/\/harsh-2002.github.io\/Nivra\/"/,
  );
  assert.match(html, /#get-started-with-docker/);
  assert.ok(existsSync("dist/404.html"));
  assert.match(readFileSync("dist/404.html", "utf8"), /Page not found/);
});
test("screenshot inventory records dimensions and public provenance", () => {
  const provenance = JSON.parse(
    readFileSync("dist/screenshots/provenance.json", "utf8"),
  );
  const screenshots = readdirSync("dist/screenshots").filter((x) =>
    x.endsWith(".webp"),
  );
  assert.equal(provenance.assets.length, screenshots.length);
  for (const file of screenshots) {
    const item = provenance.assets.find((x) => x.file === file);
    assert.ok(item && item.origin && item.width > 0 && item.height > 0, file);
    assert.equal(item.content, "Curated demonstration content");
    assert.match(item.sourceSHA256, /^[a-f0-9]{64}$/, file);
    assert.match(item.outputSHA256, /^[a-f0-9]{64}$/, file);
    assert.ok(item.sourceFile && item.processing && item.nativeWidth, file);
    const actualHash = createHash("sha256")
      .update(readFileSync(`dist/screenshots/${file}`))
      .digest("hex");
    assert.equal(item.outputSHA256, actualHash, `Hash mismatch: ${file}`);
  }
});
test("the website does not ship the application or development artifacts", () => {
  for (const path of [
    "data",
    "src",
    "tests",
    "node_modules",
    ".impeccable",
    "api",
    "session.json",
  ])
    assert.equal(existsSync(`dist/${path}`), false, path);
  assert.doesNotMatch(html, /THESIS|OWN-WORLD|Direction contract/);
  assert.ok(statSync("dist/fonts/geist-latin.woff2").size > 10000);
});
