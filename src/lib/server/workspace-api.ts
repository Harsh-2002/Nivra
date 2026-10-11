import { hasPublishedMedia } from "@/lib/media-url";
import { auth } from "@/lib/server/auth";
import { backupStatus, startBackup, verifyBackup } from "@/lib/server/backups";
import { completionStream } from "@/lib/server/completion-stream";
import { uploadLimit } from "@/lib/server/config";
import { dataDir, sqlite } from "@/lib/server/db";
import {
  checkOrigin,
  HttpError,
  json,
  readLimited,
  requestOrigin,
  response,
  throttle,
} from "@/lib/server/http";
import { startJobWorker } from "@/lib/server/jobs";
import {
  beginPasskeySetup,
  discardPasskeySetup,
  expirePasskeySetups,
  loginMethods,
} from "@/lib/server/passkey-setup";
import { passkeyFreshSeconds } from "@/lib/server/passkeys";
import { publishedNote } from "@/lib/server/publications";
import { remoteMedia } from "@/lib/server/remote-media";
import { migrateStoredFiles, storedFileResponse } from "@/lib/server/storage";
import { credentials, setupInput } from "@/lib/server/validation";
import { APIError } from "better-auth/api";
import { hashPassword } from "better-auth/crypto";
import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { z } from "zod";
import {
  authorizeContentPath,
  revokeAllAgents,
  type AgentPrincipal,
} from "./agent-access";
import { agentManagement } from "./agent-management";
import { publicFormApi } from "./public-form-api";
import { contentAreas, executeContent } from "./content-service";
import { encryptionEnabled } from "./encryption-mode";
import {
  initializeInstallation,
  InstallationBusyError,
  installationExists,
  installationUrl,
} from "./installation";
import { completionEvent } from "./jobs";
import { storageOperation } from "./storage-operations";
import { systemApi } from "./system-api";

type Attachment = {
  id: string;
  note_id: string;
  name: string;
  mime: string;
  size: number;
  storage_key: string;
  created_at: number;
};
const recoveryHash = (code: string) =>
  createHash("sha256")
    .update(code.replaceAll("-", "").trim().toLowerCase())
    .digest("hex");
const recovery = () =>
  randomBytes(24)
    .toString("hex")
    .match(/.{1,8}/g)!
    .join("-");
