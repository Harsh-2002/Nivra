import type { Connection, Tag } from "./storage.js";

export type Bookmark = {
  id: string;
  url: string;
  title: string;
  collection: string;
  revision: number;
  noteId: string | null;
};
export type CaptureResult = {
  id: string;
  type: "bookmark" | "note" | "task";
  noteId: string | null;
  alreadySaved?: boolean;
};
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
type Options = { method?: string; body?: unknown; idempotencyKey?: string };

export async function api<T>(
  connection: Pick<Connection, "instance" | "key">,
  path: string,
  { method = "GET", body, idempotencyKey }: Options = {},
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${connection.instance}/api/v1/${path}`, {
      method,
      headers: {
        authorization: `Bearer ${connection.key}`,
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new ApiError("Can’t reach your Nivra instance.", 0);
  }
  const data = (await response.json().catch(() => ({}))) as {
    error?: string;
  };
  if (!response.ok)
    throw new ApiError(
      data.error || "This action could not be completed.",
      response.status,
    );
  return data as T;
}
export async function allPages<T>(
  connection: Pick<Connection, "instance" | "key">,
  path: string,
  limit = 100,
  pages = 5,
) {
  const items: T[] = [];
  let after = "";
  for (let page = 0; page < pages; page++) {
    const result = await api<{ items: T[]; next: string | null }>(
      connection,
      `${path}?limit=${limit}${after ? `&after=${encodeURIComponent(after)}` : ""}`,
    );
    items.push(...result.items);
    if (!result.next) break;
    after = result.next;
  }
  return items;
}
export const loadTags = (connection: Connection) =>
  allPages<Tag>(connection, "tags");
export async function loadCollections(connection: Connection) {
  const result = await api<{ collections?: string[] }>(
    connection,
    "bookmarks?summary=1",
  );
  return (result.collections || []).filter(Boolean);
}
export function friendlyError(error: unknown) {
  if (!(error instanceof ApiError)) return "Something went wrong. Try again.";
  if (error.status === 429)
    return "Too many saves in a minute. Wait a moment and try again.";
  if (error.status === 401)
    return "This browser is no longer connected to Nivra.";
  return error.message;
}
