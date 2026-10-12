import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  copyPinnedOcrAsset,
  hasProvenanceLine,
  tessdataBestEnglishSha256,
} from "../scripts/copy-ocr-asset.mjs";

test("requires complete provenance citation lines", () => {
  const source = "https://github.com/tesseract-ocr/tessdata_best";
  const citation = `- Source: ${source}`;
  const provenance = readFileSync(
    "src/lib/server/ai/licenses/native/tessdata-package-provenance.txt",
    "utf8",
  );
  assert.equal(hasProvenanceLine(provenance, citation), true);
  assert.equal(hasProvenanceLine(`\r\n  ${citation}\r\n`, citation), true);
  for (const candidate of [
    `- Source: https://untrusted.example/${source}`,
    `${citation}.untrusted.example`,
    "- Source: https://github.com@untrusted.example/tesseract-ocr/tessdata_best",
    `prefix ${citation}`,
    `${citation} suffix`,
  ])
    assert.equal(hasProvenanceLine(candidate, citation), false);
});

test("copies only the pinned English OCR dataset into generated runtime assets", (t) => {
  const temporaryDirectory = mkdtempSync(
    path.join(os.tmpdir(), "nivra-ocr-asset-"),
  );
  t.after(() => rmSync(temporaryDirectory, { recursive: true, force: true }));

  const source = path.join(
    process.cwd(),
    "node_modules/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz",
  );
  const destination = path.join(
    temporaryDirectory,
    "generated/ocr/4.0.0_best_int/eng.traineddata.gz",
  );
  const copied = copyPinnedOcrAsset(source, destination);

  assert.equal(copied.sha256, tessdataBestEnglishSha256);
  assert.equal(
    copied.bytes,
    readFileSync(
      "node_modules/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz",
    ).byteLength,
  );
  assert.deepEqual(readFileSync(destination), readFileSync(source));

  const tamperedSource = path.join(temporaryDirectory, "tampered.gz");
  const rejectedDestination = path.join(
    temporaryDirectory,
    "rejected/eng.traineddata.gz",
  );
  writeFileSync(tamperedSource, "not the pinned traineddata");
  assert.throws(() => copyPinnedOcrAsset(tamperedSource, rejectedDestination), {
    message: /Pinned Tesseract English data hash mismatch/,
  });
  assert.equal(existsSync(rejectedDestination), false);
});

test("excludes the build-only language package from standalone tracing", () => {
  const nextConfig = readFileSync("next.config.ts", "utf8");
  assert.match(
    nextConfig,
    /outputFileTracingExcludes:[\s\S]*?\.\/node_modules\/@tesseract\.js-data\/eng\/\*\*\/\*/,
  );
  assert.match(
    nextConfig,
    /outputFileTracingExcludes:[\s\S]*"\*":\s*\["\.\/node_modules\/@tesseract\.js-data\/eng\/\*\*\/\*"\]/,
  );
  assert.match(
    nextConfig,
    /outputFileTracingIncludes:[\s\S]*?\.\/generated\/ocr\/4\.0\.0_best_int\/\*\*\/\*/,
  );
});
