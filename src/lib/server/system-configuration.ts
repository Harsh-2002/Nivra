import { installationUrl } from "./installation";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { sqlite, dataDir } from "./db";
import { masterKey, seal, unseal } from "./encryption";
import { runtimeFs as fs } from "./runtime-fs";

export const connectionInput = z
  .object({
    provider: z.enum(["aws", "r2", "b2", "compatible"]),
    endpoint: z.string().max(2048).default(""),
    region: z.string().min(1).max(100).default("us-east-1"),
    bucket: z.string().min(1).max(255),
    accessKeyId: z.string().max(512).optional(),
    secretAccessKey: z.string().max(4096).optional(),
    pathStyle: z.boolean().default(true),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!value.endpoint && value.provider !== "aws")
      ctx.addIssue({
        code: "custom",
        path: ["endpoint"],
        message: "Enter your provider's S3 endpoint.",
      });
    if (value.endpoint) {
      try {
        const url = new URL(value.endpoint);
        if (
          !["http:", "https:"].includes(url.protocol) ||
          url.username ||
          url.password ||
          url.search ||
          url.hash
        )
          throw new Error();
      } catch {
        ctx.addIssue({
          code: "custom",
          path: ["endpoint"],
          message:
            "Use an HTTP or HTTPS endpoint without credentials or query parameters.",
        });
      }
    }
  });
export type Connection = z.infer<typeof connectionInput>;
export type Profile =
  | {
      backend: "local";
      directory: string;
      backupDirectory?: string;
      installation?: boolean;
    }
  | (Connection & {
      backend: "s3";
      accessKeyId: string;
      secretAccessKey: string;
      mediaPrefix: string;
      backupPrefix: string;
    });
