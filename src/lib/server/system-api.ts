import { createHash, randomBytes } from "node:crypto";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { apiInputs } from "./api-schemas";
import { sqlite, dataDir } from "./db";
import { HttpError, json, response } from "./http";
import {
  readProfile,
  systemConfiguration,
  writeProfile,
  type Profile,
} from "./system-configuration";
import { masterKey, seal, unseal } from "./encryption";
import { encryptionEnabled } from "./encryption-mode";
import { installationUrl } from "./installation";
import { activateStorage } from "./storage-operations";
import { completionEvent } from "./jobs";
import { copyStorageObject, removeRetainedCopies } from "./storage";
import { randomUUID } from "node:crypto";
import { checkForUpdates } from "./updates";
import { buildInfo } from "./version";

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export function systemStatus() {
  const c = systemConfiguration();
  const media = readProfile(c.media_profile);
  const backup = readProfile(c.backup_profile);
  const connection = c.s3_profile ? readProfile(c.s3_profile) : null;
  const safe =
    connection?.backend === "s3"
      ? {
          provider: connection.provider,
          endpoint: connection.endpoint,
          region: connection.region,
          bucket: connection.bucket,
          pathStyle: connection.pathStyle,
          hasCredentials: true,
        }
      : null;
  const cleanupAvailable =
    !!sqlite()
      .prepare(
        "SELECT 1 FROM storage_copies WHERE EXISTS(SELECT 1 FROM backup_archives WHERE verified_at IS NOT NULL AND json_extract(information,'$.createdAt')>=(SELECT max(retained_at) FROM storage_copies)) LIMIT 1",
      )
      .get() &&
    !sqlite()
      .prepare("SELECT 1 FROM storage_transfers WHERE state<>'done' LIMIT 1")
      .get();
  return {
    build: buildInfo(),
    cleanupAvailable,
    revision: c.revision,
    storageBackend: media.backend,
    s3Backups: backup.backend === "s3",
    uploadMiB: c.upload_mib,
    backupHours: c.backup_hours,
    backupKeep: c.backup_keep,
    connection: safe,
    encrypted: encryptionEnabled(dataDir),
    publicUrl: installationUrl() || null,
    transfer:
      (sqlite()
        .prepare(
          "SELECT id,state,copied,error FROM storage_transfers ORDER BY created_at DESC LIMIT 1",
        )
        .get() as
        | {
            id: string;
            state: "queued" | "running" | "done" | "failed";
            copied: number;
            error: string | null;
          }
        | undefined) || null,
  };
}
export async function verifyConnection(
  profile: Extract<Profile, { backend: "s3" }>,
  backups: boolean,
) {
  const client = new S3Client({
    endpoint: profile.endpoint || undefined,
    region: profile.region,
    forcePathStyle: profile.pathStyle,
    credentials: {
      accessKeyId: profile.accessKeyId,
      secretAccessKey: profile.secretAccessKey,
    },
    maxAttempts: 1,
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  const bytes = randomBytes(32);
  try {
    for (const prefix of [
      profile.mediaPrefix,
      ...(backups ? [profile.backupPrefix] : []),
    ]) {
      const key = `${prefix}/verification-${randomUUID()}`;
      let written = false;
      try {
        await client.send(
          new ListObjectsV2Command({
            Bucket: profile.bucket,
            Prefix: `${prefix}/`,
            MaxKeys: 1,
          }),
          { abortSignal: controller.signal },
        );
        await client.send(
          new PutObjectCommand({
            Bucket: profile.bucket,
            Key: key,
            Body: bytes,
            IfNoneMatch: "*",
          }),
          { abortSignal: controller.signal },
        );
        written = true;
        const found = await client.send(
          new GetObjectCommand({ Bucket: profile.bucket, Key: key }),
          { abortSignal: controller.signal },
        );
        if (
          !found.Body ||
          (found.ContentLength !== undefined &&
            found.ContentLength !== bytes.length)
        )
          throw new Error("verification");
        const body = found.Body as AsyncIterable<Uint8Array> & {
          destroy?: () => void;
        };
        const abort = () => body.destroy?.();
        controller.signal.addEventListener("abort", abort, { once: true });
        try {
          const parts: Buffer[] = [];
          let size = 0;
          for await (const part of body) {
            controller.signal.throwIfAborted();
            size += part.length;
            if (size > bytes.length) throw new Error("verification");
            parts.push(Buffer.from(part));
          }
          if (!Buffer.concat(parts).equals(bytes))
            throw new Error("verification");
        } finally {
          controller.signal.removeEventListener("abort", abort);
          body.destroy?.();
        }
      } finally {
        if (written)
          await client.send(
            new DeleteObjectCommand({ Bucket: profile.bucket, Key: key }),
            { abortSignal: AbortSignal.timeout(5000) },
          );
      }
    }
  } catch (error) {
    const status = (error as { $metadata?: { httpStatusCode?: number } })
      .$metadata?.httpStatusCode;
    throw new HttpError(
      400,
      controller.signal.aborted
        ? "Connection timed out. Check the endpoint and network, then retry."
        : status === 403
          ? "S3 access was denied. Check credentials and list, read, write and delete permissions."
          : status === 404
            ? "The bucket was not found. Check its name, region and endpoint."
            : "S3 verification failed. Check the endpoint, credentials and bucket permissions, then retry.",
    );
  } finally {
    clearTimeout(timer);
    client.destroy();
  }
}
export async function systemApi(
  request: Request,
  owner: string,
  path: string[],
) {
  if (path.length === 1 && request.method === "GET")
    return response(systemStatus());
  if (path.length === 2 && path[1] === "verify" && request.method === "POST") {
    const c = systemConfiguration();
    const input = apiInputs.systemVerify.parse(await json(request));
    const previous = c.s3_profile ? readProfile(c.s3_profile) : null;
    const old = previous?.backend === "s3" ? previous : undefined;
    const accessKeyId = input.connection.accessKeyId || old?.accessKeyId;
    const secretAccessKey =
      input.connection.secretAccessKey || old?.secretAccessKey;
    if (!accessKeyId || !secretAccessKey)
      throw new HttpError(400, "Enter the S3 access key and secret key.");
    const profile: Extract<Profile, { backend: "s3" }> = {
      ...input.connection,
      backend: "s3",
      accessKeyId,
      secretAccessKey,
      mediaPrefix: old?.mediaPrefix || "nivra",
      backupPrefix: old?.backupPrefix || "nivra-backups",
    };
    await verifyConnection(profile, input.s3Backups);
    const token = randomBytes(32).toString("base64url");
    sqlite()
      .prepare("DELETE FROM storage_verifications WHERE expires_at<=?")
      .run(Date.now());
    sqlite()
      .prepare("INSERT INTO storage_verifications VALUES(?,?,?,?,?)")
      .run(
        hash(token),
        owner,
        seal(
          Buffer.from(
            JSON.stringify({ profile, backupsVerified: input.s3Backups }),
          ),
          masterKey(dataDir),
          `storage-verification:${hash(token)}`,
        ),
        c.revision,
        Date.now() + 300000,
      );
    return response({ verificationToken: token });
  }
  if (path.length === 2 && path[1] === "updates" && request.method === "POST")
    return response(await checkForUpdates());
  if (path.length === 2 && path[1] === "cleanup" && request.method === "POST") {
    if (!systemStatus().cleanupAvailable)
      throw new HttpError(
        409,
        "Complete and verify a recovery backup after the transfer before removing source copies.",
      );
    await activateStorage(() => removeRetainedCopies());
    completionEvent(owner, "content", "system", "cleaned");
    return response(systemStatus());
  }
  if (path.length === 2 && path[1] === "retry" && request.method === "POST") {
    sqlite()
      .prepare(
        "UPDATE storage_transfers SET state='queued',error=NULL WHERE owner_id=? AND state='failed'",
      )
      .run(owner);
    startStorageTransferWorker();
    return response(systemStatus());
  }
  if (path.length !== 1 || request.method !== "PATCH")
    throw new HttpError(404, "System action was not found.");
  const input = apiInputs.systemUpdate.parse(await json(request));
  const initial = systemConfiguration();
  if (initial.revision !== input.revision)
    throw new HttpError(409, "System settings changed. Reload before saving.");
  let verified: Profile | undefined;
  if (input.verificationToken) {
    const row = sqlite()
      .prepare(
        "SELECT * FROM storage_verifications WHERE token_hash=? AND owner_id=? AND revision=? AND expires_at>?",
      )
      .get(hash(input.verificationToken), owner, input.revision, Date.now()) as
      { configuration: Buffer } | undefined;
    if (!row)
      throw new HttpError(
        409,
        "Connection verification expired. Test the connection again.",
      );
    const proof = JSON.parse(
      unseal(
        row.configuration,
        masterKey(dataDir, true),
        `storage-verification:${hash(input.verificationToken)}`,
      ).toString(),
    ) as { profile: Profile; backupsVerified: boolean };
    verified = proof.profile;
    if (input.s3Backups && !proof.backupsVerified)
      await verifyConnection(
        verified as Extract<Profile, { backend: "s3" }>,
        true,
      );
  }
  if (
    (input.storageBackend === "s3" || input.s3Backups) &&
    !initial.s3_profile &&
    !verified
  )
    throw new HttpError(400, "Test your S3 connection before using it.");
  if (
    input.s3Backups &&
    readProfile(initial.backup_profile).backend !== "s3" &&
    !verified
  )
    await verifyConnection(
      readProfile(initial.s3_profile!) as Extract<Profile, { backend: "s3" }>,
      true,
    );
  const { waitForBackup, listBackups, lockBackupConfiguration } =
    await import("./backups");
  await waitForBackup();
  if (
    verified ||
    input.s3Backups !== (readProfile(initial.backup_profile).backend === "s3")
  ) {
    try {
      await listBackups();
    } catch {}
  }
  const unlock = lockBackupConfiguration();
  try {
    await activateStorage(() =>
      sqlite()
        .transaction(() => {
          const current = systemConfiguration();
          if (current.revision !== input.revision)
            throw new HttpError(
              409,
              "System settings changed. Reload before saving.",
            );
          if (
            sqlite()
              .prepare(
                "SELECT 1 FROM storage_transfers WHERE state IN ('queued','running')",
              )
              .get()
          )
            throw new HttpError(
              409,
              "Wait for the current storage transfer to finish.",
            );
          const local = current.local_profile;
          const s3 = verified ? writeProfile(verified) : current.s3_profile;
          const media = input.storageBackend === "s3" ? s3! : local;
          const backup = input.s3Backups ? s3! : local;
          sqlite()
            .prepare(
              "UPDATE system_configuration SET revision=revision+1,media_profile=?,s3_profile=?,backup_profile=?,upload_mib=?,backup_hours=?,backup_keep=? WHERE id=1",
            )
            .run(
              media,
              s3,
              backup,
              input.uploadMiB,
              input.backupHours,
              input.backupKeep,
            );
          if (media !== current.media_profile) {
            sqlite()
              .prepare(
                "UPDATE storage_transfers SET state='done',error=NULL WHERE state='failed'",
              )
              .run();
            sqlite()
              .prepare(
                "INSERT INTO storage_transfers(id,owner_id,destination,created_at) VALUES(?,?,?,?)",
              )
              .run(randomUUID(), owner, media, Date.now());
          }
          if (input.verificationToken)
            sqlite()
              .prepare("DELETE FROM storage_verifications WHERE token_hash=?")
              .run(hash(input.verificationToken));
          completionEvent(owner, "content", "system", "updated");
        })
        .immediate(),
    );
  } finally {
    unlock();
  }
  startStorageTransferWorker();
  return response(systemStatus());
}
const runtime = globalThis as unknown as {
  nivraTransferTimer?: ReturnType<typeof setInterval>;
  nivraTransferBusy?: boolean;
};
export function startStorageTransferWorker() {
  if (runtime.nivraTransferTimer) return;
  runtime.nivraTransferTimer = setInterval(() => void transferTick(), 5000);
  runtime.nivraTransferTimer.unref();
}
export async function transferTick() {
  if (runtime.nivraTransferBusy) return;
  const row = sqlite()
    .prepare(
      "SELECT * FROM storage_transfers WHERE state='queued' OR (state='running' AND lease_until<?) ORDER BY created_at LIMIT 1",
    )
    .get(Date.now()) as
    { id: string; owner_id: string; destination: string } | undefined;
  if (!row) return;
  const token = randomUUID();
  if (
    !sqlite()
      .prepare(
        "UPDATE storage_transfers SET state='running',lease_token=?,lease_until=? WHERE id=? AND (state='queued' OR lease_until<?)",
      )
      .run(token, Date.now() + 120000, row.id, Date.now()).changes
  )
    return;
  runtime.nivraTransferBusy = true;
  const heartbeat = setInterval(() => {
    sqlite()
      .prepare(
        "UPDATE storage_transfers SET lease_until=? WHERE id=? AND lease_token=? AND state='running'",
      )
      .run(Date.now() + 120000, row.id, token);
  }, 30000);
  heartbeat.unref();
  try {
    const files = sqlite()
      .prepare(
        "SELECT storage_key FROM storage_locations WHERE profile_id<>? AND deleted=0 LIMIT 10",
      )
      .all(row.destination) as { storage_key: string }[];
    for (const file of files) {
      await (
        await import("./storage-operations")
      ).storageOperation(() =>
        copyStorageObject(file.storage_key, row.destination),
      );
      sqlite()
        .prepare(
          "UPDATE storage_transfers SET copied=copied+1,lease_until=? WHERE id=? AND lease_token=?",
        )
        .run(Date.now() + 120000, row.id, token);
    }
    const remaining = !!sqlite()
      .prepare(
        "SELECT 1 FROM storage_locations WHERE profile_id<>? AND deleted=0 LIMIT 1",
      )
      .get(row.destination);
    sqlite()
      .prepare(
        "UPDATE storage_transfers SET state=?,lease_token=NULL,lease_until=NULL WHERE id=? AND lease_token=?",
      )
      .run(remaining ? "queued" : "done", row.id, token);
    completionEvent(
      row.owner_id,
      "content",
      "system",
      remaining ? "transferring" : "ready",
    );
  } catch {
    sqlite()
      .prepare(
        "UPDATE storage_transfers SET state='failed',error=?,lease_token=NULL,lease_until=NULL WHERE id=? AND lease_token=?",
      )
      .run(
        "File transfer failed. The original files remain available. Check both storage connections and retry.",
        row.id,
        token,
      );
    completionEvent(row.owner_id, "content", "system", "failed");
  } finally {
    clearInterval(heartbeat);
    runtime.nivraTransferBusy = false;
  }
}
