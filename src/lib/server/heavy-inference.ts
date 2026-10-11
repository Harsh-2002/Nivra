import { spawn } from "node:child_process";
import path from "node:path";
import { mkdirSync } from "node:fs";
import { dataDir } from "./db";
export async function heavyInference<T>(
  work: () => Promise<T>,
  deadline = 120_000,
  signal?: AbortSignal,
): Promise<T> {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const holder = spawn(
    "flock",
    [
      "-F",
      "-x",
      "-w",
      String(deadline / 1000),
      path.join(dataDir, "heavy-inference.lock"),
      "/bin/sh",
      "-c",
      "printf ready; IFS= read -r release",
    ],
    { stdio: ["pipe", "pipe", "ignore"] },
  );
  holder.stdin.on("error", () => {});
  let abort: () => void = () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      let ready = false;
      abort = () => reject(new Error("Inference cancelled."));
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      timer = setTimeout(
        () => reject(new Error("Inference capacity is busy.")),
        deadline,
      );
      holder.stdout.once("data", () => {
        ready = true;
        clearTimeout(timer);
        resolve();
      });
      holder.once("error", () =>
        reject(new Error("Inference coordination is unavailable.")),
      );
      holder.once("exit", () => {
        if (!ready) reject(new Error("Inference coordination is unavailable."));
      });
    });
    return await work();
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    holder.stdin.end();
    if (holder.exitCode === null && holder.signalCode === null)
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => holder.kill("SIGKILL"), 1000);
        holder.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
  }
}
