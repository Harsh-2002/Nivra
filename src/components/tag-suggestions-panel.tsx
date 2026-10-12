"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Bookmark,
  CalendarDays,
  ClipboardList,
  FileText,
  Layers,
  Plus,
  SquareCheckBig,
  Tags,
  X,
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
type ProposalSource = {
  itemId: string;
  type: SearchResult["type"];
  title: string;
  formId?: string;
};
type TagProposal = {
  id: string;
  name: string;
  color: string;
  itemCount: number;
  items: ProposalSource[];
  createdAt: number;
};

function sourceTypeLabel(type: SearchResult["type"]) {
  return type === "response"
    ? "Form response"
    : type.charAt(0).toUpperCase() + type.slice(1);
}

function sourceIcon(type: SearchResult["type"]) {
  return type === "note"
    ? FileText
    : type === "task"
      ? SquareCheckBig
      : type === "bookmark"
        ? Bookmark
        : type === "event"
          ? CalendarDays
          : type === "artifact"
            ? Layers
            : ClipboardList;
}

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
  const [proposals, setProposals] = useState<TagProposal[]>([]);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [actionError, setActionError] = useState<{
    itemId: string;
    message: string;
  } | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [vocabularyRefreshing, setVocabularyRefreshing] = useState(false);
  const [vocabularyWaitExpired, setVocabularyWaitExpired] = useState(false);
  const [version, setVersion] = useState(0);
  const completionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const vocabularyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadingRef = useRef(true);
  const refreshQueued = useRef(false);
  const reviewInFlight = useRef(false);
  const vocabularyRefreshRef = useRef(false);
  const vocabularyStartedAt = useRef<number | null>(null);
  const vocabularyPollAttempt = useRef(0);
  const reviewGeneration = useRef(0);

  const beginVocabularyRefresh = useCallback(() => {
    vocabularyRefreshRef.current = true;
    vocabularyStartedAt.current ??= Date.now();
    setVocabularyRefreshing(true);
    setVocabularyWaitExpired(false);
  }, []);

  const finishVocabularyRefresh = useCallback(() => {
    if (vocabularyTimer.current) clearTimeout(vocabularyTimer.current);
    vocabularyTimer.current = null;
    vocabularyRefreshRef.current = false;
    vocabularyStartedAt.current = null;
    vocabularyPollAttempt.current = 0;
    setVocabularyRefreshing(false);
    setVocabularyWaitExpired(false);
  }, []);

  const refresh = useCallback((preserveFeedback = false) => {
    if (reviewInFlight.current) {
      refreshQueued.current = true;
      return;
    }
    if (completionTimer.current) clearTimeout(completionTimer.current);
    completionTimer.current = null;
    if (vocabularyTimer.current) clearTimeout(vocabularyTimer.current);
    vocabularyTimer.current = null;
    refreshQueued.current = false;
    loadingRef.current = true;
    setLoading(true);
    setLoadError("");
    if (!preserveFeedback) {
      setActionError(null);
      setMessage("");
    }
    setVersion((current) => current + 1);
  }, []);

  const scheduleVocabularyPoll = useCallback(() => {
    if (!vocabularyRefreshRef.current || vocabularyTimer.current) return;
    const startedAt = vocabularyStartedAt.current ?? Date.now();
    vocabularyStartedAt.current = startedAt;
    const maxWaitMs = 120_000;
    if (Date.now() - startedAt >= maxWaitMs) {
      setVocabularyRefreshing(false);
      setVocabularyWaitExpired(true);
      return;
    }
    if (document.visibilityState === "hidden" || !document.hasFocus()) return;
    const backoff = [1000, 2000, 5000, 10_000, 20_000, 30_000];
    const delay =
      backoff[Math.min(vocabularyPollAttempt.current, backoff.length - 1)];
    vocabularyPollAttempt.current++;
    vocabularyTimer.current = setTimeout(() => {
      vocabularyTimer.current = null;
      if (!vocabularyRefreshRef.current) return;
      if (document.visibilityState === "hidden" || !document.hasFocus()) return;
      if (Date.now() - startedAt >= maxWaitMs) {
        setVocabularyRefreshing(false);
        setVocabularyWaitExpired(true);
        return;
      }
      if (loadingRef.current || reviewInFlight.current) {
        return;
      }
      refresh(true);
    }, delay);
  }, [refresh]);

  const scheduleRefresh = useCallback(() => {
    if (vocabularyRefreshRef.current) return;
    refreshQueued.current = true;
    if (completionTimer.current) clearTimeout(completionTimer.current);
    completionTimer.current = null;
    if (loadingRef.current || reviewInFlight.current) return;
    completionTimer.current = setTimeout(() => {
      completionTimer.current = null;
      if (loadingRef.current || reviewInFlight.current) return;
      refresh(true);
    }, 150);
  }, [refresh]);

  useCompletion("ai", (event) => {
    if (event.target === "settings") refresh(true);
    else scheduleRefresh();
  });

  useEffect(() => {
    const resumeVocabularyRefresh = () => {
      if (
        vocabularyRefreshRef.current &&
        document.visibilityState !== "hidden" &&
        document.hasFocus()
      ) {
        vocabularyStartedAt.current = Date.now();
        vocabularyPollAttempt.current = 0;
        setVocabularyWaitExpired(false);
        setVocabularyRefreshing(true);
        scheduleVocabularyPoll();
      }
    };
    const pauseVocabularyRefresh = () => {
      if (vocabularyTimer.current) clearTimeout(vocabularyTimer.current);
      vocabularyTimer.current = null;
    };
    document.addEventListener("visibilitychange", resumeVocabularyRefresh);
    window.addEventListener("focus", resumeVocabularyRefresh);
    window.addEventListener("blur", pauseVocabularyRefresh);
    return () => {
      document.removeEventListener("visibilitychange", resumeVocabularyRefresh);
      window.removeEventListener("focus", resumeVocabularyRefresh);
      window.removeEventListener("blur", pauseVocabularyRefresh);
    };
  }, [scheduleVocabularyPoll]);
  useEffect(
    () => () => {
      if (completionTimer.current) clearTimeout(completionTimer.current);
      if (vocabularyTimer.current) clearTimeout(vocabularyTimer.current);
    },
    [],
  );

  useEffect(() => {
    const controller = new AbortController();
    const generation = reviewGeneration.current;
    loadingRef.current = true;
    void (async () => {
      try {
        const status = await api<{
          enabled: boolean;
          vocabularyPending: number;
        }>("ai", {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        if (generation !== reviewGeneration.current || reviewInFlight.current) {
          if (reviewInFlight.current) refreshQueued.current = true;
          return;
        }
        setEnabled(status.enabled);
        if (!status.enabled) {
          finishVocabularyRefresh();
          setItems([]);
          setProposals([]);
          setHasLoaded(true);
          return;
        }
        if (status.vocabularyPending > 0) {
          setLoadError("");
          beginVocabularyRefresh();
          scheduleVocabularyPoll();
          return;
        }
        if (vocabularyTimer.current) clearTimeout(vocabularyTimer.current);
        vocabularyTimer.current = null;
        const [result, proposalResult] = await Promise.all([
          api<{ items: Suggestion[] }>("ai/suggestions", {
            signal: controller.signal,
          }),
          api<{ items: TagProposal[] }>("ai/tag-proposals", {
            signal: controller.signal,
          }),
        ]);
        if (
          !controller.signal.aborted &&
          generation === reviewGeneration.current &&
          !reviewInFlight.current
        ) {
          setItems(result.items);
          setProposals(proposalResult.items);
          setHasLoaded(true);
          finishVocabularyRefresh();
        } else if (!controller.signal.aborted && reviewInFlight.current)
          refreshQueued.current = true;
      } catch {
        if (
          !controller.signal.aborted &&
          generation === reviewGeneration.current &&
          !reviewInFlight.current
        ) {
          setLoadError("Could not load tag suggestions.");
        } else if (!controller.signal.aborted && reviewInFlight.current)
          refreshQueued.current = true;
      } finally {
        if (!controller.signal.aborted) {
          if (reviewInFlight.current) {
            loadingRef.current = false;
            refreshQueued.current = true;
            setLoading(false);
          } else if (generation !== reviewGeneration.current) {
            if (refreshQueued.current) {
              loadingRef.current = false;
              scheduleRefresh();
            }
          } else {
            loadingRef.current = false;
            if (vocabularyRefreshRef.current) scheduleVocabularyPoll();
            if (refreshQueued.current) scheduleRefresh();
            else setLoading(false);
          }
        }
      }
    })();
    return () => controller.abort();
  }, [
    version,
    scheduleRefresh,
    scheduleVocabularyPoll,
    beginVocabularyRefresh,
    finishVocabularyRefresh,
  ]);

  function retryVocabularyRefresh() {
    vocabularyStartedAt.current = Date.now();
    vocabularyPollAttempt.current = 0;
    beginVocabularyRefresh();
    refresh(true);
  }

  async function openResult(id: string, result: SearchResult) {
    if (busy || reviewInFlight.current) return;
    setBusy(true);
    setActionError(null);
    setMessage("");
    try {
      await onSelect(result);
    } catch {
      setActionError({ itemId: id, message: "Could not open this item." });
    } finally {
      setBusy(false);
    }
  }

  async function open(item: Suggestion) {
    await openResult(item.id, {
      id: item.itemId,
      type: item.type,
      title: item.title,
      excerpt: item.excerpt,
      updatedAt: item.createdAt,
      ...(item.formId ? { formId: item.formId } : {}),
    });
  }

  async function openProposalSource(
    proposal: TagProposal,
    source: ProposalSource,
  ) {
    await openResult(`${proposal.id}:${source.itemId}`, {
      id: source.itemId,
      type: source.type,
      title: source.title,
      excerpt: "",
      updatedAt: proposal.createdAt,
      ...(source.formId ? { formId: source.formId } : {}),
    });
  }

  async function decide(item: Suggestion, decision: "accept" | "reject") {
    if (busy || reviewInFlight.current || vocabularyRefreshRef.current) return;
    reviewInFlight.current = true;
    reviewGeneration.current++;
    refreshQueued.current = true;
    let reviewed = false;
    setBusy(true);
    setActionError(null);
    setMessage("");
    try {
      if (!(await beforeAction())) return;
      await api(`ai/suggestions/${item.id}/${decision}`, {
        method: "POST",
        body: "{}",
      });
      reviewed = true;
      setItems((current) =>
        current.filter((suggestion) => suggestion.id !== item.id),
      );
      setMessage(
        decision === "accept"
          ? `${item.tag.name} added to ${item.title || "Untitled"}.`
          : `Suggestion for ${item.title || "Untitled"} dismissed.`,
      );
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
      reviewGeneration.current++;
      reviewInFlight.current = false;
      setBusy(false);
      if (vocabularyRefreshRef.current) scheduleVocabularyPoll();
      if (reviewed || refreshQueued.current) {
        if (loadingRef.current) refreshQueued.current = true;
        else refresh(true);
      }
    }
  }

  async function decideProposal(
    proposal: TagProposal,
    decision: "accept" | "reject",
  ) {
    if (busy || reviewInFlight.current || vocabularyRefreshRef.current) return;
    reviewInFlight.current = true;
    reviewGeneration.current++;
    refreshQueued.current = true;
    let reviewed = false;
    setBusy(true);
    setActionError(null);
    setMessage("");
    try {
      if (!(await beforeAction())) return;
      await api(`ai/tag-proposals/${proposal.id}/${decision}`, {
        method: "POST",
        body: "{}",
      });
      reviewed = true;
      if (decision === "accept") {
        beginVocabularyRefresh();
      }
      setProposals((current) =>
        current.filter((item) => item.id !== proposal.id),
      );
      setMessage(
        decision === "accept"
          ? `Created ${proposal.name} and assigned it to ${proposal.itemCount} items.`
          : `Suggestion for ${proposal.name} dismissed.`,
      );
    } catch (error) {
      setActionError({
        itemId: proposal.id,
        message:
          error instanceof ApiError && error.status === 409
            ? error.message === "Local AI is disabled."
              ? "Smart features are turned off. Turn them on in Settings → System and refresh."
              : "This tag idea changed or was already reviewed. Refresh the list and try again."
            : "Could not update this tag idea. Refresh and try again.",
      });
    } finally {
      reviewGeneration.current++;
      reviewInFlight.current = false;
      setBusy(false);
      if (vocabularyRefreshRef.current) scheduleVocabularyPoll();
      if (reviewed || refreshQueued.current) {
        if (loadingRef.current) refreshQueued.current = true;
        else refresh(true);
      }
    }
  }

  const statusMessage = [
    message,
    hasLoaded && vocabularyRefreshing
      ? "Updating tag suggestions. Existing suggestions are kept while they refresh."
      : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <section className="tag-suggestions-panel tasks-panel">
      <div
        className="tasks-scroll"
        tabIndex={0}
        role="region"
        aria-label="Tag suggestions"
        aria-busy={loading || busy || vocabularyRefreshing}
      >
        <div className="section-content">
          <SectionHeading
            title="Tag suggestions"
            description="Suggested matches for your existing tags."
            onNavigation={onNavigation}
          />
          <p className="sr-only" role="status">
            {statusMessage}
          </p>
          {loadError && !vocabularyWaitExpired && (
            <div className="tasks-error" role="alert">
              <p>{loadError}</p>
              <Button variant="outline" onClick={() => refresh()}>
                Try again
              </Button>
            </div>
          )}
          {!hasLoaded && (loading || vocabularyRefreshing) ? (
            <LoadingState
              kind="trash"
              label={
                vocabularyRefreshing
                  ? "Updating tag suggestions"
                  : "Loading tag suggestions"
              }
            />
          ) : enabled === false ? (
            <div className="tasks-empty">
              <Tags size={32} strokeWidth={1} aria-hidden="true" />
              <h2>Smart features are off</h2>
              <p>
                Turn them on in Settings → System to review tag suggestions.
              </p>
            </div>
          ) : !hasLoaded && vocabularyWaitExpired ? (
            <div className="tasks-error" role="status">
              <p>
                Tag suggestions are taking longer than expected. Check again
                when the indexer is available.
              </p>
              <Button variant="outline" onClick={retryVocabularyRefresh}>
                Check again
              </Button>
            </div>
          ) : (
            <>
              {vocabularyWaitExpired ? (
                <div className="tasks-error" role="status">
                  <p>
                    Tag suggestions are taking longer than expected. Existing
                    suggestions are kept until they can be refreshed.
                  </p>
                  <Button variant="outline" onClick={retryVocabularyRefresh}>
                    Check again
                  </Button>
                </div>
              ) : null}
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
                          <button
                            type="button"
                            className="tag-suggestion-open"
                            disabled={busy}
                            aria-label={`Open ${title}`}
                            onClick={() => void open(item)}
                          />
                          <Button
                            size="icon"
                            variant="ghost"
                            className="tag-suggestion-dismiss"
                            disabled={
                              busy ||
                              vocabularyRefreshing ||
                              vocabularyWaitExpired
                            }
                            aria-label={`Dismiss suggestion for ${item.tag.name} on ${title}`}
                            onClick={() => void decide(item, "reject")}
                          >
                            <X size={16} aria-hidden="true" />
                          </Button>
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
                            <div className="tag-suggestion-actions">
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
                              <Button
                                size="icon"
                                variant="outline"
                                className="tag-suggestion-approve"
                                disabled={
                                  busy ||
                                  vocabularyRefreshing ||
                                  vocabularyWaitExpired
                                }
                                aria-label={`Add ${item.tag.name} to ${title}`}
                                onClick={() => void decide(item, "accept")}
                              >
                                <Plus size={18} aria-hidden="true" />
                              </Button>
                            </div>
                            {actionError?.itemId === item.id && (
                              <p className="form-error" role="alert">
                                {actionError.message}
                              </p>
                            )}
                          </footer>
                        </article>
                      </li>
                    );
                  })}
                </ul>
              ) : null}
              {proposals.length > 0 && (
                <section
                  className="tag-proposal-section"
                  aria-labelledby="tag-proposal-heading"
                >
                  <h2 id="tag-proposal-heading">New tag ideas</h2>
                  <ul className="tag-collection-grid tag-proposal-grid">
                    {proposals.map((proposal) => (
                      <li className="tag-proposal-card" key={proposal.id}>
                        <article className="tag-collection-card">
                          <div className="tag-collection-kind">
                            <Tags size={16} aria-hidden="true" />
                            <span>Suggested new tag</span>
                          </div>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="tag-suggestion-dismiss"
                            disabled={
                              busy ||
                              vocabularyRefreshing ||
                              vocabularyWaitExpired
                            }
                            aria-label={`Dismiss new tag idea ${proposal.name}`}
                            onClick={() =>
                              void decideProposal(proposal, "reject")
                            }
                          >
                            <X size={16} aria-hidden="true" />
                          </Button>
                          <div className="tag-proposal-name-row">
                            <h3 className="tag-proposal-name">
                              {proposal.name}
                            </h3>
                            <span
                              className="tag-dot"
                              data-color={proposal.color}
                              aria-hidden="true"
                            />
                          </div>
                          <p className="tag-proposal-count">
                            Suggested for {proposal.itemCount} items
                          </p>
                          {proposal.items.length > 0 && (
                            <ul className="tag-proposal-sources">
                              {proposal.items.slice(0, 3).map((source) => {
                                const title = source.title || "Untitled";
                                const kind = sourceTypeLabel(source.type);
                                const Icon = sourceIcon(source.type);
                                return (
                                  <li key={`${source.type}:${source.itemId}`}>
                                    <Button
                                      variant="ghost"
                                      className="tag-proposal-source"
                                      disabled={busy}
                                      aria-label={`Open ${title} (${kind})`}
                                      onClick={() =>
                                        void openProposalSource(
                                          proposal,
                                          source,
                                        )
                                      }
                                    >
                                      <Icon size={16} aria-hidden="true" />
                                      <span>{title}</span>
                                      <small>{kind}</small>
                                    </Button>
                                  </li>
                                );
                              })}
                            </ul>
                          )}
                          <footer className="tag-proposal-footer">
                            <Button
                              variant="outline"
                              disabled={
                                busy ||
                                vocabularyRefreshing ||
                                vocabularyWaitExpired
                              }
                              aria-label={`Create ${proposal.name} and tag ${proposal.itemCount} items`}
                              onClick={() =>
                                void decideProposal(proposal, "accept")
                              }
                            >
                              <Plus size={16} aria-hidden="true" />
                              Create tag
                            </Button>
                            {actionError?.itemId === proposal.id && (
                              <p className="form-error" role="alert">
                                {actionError.message}
                              </p>
                            )}
                          </footer>
                        </article>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
              {!items.length &&
              !proposals.length &&
              !loading &&
              !vocabularyRefreshing &&
              !vocabularyWaitExpired &&
              !loadError ? (
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
