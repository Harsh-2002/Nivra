import { installationUrl } from "./installation";
import { eq } from "drizzle-orm";
import { mcp } from "@better-auth/mcp";
import { cimd } from "@better-auth/cimd";
import { fetchClientMetadataResource } from "@better-auth/cimd/node";
import { apiKey } from "@better-auth/api-key";
import { jwt } from "better-auth/plugins/jwt";
import { isLoginIdentifier } from "../login-identifier";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { username } from "better-auth/plugins/username";
import { twoFactor } from "better-auth/plugins/two-factor";
import { randomBytes } from "node:crypto";
import { runtimeFs } from "./runtime-fs";
const { existsSync, readFileSync, writeFileSync } = runtimeFs;
import path from "node:path";
import { db, dataDir } from "./db";
import * as schema from "./schema";
import { requestOrigin } from "./http";
import {
  passkeyPlugin,
  authGuard,
  passkeyFreshSeconds,
  passkeyOptions,
} from "./passkeys";
import {
  isEncrypted,
  masterKey,
  replaceFile,
  seal,
  unseal,
  syncDirectory,
} from "./encryption";

export function authSecret() {
  db();
  const file = path.join(/* turbopackIgnore: true */ dataDir, "auth.secret");
  const key = masterKey(
    dataDir,
    existsSync(file) && isEncrypted(readFileSync(file)),
  );
  try {
    const bytes = readFileSync(file);
    if (isEncrypted(bytes))
      return unseal(bytes, key, "auth-secret").toString("utf8").trim();
    replaceFile(file, seal(bytes, key, "auth-secret"));
    return bytes.toString("utf8").trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    try {
      writeFileSync(
        file,
        seal(
          Buffer.from(randomBytes(48).toString("base64url")),
          key,
          "auth-secret",
        ),
        {
          flag: "wx",
          mode: 0o600,
          flush: true,
        },
      );
      syncDirectory(dataDir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    return unseal(readFileSync(file), key, "auth-secret")
      .toString("utf8")
      .trim();
  }
}
const instances = new Map<string, ReturnType<typeof createAuth>>();
export function auth(request?: Request) {
  const origin = request
    ? requestOrigin(request)
    : installationUrl() || "http://localhost:3000";
  const cached = instances.get(origin);
  if (cached) return cached;
  const instance = createAuth(origin);
  if (instances.size >= 8) instances.delete(instances.keys().next().value!);
  instances.set(origin, instance);
  return instance;
}
function createAuth(origin: string) {
  return betterAuth({
    appName: "Nivra",
    baseURL: origin,
    disabledPaths: ["/token"],
    secret: authSecret(),
    database: drizzleAdapter(db(), { provider: "sqlite", schema }),
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      minPasswordLength: 12,
      maxPasswordLength: 128,
    },
    plugins: [
      username({
        usernameValidator: isLoginIdentifier,
        maxUsernameLength: 254,
        usernameNormalization: (value) => value.trim().toLowerCase(),
      }),
      twoFactor({ issuer: "Nivra" }),
      passkeyPlugin(),
      jwt({ disableSettingJwtHeader: true }),
      apiKey({
        defaultPrefix: "nivra_",
        maximumNameLength: 80,
        enableSessionForAPIKeys: false,
        rateLimit: { enabled: true, timeWindow: 60000, maxRequests: 120 },
        permissions: { defaultPermissions: { nivra: ["read"] } },
      }),
      ...(new URL(origin).protocol === "https:" ||
      ["localhost", "127.0.0.1", "[::1]"].includes(new URL(origin).hostname)
        ? [
            mcp({
              loginPage: "/oauth/login",
              consentPage: "/oauth/consent",
              resource: `${origin}/mcp`,
              scopes: ["nivra:read", "nivra:write", "offline_access"],
              allowDynamicClientRegistration: true,
              allowUnauthenticatedClientRegistration: true,
              clientRegistrationRequirePKCE: true,
              grantTypes: ["authorization_code", "refresh_token"],
              accessTokenExpiresIn: 900,
              refreshTokenExpiresIn: 2592000,
              clientPrivileges: ({ user }) =>
                !!user &&
                !!db()
                  .select()
                  .from(schema.user)
                  .where(eq(schema.user.id, user.id))
                  .get(),
            }),
            cimd({
              fetchClientMetadataResource,
              metadataProfile: "mcp-2026-07-28",
            }),
          ]
        : []),
    ],
    hooks: { before: authGuard, after: passkeyOptions },
    trustedOrigins: [origin],
    onAPIError: { errorURL: `${origin}/oauth/error` },
    rateLimit: { enabled: true, window: 60, max: 30 },
    session: {
      expiresIn: 60 * 60 * 24 * 14,
      freshAge: passkeyFreshSeconds,
    },
  });
}
