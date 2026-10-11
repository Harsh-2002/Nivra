import assert from "node:assert/strict";
import test from "node:test";
import {
  detectInstallPlatform,
  getSuggestedTags,
  isSecureInstallContext,
  normalizeTagName,
  parseTagAliases,
  STARTER_TAG_SUGGESTIONS,
} from "../src/lib/onboarding";

test("starter tags are short, predictable and omit normalized existing tags", () => {
  assert.equal(STARTER_TAG_SUGGESTIONS.length, 6);
  assert.deepEqual(getSuggestedTags(), [...STARTER_TAG_SUGGESTIONS]);
  assert.deepEqual(getSuggestedTags(["work", "ＩＤＥＡＳ"]), [
    "Personal",
    "Projects",
    "Learning",
    "Reference",
  ]);
  assert.deepEqual(getSuggestedTags(STARTER_TAG_SUGGESTIONS), []);
  assert.equal(
    new Set(STARTER_TAG_SUGGESTIONS.map(normalizeTagName)).size,
    STARTER_TAG_SUGGESTIONS.length,
  );
});

test("custom tag matching words retain useful phrases and remove normalized duplicates", () => {
  assert.equal(normalizeTagName("  ＷＯＲＫ  "), "work");
  assert.deepEqual(
    parseTagAliases(
      " Work, sqlite database, SQLite Database, , queries ",
      "work",
    ),
    ["sqlite database", "queries"],
  );
  assert.deepEqual(parseTagAliases("", "Home"), []);
});

test("installation guidance recognizes Android, iPhone and desktop-mode iPad", () => {
  assert.equal(detectInstallPlatform("Mozilla/5.0 (iPhone)"), "ios");
  assert.equal(detectInstallPlatform("Mozilla/5.0 (iPad)"), "ios");
  assert.equal(detectInstallPlatform("Mozilla/5.0 (Macintosh)", 5), "ios");
  assert.equal(detectInstallPlatform("Mozilla/5.0 (Macintosh)", 0), "desktop");
  assert.equal(detectInstallPlatform("Mozilla/5.0 (Android 16)"), "android");
  assert.equal(detectInstallPlatform("Mozilla/5.0 (Windows NT)"), "desktop");
});

test("install guidance requires HTTPS except trusted loopback development origins", () => {
  assert.ok(isSecureInstallContext("https:", "workspace.example"));
  assert.ok(isSecureInstallContext("http:", "localhost"));
  assert.ok(isSecureInstallContext("http:", "127.0.0.1"));
  assert.ok(isSecureInstallContext("http:", "[::1]"));
  assert.equal(isSecureInstallContext("http:", "localhost.example"), false);
  assert.equal(isSecureInstallContext("http:", "workspace.example"), false);
});
