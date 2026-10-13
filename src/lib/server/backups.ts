import {
  activeBackupSource,
  profileSource,
  readProfile,
  readableProfile,
  systemConfiguration,
} from "./system-configuration";
import { completionEvent } from "./jobs";
import { environment } from "./environment";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import Database from "better-sqlite3";
import { z } from "zod";
import { runtimeFs as fs } from "./runtime-fs";
import { dataDir, databaseFile, sqlite } from "./db";
import { encryptionEnabled, persistEncryptionMode } from "./encryption-mode";
import {
  masterKey,
  deriveKey,
  seal,
  unseal,
  replaceFile,
  syncDirectory,
} from "./encryption";
import {
  createStorage,
  storage,
  pinStoredFiles,
  migrateStoredFiles,
} from "./storage";
import {
  backupConfig,
  backupId,
  backupRepository,
  type BackupRepository,
} from "./backup-repository";
import { HttpError } from "./http";
const object = z
  .object({
    name: z.string().regex(/^(database|auth|files\/[a-f0-9-]{36})$/),
    size: z.number().int().nonnegative(),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
const manifestSchema = z
  .object({
    format: z.literal("nivra-backup"),
    version: z.literal(1),
    id: z.string().regex(backupId),
    createdAt: z.number().int().positive(),
    storage: z.enum(["local", "s3"]),
    encrypted: z.boolean().default(true),
    objects: z.array(object).min(2).max(1_000_000),
  })
  .strict();
type Manifest = z.infer<typeof manifestSchema>;
export type BackupInfo = {
  id: string;
  createdAt: number;
  size: number;
  files: number;
};
export type BackupStatus = {
  backend: "local" | "s3";
  storage: "local" | "s3";
  intervalHours: number;
  keep: number;
  running: boolean;
  lastSuccess: number | null;
  nextAt: number | null;
  error: string | null;
  backups: BackupInfo[];
};
type State = {
  lastSuccess: number | null;
  lastAttempt: number | null;
  error: string | null;
};
const stateSchema = z.object({
  lastSuccess: z.number().nullable(),
  lastAttempt: z.number().nullable(),
  error: z.string().nullable(),
});
const runtime = globalThis as unknown as {
  nivraBackupJob?: Promise<BackupInfo>;
  nivraBackupTimer?: ReturnType<typeof setInterval>;
};
const privatePath = (name: string) =>
  path.join(/* turbopackIgnore: true */ dataDir, name);
const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
function openSnapshot(
  file: string,
  key: Buffer,
  readonly = true,
  encrypted = true,
) {
  const database = new Database(file, { readonly, fileMustExist: true });
  try {
    database.pragma("cipher='chacha20'");
    if (encrypted)
      database.pragma(`key='${deriveKey(key, "sqlite").toString("hex")}'`);
    database.pragma("temp_store=MEMORY");
    if (
      database.pragma("integrity_check", { simple: true }) !== "ok" ||
      (database.pragma("foreign_key_check") as unknown[]).length
    )
      throw new Error("The database snapshot failed integrity checks.");
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}
export function referencedFiles(database: Database.Database): string[] {
  const hasArtifacts = !!database
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='artifacts'",
    )
    .get();
  const hasForms = !!database
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='form_files'",
    )
    .get();
  const hasWritingTemplateAttachments = !!database
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='writing_template_attachments'",
    )
    .get();
  return (
    database
      .prepare(
        `SELECT storage_key AS key FROM attachments UNION SELECT storage_key FROM publication_files
    UNION SELECT thumbnail_key FROM bookmarks WHERE thumbnail_key IS NOT NULL
    UNION SELECT icon_key FROM bookmarks WHERE icon_key IS NOT NULL${
      hasWritingTemplateAttachments
        ? " UNION SELECT storage_key FROM writing_template_attachments"
        : ""
    }${
      hasArtifacts
        ? " UNION SELECT storage_key FROM artifacts WHERE storage_key IS NOT NULL UNION SELECT thumb_key FROM artifacts WHERE thumb_key IS NOT NULL"
        : ""
    }${hasForms ? " UNION SELECT storage_key FROM form_files WHERE state IN ('ready','attached') UNION SELECT thumb_key FROM form_files WHERE thumb_key IS NOT NULL AND state IN ('ready','attached')" : ""}`,
      )
      .all() as { key: string }[]
  ).map((r) => {
    if (!/^[a-f0-9-]{36}$/.test(r.key))
      throw new Error("The database contains an invalid storage key.");
    return r.key;
  });
}
function state(): State {
  if (fs.existsSync(privatePath("backup-state.enc")))
    return stateSchema.parse(
      JSON.parse(
        unseal(
          fs.readFileSync(privatePath("backup-state.enc")),
          masterKey(dataDir, true),
          "backup-state",
        ).toString(),
      ),
    );
  return { lastSuccess: null, lastAttempt: null, error: null };
}
function persistState(next: State) {
  replaceFile(
    privatePath("backup-state.enc"),
    seal(
      Buffer.from(JSON.stringify(next)),
      masterKey(dataDir, true),
      "backup-state",
    ),
  );
}
function lease() {
  const file = privatePath("backup.lock");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, String(process.pid), {
        flag: "wx",
        mode: 0o600,
        flush: true,
      });
      return () => {
        fs.unlinkSync(file);
        syncDirectory(dataDir);
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const pid = Number(fs.readFileSync(file, "utf8"));
      if (!Number.isInteger(pid) || pid <= 0)
        throw new Error("An invalid backup lock needs operator attention.");
      try {
        process.kill(pid, 0);
        throw new HttpError(409, "A backup is already running.");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
        fs.unlinkSync(file);
      }
    }
  }
  throw new HttpError(409, "A backup is already running.");
}
async function manifest(
  repository: BackupRepository,
  id: string,
  key: Buffer,
): Promise<Manifest> {
  if (!backupId.test(id)) throw new Error("Invalid backup identifier.");
  const bytes = unseal(
    await repository.read(`${id}/manifest`),
    key,
    `backup:${id}:manifest`,
  );
  const data = manifestSchema.parse(JSON.parse(bytes.toString()));
  const names = new Set(data.objects.map((o) => o.name));
  if (
    data.id !== id ||
    names.size !== data.objects.length ||
    !names.has("database") ||
    !names.has("auth")
  )
    throw new Error("The backup manifest is inconsistent.");
  return data;
}
function info(data: Manifest): BackupInfo {
  return {
    id: data.id,
    createdAt: data.createdAt,
    size: data.objects.reduce((n, o) => n + o.size, 0),
    files: data.objects.length - 2,
  };
}
export async function listBackups(
  env?: NodeJS.ProcessEnv,
  key = masterKey(dataDir, true),
): Promise<BackupInfo[]> {
  const repository = backupRepository(env || activeBackupSource());
  const keys = await repository.list();
  const result: BackupInfo[] = [];
  for (const object of keys.filter((k) => k.endsWith("/manifest"))) {
    const value = info(await manifest(repository, object.split("/")[0], key));
    result.push(value);
    if (!env)
      sqlite()
        .prepare(
          "INSERT INTO backup_archives(id,profile_id,information) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET profile_id=excluded.profile_id,information=excluded.information",
        )
        .run(
          value.id,
          systemConfiguration().backup_profile,
          JSON.stringify(value),
        );
  }
  if (!env) {
    const old = sqlite()
      .prepare("SELECT information FROM backup_archives WHERE profile_id<>?")
      .all(systemConfiguration().backup_profile) as { information: string }[];
    for (const row of old) result.push(JSON.parse(row.information));
  }
  return result.sort((a, b) => b.createdAt - a.createdAt);
}
export function lockBackupConfiguration() {
  return lease();
}
export async function waitForBackup() {
  if (runtime.nivraBackupJob) await runtime.nivraBackupJob;
  if (leaseIsAlive())
    throw new HttpError(409, "A backup is running. Retry after it finishes.");
}