export type SystemConfiguration = {
  revision: number;
  media_profile: string;
  local_profile: string;
  s3_profile: string | null;
  backup_profile: string;
  upload_mib: number;
  backup_hours: number;
  backup_keep: number;
};
export function writeProfile(value: Profile) {
  const id = randomUUID();
  sqlite()
    .prepare("INSERT INTO storage_profiles VALUES(?,?,?)")
    .run(
      id,
      seal(
        Buffer.from(JSON.stringify(value)),
        masterKey(dataDir),
        `storage-profile:${id}`,
      ),
      Date.now(),
    );
  return id;
}
export function readProfile(id: string): Profile {
  const row = sqlite()
    .prepare("SELECT configuration FROM storage_profiles WHERE id=?")
    .get(id) as { configuration: Buffer } | undefined;
  if (!row) throw new Error("Storage configuration is missing.");
  return JSON.parse(
    unseal(
      row.configuration,
      masterKey(dataDir, true),
      `storage-profile:${id}`,
    ).toString(),
  ) as Profile;
}
export function systemConfiguration(): SystemConfiguration {
  const database = sqlite();
  const current = database
    .prepare("SELECT * FROM system_configuration WHERE id=1")
    .get() as (SystemConfiguration & { public_url: string | null }) | undefined;
  if (current) {
    if (!current.local_profile) {
      const local =
        readProfile(current.media_profile).backend === "local"
          ? current.media_profile
          : (
              database
                .prepare("SELECT id FROM storage_profiles ORDER BY created_at")
                .all() as { id: string }[]
            ).find((row) => readProfile(row.id).backend === "local")?.id;
      if (!local) throw new Error("Local storage configuration is missing.");
      database
        .prepare(
          "UPDATE system_configuration SET local_profile=? WHERE id=1 AND local_profile IS NULL",
        )
        .run(local);
      current.local_profile = local;
    }
    if (!current.public_url) {
      const address = installationUrl();
      if (address)
        database
          .prepare(
            "UPDATE system_configuration SET public_url=? WHERE id=1 AND public_url IS NULL",
          )
          .run(address);
    }
    return current;
  }
  return database
    .transaction(() => {
      const saved = database
        .prepare("SELECT * FROM system_configuration WHERE id=1")
        .get() as SystemConfiguration | undefined;
      if (saved) {
        if (installationUrl())
          database
            .prepare(
              "UPDATE system_configuration SET public_url=? WHERE id=1 AND public_url IS NULL",
            )
            .run(installationUrl());
        return saved;
      }
      const file = path.join(dataDir, "configuration-import.enc");
      const imported: Record<string, string> = fs.existsSync(file)
        ? JSON.parse(
            unseal(
              fs.readFileSync(file),
              masterKey(dataDir, true),
              "system-configuration-import",
            ).toString(),
          )
        : {};
      const local = writeProfile({
        backend: "local",
        installation: true,
        directory: dataDir,
        backupDirectory:
          imported.NIVRA_BACKUP_DIR || path.join(dataDir, "backups"),
      });
      let s3: string | null = null;
      if (imported.NIVRA_S3_BUCKET)
        s3 = writeProfile({
          backend: "s3",
          provider: "compatible",
          endpoint: imported.NIVRA_S3_ENDPOINT || "",
          region: imported.NIVRA_S3_REGION || "us-east-1",
          bucket: imported.NIVRA_S3_BUCKET,
          accessKeyId: imported.NIVRA_S3_ACCESS_KEY_ID,
          secretAccessKey: imported.NIVRA_S3_SECRET_ACCESS_KEY,
          pathStyle: imported.NIVRA_S3_FORCE_PATH_STYLE !== "false",
          mediaPrefix: imported.NIVRA_S3_PREFIX || "nivra",
          backupPrefix: imported.NIVRA_BACKUP_PREFIX || "nivra-backups",
        });
      database
        .prepare(
          "INSERT INTO system_configuration(id,media_profile,s3_profile,backup_profile,upload_mib,backup_hours,backup_keep,local_profile) VALUES(1,?,?,?,?,?,?,?)",
        )
        .run(
          imported.NIVRA_STORAGE_BACKEND === "s3" ? s3 : local,
          s3,
          imported.NIVRA_S3_BACKUP_ENABLED === "true" ? s3 : local,
          Number(imported.NIVRA_UPLOAD_LIMIT_MIB || 25),
          Number(imported.NIVRA_BACKUP_INTERVAL_HOURS || 24),
          Number(imported.NIVRA_BACKUP_KEEP || 7),
          local,
        );
      database
        .prepare("UPDATE system_configuration SET public_url=? WHERE id=1")
        .run(installationUrl() || null);
      const config = database
        .prepare("SELECT * FROM system_configuration WHERE id=1")
        .get() as SystemConfiguration;
      database
        .prepare(
          `INSERT OR IGNORE INTO storage_locations(storage_key,profile_id)
      SELECT storage_key,? FROM attachments UNION SELECT storage_key,? FROM publication_files
      UNION SELECT thumbnail_key,? FROM bookmarks WHERE thumbnail_key IS NOT NULL
      UNION SELECT icon_key,? FROM bookmarks WHERE icon_key IS NOT NULL
      UNION SELECT storage_key,? FROM artifacts WHERE storage_key IS NOT NULL
      UNION SELECT thumb_key,? FROM artifacts WHERE thumb_key IS NOT NULL
      UNION SELECT storage_key,? FROM form_files WHERE state IN ('ready','attached')
      UNION SELECT thumb_key,? FROM form_files WHERE thumb_key IS NOT NULL AND state IN ('ready','attached')
      UNION SELECT storage_key,? FROM writing_template_attachments`,
        )
        .run(...Array(9).fill(config.media_profile));
      return config;
    })
    .immediate();
}
export function profileSource(id: string): NodeJS.ProcessEnv {
  const value = readProfile(id);
  const config = systemConfiguration();
  const common = {
    NODE_ENV: process.env.NODE_ENV || "development",
    NIVRA_KEY_DATA_DIR: dataDir,
    NIVRA_ENCRYPTION_KEY_FILE: process.env.NIVRA_ENCRYPTION_KEY_FILE,
    NIVRA_DATA_DIR: dataDir,
    NIVRA_BACKUP_KEEP: String(config.backup_keep),
    NIVRA_BACKUP_INTERVAL_HOURS: String(config.backup_hours),
  };
  if (value.backend === "local") {
    const directory =
      value.installation || id === config.local_profile
        ? dataDir
        : value.directory;
    return {
      ...common,
      NIVRA_STORAGE_BACKEND: "local",
      NIVRA_BACKUP_DIR:
        value.backupDirectory &&
        value.backupDirectory !== path.join(value.directory, "backups")
          ? value.backupDirectory
          : path.join(directory, "backups"),
      NIVRA_DATA_DIR: directory,
    };
  }
  return {
    ...common,
    NIVRA_STORAGE_BACKEND: "s3",
    NIVRA_S3_BACKUP_ENABLED: "true",
    NIVRA_S3_ENDPOINT: value.endpoint,
    NIVRA_S3_REGION: value.region,
    NIVRA_S3_BUCKET: value.bucket,
    NIVRA_S3_ACCESS_KEY_ID: value.accessKeyId,
    NIVRA_S3_SECRET_ACCESS_KEY: value.secretAccessKey,
    NIVRA_S3_FORCE_PATH_STYLE: String(value.pathStyle),
    NIVRA_S3_PREFIX: value.mediaPrefix,
    NIVRA_BACKUP_PREFIX: value.backupPrefix,
  };
}
export function activeStorageSource() {
  return profileSource(systemConfiguration().media_profile);
}
export function activeBackupSource() {
  return profileSource(systemConfiguration().backup_profile);
}

export function readableProfile(
  id: string,
  kind: "media" | "backup" = "media",
) {
  const current = systemConfiguration().s3_profile;
  if (!current || current === id) return id;
  const original = readProfile(id),
    latest = readProfile(current);
  if (original.backend !== "s3" || latest.backend !== "s3") return id;
  const prefix = kind === "media" ? "mediaPrefix" : "backupPrefix";
  return original.endpoint.replace(/\/$/, "") ===
    latest.endpoint.replace(/\/$/, "") &&
    original.bucket === latest.bucket &&
    original[prefix] === latest[prefix]
    ? current
    : id;
}
