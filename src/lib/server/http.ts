import { installationUrl } from "./installation";
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export function response(value: unknown, status = 200) {
  return Response.json(value, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}
export async function readLimited(
  request: Request,
  limit: number,
): Promise<Uint8Array> {
  if (Number(request.headers.get("content-length")) > limit)
    throw new HttpError(413, "This file is too large.");
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel();
      throw new HttpError(413, "This request is too large.");
    }
    chunks.push(value);
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}
export async function json(request: Request, optional = false) {
  try {
    const bytes = await readLimited(request, 8 * 1024 * 1024);
    if (optional && !bytes.length) return undefined;
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "Invalid request data.");
  }
}
export function requestOrigin(request: Request) {
  const publicUrl = installationUrl();
  if (publicUrl) return new URL(publicUrl).origin;
  const url = new URL(request.url);
  return `${url.protocol}//${request.headers.get("host") || url.host}`;
}
export function checkOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (origin && origin !== requestOrigin(request))
    throw new HttpError(403, "Request origin is not allowed.");
  if (!origin && request.headers.get("sec-fetch-site") === "cross-site")
    throw new HttpError(403, "Request origin is not allowed.");
}
const attempts = new Map<string, { count: number; expires: number }>();
export function throttle(key: string, limit = 10) {
  const now = Date.now();
  for (const [id, entry] of attempts)
    if (entry.expires < now) attempts.delete(id);
  const entry = attempts.get(key) || { count: 0, expires: now + 60_000 };
  if (++entry.count > limit)
    throw new HttpError(429, "Too many attempts. Try again in a minute.");
  attempts.set(key, entry);
}
