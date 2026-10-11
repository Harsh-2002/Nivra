import path from "node:path";
import { Worker } from "node:worker_threads";
import { heavyInference } from "./heavy-inference";
export function extractFile(
  bytes: Uint8Array,
  name: string,
  mime: string,
  signal?: AbortSignal,
) {
  return heavyInference(
    () =>
      new Promise<{ text: string; status: string }>((resolve, reject) => {
        const worker = new Worker(
          path.join(process.cwd(), "generated/processing-worker.cjs"),
          {
            workerData: { bytes, name, mime },
            transferList: [bytes.buffer as ArrayBuffer],
            execArgv: [],
            resourceLimits: { maxOldGenerationSizeMb: 512 },
          },
        );
        let settled = false;
        const finish = async (
          result?: { text: string; status: string },
          error?: Error,
        ) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener("abort", cancel);
          await worker.terminate();
          if (error) reject(error);
          else resolve(result!);
        };
        const cancel = () =>
          void finish(undefined, new Error("Extraction cancelled."));
        const timer = setTimeout(
          () => void finish(undefined, new Error("Extraction timed out.")),
          100_000,
        );
        worker.once(
          "message",
          (result) =>
            void finish(
              result.error ? undefined : result,
              result.error ? new Error("Extraction failed.") : undefined,
            ),
        );
        worker.once("error", (error) => void finish(undefined, error));
        worker.once(
          "exit",
          () => void finish(undefined, new Error("Extraction worker stopped.")),
        );
        signal?.addEventListener("abort", cancel, { once: true });
        if (signal?.aborted) cancel();
      }),
    120_000,
    signal,
  );
}
