import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
const html = readFileSync("dist/index.html", "utf8");
test("all local page assets exist under the project base", () => {
  for (const match of html.matchAll(
    /(?:data-(?:desktop|mobile)-href|src|href)="(\/Nivra\/[^"?#]+)"/g,
  )) {
    const path = decodeURIComponent(match[1]).slice("/Nivra/".length);
    assert.ok(existsSync(`dist/${path}`), `Missing asset ${path}`);
  }
  for (const name of [
    "overview",
    "notes",
    "board",
    "calendar",
    "forms",
    "smart-tags",
    "semantic-search",
  ])
    for (const theme of ["light", "dark"])
      for (const variant of ["", "-960", "-mobile"]) {
        const filename =
          variant === "-mobile"
            ? `${name}-mobile-${theme}.webp`
            : `${name}-${theme}${variant}.webp`;
        assert.ok(existsSync(`dist/screenshots/${filename}`), filename);
        assert.ok(
          statSync(`dist/screenshots/${filename}`).size > 5000,
          `Empty screenshot ${filename}`,
        );
      }
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
