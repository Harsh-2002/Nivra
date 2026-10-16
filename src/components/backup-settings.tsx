"use client";
import { useCompletion } from "@/lib/completion-client";
import { useEffect, useState } from "react";
import { Check, Loader2, ShieldCheck } from "lucide-react";
import { api } from "@/lib/client";
import { formatDateTime } from "@/lib/dates";
import { Button } from "./ui/button";
import type { BackupStatus } from "@/lib/server/backups";
export function BackupSettings({
  beforeAction,
}: {
  beforeAction: () => Promise<boolean>;
}) {
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [verifying, setVerifying] = useState("");
  const [verified, setVerified] = useState("");
  const [reload, setReload] = useState(0);
  useCompletion("backup", () => setReload((n) => n + 1));
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    async function load() {
      try {
        const result = await api<BackupStatus>("backups", {
          signal: controller.signal,
        });
        if (active) {
          setStatus(result);
          setError("");
        }
      } catch (e) {
        if (active) setError((e as Error).message);
      }
    }
    void load();
    const timer = setInterval(
      () => void load(),
      status?.running ? 2000 : 30_000,
    );
    return () => {
      active = false;
      controller.abort();
      clearInterval(timer);
    };
  }, [reload, status?.running]);
  async function backup() {
    if (!(await beforeAction())) return;
    setBusy(true);
    setError("");
    try {
      await api("backups", { method: "POST", body: "{}" });
      setStatus((current) =>
        current ? { ...current, running: true } : current,
      );
      setReload((n) => n + 1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function verify(id: string) {
    setVerifying(id);
    setError("");
    try {
      await api(`backups/${id}/verify`, { method: "POST", body: "{}" });
      setVerified(id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setVerifying("");
    }
  }
  return (
    <section
      className="settings-section backup-settings"
      aria-labelledby="backup-heading"
    >
      <h2 id="backup-heading">Instance backups</h2>
      <p className="settings-description">
        An encrypted recovery copy of your account, notes, tasks, bookmarks,
        shared notes, and files. Keep your original encryption key separately to
        restore it.
      </p>
      {!status && !error && (
        <p className="backup-state" aria-busy="true">
          <Loader2 size={14} className="animate-spin" />
          Loading backup status…
        </p>
      )}
      {status && (
        <>
          <div className="settings-row">
            <div>
              <h3>
                {status.backend === "s3" ? "S3 backups" : "Local backups"}
              </h3>
              <p>
                {status.storage === "s3"
                  ? "Hybrid storage · SQLite stays local; backups include your remote files."
                  : "Local storage · your data lives in one directory."}
              </p>
              <p>
                {`Every ${status.intervalHours} hours · keep ${status.keep} completed backups`}
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              disabled={busy || !!verifying || status.running}
              onClick={() => void backup()}
            >
              {busy || status.running ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <ShieldCheck size={14} />
              )}
              {status.running ? "Backing up…" : "Back up now"}
            </Button>
          </div>
          <p className="backup-state" role="status">
            {status.running
              ? "Creating a complete recovery copy. You can keep using Nivra."
              : status.lastSuccess
                ? `Last completed ${formatDateTime(status.lastSuccess)}`
                : "No completed backup yet."}
            {status.nextAt && !status.running && (
              <span>Next scheduled {formatDateTime(status.nextAt)}</span>
            )}
          </p>
          {status.backend === "local" && (
            <p className="settings-description">
              Local backups protect against accidental changes. Use a separate
              disk or an S3 backup destination for recovery after a host
              failure.
            </p>
          )}
          {!!status.backups.length && (
            <div className="backup-list" aria-label="Recent backups">
              {status.backups.slice(0, 3).map((backup) => (
                <div className="settings-row" key={backup.id}>
                  <div>
                    <h3>{formatDateTime(backup.createdAt)}</h3>
                    <p>
                      {backup.files} files ·{" "}
                      {(backup.size / 1024 / 1024).toFixed(1)} MB
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={!!verifying || busy || status.running}
                    onClick={() => void verify(backup.id)}
                  >
                    {verifying === backup.id ? (
                      <Loader2 size={14} className="animate-spin" />
                    ) : verified === backup.id ? (
                      <Check size={14} />
                    ) : null}
                    {verifying === backup.id
                      ? "Verifying…"
                      : verified === backup.id
                        ? "Verified"
                        : "Verify"}
                  </Button>
                </div>
              ))}
            </div>
          )}
          {verified && (
            <p className="backup-state" role="status">
              Recovery check passed, including database integrity and every
              file.
            </p>
          )}
          {status.error && (
            <p className="form-error" role="alert">
              {status.error}
            </p>
          )}
        </>
      )}
      {error && (
        <div className="tasks-error" role="alert">
          <p>{error}</p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setReload((n) => n + 1)}
          >
            Retry
          </Button>
        </div>
      )}
      <p className="settings-description">
        Restore from the server CLI into a new directory. The running
        installation is never overwritten.
      </p>
    </section>
  );
}
