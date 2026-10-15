import { installationExists, installationUrl } from "./installation";
import { requireMcpAuth } from "@better-auth/mcp";
import { decodeJwt } from "jose";
import { auth } from "./auth";
import { sqlite } from "./db";
import { checkOrigin, HttpError, requestOrigin, response } from "./http";
import {
  agentScopes,
  tokenHash,
  revokeOAuth,
  type AgentPrincipal,
} from "./agent-access";
import { extensionBinding, extensionIdFromOrigin } from "./extension-pairing";
function limitedResponse() {
  const result = response(
    { error: "Too many agent requests. Retry shortly." },
    429,
  );
  result.headers.set("Retry-After", "60");
  return result;
}
export function agentResource(request: Request) {
  return `${requestOrigin(request)}/mcp`;
}
export function agentChallenge(
  request: Request,
  status = 401,
  scope = status === 401 ? "nivra:read nivra:write" : "nivra:read",
) {
  const result = response(
    {
      error:
        status === 401
          ? "An API key or OAuth access token is required."
          : "This connection needs additional permissions.",
    },
    status,
  );
  result.headers.set(
    "WWW-Authenticate",
    `Bearer resource_metadata="${requestOrigin(request)}/.well-known/oauth-protected-resource/mcp", scope="${scope}"${status === 403 ? ', error="insufficient_scope"' : ""}`,
  );
  return result;
}
export async function withAgent(
  request: Request,
  handler: (p: AgentPrincipal) => Promise<Response>,
  options: { apiKeyOnly?: boolean } = {},
) {
  try {
    if (!installationExists())
      return response({ error: "Complete installation setup first." }, 401);
    const origin = request.headers.get("origin");
    const extensionOrigin = origin ? extensionIdFromOrigin(origin) : undefined;
    const bareCrossSite =
      !origin && request.headers.get("sec-fetch-site") === "cross-site";
    const crossOrigin = Boolean(extensionOrigin) || bareCrossSite;
    // Bearer keys carry no ambient credentials; only extension keys may cross origins
    if (!crossOrigin) checkOrigin(request);
    const publicUrl = installationUrl();
    if (
      publicUrl &&
      request.headers.get("host") &&
      request.headers.get("host") !== new URL(publicUrl).host
    )
      throw new HttpError(403, "Request host is not allowed.");
    const header = request.headers.get("authorization") || "";
    const token = /^Bearer ([^\s]+)$/i.exec(header)?.[1];
    if (!token || token.length > 8192) return agentChallenge(request);
    if (token.startsWith("nivra_")) {
      const result = await auth(request).api.verifyApiKey({
        body: { key: token },
      });
      if (result.error?.code === "RATE_LIMIT_EXCEEDED")
        return limitedResponse();
      if (!result.valid || !result.key) return agentChallenge(request);
      const owner = result.key.referenceId;
      if (!sqlite().prepare("SELECT 1 FROM user WHERE id=?").get(owner))
        return agentChallenge(request);
      const scopes = result.key.permissions?.nivra || [];
      if (!scopes.includes("read")) return agentChallenge(request, 403);
      const binding = extensionBinding(result.key.id);
      if (binding && !options.apiKeyOnly) return agentChallenge(request, 403);
      if (
        crossOrigin &&
        (!binding ||
          (extensionOrigin && binding.extensionId !== extensionOrigin))
      )
        throw new HttpError(403, "Request origin is not allowed.");
      return handler({
        ownerId: owner,
        connectionId: `key:${result.key.id}`,
        scopes: scopes.map((s) => `nivra:${s}`),
        ...(binding ? { client: "extension" as const } : {}),
      });
    }
    if (crossOrigin) throw new HttpError(403, "Request origin is not allowed.");
    if (options.apiKeyOnly)
      return response(
        { error: "A bearer API key is required.", code: "unauthorized" },
        401,
      );
    if (
      !sqlite()
        .prepare(
          "SELECT 1 FROM agent_tokens WHERE token_hash=? AND expires_at>?",
        )
        .get(tokenHash(token), Date.now())
    )
      return agentChallenge(request);
    return requireMcpAuth(
      auth(request),
      async (_r, claims) => {
        const stored = sqlite()
          .prepare(
            "SELECT owner_id,client_id FROM agent_tokens WHERE token_hash=? AND expires_at>?",
          )
          .get(tokenHash(token), Date.now()) as
          { owner_id: string; client_id: string } | undefined;
        if (
          !stored ||
          claims.sub !== stored.owner_id ||
          claims.client_id !== stored.client_id
        )
          return agentChallenge(request);
        const scopes =
          typeof claims.scope === "string"
            ? claims.scope.split(" ").filter((s) => agentScopes.includes(s))
            : [];
        const connection = `oauth:${stored.client_id}`;
        const now = Date.now();
        const quota = sqlite()
          .prepare(
            "INSERT INTO agent_rate_limits VALUES(?,?,1) ON CONFLICT(connection_id) DO UPDATE SET requests=CASE WHEN window_start<=? THEN 1 ELSE requests+1 END,window_start=CASE WHEN window_start<=? THEN excluded.window_start ELSE window_start END RETURNING requests",
          )
          .get(connection, now, now - 60000, now - 60000) as {
          requests: number;
        };
        if (quota.requests > 120) return limitedResponse();
        return handler({
          ownerId: stored.owner_id,
          connectionId: `oauth:${stored.client_id}`,
          scopes,
        });
      },
      { resource: agentResource(request), requiredScopes: ["nivra:read"] },
    )(request);
  } catch (e) {
    if (e instanceof HttpError) return response({ error: e.message }, e.status);
    return agentChallenge(request);
  }
}
export async function captureOAuthToken(
  request: Request,
  result: Response,
  startedAt = Date.now(),
) {
  if (!new URL(request.url).pathname.endsWith("/oauth2/token") || !result.ok)
    return result;
  const body = await result.clone().json();
  if (typeof body.access_token !== "string") return result;
  const claims = decodeJwt(body.access_token);
  if (
    typeof claims.sub !== "string" ||
    typeof claims.client_id !== "string" ||
    typeof claims.exp !== "number" ||
    !sqlite().prepare("SELECT 1 FROM user WHERE id=?").get(claims.sub)
  )
    return response({ error: "invalid_grant" }, 400);
  const expiresAt = claims.exp * 1000;
  if (
    sqlite()
      .prepare(
        "SELECT 1 FROM agent_revocations WHERE owner_id=? AND client_id IN (?, '*') AND revoked_at>=?",
      )
      .get(claims.sub, claims.client_id, startedAt)
  ) {
    revokeOAuth(claims.sub, claims.client_id);
    return response({ error: "invalid_grant" }, 400);
  }
  sqlite().transaction(() => {
    sqlite()
      .prepare("DELETE FROM agent_tokens WHERE expires_at<=?")
      .run(Date.now());
    sqlite()
      .prepare("INSERT OR REPLACE INTO agent_tokens VALUES(?,?,?,?,?)")
      .run(
        tokenHash(body.access_token),
        claims.sub,
        claims.client_id,
        expiresAt,
        Date.now(),
      );
  })();
  result.headers.set("Cache-Control", "no-store");
  return result;
}
