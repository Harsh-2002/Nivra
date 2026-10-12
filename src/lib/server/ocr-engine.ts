import path from "node:path";
import type { Worker } from "tesseract.js";
import { maxTextLength } from "./extract";

// Language data ships with the app and is read from disk, so no image or text ever leaves this server.
const languageDirectory = () =>
  path.join(
    /* turbopackIgnore: true */ process.cwd(),
    "generated",
    "ocr",
    "4.0.0_best_int",
  );
const timeoutMs = 90_000;
const idleMs = 30_000;
const state = globalThis as unknown as {
  nivraOcr?: {
    worker?: Promise<Worker>;
    idle?: ReturnType<typeof setTimeout>;
  };
};
const ocr = (state.nivraOcr ||= {});
async function stop() {
  clearTimeout(ocr.idle);
  const worker = ocr.worker;
  ocr.worker = undefined;
  await (await worker?.catch(() => undefined))?.terminate().catch(() => {});
}
async function engine() {
  ocr.worker ||= import("tesseract.js").then(({ createWorker }) =>
    createWorker("eng", 1, {
      langPath: languageDirectory(),
      cacheMethod: "none",
      gzip: true,
      errorHandler: () => {},
    }),
  );
  return ocr.worker;
}
export async function recognize(bytes: Uint8Array, limit = timeoutMs) {
  clearTimeout(ocr.idle);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      (async () => {
        const worker = await engine();
        await worker.setParameters({ preserve_interword_spaces: "1" });
        const sharp = (await import("sharp")).default;
        const input = await sharp(Buffer.from(bytes), {
          limitInputPixels: 60_000_000,
        })
          .autoOrient()
          .resize({
            width: 2400,
            height: 2400,
            fit: "inside",
            withoutEnlargement: true,
          })
          .png()
          .toBuffer();
        let best = (await worker.recognize(input)).data;
        if (best.confidence < 75) {
          for (const angle of [270, 90, 180]) {
            const rotated = await sharp(input, { limitInputPixels: 60_000_000 })
              .rotate(angle)
              .png()
              .toBuffer();
            const candidate = (await worker.recognize(rotated)).data;
            if (candidate.text.trim() && candidate.confidence > best.confidence)
              best = candidate;
            if (best.confidence >= 75) break;
          }
        }
        if (best.text.trim() && best.confidence < 45)
          throw new Error("Text could not be read reliably.");
        return best;
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Text recognition timed out.")),
          limit,
        );
      }),
    ]);
    return result.text
      .replace(/\r\n?/g, "\n")
      .replace(/[ \t]+$/gm, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
      .slice(0, maxTextLength);
  } catch (error) {
    await stop();
    throw error;
  } finally {
    clearTimeout(timer);
    ocr.idle = setTimeout(() => void stop(), idleMs);
    ocr.idle.unref?.();
  }
}
export const shutdownEngine = stop;
