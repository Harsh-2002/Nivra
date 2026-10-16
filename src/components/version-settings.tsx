"use client";
import { useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { api } from "@/lib/client";
import { formatDay } from "@/lib/dates";
import { Button } from "./ui/button";
import type { systemStatus } from "@/lib/server/system-api";
import type { checkForUpdates } from "@/lib/server/updates";

type Build = ReturnType<typeof systemStatus>["build"];
type Check = Awaited<ReturnType<typeof checkForUpdates>>;
export function VersionSettings({ build }: { build: Build }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [check, setCheck] = useState<Check | null>(null);
  async function look() {
    setBusy(true);
    setError("");
    try {
      setCheck(await api<Check>("system/updates", { method: "POST" }));
    } catch (e) {
      setCheck(null);
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="settings-section version-settings"
      aria-labelledby="version-heading"
    >
      <h2 id="version-heading">Version</h2>
      <p className="settings-description">
        The release this server is running. Looking for updates contacts GitHub
        only when you ask.
      </p>
      <div className="settings-row">
        <div>
          <h3>{build.version ?? "Development build"}</h3>
          <p>
            {build.commit ? (
              <>
                Commit <code>{build.commit.slice(0, 7)}</code>
                {build.modified && " · uncommitted changes"}
              </>
            ) : (
              "Commit unavailable"
            )}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => void look()}
        >
          {busy ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <RefreshCw size={14} />
          )}
          {busy ? "Checking…" : "Check for updates"}
        </Button>
      </div>
      {check && (
        <p className="backup-state" role="status">
          <span>
            {check.state === "available" ? (
              <>
                {check.latest.version} is available, published{" "}
                {formatDay(check.latest.publishedAt)}. Pull the latest image and
                recreate the container.{" "}
                <a
                  className="text-foreground underline underline-offset-4"
                  href={check.latest.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  Release notes
                </a>
              </>
            ) : check.state === "current" ? (
              `This is the latest release, ${check.latest.version}.`
            ) : (
              `The latest release is ${check.latest.version}, published ${formatDay(check.latest.publishedAt)}. This build has no release version to compare.`
            )}
          </span>
        </p>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
