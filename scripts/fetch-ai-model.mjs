import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, rename, rm } from "node:fs/promises";
import path from "node:path";
const maxAssetBytes = 32 * 1024 * 1024;
async function readBounded(response) {
  if (!response.body) throw new Error("Model build asset unavailable.");
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (size + value.byteLength > maxAssetBytes)
        throw new Error("Model build asset exceeds the 32 MiB limit.");
      size += value.byteLength;
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}
const manifest = JSON.parse(
  await readFile("src/lib/server/ai/model-manifest.json", "utf8"),
);
const root = path.resolve("models/arctic");
for (const [file, expected] of Object.entries(manifest.files)) {
  const target = path.join(root, file);
  const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const previous = await readFile(target).catch(() => null);
  if (previous && hash(previous) === expected) continue;
  const response = await fetch(
    `https://huggingface.co/${manifest.repository}/resolve/${manifest.revision}/${file}`,
    { signal: AbortSignal.timeout(120_000) },
  );
  if (!response.ok) throw new Error(`Model build asset unavailable: ${file}`);
  const bytes = await readBounded(response);
  if (hash(bytes) !== expected)
    throw new Error(`Model build asset checksum mismatch: ${file}`);
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp`;
  try {
    await writeFile(temporary, bytes);
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}
await writeFile(path.join(root, "manifest.json"), JSON.stringify(manifest));
await writeFile(
  path.join(root, "NOTICE"),
  `Snowflake Arctic Embed XS q8\nRepository: ${manifest.repository}\nRevision: ${manifest.revision}\nWeights and tokenizer configuration: Apache-2.0\nhttps://www.apache.org/licenses/LICENSE-2.0\n`,
);
await writeFile(
  path.join(root, "LICENSE"),
  await readFile("node_modules/@huggingface/tokenizers/LICENSE"),
);
console.log(
  "Pinned Arctic model pack verified; inference never downloads assets.",
);
