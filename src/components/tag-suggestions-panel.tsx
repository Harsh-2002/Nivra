"use client";
import { useEffect, useRef, useState } from "react";
import {
  Bookmark,
  CalendarDays,
  ClipboardList,
  FileText,
  Layers,
  SquareCheckBig,
  Tags,
} from "lucide-react";
import { ApiError, api } from "@/lib/client";
import { useCompletion } from "@/lib/completion-client";
import type { SearchResult } from "@/lib/types";
import { Button } from "./ui/button";
import { LoadingState } from "./loading-state";
import { SectionHeading } from "./section-heading";

type Suggestion = {
  id: string;
  itemId: string;
  type: SearchResult["type"];
  title: string;
  excerpt: string;
  formId?: string;
  tag: { id: string; name: string; color: string };
  createdAt: number;
};

export function TagSuggestionsPanel({
  beforeAction,
  onNavigation,
  onSelect,
}: {
  beforeAction: () => Promise<boolean>;
  onNavigation: () => void;
  onSelect: (result: SearchResult) => Promise<boolean>;
}) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [items, setItems] = useState<Suggestion[]>([]);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [actionError, setActionError] = useState<{
    itemId: string;
    message: string;
  } | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);
  const completionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function refresh(preserveFeedback = false) {
    if (completionTimer.current) clearTimeout(completionTimer.current);
    completionTimer.current = null;
    setLoading(true);
    setLoadError("");
    if (!preserveFeedback) {
      setActionError(null);
      setMessage("");
    }
    setVersion((current) => current + 1);
  }

  function scheduleRefresh() {
    if (completionTimer.current) clearTimeout(completionTimer.current);
    completionTimer.current = setTimeout(() => {
      completionTimer.current = null;
      refresh(true);
    }, 150);
  }

  useCompletion("ai", scheduleRefresh);
  useEffect(
    () => () => {
      if (completionTimer.current) clearTimeout(completionTimer.current);
    },
    [],
  );

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const status = await api<{ enabled: boolean }>("ai", {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setEnabled(status.enabled);
        if (!status.enabled) {
          setItems([]);
          setHasLoaded(true);
          return;
        }
        const result = await api<{ items: Suggestion[] }>("ai/suggestions", {
          signal: controller.signal,
        });
        if (!controller.signal.aborted) {
          setItems(result.items);
          setHasLoaded(true);
        }
      } catch {
        if (!controller.signal.aborted) {
          setLoadError("Could not load tag suggestions.");
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [version]);

  async function open(item: Suggestion) {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    setMessage("");
    try {
      await onSelect({
        id: item.itemId,
        type: item.type,
        title: item.title,
        excerpt: item.excerpt,
        updatedAt: item.createdAt,
        ...(item.formId ? { formId: item.formId } : {}),
      });
    } catch {
      setActionError({ itemId: item.id, message: "Could not open this item." });
    } finally {
      setBusy(false);
    }
  }

  async function decide(item: Suggestion, decision: "accept" | "reject") {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    setMessage("");
    try {
      if (!(await beforeAction())) return;
      await api(`ai/suggestions/${item.id}/${decision}`, {
        method: "POST",
        body: "{}",
      });
      setItems((current) =>
        current.filter((suggestion) => suggestion.id !== item.id),
      );
      setMessage(
        decision === "accept"
          ? `${item.tag.name} added to ${item.title || "Untitled"}.`
          : `Suggestion for ${item.title || "Untitled"} dismissed.`,
      );
      refresh(true);
    } catch (error) {
      setActionError({
        itemId: item.id,
        message:
          error instanceof ApiError && error.status === 409
            ? error.message === "Local AI is disabled."
              ? "Smart features are turned off. Turn them on in Settings → System and refresh."
              : "This item changed or was already reviewed. Refresh the list and try again."
            : "Could not update this suggestion. Refresh and try again.",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="tag-suggestions-panel tasks-panel">
      <div
        className="tasks-scroll"
        tabIndex={0}
        role="region"
        aria-label="Tag suggestions"
        aria-busy={loading || busy}
      >
        <div className="section-content">
          <SectionHeading
            title="Tag suggestions"
            description="Choose which suggested tags to add to your items."
            onNavigation={onNavigation}
          />
          {message && (
            <div
              className="inline-feedback tag-suggestions-message"
              role="status"
            >
              <p>{message}</p>
            </div>
          )}
          {loadError && (
            <div className="tasks-error" role="alert">
              <p>{loadError}</p>
              <Button variant="outline" onClick={() => refresh()}>
                Try again
              </Button>
            </div>
          )}
          {!hasLoaded && loading ? (
            <LoadingState kind="trash" label="Loading tag suggestions" />
          ) : enabled === false ? (
            <div className="tasks-empty">
              <Tags size={32} strokeWidth={1} aria-hidden="true" />
              <h2>Smart features are off</h2>
              <p>
                Turn them on in Settings → System to review tag suggestions.
              </p>
            </div>
          ) : (
            <>
              {loading && hasLoaded && (
                <p className="settings-description" role="status">
                  Updating tag suggestions…
                </p>
              )}
              {items.length ? (
                <ul className="tag-collection-grid tag-suggestion-grid">
                  {items.map((item) => {
                    const title = item.title || "Untitled";
                    const type =
                      item.type === "response"
                        ? "Form response"
                        : item.type.charAt(0).toUpperCase() +
                          item.type.slice(1);
                    const Icon =
                      item.type === "note"
                        ? FileText
                        : item.type === "task"
                          ? SquareCheckBig
                          : item.type === "bookmark"
                            ? Bookmark
                            : item.type === "event"
                              ? CalendarDays
                              : item.type === "artifact"
                                ? Layers
                                : ClipboardList;
                    return (
                      <li className="tag-suggestion-card" key={item.id}>
                        <article className="tag-collection-card">
                          <div className="tag-collection-kind">
                            <Icon size={16} aria-hidden="true" />
                            <span>{type}</span>
                          </div>
                          <h2 className="tag-suggestion-title">{title}</h2>
                          {item.excerpt && (
                            <p className="tag-suggestion-excerpt">
                              {item.excerpt.replace(/\s+/g, " ")}
                            </p>
                          )}
                          <footer>
                            <span className="tag-suggestion-chip">
                              <span className="tag-suggestion-chip-label">
                                Suggested tag
                              </span>
                              <span
                                className="tag-chip"
                                data-color={item.tag.color}
                              >
                                <span
                                  className="tag-dot"
                                  data-color={item.tag.color}
                                  aria-hidden="true"
                                />
                                <span className="tag-chip-label">
                                  {item.tag.name}
                                </span>
                              </span>
                            </span>
                            {actionError?.itemId === item.id && (
                              <p className="form-error" role="alert">
                                {actionError.message}
                              </p>
                            )}
                            <div className="tag-suggestion-actions">
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={busy}
                                aria-label={`Open ${title}`}
                                onClick={() => void open(item)}
                              >
                                Open
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={busy}
                                aria-label={`Add ${item.tag.name} to ${title}`}
                                onClick={() => void decide(item, "accept")}
                              >
                                Add tag
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={busy}
                                aria-label={`Dismiss suggestion for ${item.tag.name} on ${title}`}
                                onClick={() => void decide(item, "reject")}
                              >
                                Dismiss
                              </Button>
                            </div>
                          </footer>
                        </article>
                      </li>
                    );
                  })}
                </ul>
              ) : !loading && !loadError ? (
                <div className="tasks-empty">
                  <Tags size={32} strokeWidth={1} aria-hidden="true" />
                  <h2>No tag suggestions to review</h2>
                  <p>There are no tag suggestions right now.</p>
                </div>
              ) : null}
            </>
          )}
        </div>
      </div>
    </section>
  );
}
