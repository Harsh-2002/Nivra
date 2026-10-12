import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
const child = fork("generated/ai-worker.cjs", [], {
  execArgv: ["--max-old-space-size=128"],
  stdio: ["ignore", "ignore", "inherit", "ipc"],
});
let peak = 0;
const messages = [];
let wake;
child.on("message", (message) => {
  if (typeof message.rss === "number") peak = Math.max(peak, message.rss);
  if (typeof message.peakRss === "number")
    peak = Math.max(peak, message.peakRss);
  messages.push(message);
  wake?.();
});
const timer = setTimeout(() => {
  child.kill("SIGKILL");
  throw new Error("Local AI smoke timed out.");
}, 45_000);
const next = async (type, id) => {
  for (;;) {
    const index = messages.findIndex(
      (m) => m.type === type && (!id || m.id === id),
    );
    if (index >= 0) return messages.splice(index, 1)[0];
    if (messages.some((m) => m.type === "unavailable" || m.type === "failed"))
      throw new Error("Local AI smoke inference failed.");
    await new Promise((resolve) => {
      wake = resolve;
    });
  }
};
try {
  const started = performance.now();
  await next("ready");
  const coldMs = performance.now() - started;
  const samples = [];
  let previous;
  for (let i = 0; i < 12; i++) {
    const id = String(i),
      start = performance.now();
    child.send({
      type: "encode",
      id,
      text: "An encrypted SQLite backup can restore saved notes.",
      query: i < 2,
    });
    const { embedding } = await next("result", id);
    assert.equal(embedding.length, 384);
    assert.ok(embedding.every(Number.isFinite));
    assert.ok(Math.abs(Math.hypot(...embedding) - 1) < 0.00001);
    if (i === 1)
      assert.ok(embedding.every((v, n) => Math.abs(v - previous[n]) < 0.00001));
    previous = embedding;
    samples.push(performance.now() - start);
  }
  const searchStarted = performance.now();
  child.send({
    type: "search",
    id: "db",
    owner: "absent-synthetic-owner",
    text: "SQLite backup",
    deadline: Date.now() + 3000,
  });
  const { candidates } = await next("result", "db");
  assert.deepEqual(candidates, []);
  const encryptedSearchMs = performance.now() - searchStarted;
  samples.sort((a, b) => a - b);
  assert.ok(peak < 512 * 1024 * 1024);
  console.log(
    JSON.stringify({
      runtime: process.version,
      architecture: process.arch,
      coldMs,
      encryptedSearchMs,
      warmP50Ms: samples[5],
      warmP95Ms: samples[11],
      peakRssMiB: peak / 1024 / 1024,
      aggregateContainerPeakMiB:
        readFileSync("/sys/fs/cgroup/memory.peak", "utf8").trim() / 1024 / 1024,
    }),
  );
} finally {
  clearTimeout(timer);
  child.send({ type: "shutdown" }, () => {});
  const kill = setTimeout(() => child.kill("SIGKILL"), 2000);
  await new Promise((resolve) => child.once("exit", resolve));
  clearTimeout(kill);
}

const { createCanvas, GlobalFonts } = await import("@napi-rs/canvas");
const { createWorker } = await import("tesseract.js");
assert.ok(
  !existsSync("node_modules/@tesseract.js-data/eng"),
  "The Tesseract npm wrapper must not ship in the production image.",
);
assert.ok(
  GlobalFonts.registerFromPath(
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "NivraSmoke",
  ),
  "The container OCR fixture requires the shipped DejaVu font.",
);
const canvas = createCanvas(800, 160),
  context = canvas.getContext("2d");
context.fillStyle = "white";
context.fillRect(0, 0, 800, 160);
context.fillStyle = "black";
context.font = "50px NivraSmoke";
context.fillText("NIVRA OFFLINE TEST", 20, 100);
const ocr = await createWorker("eng", 1, {
  langPath: `${process.cwd()}/generated/ocr/4.0.0_best_int`,
  gzip: true,
  cacheMethod: "none",
});
try {
  const result = await ocr.recognize(canvas.toBuffer("image/png"));
  assert.ok(result.data.text.includes("NIVRA"));
  console.log("Shipped OCR and native canvas verified offline.");
} finally {
  await ocr.terminate();
}
