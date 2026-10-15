import { api } from "./api.js";
import {
  clearConnection,
  getConnection,
  setConnection,
  setPendingInstance,
  type Connection,
} from "./storage.js";

export class PairingError extends Error {}
const privateHost =
  /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|[^.]+\.local)$/;

export function parseInstance(input: string) {
  let value = input.trim();
  if (!value) throw new PairingError("Enter your Nivra address.");
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = `https://${value}`;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PairingError("That doesn’t look like a web address.");
  }
  if (url.username || url.password)
    throw new PairingError(
      "Remove the username and password from the address.",
    );
  if (url.protocol === "http:" && !privateHost.test(url.hostname))
    throw new PairingError("Use an https:// address for a remote instance.");
  if (!["https:", "http:"].includes(url.protocol))
    throw new PairingError("Use an https:// address.");
  return { origin: url.origin, insecure: url.protocol === "http:" };
}
export function deviceName() {
  const data = (
    navigator as Navigator & {
      userAgentData?: { platform?: string; brands?: { brand: string }[] };
    }
  ).userAgentData;
  const brand =
    data?.brands?.find((b) => !/not.?a.?brand|chromium/i.test(b.brand))
      ?.brand || "Chrome";
  return `${brand} on ${data?.platform || "this device"}`.slice(0, 60);
}
// Must be the first await in a click handler: the browser requires a user gesture.
export async function allowInstance(origin: string) {
  const granted = await chrome.permissions.request({
    origins: [`${origin}/*`],
  });
  if (!granted)
    throw new PairingError(
      "Allow access to your Nivra address to connect this browser.",
    );
}
async function checkInstance(origin: string) {
  try {
    const response = await fetch(`${origin}/health`, {
      credentials: "omit",
      redirect: "error",
      signal: AbortSignal.timeout(8000),
    });
    const body = (await response.json()) as { status?: string };
    if (response.ok && body.status === "ok") return;
  } catch {
    // Reported below as one clear message.
  }
  throw new PairingError("Nivra didn’t answer at that address.");
}
function connectUrl(origin: string, flow: "web" | "code", state: string) {
  const url = new URL("/extension/connect", origin);
  url.searchParams.set("extension", chrome.runtime.id);
  url.searchParams.set("flow", flow);
  url.searchParams.set("name", deviceName());
  if (state) url.searchParams.set("state", state);
  return url.href;
}
export async function exchange(origin: string, code: string) {
  let response: Response;
  try {
    response = await fetch(`${origin}/api/v1/extension/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code: code.trim(),
        extensionId: chrome.runtime.id,
      }),
      credentials: "omit",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new PairingError("Can’t reach your Nivra instance.");
  }
  const body = (await response.json().catch(() => ({}))) as {
    key?: string;
    expiresAt?: number;
    error?: string;
  };
  if (!response.ok || !body.key)
    throw new PairingError(
      body.error || "That pairing code is not valid or has expired.",
    );
  const connection: Connection = {
    instance: origin,
    key: body.key,
    expiresAt: body.expiresAt ?? null,
    device: deviceName(),
  };
  await setConnection(connection);
  await setPendingInstance(null);
  return connection;
}
// Resolves with the connection, or null when the owner must paste a code instead.
export async function connectInBrowser(origin: string) {
  await checkInstance(origin);
  const state = crypto.randomUUID();
  let redirect: string | undefined;
  try {
    redirect = await chrome.identity.launchWebAuthFlow({
      url: connectUrl(origin, "web", state),
      interactive: true,
    });
  } catch {
    redirect = undefined;
  }
  if (!redirect) return null;
  const fields = new URLSearchParams(new URL(redirect).hash.slice(1));
  const code = fields.get("code");
  if (!code || fields.get("state") !== state)
    throw new PairingError("The connection was cancelled. Try again.");
  return exchange(origin, code);
}
export async function openCodePage(origin: string) {
  await setPendingInstance(origin);
  await chrome.tabs.create({ url: connectUrl(origin, "code", "") });
}
export async function disconnect() {
  const connection = await getConnection();
  if (connection)
    await api(connection, "extension/session", { method: "DELETE" }).catch(
      () => undefined,
    );
  await clearConnection();
}
