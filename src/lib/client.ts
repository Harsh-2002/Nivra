export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
  ) {
    super(message);
  }
}
export const unreachable =
  "Nivra can't be reached. Check your connection and try again.";
function failure(status: number) {
  if (status === 413)
    return "That is larger than the server accepts. Try a smaller file.";
  if (status === 429) return "Too many requests. Wait a moment and try again.";
  if (status >= 500)
    return "Nivra could not finish that. Try again in a moment.";
  return "This action could not be completed.";
}
async function send(input: string, init?: RequestInit) {
  try {
    return await fetch(input, init);
  } catch (error) {
    if (
      init?.signal?.aborted ||
      (error instanceof DOMException && error.name === "AbortError")
    )
      throw error;
    throw new ApiError(unreachable, 0, "unreachable");
  }
}
async function errorBody(result: Response) {
  try {
    const body = await result.json();
    return body && typeof body === "object"
      ? (body as { error?: unknown; code?: unknown })
      : {};
  } catch {
    return {};
  }
}
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const result = await send(`/api/v1/${path}`, {
    ...init,
    headers: {
      ...(init?.body instanceof FormData
        ? {}
        : { "Content-Type": "application/json" }),
      ...init?.headers,
    },
  });
  if (!result.ok) {
    const body = await errorBody(result);
    throw new ApiError(
      typeof body.error === "string" && body.error
        ? body.error
        : failure(result.status),
      result.status,
      typeof body.code === "string" ? body.code : undefined,
    );
  }
  try {
    return await result.json();
  } catch {
    throw new ApiError(
      "Nivra sent an unexpected response. Try again.",
      result.status,
      "invalid-response",
    );
  }
}
export async function apiItems<T>(
  path: string,
  init?: RequestInit,
): Promise<T[]> {
  const page = await api<{ items: T[]; next: string | null }>(path, init);
  if (path.split("?")[0] === "tags" && page.next) {
    const url = new URL(path, "https://nivra.invalid");
    url.searchParams.set("after", page.next);
    return [
      ...page.items,
      ...(await apiItems<T>(url.pathname.slice(1) + url.search, init)),
    ];
  }
  return page.items;
}
export function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export async function downloadRequest(
  path: string,
  name: string,
  init?: RequestInit,
) {
  const result = await send(`/api/v1/${path}`, init);
  if (!result.ok) {
    const body = await errorBody(result);
    throw new ApiError(
      typeof body.error === "string" && body.error
        ? body.error
        : failure(result.status),
      result.status,
    );
  }
  download(await result.blob(), name);
}
export async function authRequest(path: string, data: Record<string, unknown>) {
  const result = await send(`/api/auth/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  let parsed;
  try {
    parsed = await result.json();
  } catch {
    if (result.ok)
      throw new ApiError(
        "Nivra sent an unexpected response. Try again.",
        result.status,
        "invalid-response",
      );
  }
  if (result.ok) return parsed;
  const body = (parsed && typeof parsed === "object" ? parsed : {}) as Record<
    string,
    string | undefined
  >;
  throw new ApiError(
    (body.error === "invalid_signature"
      ? "This connection request expired or is invalid. Start again from your MCP client."
      : body.error_description) ||
      body.message ||
      failure(result.status),
    result.status,
    body.code || body.error,
  );
}
