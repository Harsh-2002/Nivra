import { readdirSync, existsSync } from "node:fs";
import path from "node:path";
const root = path.resolve(".next/standalone");
function inspect(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (
      (directory === root && entry.name === "data") ||
      /\.sqlite(?:-(?:wal|shm))?$/.test(entry.name) ||
      [
        "encryption.key",
        "encryption-mode.json",
        "installation.json",
        "installation.lock",
        "configuration-import.enc",
        "imported-encryption.key",
        "backup-state.enc",
        "backup.lock",
        "auth.secret",
        "nivra.sqlite",
        "nivra.sqlite-wal",
        "nivra.sqlite-shm",
      ].includes(entry.name)
    )
      throw new Error(
        "Private instance data was traced into the shipping artifact.",
      );
    if (entry.isDirectory()) inspect(file);
  }
}
inspect(root);
if (!existsSync(path.join(root, "generated/publication-renderer.cjs")))
  throw new Error(
    "The publication renderer is missing from the shipping artifact.",
  );
if (!existsSync(path.join(root, "generated/thumbnail-worker.cjs")))
  throw new Error(
    "The thumbnail worker is missing from the shipping artifact.",
  );
if (!existsSync(path.join(root, "node_modules/@napi-rs/canvas")))
  throw new Error(
    "PDF preview rendering is missing from the shipping artifact.",
  );
for (const file of ["main.js", "reader.css", "geist-latin-wght-normal.woff2"])
  if (!existsSync(path.join("public/reader", file)))
    throw new Error("A prebuilt public reader asset is missing.");
console.log("Shipping artifact excludes private instance data.");

if (!existsSync(path.join(root, "generated/agent-markdown-worker.mjs")))
  throw new Error(
    "The agent Markdown worker is missing from the shipping artifact.",
  );

if (!existsSync(path.join(root, "generated/ai-worker.cjs")))
  throw new Error("The local AI worker is missing from the shipping artifact.");
