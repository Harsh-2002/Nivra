import assert from "node:assert/strict";
import test from "node:test";
import { access, mkdtemp, mkdir, copyFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { EmbeddingWorker } from "../src/lib/server/ai/runtime";
test("persistent local AI uses normalized deterministic embeddings and shuts down", async () => {
  await access("models/arctic/onnx/model_int8.onnx");
  const worker = new EmbeddingWorker();
  try {
    await worker.start();
    const first = await worker.encode(
      "An encrypted SQLite backup restores notes.",
      true,
    );
    const second = await worker.encode(
      "An encrypted SQLite backup restores notes.",
      true,
    );
    assert.equal(first.length, 384);
    assert.ok(Math.abs(Math.hypot(...first) - 1) < 0.00001);
    assert.ok(first.every((value, i) => Math.abs(value - second[i]) < 0.00001));
    const passage = await worker.encode(
      "An encrypted SQLite backup restores notes.",
    );
    assert.ok(first.some((value, i) => Math.abs(value - passage[i]) > 0.00001));
    assert.ok(worker.resources.peakRss < 512 * 1024 * 1024);
    await assert.rejects(worker.encode("x".repeat(20_001)), /limit/);
  } finally {
    await worker.stop();
  }
});
test("missing or corrupt local model assets fail closed without downloads", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "nivra-ai-assets-"));
  const worker = new EmbeddingWorker(directory);
  try {
    await mkdir(path.join(directory, "generated"));
    await copyFile(
      "generated/ai-worker.cjs",
      path.join(directory, "generated/ai-worker.cjs"),
    );
    // Resolve native packages from the worktree, while keeping model lookup disposable.
    const { symlink } = await import("node:fs/promises");
    await symlink(
      path.resolve("node_modules"),
      path.join(directory, "node_modules"),
      "dir",
    );
    await assert.rejects(worker.start(), /unavailable|stopped/);
    await worker.stop();
    await mkdir(path.join(directory, "models/arctic"), { recursive: true });
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      path.join(directory, "models/arctic/config.json"),
      "corrupt",
    );
    await assert.rejects(worker.start(), /unavailable|stopped/);
  } finally {
    await worker.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
