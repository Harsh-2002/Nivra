import { createRequire } from "node:module";
import { writeFile } from "node:fs/promises";
import { build } from "esbuild";
await build({
  entryPoints: ["scripts/processing-worker.ts"],
  outfile: "generated/processing-worker.cjs",
  bundle: true,
  platform: "node",
  target: "node24",
  format: "cjs",
  external: ["tesseract.js", "unpdf", "better-sqlite3", "sharp"],
  logLevel: "warning",
});

await build({
  entryPoints: ["scripts/thumbnail-worker.ts"],
  outfile: "generated/thumbnail-worker.cjs",
  bundle: true,
  platform: "node",
  target: "node24",
  format: "cjs",
  external: ["sharp", "unpdf", "@napi-rs/canvas"],
  logLevel: "warning",
});

await build({
  entryPoints: ["scripts/agent-markdown-worker.ts"],
  outfile: "generated/agent-markdown-worker.mjs",
  bundle: true,
  external: ["jsdom"],
  banner: {
    js: 'import {createRequire as requireForWorker} from "node:module"; const require=requireForWorker(import.meta.url);',
  },
  define: { "process.env.NODE_ENV": '"production"' },
  platform: "node",
  target: "node24",
  format: "esm",
  logLevel: "warning",
});

const { nodeFileTrace } = createRequire(import.meta.url)(
  "next/dist/compiled/@vercel/nft",
);
const { fileList } = await nodeFileTrace(
  ["generated/agent-markdown-worker.mjs"],
  { base: process.cwd() },
);
await writeFile(
  "generated/agent-markdown-trace.json",
  JSON.stringify([...fileList]),
);

await build({
  entryPoints: ["scripts/ai-worker.ts"],
  outfile: "generated/ai-worker.cjs",
  bundle: true,
  platform: "node",
  target: "node24",
  format: "cjs",
  external: [
    "onnxruntime-node",
    "@huggingface/tokenizers",
    "better-sqlite3",
    "drizzle-orm",
  ],
  logLevel: "warning",
});
