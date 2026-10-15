import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { unzipSync } from "fflate";
import {
  auditManifest,
  buildPackage,
  manifestVersion,
} from "../scripts/package-extension.mjs";

const manifest = () =>
  JSON.parse(readFileSync("extension/manifest.json", "utf8"));
if (!existsSync("extension/dist/popup.js"))
  execFileSync("npx", ["tsc", "-p", "extension/tsconfig.json"], {
    stdio: "ignore",
  });

test("the release package is deterministic, version-stamped and limited to extension files", () => {
  assert.equal(manifestVersion("v2026.10.05"), "2026.10.5");
  assert.equal(manifestVersion("v2026.12.31"), "2026.12.31");
  assert.throws(() => manifestVersion("v2026.13.01"));
  const first = buildPackage({ tag: "v2026.10.05" });
  const second = buildPackage({ tag: "v2026.10.05" });
  assert.equal(first.sha256, second.sha256);
  assert.equal(first.name, "nivra-extension-v2026.10.05.zip");
  const files = unzipSync(first.bytes);
  assert.deepEqual(
    Object.keys(files).filter((name) => !/^(dist|fonts|icons)\//.test(name)),
    ["manifest.json", "popup.css", "popup.html"],
  );
  assert.ok(Object.keys(files).includes("dist/background.js"));
  assert.ok(
    Object.keys(files).every((name) => !/\.(map|ts|d\.ts|env)$/.test(name)),
  );
  const stamped = JSON.parse(new TextDecoder().decode(files["manifest.json"]));
  assert.equal(stamped.version, "2026.10.5");
  assert.equal(stamped.version_name, "2026.10.05");
  assert.equal(stamped.key, manifest().key);
});

test("manifest audit rejects any widening of the extension's trust boundary", () => {
  assert.doesNotThrow(() => auditManifest(manifest()));
  const mutations: Array<(m: Record<string, unknown>) => void> = [
    (m) => (m.permissions = [...(m.permissions as string[]), "tabs"]),
    (m) => (m.permissions = (m.permissions as string[]).slice(1)),
    (m) => (m.host_permissions = ["<all_urls>"]),
    (m) => (m.optional_host_permissions = ["<all_urls>"]),
    (m) => (m.content_scripts = [{ matches: ["<all_urls>"], js: ["x.js"] }]),
    (m) => (m.web_accessible_resources = [{ resources: ["*"], matches: [] }]),
    (m) => (m.externally_connectable = { matches: ["https://*/*"] }),
    (m) => (m.content_security_policy = { extension_pages: "script-src *" }),
    (m) => (m.update_url = "https://example.test/update.xml"),
    (m) => delete m.key,
  ];
  for (const mutate of mutations) {
    const changed = manifest();
    mutate(changed);
    assert.throws(() => auditManifest(changed));
  }
});
