"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/client";
import { useCompletion } from "@/lib/completion-client";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Label } from "./ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
type Status = {
  enabled: boolean;
  revision: number;
  taggingMode: "manual" | "automatic";
  total: number;
  indexed: number;
  failed: number;
  capacity: number;
  chunkLimit: number;
};
export function LocalAiSettings({
  beforeAction,
  onboarding = false,
  onBusyChange,
}: {
  beforeAction: () => Promise<boolean>;
  onboarding?: boolean;
  onBusyChange?: (busy: boolean) => void;
}) {
  const [status, setStatus] = useState<Status | null>(null),
    [statusError, setStatusError] = useState(""),
    [statusLoading, setStatusLoading] = useState(true),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [version, setVersion] = useState(0);
  function refresh() {
    setStatusLoading(true);
    setStatusError("");
    setVersion((n) => n + 1);
  }
  useCompletion("ai", refresh);
  useEffect(() => {
    const controller = new AbortController();
    void api<Status>("ai", { signal: controller.signal })
      .then((state) => {
        if (!controller.signal.aborted) setStatus(state);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setStatusError((e as Error).message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setStatusLoading(false);
      });
    return () => controller.abort();
  }, [version]);
  function setActionBusy(value: boolean) {
    setBusy(value);
    onBusyChange?.(value);
  }
  async function run(action: () => Promise<unknown>) {
    if (busy) return;
    setActionBusy(true);
    setError("");
    try {
      if (!(await beforeAction()))
        throw new Error("Save your current item before continuing.");
      await action();
      refresh();
    } catch (e) {
      setError(
        (e as Error).message === "Save your current item before continuing."
          ? (e as Error).message
          : "Could not update smart features. Try again.",
      );
    } finally {
      setActionBusy(false);
    }
  }
  return (
    <section
      className={`settings-section local-ai-settings${onboarding ? " local-ai-onboarding" : ""}`}
      aria-labelledby="local-ai-title"
    >
      <h2 id="local-ai-title">Smart tagging and search</h2>
      <p className="settings-description">
        Suggest tags for your items and use semantic search to find related
        content. Review tag suggestions under Tags.
      </p>
      {!status && statusLoading && !error && (
        <p className="settings-description" role="status">
          Loading smart feature settings…
        </p>
      )}
      {statusError && (
        <p role="alert" className="form-error">
          Could not load smart features.{" "}
          <Button size="sm" variant="ghost" onClick={refresh}>
            Retry
          </Button>
        </p>
      )}
      <Label className="local-ai-toggle">
        <Checkbox
          checked={status?.enabled ?? false}
          disabled={!status || statusLoading || !!statusError || busy}
          onCheckedChange={(value) =>
            void run(() =>
              api("ai", {
                method: "PATCH",
                body: JSON.stringify({
                  enabled: value === true,
                  revision: status!.revision,
                }),
              }),
            )
          }
        />
        Enable smart features
      </Label>
      {status?.enabled && (
        <div className="local-ai-mode">
          <Label htmlFor="local-ai-tagging-mode">Tagging mode</Label>
          <Select
            value={status.taggingMode ?? "manual"}
            disabled={statusLoading || !!statusError || busy}
            onValueChange={(value) => {
              if (value !== "manual" && value !== "automatic") return;
              void run(() =>
                api("ai", {
                  method: "PATCH",
                  body: JSON.stringify({
                    enabled: status.enabled,
                    revision: status.revision,
                    taggingMode: value,
                  }),
                }),
              );
            }}
          >
            <SelectTrigger
              id="local-ai-tagging-mode"
              aria-describedby="local-ai-mode-description"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="manual">Review suggestions</SelectItem>
              <SelectItem value="automatic">Automatic tagging</SelectItem>
            </SelectContent>
          </Select>
          <p id="local-ai-mode-description" className="settings-description">
            {status.taggingMode === "automatic"
              ? "Reliable matches are assigned automatically, and reusable tags are created for recurring topics."
              : "Review each suggestion before assigning it or creating a reusable tag."}
          </p>
        </div>
      )}
      {status?.enabled && !onboarding && (
        <>
          <p className="settings-description" role="status">
            {status.indexed.toLocaleString()} of {status.total.toLocaleString()}{" "}
            items ready for smart features. Search by meaning is on.
          </p>
          {status.failed > 0 && (
            <p className="settings-description" role="status">
              Some items could not be prepared for smart tagging or Search by
              meaning.
            </p>
          )}
          {status.capacity > 0 && (
            <p className="settings-description" role="status">
              More items are waiting to be prepared for smart tagging and Search
              by meaning.
            </p>
          )}
          {status.failed > 0 && (
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() =>
                void run(() =>
                  api("ai", {
                    method: "PATCH",
                    body: JSON.stringify({
                      enabled: true,
                      revision: status.revision,
                    }),
                  }),
                )
              }
            >
              Try again
            </Button>
          )}
        </>
      )}
      {error && (
        <p role="alert" className="form-error">
          {error}{" "}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setError("");
              refresh();
            }}
          >
            Retry
          </Button>
        </p>
      )}
    </section>
  );
}
