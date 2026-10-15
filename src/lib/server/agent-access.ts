import { createHash } from "node:crypto";
import { sqlite } from "./db";
import { HttpError } from "./http";
export type AgentPrincipal = {
  ownerId: string;
  connectionId: string;
  scopes: string[];
  client?: "extension";
};
export const agentScopes = ["nivra:read", "nivra:write"];
export function tokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}
function extensionMayCall(path: string[], method: string) {
  const [area, id, third] = path;
  if (area === "capture") return method === "POST" && path.length === 1;
  if (area === "bookmarks")
    return path.length === 1
      ? method === "GET"
      : path.length === 2 && ["GET", "PATCH", "DELETE"].includes(method);
  if (area === "tags")
    return path.length === 1 && ["GET", "POST"].includes(method);
  if (area === "item-tags")
    return id === "bookmark" && !!third && ["GET", "PATCH"].includes(method);
  if (area === "notes") return method === "POST" && path.length === 1;
  if (area === "extension")
    return id === "session" && ["GET", "DELETE"].includes(method);
  return false;
}
export function authorizeContentPath(
  principal: AgentPrincipal,
  path: string[],
  method: string,
) {
  if (principal.client === "extension" && !extensionMayCall(path, method))
    throw new HttpError(
      403,
      "This browser extension connection cannot use that operation.",
    );
  if (path[0] === "extension" && principal.client !== "extension")
    throw new HttpError(403, "Agents cannot administer this instance.");
  if (
    path[0] !== "extension" &&
    ![
      "forms",
      "capture",
      "notes",
      "journals",
      "events",
      "counts",
      "jobs",
      "tasks",
      "boards",
      "bookmarks",
      "artifacts",
      "tags",
      "item-tags",
      "favorites",
      "trash",
      "files",
      "search",
      "overview",
      "calendar",
      "templates",
      "export",
      "import",
    ].includes(path[0])
  )
    throw new HttpError(403, "Agents cannot administer this instance.");
  if (
    !principal.scopes.includes("nivra:read") ||
    (method !== "GET" &&
      path[0] !== "export" &&
      !principal.scopes.includes("nivra:write"))
  )
    throw new HttpError(
      403,
      "This connection does not have permission to change content.",
    );
  if (path[0] === "calendar" && path[1] === "subscriptions")
    throw new HttpError(403, "Enable device notifications in the app.");
  if (path[0] === "templates" && method === "DELETE")
    throw new HttpError(
      403,
      "Agents cannot permanently delete writing templates.",
    );
  if (
    path[0] === "bookmarks" &&
    path[2] === "highlights" &&
    method === "DELETE"
  )
    throw new HttpError(
      403,
      "Agents cannot permanently delete article highlights.",
    );
  if (method !== "GET") {
    if (path[0] === "trash")
      throw new HttpError(
        403,
        "Agents cannot restore or permanently delete items. Trash is read-only.",
      );
    const tables: Record<string, string> = {
      forms: "forms",
      notes: "notes",
      journals: "notes",
      events: "calendar_events",
      tasks: "tasks",
      bookmarks: "bookmarks",
      artifacts: "artifacts",
    };
    if (
      path[0] === "forms" &&
      path[2] === "responses" &&
      path[3] &&
      sqlite()
        .prepare(
          "SELECT 1 FROM form_responses r JOIN forms f ON f.id=r.form_id WHERE r.id=? AND f.id=? AND f.owner_id=? AND r.trashed_at IS NOT NULL",
        )
        .get(path[3], path[1], principal.ownerId)
    )
      throw new HttpError(403, "Agents cannot change submissions in Trash.");
    const table = tables[path[0]];
    if (
      table &&
      path[1] &&
      sqlite()
        .prepare(
          `SELECT 1 FROM ${table} WHERE id=? AND owner_id=? AND trashed_at IS NOT NULL`,
        )
        .get(path[1], principal.ownerId)
    )
      throw new HttpError(403, "Agents cannot change items in Trash.");
  }
}
export function revokeOAuth(owner: string, client: string) {
  const d = sqlite();
  d.transaction(() => {
    d.prepare("INSERT OR REPLACE INTO agent_revocations VALUES(?,?,?)").run(
      owner,
      client,
      Date.now(),
    );
    d.prepare("DELETE FROM agent_tokens WHERE owner_id=? AND client_id=?").run(
      owner,
      client,
    );
    d.prepare(
      "DELETE FROM oauth_access_token WHERE user_id=? AND client_id=?",
    ).run(owner, client);
    d.prepare(
      "DELETE FROM oauth_refresh_token WHERE user_id=? AND client_id=?",
    ).run(owner, client);
    d.prepare("DELETE FROM oauth_consent WHERE user_id=? AND client_id=?").run(
      owner,
      client,
    );
    d.prepare(
      "DELETE FROM verification WHERE json_valid(value) AND json_extract(value,'$.query.client_id')=?",
    ).run(client);
    d.prepare("DELETE FROM agent_idempotency WHERE connection_id=?").run(
      `oauth:${client}`,
    );
    d.prepare("DELETE FROM agent_rate_limits WHERE connection_id=?").run(
      `oauth:${client}`,
    );
  }).immediate();
}
export function revokeAllAgents(owner: string) {
  const d = sqlite();
  d.prepare("INSERT OR REPLACE INTO agent_revocations VALUES(?,?,?)").run(
    owner,
    "*",
    Date.now(),
  );
  d.prepare("DELETE FROM agent_tokens WHERE owner_id=?").run(owner);
  d.prepare("DELETE FROM oauth_access_token WHERE user_id=?").run(owner);
  d.prepare("DELETE FROM oauth_refresh_token WHERE user_id=?").run(owner);
  d.prepare("DELETE FROM oauth_consent WHERE user_id=?").run(owner);
  d.prepare("DELETE FROM apikey WHERE reference_id=?").run(owner);
  d.prepare(
    "DELETE FROM verification WHERE json_valid(value) AND json_extract(value,'$.query.client_id') IS NOT NULL",
  ).run();
  d.prepare("DELETE FROM agent_idempotency").run();
  d.prepare("DELETE FROM agent_rate_limits").run();
}