const settings = () => {
  const row = sqlite().prepare("SELECT theme FROM instance WHERE id=1").get();
  const owner = sqlite()
    .prepare("SELECT two_factor_enabled FROM user LIMIT 1")
    .get() as { two_factor_enabled: number } | undefined;
  return {
    ...(row as { theme: string }),
    hasPassword: !!sqlite()
      .prepare(
        "SELECT 1 FROM account WHERE provider_id='credential' AND password IS NOT NULL",
      )
      .get(),
    uploadLimit: uploadLimit(),
    twoFactorEnabled: Boolean(owner?.two_factor_enabled),
  };
};
async function handleWorkspaceInternal(
  request: Request,
  context: { params: Promise<{ path: string[] }> },
  principal?: AgentPrincipal,
) {
  try {
    const { path } = await context.params;
    const [area, id, action] = path;
    if (principal) authorizeContentPath(principal, path, request.method);
    const method = request.method;
    const url = new URL(request.url);
    if (!installationExists()) {
      if (area === "health" && method === "GET")
        return response({ status: "ok", installation: "pending" });
      if (area === "status" && method === "GET")
        return response({
          setup: true,
          installation: {
            encrypted: true,
            locked: false,
            publicUrl: installationUrl() || requestOrigin(request),
          },
          methods: { password: false, passkey: false },
          owner: null,
          settings: null,
        });
      if (
        method === "POST" &&
        (area === "setup" || (area === "setup-passkey" && !id))
      ) {
        checkOrigin(request);
        throttle("initialize");
        const body = await json(request.clone());
        const input = (
          area === "setup" ? setupInput : setupInput.omit({ password: true })
        ).parse(body);
        const encrypted = z.boolean().parse(body.encrypted ?? true);
        void input;
        initializeInstallation(
          encrypted,
          installationUrl() || requestOrigin(request),
        );
      } else throw new HttpError(401, "Please sign in to continue.");
    }
    const database = sqlite();
    await migrateStoredFiles();
    if (!principal && method !== "GET") checkOrigin(request);
    if (area === "health" && method === "GET") {
      database.prepare("SELECT 1").get();
      return response({ status: "ok" });
    }
    if (area === "published" && method === "GET") {
      const published = publishedNote(id);
      if (!published)
        throw new HttpError(404, "This shared note is no longer available.");
      if (action === "media") {
        const source = url.searchParams.get("url") || "";
        if (!hasPublishedMedia(published.document, source))
          throw new HttpError(404, "This media is not shared by this note.");
        return await remoteMedia(request, source);
      }
      if (action === "files" && path[3]) {
        const file = database
          .prepare("SELECT * FROM publication_files WHERE token=? AND id=?")
          .get(id, path[3]) as Attachment | undefined;
        if (!file) throw new HttpError(404, "This file was not found.");
        return await storedFileResponse(request, file.storage_key, file, true);
      }
      if (action) throw new HttpError(404, "This shared note was not found.");
      return response(published);
    }
    if (area === "status" || area === "setup-passkey" || area === "setup")
      expirePasskeySetups();
    const owner = database
      .prepare("SELECT id,name,username FROM user LIMIT 1")
      .get() as { id: string; name: string; username: string } | undefined;
    if (area === "status" && method === "GET") {
      const session = await auth(request).api.getSession({
        headers: request.headers,
      });
      return response({
        setup: !owner,
        installation: {
          encrypted: encryptionEnabled(dataDir),
          locked: true,
          publicUrl: installationUrl() || requestOrigin(request),
        },
        methods: loginMethods(owner?.id),
        owner: session ? owner : null,
        settings: session ? settings() : null,
      });
    }
    if (area === "setup-passkey" && method === "POST") {
      throttle("setup");
      if (id === "cancel") {
        const input = z
          .object({ context: z.string().min(43).max(43) })
          .parse(await json(request));
        discardPasskeySetup(input.context);
        return response({ ok: true });
      }
      if (id) throw new HttpError(404, "Setup action was not found.");
      return response(beginPasskeySetup(await json(request)));
    }
    if (area === "setup" && method === "POST") {
      throttle("setup");
      if (owner)
        throw new HttpError(409, "Nivra is already set up. Sign in instead.");
      const input = setupInput.parse(await json(request));
      const password = await hashPassword(input.password);
      const userId = randomUUID();
      const code = recovery();
      const now = Date.now();
      database
        .transaction(() => {
          if (database.prepare("SELECT 1 FROM user").get())
            throw new HttpError(
              409,
              "Nivra is already set up. Sign in instead.",
            );
          database
            .prepare(
              "INSERT INTO user(id,name,email,username,display_username,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
            )
            .run(
              userId,
              input.name,
              `${userId}@nivra.invalid`,
              input.username.toLowerCase(),
              input.username,
              now,
              now,
            );
          database
            .prepare(
              "INSERT INTO account(id,account_id,provider_id,user_id,password,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
            )
            .run(
              randomUUID(),
              userId,
              "credential",
              userId,
              password,
              now,
              now,
            );
          database
            .prepare("UPDATE instance SET recovery_hash=?,theme=? WHERE id=1")
            .run(recoveryHash(code), input.theme);
        })
        .immediate();
      const signIn = await auth(request).api.signInUsername({
        body: { username: input.username, password: input.password },
        headers: request.headers,
        asResponse: true,
      });
      await (await import("./startup")).startInstallationWorkersAfterSetup();
      const headers = new Headers(signIn.headers);
      headers.set("Content-Type", "application/json");
      headers.set("Cache-Control", "no-store");
      return new Response(JSON.stringify({ recoveryCode: code }), { headers });
    }
    if (area === "recover" && method === "POST") {
      throttle("recover");
      const input = credentials
        .omit({ username: true })
        .extend({ code: z.string().min(30).max(100) })
        .parse(await json(request));
      const password = await hashPassword(input.password);
      const code = recovery();
      database
        .transaction(() => {
          const stored = database
            .prepare("SELECT recovery_hash AS hash FROM instance WHERE id=1")
            .get() as { hash: string | null };
          const supplied = recoveryHash(input.code);
          if (
            !owner ||
            !stored?.hash ||
            !timingSafeEqual(Buffer.from(stored.hash), Buffer.from(supplied))
          )
            throw new HttpError(400, "That recovery code is not valid.");
          revokeAllAgents(owner.id);
          database
            .prepare(
              "UPDATE account SET password=?,updated_at=? WHERE user_id=? AND provider_id='credential'",
            )
            .run(password, Date.now(), owner.id);
          if (
            !database
              .prepare(
                "SELECT 1 FROM account WHERE user_id=? AND provider_id='credential'",
              )
              .get(owner.id)
          )
            database
              .prepare(
                "INSERT INTO account(id,account_id,provider_id,user_id,password,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
              )
              .run(
                randomUUID(),
                owner.id,
                "credential",
                owner.id,
                password,
                Date.now(),
                Date.now(),
              );
          database.prepare("DELETE FROM session").run();
          database.prepare("DELETE FROM verification").run();
          database
            .prepare("DELETE FROM two_factor WHERE user_id=?")
            .run(owner.id);
          database
            .prepare("UPDATE user SET two_factor_enabled=0 WHERE id=?")
            .run(owner.id);
          database
            .prepare("UPDATE instance SET recovery_hash=? WHERE id=1")
            .run(recoveryHash(code));
        })
        .immediate();
      return response({ recoveryCode: code });
    }
    if (area === "public" && id === "forms")
      return await publicFormApi(request, path);
    const session = principal
      ? null
      : await auth(request).api.getSession({ headers: request.headers });
    if (
      !owner ||
      (principal
        ? principal.ownerId !== owner.id
        : !session || session.user.id !== owner.id)
    )
      throw new HttpError(401, "Please sign in to continue.");
    if (contentAreas.has(area)) {
      if (
        method === "POST" &&
        ["files", "artifacts"].includes(area) &&
        Number(request.headers.get("content-length")) >
          uploadLimit() + 1024 * 1024
      )
        throw new HttpError(413, "This file exceeds your attachment limit.");
      let input: unknown;
      if (!["GET", "HEAD"].includes(method)) {
        if (area === "import" && id === "bundle")
          input = await readLimited(request, 100 * 1024 * 1024);
        else if (
          (request.headers.get("content-type") || "").startsWith(
            "multipart/form-data",
          )
        ) {
          const bytes = await readLimited(request, uploadLimit() + 1024 * 1024);
          input = await new Request(request.url, {
            method: "POST",
            headers: { "content-type": request.headers.get("content-type")! },
            body: new Uint8Array(bytes),
          }).formData();
        } else if (request.body) input = await json(request, true);
      }
      const result = await executeContent({
        ownerId: owner.id,
        principal,
        sessionId: session?.session.id,
        origin: requestOrigin(request),
        path,
        method,
        query: url.searchParams,
        input,
        transport: request,
        idempotencyKey: request.headers.get("Idempotency-Key") ?? undefined,
      });
      return "response" in result
        ? result.response
        : response(result.data, result.status);
    }
    if (area === "system") return await systemApi(request, owner.id, path);
    if (area === "ai-consent" && method === "GET" && !id) {
      const client = z
        .string()
        .min(1)
        .max(4096)
        .parse(url.searchParams.get("client"));
      const info = database
        .prepare(
          "SELECT name,client_id FROM oauth_client WHERE client_id=? AND coalesce(disabled,0)=0",
        )
        .get(client) as { name: string | null; client_id: string } | undefined;
      if (!info)
        throw new HttpError(
          404,
          "This OAuth client was not found. Start again from your AI client.",
        );
      return response({ name: info.name || info.client_id });
    }
    if (area === "ai-connections" && !id)
      return await agentManagement(request, owner.id);
    if (area === "media" && method === "GET" && !id)
      return await remoteMedia(request, url.searchParams.get("url") || "");
    if (area === "account-password" && method === "POST" && !id) {
      if (
        Date.now() - new Date(session!.session.createdAt).getTime() >=
        passkeyFreshSeconds * 1000
      )
        throw new HttpError(403, "Sign in again before adding a password.");
      const input = credentials
        .omit({ username: true })
        .parse(await json(request));
      await auth(request).api.setPassword({
        headers: request.headers,
        body: { newPassword: input.password },
      });
      return response({ ok: true });
    }
    if (area === "completions" && method === "GET" && !id) {
      startJobWorker();
      return completionStream(request, owner.id, session!.session.id);
    }
    if (area === "settings") {
      if (method === "GET") return response(settings());
      if (method === "PATCH") {
        const input = z
          .object({
            theme: z.enum(["light", "dark", "system"]),
          })
          .strict()
          .parse(await json(request));
        database
          .prepare("UPDATE instance SET theme=? WHERE id=1")
          .run(input.theme);
        return response(settings());
      }
      if (id === "recovery" && method === "POST") {
        const input = z
          .object({ password: z.string() })
          .parse(await json(request));
        if (loginMethods(owner.id).password) {
          const result = await auth(request).api.verifyPassword({
            body: input,
            headers: request.headers,
          });
          if (!result.status)
            throw new HttpError(400, "The current password is incorrect.");
        } else if (
          Date.now() - new Date(session!.session.createdAt).getTime() >=
          passkeyFreshSeconds * 1000
        )
          throw new HttpError(
            403,
            "Sign in again before replacing your recovery code.",
          );
        const code = recovery();
        database
          .prepare("UPDATE instance SET recovery_hash=? WHERE id=1")
          .run(recoveryHash(code));
        return response({ recoveryCode: code });
      }
    }
    if (area === "backups") {
      if (method === "GET" && !id) return response(await backupStatus());
      if (method === "POST" && !id) {
        throttle(`backup:${owner.id}`);
        void startBackup().catch(() => undefined);
        return response({ accepted: true }, 202);
      }
      if (method === "POST" && id && action === "verify") {
        throttle(`backup:${owner.id}`);
        return response(await verifyBackup(id));
      }
    }
    throw new HttpError(404, "This action was not found.");
  } catch (error) {
    if (error instanceof APIError)
      return response(
        {
          error:
            error.body?.message ||
            error.body?.error_description ||
            "Authentication failed. Check your credentials.",
        },
        error.statusCode,
      );
    if (error instanceof InstallationBusyError)
      return response({ error: error.message }, 409);
    if (error instanceof HttpError)
      return response({ error: error.message }, error.status);
    if (error instanceof SyntaxError)
      return response(
        { error: "This file contains invalid document data." },
        400,
      );
    if (error instanceof z.ZodError)
      return response(
        { error: error.issues[0]?.message || "Please check the form." },
        400,
      );
    if ((error as { code?: string }).code?.startsWith("SQLITE_CONSTRAINT"))
      return response(
        {
          error:
            "That name is already in use, or a referenced item no longer exists.",
        },
        409,
      );
    console.error(
      "Nivra request failed:",
      error instanceof Error ? error.message : "Unknown error",
    );
    return response(
      { error: "Nivra could not complete this action. Try again." },
      500,
    );
  }
}

export async function handleWorkspace(
  request: Request,
  context: { params: Promise<{ path: string[] }> },
  principal?: AgentPrincipal,
) {
  const path = (await context.params).path;
  const run = () => handleWorkspaceInternal(request, context, principal);
  const result = await (installationExists() &&
  request.method !== "GET" &&
  !["system", "setup", "setup-passkey"].includes(path[0])
    ? storageOperation(run)
    : run());
  if (
    result.ok &&
    ["POST", "PATCH", "DELETE"].includes(request.method) &&
    [
      "notes",
      "journals",
      "trash",
      "bookmarks",
      "artifacts",
      "tags",
      "item-tags",
      "files",
      "import",
    ].includes(path[0])
  ) {
    const owner = sqlite().prepare("SELECT id FROM user LIMIT 1").get() as {
      id: string;
    };
    const target =
      path[0] === "item-tags"
        ? path[2]
        : ["notes", "bookmarks", "artifacts"].includes(path[0])
          ? path[1] === "daily"
            ? ""
            : path[1] || ""
          : "";
    completionEvent(owner.id, "content", target, "changed");
  }
  return result;
}
