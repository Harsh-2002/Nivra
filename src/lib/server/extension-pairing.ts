import { createHash, randomBytes } from "node:crypto";
import { auth } from "./auth";
import { sqlite } from "./db";
import { HttpError, throttle } from "./http";

export const extensionIdPattern = /^[a-p]{32}$/;
const bundledExtensionIds = ["afdnjjepnkbmblblbcjfjakoimgniabn"];
const codeLifetimeMs = 2 * 60 * 1000;
const keyLifetimeSeconds = 90 * 24 * 60 * 60;
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");

export function allowedExtensionIds() {
  const configured = (process.env.NIVRA_EXTENSION_IDS || "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => extensionIdPattern.test(id));
  return [...new Set([...bundledExtensionIds, ...configured])];
}
export const isAllowedExtension = (id: string) =>
  allowedExtensionIds().includes(id);
export function extensionIdFromOrigin(origin: string | null) {
  const id = /^chrome-extension:\/\/([a-p]{32})$/.exec(origin || "")?.[1];
  return id && isAllowedExtension(id) ? id : undefined;
}
export function extensionBinding(keyId: string) {
  return sqlite()
    .prepare(
      "SELECT extension_id AS extensionId FROM extension_keys WHERE key_id=?",
    )
    .get(keyId) as { extensionId: string } | undefined;
}
export function beginPairing(
  ownerId: string,
  input: { extensionId: string; deviceName: string },
) {
  if (!isAllowedExtension(input.extensionId))
    throw new HttpError(
      400,
      "This extension is not recognized by this instance.",
    );
  throttle(`extension-authorize:${ownerId}`, 10);
  const code = randomBytes(32).toString("base64url");
  const now = Date.now();
  const d = sqlite();
  d.transaction(() => {
    d.prepare("DELETE FROM extension_pairing WHERE expires_at<=?").run(now);
    d.prepare(
      "INSERT INTO extension_pairing(code_hash,owner_id,extension_id,device_name,expires_at,created_at) VALUES(?,?,?,?,?,?)",
    ).run(
      hash(code),
      ownerId,
      input.extensionId,
      input.deviceName,
      now + codeLifetimeMs,
      now,
    );
  })();
  return { code, expiresAt: now + codeLifetimeMs };
}
export async function completePairing(
  request: Request,
  input: { code: string; extensionId: string },
) {
  throttle("extension-pair", 20);
  if (
    !isAllowedExtension(input.extensionId) ||
    request.headers.get("origin") !== `chrome-extension://${input.extensionId}`
  )
    throw new HttpError(403, "Request origin is not allowed.");
  const claimed = sqlite()
    .prepare(
      "DELETE FROM extension_pairing WHERE code_hash=? AND extension_id=? AND expires_at>? RETURNING owner_id AS ownerId,device_name AS deviceName",
    )
    .get(hash(input.code), input.extensionId, Date.now()) as
    { ownerId: string; deviceName: string } | undefined;
  if (!claimed)
    throw new HttpError(400, "This pairing code is not valid or has expired.");
  const key = await auth(request).api.createApiKey({
    body: {
      userId: claimed.ownerId,
      name: `Chrome extension – ${claimed.deviceName}`.slice(0, 80),
      expiresIn: keyLifetimeSeconds,
      permissions: { nivra: ["read", "write"] },
    },
  });
  sqlite()
    .prepare(
      "INSERT INTO extension_keys(key_id,owner_id,extension_id,created_at) VALUES(?,?,?,?)",
    )
    .run(key.id, claimed.ownerId, input.extensionId, Date.now());
  return {
    key: key.key,
    id: key.id,
    expiresAt: Date.now() + keyLifetimeSeconds * 1000,
  };
}
export function extensionSession(ownerId: string, connectionId: string) {
  const keyId = connectionId.replace(/^key:/, "");
  const row = sqlite()
    .prepare(
      "SELECT name,expires_at AS expiresAt FROM apikey WHERE id=? AND reference_id=?",
    )
    .get(keyId, ownerId) as
    { name: string | null; expiresAt: number | null } | undefined;
  if (!row) throw new HttpError(401, "This connection is no longer active.");
  const theme = (
    sqlite().prepare("SELECT theme FROM instance WHERE id=1").get() as
      { theme: "light" | "dark" | "system" } | undefined
  )?.theme;
  return {
    name: row.name || "Chrome extension",
    expiresAt: row.expiresAt,
    theme: theme ?? "system",
  };
}
export function revokeOwnExtensionKey(ownerId: string, connectionId: string) {
  const keyId = connectionId.replace(/^key:/, "");
  const d = sqlite();
  d.transaction(() => {
    d.prepare("DELETE FROM apikey WHERE id=? AND reference_id=?").run(
      keyId,
      ownerId,
    );
    d.prepare("DELETE FROM agent_idempotency WHERE connection_id=?").run(
      connectionId,
    );
  })();
}