async function prune(repository: BackupRepository, key: Buffer, keep: number) {
  const keys = await repository.list();
  const complete: Manifest[] = [];
  for (const object of keys.filter((k) => k.endsWith("/manifest")))
    complete.push(await manifest(repository, object.split("/")[0], key));
  complete.sort((a, b) => b.createdAt - a.createdAt);
  for (const old of complete.slice(keep)) {
    // Remove the commit marker before pruning its objects.
    await repository.remove(`${old.id}/manifest`);
    sqlite().prepare("DELETE FROM backup_archives WHERE id=?").run(old.id);
    for (const object of old.objects)
      await repository.remove(`${old.id}/${object.name}`);
  }
  const completed = new Set(complete.map((m) => m.id));
  for (const object of keys) {
    const id = object.split("/")[0];
    if (
      !completed.has(id) &&
      Date.now() - Number(id.slice(0, 13)) > 24 * 60 * 60 * 1000
    )
      await repository.remove(object);
  }
}
export async function createBackup(): Promise<BackupInfo> {
  const config = backupConfig();
  const repository = backupRepository();
  if (runtime.nivraBackupJob)
    throw new HttpError(409, "A backup is already running.");
  await migrateStoredFiles();
  if (!sqlite().prepare("SELECT 1 FROM user LIMIT 1").get())
    throw new HttpError(400, "Set up your account before creating a backup.");
  const key = masterKey(dataDir, true);
  const unlock = lease();
  const id = `${Date.now()}-${randomUUID()}`;
  const snapshot = privatePath(`backup-${id}.sqlite`);
  let release: (() => Promise<void>) | undefined;
  const written: string[] = [];
  try {
    persistState({ ...state(), lastAttempt: Date.now(), error: null });
    sqlite().prepare("VACUUM INTO ?").run(snapshot);
    fs.chmodSync(snapshot, 0o600);
    const encrypted = encryptionEnabled(dataDir);
    const database = openSnapshot(snapshot, key, true, encrypted);
    let files: string[];
    try {
      files = referencedFiles(database);
    } finally {
      database.close();
    }
    release = pinStoredFiles(files);
    const data: Manifest = {
      format: "nivra-backup",
      version: 1,
      id,
      createdAt: Date.now(),
      storage: readProfile(systemConfiguration().media_profile).backend,
      encrypted,
      objects: [],
    };
    async function write(name: string, bytes: Buffer) {
      const objectKey = `${id}/${name}`;
      await repository.write(
        objectKey,
        seal(bytes, key, `backup:${id}:${name}`),
      );
      written.push(objectKey);
      data.objects.push({ name, size: bytes.length, hash: hash(bytes) });
    }
    await write("database", fs.readFileSync(snapshot));
    const secret = fs.readFileSync(privatePath("auth.secret"));
    unseal(secret, key, "auth-secret");
    await write("auth", secret);
    for (const file of files)
      await write(`files/${file}`, await storage.read(file));
    await repository.write(
      `${id}/manifest`,
      seal(Buffer.from(JSON.stringify(data)), key, `backup:${id}:manifest`),
    );
    written.length = 0;
    persistState({
      lastAttempt: state().lastAttempt,
      lastSuccess: data.createdAt,
      error: null,
    });
    try {
      await prune(repository, key, config.keep);
    } catch {
      persistState({
        ...state(),
        error:
          "Backup saved, but retention cleanup failed. Check the backup destination and permissions.",
      });
    }
    sqlite()
      .prepare(
        "INSERT INTO backup_archives(id,profile_id,information) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET profile_id=excluded.profile_id,information=excluded.information",
      )
      .run(
        data.id,
        systemConfiguration().backup_profile,
        JSON.stringify(info(data)),
      );
    return info(data);
  } catch (error) {
    persistState({
      ...state(),
      error:
        "Backup failed. Check storage availability and free space, then retry. Your existing data is unchanged.",
    });
    for (const object of written)
      await repository.remove(object).catch(() => undefined);
    throw error;
  } finally {
    try {
      if (fs.existsSync(snapshot)) fs.unlinkSync(snapshot);
      await release?.();
    } finally {
      unlock();
    }
  }
}
export function startBackup(): Promise<BackupInfo> {
  if (runtime.nivraBackupJob)
    throw new HttpError(409, "A backup is already running.");
  const job = createBackup();
  runtime.nivraBackupJob = job;
  void job
    .finally(() => {
      delete runtime.nivraBackupJob;
      const owner = sqlite().prepare("SELECT id FROM user LIMIT 1").get() as
        { id: string } | undefined;
      if (owner) completionEvent(owner.id, "backup", "", "finished");
    })
    .catch(() => undefined);
  return job;
}
function leaseIsAlive() {
  if (!fs.existsSync(privatePath("backup.lock"))) return false;
  const pid = Number(fs.readFileSync(privatePath("backup.lock"), "utf8"));
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
export async function backupStatus(): Promise<BackupStatus> {
  const config = backupConfig();
  const current = state();
  return {
    backend: config.backend,
    storage: readProfile(systemConfiguration().media_profile).backend,
    intervalHours: config.intervalHours,
    keep: config.keep,
    running: !!runtime.nivraBackupJob || leaseIsAlive(),
    lastSuccess: current.lastSuccess,
    nextAt:
      (current.lastAttempt ||
        Number(fs.statSync(databaseFile).birthtimeMs) ||
        Date.now()) +
      config.intervalHours * 3_600_000,
    error:
      current.error ||
      (fs.existsSync(privatePath("backup.lock")) && !leaseIsAlive()
        ? "A backup was interrupted. Retry to create a new complete copy."
        : null),
    backups: await listBackups(),
  };
}
async function readObject(
  repository: BackupRepository,
  data: Manifest,
  name: string,
  key: Buffer,
) {
  const object = data.objects.find((o) => o.name === name);
  if (!object) throw new Error("A required backup object is missing.");
  const bytes = unseal(
    await repository.read(`${data.id}/${name}`),
    key,
    `backup:${data.id}:${name}`,
  );
  if (bytes.length !== object.size || hash(bytes) !== object.hash)
    throw new Error("A backup object failed integrity checks.");
  return bytes;
}
export async function restoreBackup(
  id: string,
  destination: string,
  env?: NodeJS.ProcessEnv,
): Promise<BackupInfo> {
  if (!env) {
    const archive = sqlite()
      .prepare("SELECT profile_id FROM backup_archives WHERE id=?")
      .get(id) as { profile_id: string } | undefined;
    env = archive
      ? profileSource(readableProfile(archive.profile_id, "backup"))
      : activeBackupSource();
  }
  env = environment(env);
  const key = masterKey(
    path.resolve(
      /* turbopackIgnore: true */ env.NIVRA_KEY_DATA_DIR ||
        env.NIVRA_DATA_DIR ||
        "./data",
    ),
    true,
    env,
  );
  const repository = backupRepository(env);
  const data = await manifest(repository, id, key);
  const target = path.resolve(/* turbopackIgnore: true */ destination);
  function checkEmpty() {
    if (!fs.existsSync(target)) return;
    if (
      fs.lstatSync(target).isSymbolicLink() ||
      !fs.statSync(target).isDirectory() ||
      fs.readdirSync(target).length
    )
      throw new Error(
        "Restore requires a new or empty directory. Existing installations cannot be overwritten.",
      );
  }
  checkEmpty();
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const stage = fs.mkdtempSync(
    path.join(
      /* turbopackIgnore: true */ path.dirname(target),
      ".nivra-restore-",
    ),
  );
  try {
    fs.writeFileSync(
      path.join(/* turbopackIgnore: true */ stage, "nivra.sqlite"),
      await readObject(repository, data, "database", key),
      { mode: 0o600, flag: "wx", flush: true },
    );
    const database = openSnapshot(
      path.join(/* turbopackIgnore: true */ stage, "nivra.sqlite"),
      key,
      false,
      data.encrypted,
    );
    let files: string[];
    try {
      files = referencedFiles(database);
      if (
        (
          database.prepare("SELECT count(*) AS n FROM user").get() as {
            n: number;
          }
        ).n !== 1
      )
        throw new Error("The backup must contain exactly one owner.");
      if (
        database.prepare("SELECT 1 FROM encryption_pending_files LIMIT 1").get()
      )
        throw new Error("The backup has unfinished encryption migration.");
      for (const table of [
        "notes_fts",
        "bookmarks_fts",
        "tasks_fts",
        "artifacts_fts",
        "events_fts",
        "forms_fts",
        "form_responses_fts",
      ]) {
        if (
          database
            .prepare(
              "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
            )
            .get(table)
        )
          database
            .prepare(
              `INSERT INTO ${table}(${table},rank) VALUES('integrity-check',1)`,
            )
            .run();
      }
      if (
        database
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE name='push_subscriptions'",
          )
          .get()
      ) {
        database.prepare("DELETE FROM push_subscriptions").run();
        database
          .prepare(
            "UPDATE calendar_reminders SET state='missed' WHERE state IN ('queued','accepted')",
          )
          .run();
      }
      if (
        database
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE name='system_configuration'",
          )
          .get()
      ) {
        const columns = database.pragma("table_info(system_configuration)") as {
          name: string;
        }[];
        const address = columns.some((column) => column.name === "public_url")
          ? (database
              .prepare("SELECT public_url FROM system_configuration WHERE id=1")
              .get() as { public_url: string | null })
          : undefined;
        if (address?.public_url)
          fs.writeFileSync(
            path.join(stage, "installation.json"),
            JSON.stringify({ version: 1, publicUrl: address.public_url }),
            { mode: 0o600, flag: "wx", flush: true },
          );
        const profile = randomUUID();
        database.prepare("INSERT INTO storage_profiles VALUES(?,?,?)").run(
          profile,
          seal(
            Buffer.from(
              JSON.stringify({
                backend: "local",
                installation: true,
                directory: target,
                backupDirectory: path.join(target, "backups"),
              }),
            ),
            key,
            `storage-profile:${profile}`,
          ),
          Date.now(),
        );
        database
          .prepare("UPDATE storage_locations SET profile_id=? WHERE deleted=0")
          .run(profile);
        database
          .prepare(
            "UPDATE system_configuration SET media_profile=?,backup_profile=?,revision=revision+1 WHERE id=1",
          )
          .run(profile, profile);
        if (columns.some((column) => column.name === "local_profile"))
          database
            .prepare(
              "UPDATE system_configuration SET local_profile=? WHERE id=1",
            )
            .run(profile);
        database.prepare("DELETE FROM storage_transfers").run();
        database.prepare("DELETE FROM storage_verifications").run();
        database.prepare("DELETE FROM storage_copies").run();
        database.prepare("DELETE FROM backup_archives").run();
      }
    } finally {
      database.close();
    }
    const archived = data.objects
      .filter((o) => o.name.startsWith("files/"))
      .map((o) => o.name.slice(6))
      .sort();
    if (JSON.stringify([...files].sort()) !== JSON.stringify(archived))
      throw new Error("The backup file inventory does not match the database.");
    const secret = await readObject(repository, data, "auth", key);
    unseal(secret, key, "auth-secret");
    fs.writeFileSync(
      path.join(/* turbopackIgnore: true */ stage, "auth.secret"),
      secret,
      { mode: 0o600, flag: "wx", flush: true },
    );
    fs.writeFileSync(
      path.join(/* turbopackIgnore: true */ stage, "encryption.key"),
      key,
      { mode: 0o600, flag: "wx", flush: true },
    );
    persistEncryptionMode(stage, data.encrypted);
    const local = createStorage({ NIVRA_DATA_DIR: stage });
    for (const file of files) {
      await local.write(
        file,
        await readObject(repository, data, `files/${file}`, key),
      );
      await local.read(file);
    }
    fs.chmodSync(stage, 0o700);
    syncDirectory(stage);
    checkEmpty();
    fs.renameSync(stage, target);
    syncDirectory(path.dirname(target));
    return info(data);
  } finally {
    if (fs.existsSync(stage)) fs.rmSync(stage, { recursive: true });
  }
}
export async function verifyBackup(
  id: string,
  env?: NodeJS.ProcessEnv,
): Promise<BackupInfo> {
  const target = privatePath(`verify-${randomUUID()}`);
  try {
    const restored = await restoreBackup(id, target, env);
    if (!env) {
      sqlite()
        .prepare("UPDATE backup_archives SET verified_at=? WHERE id=?")
        .run(Date.now(), id);
      const owner = sqlite().prepare("SELECT id FROM user LIMIT 1").get() as
        { id: string } | undefined;
      if (owner) completionEvent(owner.id, "backup", id, "verified");
    }
    return restored;
  } finally {
    if (fs.existsSync(target)) fs.rmSync(target, { recursive: true });
  }
}
export function startBackupScheduler() {
  backupConfig();
  if (
    runtime.nivraBackupTimer ||
    process.env.NEXT_PHASE === "phase-production-build"
  )
    return;
  backupRepository();
  runtime.nivraBackupTimer = setInterval(() => {
    if (
      runtime.nivraBackupJob ||
      !sqlite().prepare("SELECT 1 FROM user LIMIT 1").get()
    )
      return;
    const current = state();
    const base =
      current.lastAttempt ||
      Number(fs.statSync(databaseFile).birthtimeMs) ||
      Date.now();
    if (Date.now() >= base + backupConfig().intervalHours * 3_600_000)
      void startBackup().catch(() => undefined);
  }, 60_000);
  runtime.nivraBackupTimer.unref();
}
