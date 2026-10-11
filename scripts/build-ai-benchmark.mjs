import { readFileSync } from "node:fs";
import { build } from "esbuild";
await build({
  entryPoints: ["scripts/benchmark-ai.mts"],
  outfile: process.argv[2] ?? "/tmp/nivra-ai-benchmark.mjs",
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  external: Object.keys(
    JSON.parse(readFileSync("package.json", "utf8")).dependencies,
  ),
  define: { "process.env.NIVRA_AI_BENCH_RESOURCE_ONLY": '"1"' },
});
