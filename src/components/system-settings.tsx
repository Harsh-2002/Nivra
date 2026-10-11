"use client";
import { useEffect, useState } from "react";
import { Check, Loader2 } from "lucide-react";
import { api } from "@/lib/client";
import { useCompletion } from "@/lib/completion-client";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Checkbox } from "./ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import { useConfirm } from "./confirm-provider";
import { LocalAiSettings } from "./local-ai-settings";
import { BackupSettings } from "./backup-settings";
import type { systemStatus } from "@/lib/server/system-api";
import type { SearchResult } from "@/lib/types";
type Status = ReturnType<typeof systemStatus>;
type Draft = {
  provider: "aws" | "r2" | "b2" | "compatible";
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  pathStyle: boolean;
};
const empty: Draft = {
  provider: "compatible",
  endpoint: "",
  region: "us-east-1",
  bucket: "",
  accessKeyId: "",
  secretAccessKey: "",
  pathStyle: true,
};
export function SystemSettings({
  beforeAction = async () => true,
  onboarding = false,
  onDone,
  onSelect,
}: {
  beforeAction?: () => Promise<boolean>;
  onboarding?: boolean;
  onDone?: () => Promise<void>;
  onSelect?: (result: SearchResult) => Promise<boolean>;
}) {
  const confirm = useConfirm();
  const [status, setStatus] = useState<Status | null>(null);
  const [draft, setDraft] = useState(empty);
  const [backend, setBackend] = useState<"local" | "s3">("local");
  const [s3Backups, setS3Backups] = useState(false);
  const [limit, setLimit] = useState(25);
  const [hours, setHours] = useState(24);
  const [keep, setKeep] = useState(7);
  const [dirty, setDirty] = useState(false);
  const [connectionDirty, setConnectionDirty] = useState(false);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [reload, setReload] = useState(0);
  function accept(value: Status) {
    setStatus(value);
    setBackend(value.storageBackend);
    setS3Backups(value.s3Backups);
    setLimit(value.uploadMiB);
    setHours(value.backupHours);
    setKeep(value.backupKeep);
    setDraft(
      value.connection
        ? {
            ...empty,
            provider: value.connection.provider,
            endpoint: value.connection.endpoint,
            region: value.connection.region,
            bucket: value.connection.bucket,
            pathStyle: value.connection.pathStyle,
          }
        : empty,
    );
    setDirty(false);
    setConnectionDirty(false);
    setToken("");
  }
  useEffect(() => {
    const controller = new AbortController();
    api<Status>("system", { signal: controller.signal })
      .then((value) => {
        if (!controller.signal.aborted) accept(value);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [reload]);
  useCompletion("content", () => {
    if (!dirty && !busy) setReload((n) => n + 1);
    else
      void api<Status>("system")
        .then((value) =>
          setStatus((current) =>
            current
              ? {
                  ...current,
                  transfer: value.transfer,
                  cleanupAvailable: value.cleanupAvailable,
                }
              : value,
          ),
        )
        .catch(() => {});
  });
  useCompletion("backup", () => {
    void api<Status>("system")
      .then((value) =>
        setStatus((current) =>
          current
            ? { ...current, cleanupAvailable: value.cleanupAvailable }
            : value,
        ),
      )
      .catch(() => {});
  });
  function change<K extends keyof Draft>(field: K, value: Draft[K]) {
    setDraft((current) => ({ ...current, [field]: value }));
    setConnectionDirty(true);
    setDirty(true);
    setToken("");
    setMessage("");
  }
  async function verify() {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await api<{ verificationToken: string }>("system/verify", {
        method: "POST",
        body: JSON.stringify({
          connection: {
            ...draft,
            accessKeyId: draft.accessKeyId || undefined,
            secretAccessKey: draft.secretAccessKey || undefined,
          },
          s3Backups,
        }),
      });
      setToken(result.verificationToken);
      setMessage("Connection verified. Ready to save.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!status || !(await beforeAction())) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await api<Status>("system", {
        method: "PATCH",
        body: JSON.stringify({
          revision: status.revision,
          storageBackend: backend,
          s3Backups,
          uploadMiB: limit,
          backupHours: hours,
          backupKeep: keep,
          ...(token ? { verificationToken: token } : {}),
        }),
      });
      accept(result);
      setMessage(
        result.transfer && result.transfer.state !== "done"
          ? "Settings saved. Existing files are transferring in the background."
          : "Settings saved.",
      );
      await onDone?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (!status)
    return (
      <div className="settings-section" aria-busy={!error}>
        {error ? (
          <>
            <p className="form-error" role="alert">
              {error}
            </p>
            <Button
              variant="outline"
              onClick={() => {
                setError("");
                setReload((n) => n + 1);
              }}
            >
              Retry
            </Button>
          </>
        ) : (
          <p className="backup-state">
            <Loader2 size={16} className="animate-spin" />
            Loading system settings…
          </p>
        )}
      </div>
    );
  const needsVerification =
    (backend === "s3" || s3Backups) && (connectionDirty || !status.connection);
  const transferring =
    status.transfer && ["queued", "running"].includes(status.transfer.state);
  return (
    <div className="system-settings">
      <form onSubmit={save} className="system-form">
        <section className="settings-section">
          <div className="settings-section-heading">
            <h2>Storage</h2>
            <p className="settings-description">
              Keep files on this server or use an S3-compatible bucket.
            </p>
          </div>
          <div className="field">
            <Label htmlFor="system-storage">File storage</Label>
            <Select
              value={backend}
              disabled={busy || !!transferring}
              onValueChange={(value) => {
                setBackend(value as "local" | "s3");
                setDirty(true);
              }}
            >
              <SelectTrigger id="system-storage">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="local">Local</SelectItem>
                <SelectItem value="s3">S3</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <label className="check-row">
            <Checkbox
              checked={s3Backups}
              disabled={busy || !!transferring}
              onCheckedChange={(value) => {
                setS3Backups(value === true);
                setDirty(true);
                setToken("");
                setMessage("");
              }}
            />
            Use S3 for backups
          </label>
          {(backend === "s3" || s3Backups) && (
            <fieldset
              className="system-connection"
              disabled={busy || !!transferring}
            >
              <legend className="sr-only">S3 connection</legend>
              <p className="field-hint">
                Files and backups share this connection and bucket, using
                separate folders.
              </p>
              <div className="field">
                <Label htmlFor="system-provider">Provider</Label>
                <Select
                  value={draft.provider}
                  onValueChange={(value) => {
                    change("provider", value as Draft["provider"]);
                    change("pathStyle", value !== "aws");
                    change("region", value === "r2" ? "auto" : "us-east-1");
                  }}
                >
                  <SelectTrigger id="system-provider">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="aws">Amazon S3</SelectItem>
                    <SelectItem value="r2">Cloudflare R2</SelectItem>
                    <SelectItem value="b2">Backblaze B2</SelectItem>
                    <SelectItem value="compatible">S3-compatible</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="field">
                <Label htmlFor="system-endpoint">
                  Endpoint{draft.provider === "aws" ? " (optional)" : ""}
                </Label>
                <Input
                  id="system-endpoint"
                  type="url"
                  required={draft.provider !== "aws"}
                  value={draft.endpoint}
                  placeholder="https://s3.example.com"
                  onChange={(e) => change("endpoint", e.target.value)}
                />
              </div>
              <div className="system-field-pair">
                <div className="field">
                  <Label htmlFor="system-region">Region</Label>
                  <Input
                    id="system-region"
                    required
                    value={draft.region}
                    onChange={(e) => change("region", e.target.value)}
                  />
                </div>
                <div className="field">
                  <Label htmlFor="system-bucket">Bucket</Label>
                  <Input
                    id="system-bucket"
                    required
                    value={draft.bucket}
                    onChange={(e) => change("bucket", e.target.value)}
                  />
                </div>
              </div>
              <div className="field">
                <Label htmlFor="system-access">Access key</Label>
                <Input
                  id="system-access"
                  autoComplete="off"
                  value={draft.accessKeyId}
                  placeholder={
                    status.connection
                      ? "Saved — enter to replace"
                      : "Access key ID"
                  }
                  onChange={(e) => change("accessKeyId", e.target.value)}
                />
              </div>
              <div className="field">
                <Label htmlFor="system-secret">Secret key</Label>
                <Input
                  id="system-secret"
                  type="password"
                  autoComplete="new-password"
                  value={draft.secretAccessKey}
                  placeholder={
                    status.connection
                      ? "Saved — enter to replace"
                      : "Secret access key"
                  }
                  onChange={(e) => change("secretAccessKey", e.target.value)}
                />
              </div>
              <details>
                <summary>Advanced</summary>
                <label className="check-row">
                  <Checkbox
                    checked={draft.pathStyle}
                    onCheckedChange={(v) => change("pathStyle", v === true)}
                  />
                  Use path-style addressing
                </label>
              </details>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => void verify()}
              >
                {busy ? (
                  <Loader2 size={16} className="animate-spin" />
                ) : token ? (
                  <Check size={16} />
                ) : null}
                Test connection
              </Button>
            </fieldset>
          )}
        </section>
        {!onboarding && (
          <>
            <section className="settings-section">
              <h2>Uploads</h2>
              <div className="field">
                <Label htmlFor="system-limit">Maximum file size (MiB)</Label>
                <Input
                  id="system-limit"
                  type="number"
                  min={1}
                  max={100}
                  required
                  value={limit}
                  onChange={(e) => {
                    setLimit(e.target.valueAsNumber);
                    setDirty(true);
                  }}
                />
                <p className="field-hint">
                  Applies to new uploads. Uploads already running keep their
                  original limit.
                </p>
              </div>
            </section>
            <section className="settings-section">
              <h2>Backup schedule</h2>
              <div className="system-field-pair">
                <div className="field">
                  <Label htmlFor="system-hours">Every (hours)</Label>
                  <Input
                    id="system-hours"
                    type="number"
                    min={1}
                    max={8760}
                    required
                    value={hours}
                    onChange={(e) => {
                      setHours(e.target.valueAsNumber);
                      setDirty(true);
                    }}
                  />
                </div>
                <div className="field">
                  <Label htmlFor="system-keep">Copies to keep</Label>
                  <Input
                    id="system-keep"
                    type="number"
                    min={1}
                    max={365}
                    required
                    value={keep}
                    onChange={(e) => {
                      setKeep(e.target.valueAsNumber);
                      setDirty(true);
                    }}
                  />
                </div>
              </div>
            </section>
            <section className="settings-section">
              <h2>Encryption</h2>
              <p>{status.encrypted ? "Enabled" : "Disabled"}</p>
              <p className="settings-description">
                Chosen during installation.
              </p>
            </section>
          </>
        )}
        {status.transfer && status.transfer.state !== "done" && (
          <p className="backup-state" role="status">
            {status.transfer.state === "failed"
              ? status.transfer.error
              : `Transferring files · ${status.transfer.copied} verified`}
            {status.transfer.state === "failed" && (
              <Button
                type="button"
                variant="outline"
                onClick={() =>
                  void api<Status>("system/retry", {
                    method: "POST",
                    body: "{}",
                  })
                    .then(accept)
                    .catch((e) => setError(e.message))
                }
              >
                Retry transfer
              </Button>
            )}
          </p>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        {message && (
          <p className="backup-state" role="status">
            {message}
          </p>
        )}
        <Button
          type="submit"
          disabled={
            busy ||
            !!transferring ||
            (!onboarding && !dirty && !token) ||
            (needsVerification && !token)
          }
        >
          {busy && <Loader2 size={16} className="animate-spin" />}
          {onboarding ? "Continue" : "Save settings"}
        </Button>
      </form>
      {!onboarding && (
        <LocalAiSettings beforeAction={beforeAction} onSelect={onSelect} />
      )}
      {!onboarding && status.cleanupAvailable && (
        <section className="settings-section">
          <h2>Previous storage</h2>
          <p className="settings-description">
            A verified recovery backup is available. You can remove retained
            source files after the transfer.
          </p>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() =>
              void (async () => {
                if (
                  !(await confirm({
                    title: "Remove retained source files?",
                    description:
                      "The verified destination files and recovery backups remain available. Only Nivra's retained source copies will be removed.",
                    action: "Remove copies",
                  }))
                )
                  return;
                setBusy(true);
                try {
                  accept(
                    await api<Status>("system/cleanup", {
                      method: "POST",
                      body: "{}",
                    }),
                  );
                  setMessage("Retained source copies removed.");
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              })()
            }
          >
            Remove source copies
          </Button>
        </section>
      )}
      {!onboarding && (
        <BackupSettings key={status.revision} beforeAction={beforeAction} />
      )}
    </div>
  );
}
