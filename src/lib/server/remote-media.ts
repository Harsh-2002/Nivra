import { bookmarkUrl, fetchPublic, imageMime } from "./link-metadata";
import { fileResponse, mediaMime, memorySource } from "./file-response";
import { uploadLimit } from "./config";
import { HttpError } from "./http";

let active = 0;
const waiting: (() => void)[] = [];
const cache = new Map<
  string,
  { bytes: Uint8Array; mime: string; expires: number; weight: number }
>();
let cached = 0;
const cacheLimit = 32 * 1024 * 1024;
const cacheEntryLimit = 4 * 1024 * 1024;
const cacheEntries = 256;
const cacheLifetime = 5 * 60_000;
function forget(key: string) {
  cached -= cache.get(key)?.weight ?? 0;
  cache.delete(key);
}
function remember(key: string, bytes: Uint8Array, mime: string) {
  if (bytes.byteLength > cacheEntryLimit) return;
  const now = Date.now();
  // Count the address and a fixed overhead too, so many tiny entries cannot exceed the stated bound.
  const weight = bytes.byteLength + key.length * 2 + 512;
  forget(key);
  for (const [name, entry] of cache) if (entry.expires <= now) forget(name);
  while (
    (cached + weight > cacheLimit || cache.size >= cacheEntries) &&
    cache.size
  )
    forget(cache.keys().next().value as string);
  cache.set(key, { bytes, mime, expires: now + cacheLifetime, weight });
  cached += weight;
}

export async function remoteMedia(
  request: Request,
  value: string,
  fetcher = fetchPublic,
  beforeFetch?: () => void,
) {
  const url = bookmarkUrl(value);
  const hit = cache.get(url);
  if (hit && hit.expires > Date.now())
    return fileResponse(request, memorySource(hit.bytes), {
      mime: hit.mime,
      name: "linked-media",
    });
  beforeFetch?.();
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(10000)]);
  signal.throwIfAborted();
  if (active >= 2) {
    if (waiting.length >= 16)
      throw new HttpError(429, "Media requests are busy. Try again shortly.");
    await new Promise<void>((resolve, reject) => {
      const ready = () => {
        signal.removeEventListener("abort", cancel);
        resolve();
      };
      const cancel = () => {
        const index = waiting.indexOf(ready);
        if (index < 0) return;
        waiting.splice(index, 1);
        reject(new HttpError(504, "This media request timed out."));
      };
      signal.addEventListener("abort", cancel, { once: true });
      waiting.push(ready);
    });
  } else active++;
  try {
    signal.throwIfAborted();
    const result = await fetcher(
      url,
      uploadLimit(),
      signal,
      0,
      "image/*,audio/*,video/*",
    );
    const mime = imageMime(result.bytes) || mediaMime(result.bytes);
    if (!mime || mime === "image/x-icon")
      throw new HttpError(415, "This remote media format is not supported.");
    remember(url, result.bytes, mime);
    return await fileResponse(request, memorySource(result.bytes), {
      mime,
      name: "linked-media",
    });
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(502, "This linked media could not be loaded safely.");
  } finally {
    const next = waiting.shift();
    if (next) next();
    else active--;
  }
}
