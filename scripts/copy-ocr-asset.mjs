import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

export const tessdataBestEnglishSha256 =
  "45b4cb346724ac1774f1c36f42f182b887bcdb28ebe63e6fff90ac41f3fcff91";

export function copyPinnedOcrAsset(sourcePath, destinationPath) {
  const source = readFileSync(sourcePath);
  const sourceHash = createHash("sha256").update(source).digest("hex");
  if (sourceHash !== tessdataBestEnglishSha256)
    throw new Error(
      `Pinned Tesseract English data hash mismatch: expected ${tessdataBestEnglishSha256}, received ${sourceHash}.`,
    );

  mkdirSync(path.dirname(destinationPath), { recursive: true });
  copyFileSync(sourcePath, destinationPath);
  const copiedHash = createHash("sha256")
    .update(readFileSync(destinationPath))
    .digest("hex");
  if (copiedHash !== tessdataBestEnglishSha256)
    throw new Error(
      "Generated Tesseract English data failed hash verification.",
    );

  return { bytes: source.byteLength, sha256: copiedHash };
}
