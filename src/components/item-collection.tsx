"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  FileText,
  NotebookPen,
  Search,
  Star,
  Tags,
  Heart,
  SquareCheckBig,
  Bookmark,
  Layers,
  ClipboardList,
} from "lucide-react";
import type { TaggedItem } from "@/lib/types";
import { api } from "@/lib/client";
import { useCompletion } from "@/lib/completion-client";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { LoadingState } from "./loading-state";
import { SectionHeading } from "./section-heading";

type Results = { items: TaggedItem[]; next: string | null };
export function ItemCollection({
  tag,
  title,
  onOpen,
  opening,
  onNavigation,
}: {
  tag?: string;
  title: string;
  onOpen: (item: TaggedItem) => void;
  opening: boolean;
  onNavigation: () => void;
}) {
  const label = tag ? "tagged items" : "favorites";
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [rows, setRows] = useState<TaggedItem[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [moreError, setMoreError] = useState("");
  const [loadingMore, setLoadingMore] = useState(false);
  const generation = useRef(0);
  const completionRefresh = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  useEffect(() => {
    const timer = setTimeout(() => setSearch(query), 180);
    return () => clearTimeout(timer);
  }, [query]);
  const load = useCallback(
    async (signal?: AbortSignal) => {
      const version = ++generation.current;
      setError("");
      setLoadingMore(false);
      setMoreError("");
      try {
        const result = await api<Results>(
          `${tag ? `tags/${tag}/items` : "favorites"}?limit=60&q=${encodeURIComponent(search)}`,
          { signal },
        );
        if (version !== generation.current || signal?.aborted) return;
        setRows(result.items);
        setNext(result.next);
      } catch (e) {
        if (!signal?.aborted && version === generation.current)
          setError((e as Error).message);
      }
    },
    [tag, search],
  );
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setRows(null);
      void load(controller.signal);
    }, 0);
    const changed = () => void load();
    window.addEventListener("nivra:tags-changed", changed);
    return () => {
      clearTimeout(timer);
      clearTimeout(completionRefresh.current);
      controller.abort();
      window.removeEventListener("nivra:tags-changed", changed);
    };
  }, [load]);
  const latestLoad = useRef(load);
  useEffect(() => {
    latestLoad.current = load;
  }, [load]);
  useCompletion(undefined, () => {
    clearTimeout(completionRefresh.current);
    completionRefresh.current = setTimeout(
      () => void latestLoad.current(),
      150,
    );
  });
  useEffect(() => () => clearTimeout(completionRefresh.current), []);
  async function more() {
    if (next === null || loadingMore) return;
    const version = generation.current;
    setLoadingMore(true);
    setMoreError("");
    try {
      const result = await api<Results>(
        `${tag ? `tags/${tag}/items` : "favorites"}?limit=60&after=${encodeURIComponent(next)}&q=${encodeURIComponent(search)}`,
      );
      if (version !== generation.current) return;
      setRows((previous) => [
        ...(previous || []),
        ...result.items.filter(
          (item) =>
            !previous?.some(
              (row) => row.type === item.type && row.id === item.id,
            ),
        ),
      ]);
      setNext(result.next);
    } catch (e) {
      if (version === generation.current) setMoreError((e as Error).message);
    } finally {
      if (version === generation.current) setLoadingMore(false);
    }
  }
  return (
    <section className="tag-collection tasks-panel">
      <div
        className="tasks-scroll"
        tabIndex={0}
        role="region"
        aria-label={tag ? "Tagged items" : "Favorites"}
      >
        <div className="section-content">
          <SectionHeading
            title={title}
            description={
              tag
                ? "Items organized with this tag."
                : "Your favorite items, together in one place."
            }
            onNavigation={onNavigation}
          />
          <div className="section-toolbar">
            <span className="tag-result-count">
              {rows === null
                ? "Loading items…"
                : `${rows.length}${next !== null ? "+" : ""} items`}
            </span>
            <div className="task-search">
              <Search size={15} />
              <Input
                aria-label={`Search ${label}`}
                placeholder={`Search ${label}…`}
                value={query}
                maxLength={300}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
          </div>
          {error ? (
            <div className="tasks-empty">
              <p role="alert">{error}</p>
              <Button variant="outline" onClick={() => void load()}>
                Try again
              </Button>
            </div>
          ) : rows === null ? (
            <LoadingState kind="bookmarks" label={`Loading ${label}`} />
          ) : !rows.length ? (
            <div className="tasks-empty">
              {tag ? <Tags size={28} /> : <Heart size={28} />}
              <h2>
                {search
                  ? "No matching items"
                  : tag
                    ? "No items with this tag"
                    : "No favorites yet"}
              </h2>
              <p>
                {search
                  ? "Try another search within this collection."
                  : tag
                    ? "Apply this tag to an item to organize it here."
                    : "Mark an item as a favorite to find it here."}
              </p>
            </div>
          ) : (
            <ul
              className="tag-collection-grid"
              aria-label={tag ? "Tagged items" : "Favorites"}
            >
              {rows.map((item) => {
                const Icon =
                  item.type === "note"
                    ? item.dailyDate
                      ? NotebookPen
                      : FileText
                    : item.type === "task"
                      ? SquareCheckBig
                      : item.type === "bookmark"
                        ? Bookmark
                        : item.type === "form" || item.type === "response"
                          ? ClipboardList
                          : Layers;
                const label =
                  item.type === "note"
                    ? item.dailyDate
                      ? "Journal entry"
                      : "Note"
                    : item.type === "task"
                      ? "Task"
                      : item.type === "bookmark"
                        ? "Bookmark"
                        : item.type === "event"
                          ? "Event"
                          : item.type === "form"
                            ? "Form"
                            : item.type === "response"
                              ? "Form response"
                              : "Artifact";
                return (
                  <li key={`${item.type}:${item.id}`}>
                    <button
                      className="tag-collection-card"
                      disabled={opening}
                      onClick={() => onOpen(item)}
                    >
                      <div className="tag-collection-kind">
                        <Icon size={16} />
                        <span>{label}</span>
                        {item.favorite && (
                          <Star
                            size={14}
                            fill="currentColor"
                            aria-label="Favorite"
                          />
                        )}
                      </div>
                      <strong>{item.title || "Untitled"}</strong>
                      {item.excerpt && (
                        <p>{item.excerpt.replace(/\s+/g, " ")}</p>
                      )}
                      <footer>
                        <time dateTime={new Date(item.updatedAt).toISOString()}>
                          Edited{" "}
                          {new Date(item.updatedAt).toLocaleDateString(
                            undefined,
                            { month: "short", day: "numeric" },
                          )}
                        </time>
                        <div>
                          {item.tags.map((tag) => (
                            <span key={tag.id}>
                              <span
                                className="tag-dot"
                                data-color={tag.color}
                              />
                              {tag.name}
                            </span>
                          ))}
                        </div>
                      </footer>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {!error && next !== null && rows !== null && (
            <div className="list-continuation">
              {moreError && <p role="alert">{moreError}</p>}
              <Button
                variant="outline"
                disabled={loadingMore}
                onClick={() => void more()}
              >
                {loadingMore
                  ? "Loading…"
                  : moreError
                    ? "Try again"
                    : "Load more"}
              </Button>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
