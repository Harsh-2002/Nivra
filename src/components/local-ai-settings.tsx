"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/client";
import { useCompletion } from "@/lib/completion-client";
import type { SearchResult } from "@/lib/types";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Label } from "./ui/label";
type Status = {
  enabled: boolean;
  revision: number;
  total: number;
  indexed: number;
  failed: number;
  capacity: number;
  chunkLimit: number;
};
type Suggestion = {
  id: string;
  itemId: string;
  type: string;
  title: string;
  excerpt: string;
  formId?: string;
  tag: { id: string; name: string; color: string };
  createdAt: number;
};
export function LocalAiSettings({
  beforeAction,
  onSelect,
}: {
  beforeAction: () => Promise<boolean>;
  onSelect?: (result: SearchResult) => Promise<boolean>;
}) {
  const [status, setStatus] = useState<Status | null>(null),
    [suggestions, setSuggestions] = useState<Suggestion[]>([]),
    [statusError, setStatusError] = useState(""),
    [suggestionsError, setSuggestionsError] = useState(""),
    [statusLoading, setStatusLoading] = useState(true),
    [suggestionsLoading, setSuggestionsLoading] = useState(true),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [version, setVersion] = useState(0);
  function refresh() {
    setStatusLoading(true);
    setSuggestionsLoading(true);
    setStatusError("");
    setSuggestionsError("");
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
    void api<{ items: Suggestion[] }>("ai/suggestions", {
      signal: controller.signal,
    })
      .then((proposals) => {
        if (!controller.signal.aborted) setSuggestions(proposals.items);
      })
      .catch((e) => {
        if (!controller.signal.aborted) {
          setSuggestions([]);
          setSuggestionsError((e as Error).message);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setSuggestionsLoading(false);
      });
    return () => controller.abort();
  }, [version]);
  async function run(action: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      if (!(await beforeAction()))
        throw new Error("Save your current item before continuing.");
      await action();
      refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="settings-section local-ai-settings"
      aria-labelledby="local-ai-title"
    >
      <h2 id="local-ai-title">Local AI</h2>
      <p className="settings-description">
        Find related content and review suggestions for your existing tags. Runs
        privately on your server in English.
      </p>
      {!status && statusLoading && !error && (
        <p className="settings-description" role="status">
          Loading local AI settings…
        </p>
      )}
      {statusError && (
        <p role="alert" className="form-error">
          Could not load local AI settings. {statusError}{" "}
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
        Enable local AI
      </Label>
      {status?.enabled && (
        <>
          <p className="settings-description" role="status">
            {status.indexed.toLocaleString()} of {status.total.toLocaleString()}{" "}
            sources indexed. Keyword search stays available.
            {status.failed > 0
              ? ` ${status.failed} sources could not be indexed.`
              : ""}
            {status.capacity > 0
              ? ` ${status.capacity} sources are waiting for index capacity.`
              : ""}
          </p>
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
              Retry indexing
            </Button>
          )}
          <div className="local-ai-suggestions">
            <h3>Tag suggestions</h3>
            {suggestionsLoading && !suggestions.length && (
              <p className="settings-description" role="status">
                Loading tag suggestions…
              </p>
            )}
            {suggestionsError && (
              <p role="alert" className="form-error">
                Could not load tag suggestions. {suggestionsError}{" "}
                <Button size="sm" variant="ghost" onClick={refresh}>
                  Retry
                </Button>
              </p>
            )}
            {suggestions.length ? (
              <ul>
                {suggestions.map((item) => (
                  <li key={item.id}>
                    <div className="local-ai-suggestion-copy">
                      <strong>{item.title || "Untitled"}</strong>
                      <span>
                        {item.type === "response" ? "Form response" : item.type}{" "}
                        · Suggested: {item.tag.name}
                      </span>
                      {item.excerpt && (
                        <span className="local-ai-suggestion-excerpt">
                          {item.excerpt}
                        </span>
                      )}
                    </div>
                    <div className="local-ai-suggestion-actions">
                      {onSelect && (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          aria-label={`Open ${item.title || "Untitled"}`}
                          onClick={async () => {
                            if (busy) return;
                            setBusy(true);
                            setError("");
                            try {
                              await onSelect({
                                id: item.itemId,
                                type: item.type as SearchResult["type"],
                                title: item.title,
                                excerpt: item.excerpt,
                                updatedAt: item.createdAt,
                                ...(item.formId ? { formId: item.formId } : {}),
                              });
                            } catch (e) {
                              setError((e as Error).message);
                            } finally {
                              setBusy(false);
                            }
                          }}
                        >
                          Open
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        aria-label={`Approve ${item.tag.name} for ${item.title || "Untitled"}`}
                        onClick={() =>
                          void run(() =>
                            api(`ai/suggestions/${item.id}/accept`, {
                              method: "POST",
                              body: "{}",
                            }),
                          )
                        }
                      >
                        Approve
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        aria-label={`Dismiss ${item.tag.name} for ${item.title || "Untitled"}`}
                        onClick={() =>
                          void run(() =>
                            api(`ai/suggestions/${item.id}/reject`, {
                              method: "POST",
                              body: "{}",
                            }),
                          )
                        }
                      >
                        Dismiss
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              !suggestionsLoading &&
              !suggestionsError && (
                <p className="settings-description">
                  No suggestions to review. Add matching words to tags to help
                  recognize your vocabulary.
                </p>
              )
            )}
          </div>
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
