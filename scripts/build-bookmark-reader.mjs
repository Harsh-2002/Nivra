import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { build } from "esbuild";

await mkdir("generated", { recursive: true });
await build({
  entryPoints: ["scripts/bookmark-reader-worker.ts"],
  outfile: "generated/bookmark-reader-worker.mjs",
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  external: ["@mozilla/readability", "jsdom", "parse5"],
  logLevel: "warning",
});

const { nodeFileTrace } = createRequire(import.meta.url)(
  "next/dist/compiled/@vercel/nft",
);
const { fileList } = await nodeFileTrace(
  ["generated/bookmark-reader-worker.mjs"],
  { base: process.cwd() },
);
await writeFile(
  "generated/bookmark-reader-trace.json",
  JSON.stringify([...fileList].sort()),
);
