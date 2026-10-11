import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { EmbeddingWorker } from "../src/lib/server/ai/runtime";
test("separate processes serialize heavy inference and only one persistent model leader starts", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "nivra-ai-lock-"));
  process.env.NIVRA_DATA_DIR = directory;
  const first = new EmbeddingWorker(
      process.cwd(),
      path.join(directory, "leader.lock"),
    ),
    second = new EmbeddingWorker(
      process.cwd(),
      path.join(directory, "leader.lock"),
    );
  const run = () =>
    new Promise<number[]>((resolve, reject) => {
      const script = `import {heavyInference} from ${JSON.stringify(path.resolve("src/lib/server/heavy-inference.ts"))};await heavyInference(async()=>{console.log(Date.now());await new Promise(r=>setTimeout(r,150));console.log(Date.now())},5000)`;
      const child = spawn(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "-e", script],
        {
          env: { ...process.env, NIVRA_DATA_DIR: directory },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let output = "",
        error = "";
      child.stdout.on("data", (b) => (output += b));
      child.stderr.on("data", (b) => (error += b));
      child.once("error", reject);
      child.once("exit", (code) =>
        code === 0
          ? resolve(output.trim().split("\n").map(Number))
          : reject(new Error(error)),
      );
    });
  try {
    const intervals = await Promise.all([run(), run()]);
    intervals.sort((a, b) => a[0] - b[0]);
    assert.ok(intervals[0][1] <= intervals[1][0]);
    await first.start();
    await assert.rejects(second.start(), /stopped|unavailable/);
    assert.equal(
      (await first.encode("SQLite backups protect saved notes.")).length,
      384,
    );
  } finally {
    await first.stop();
    await second.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
test("job ticks stop a model after an external disable and restart it safely after re-enable", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "nivra-ai-disable-"));
  process.env.NIVRA_DATA_DIR = directory;
  const { sqlite } = await import("../src/lib/server/db"),
    { canIndexLocally, stopAi } = await import("../src/lib/server/ai/indexer"),
    { wakeJobs } = await import("../src/lib/server/jobs");
  const d = sqlite(),
    getState = () =>
      (
        globalThis as unknown as {
          nivraAi?: { worker: EmbeddingWorker; ready: boolean };
        }
      ).nivraAi;
  const waitFor = async (predicate: () => boolean, message: string) => {
    const deadline = Date.now() + 45_000;
    while (!predicate()) {
      if (Date.now() >= deadline) assert.fail(message);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };
  try {
    d.prepare("UPDATE ai_configuration SET enabled=1").run();
    wakeJobs();
    await waitFor(() => canIndexLocally(), "AI worker did not start.");
    const previous = getState();
    assert.ok(previous?.worker.running);

    d.prepare("UPDATE ai_configuration SET enabled=0").run();
    wakeJobs();
    d.prepare("UPDATE ai_configuration SET enabled=1").run();
    wakeJobs();
    await waitFor(
      () => !previous.worker.running && getState() === undefined,
      "Job tick did not stop the disabled AI worker.",
    );

    wakeJobs();
    await waitFor(
      () => Boolean(getState()?.ready && getState()?.worker.running),
      "AI worker did not restart after re-enable.",
    );
    const restarted = getState();
    assert.ok(restarted);
    assert.notEqual(restarted, previous);
    assert.equal(
      (await restarted.worker.encode("SQLite recovery requires a safe backup."))
        .length,
      384,
    );
  } finally {
    await stopAi();
    d.close();
    await rm(directory, { recursive: true, force: true });
  }
});
