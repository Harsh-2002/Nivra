import { api } from "./api.js";
import {
  clearConnection,
  getConnection,
  setConnection,
  setPending,
  type Connection,
} from "./storage.js";

export class PairingError extends Error {}
// Plain http would expose the key and saved links to the network.
const loopbackHost = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/;
const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
const newVerifier = () => base64url(crypto.getRandomValues(new Uint8Array(32)));
async function challengeFor(verifier: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return base64url(new Uint8Array(digest));
}

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
  if (url.protocol === "http:" && !loopbackHost.test(url.hostname))
    throw new PairingError(
      "Use an https:// address. Plain http is allowed only for localhost.",
    );
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
async function connectUrl(
  origin: string,
  flow: "web" | "code",
  state: string,
  verifier: string,
) {
  const url = new URL("/extension/connect", origin);
  url.searchParams.set("extension", chrome.runtime.id);
  url.searchParams.set("flow", flow);
  url.searchParams.set("name", deviceName());
  url.searchParams.set("challenge", await challengeFor(verifier));
  if (state) url.searchParams.set("state", state);
  return url.href;
}
export async function exchange(origin: string, code: string, verifier: string) {
  let response: Response;
  try {
    response = await fetch(`${origin}/api/v1/extension/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code: code.trim(),
        extensionId: chrome.runtime.id,
        verifier,
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
  await setPending(null);
  return connection;
}
// Resolves with the connection, or null when the owner must paste a code instead.
export async function connectInBrowser(origin: string) {
  await checkInstance(origin);
  const state = crypto.randomUUID();
  const verifier = newVerifier();
  let redirect: string | undefined;
  try {
    redirect = await chrome.identity.launchWebAuthFlow({
      url: await connectUrl(origin, "web", state, verifier),
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
  return exchange(origin, code, verifier);
}
export async function openCodePage(origin: string) {
  const verifier = newVerifier();
  await setPending({ origin, verifier });
  await chrome.tabs.create({
    url: await connectUrl(origin, "code", "", verifier),
  });
}
/** Reports whether the server key was revoked; the local connection is always removed. */
export async function disconnect() {
  const connection = await getConnection();
  let revoked = true;
  if (connection) {
    revoked = await api(connection, "extension/session", {
      method: "DELETE",
    }).then(
      () => true,
      () => false,
    );
    await chrome.permissions
      .remove({ origins: [`${connection.instance}/*`] })
      .catch(() => false);
  }
  await clearConnection();
  return revoked;
}
