"use client";
import { useRouter } from "next/navigation";
import {
  guardComposition,
  returnToCreation,
  useCreationFocus,
} from "@/lib/input-behavior";
import { CalendarDays as ScheduleIcon } from "lucide-react";
import { scheduleItem } from "@/lib/schedule";
import { ItemTagPicker } from "./item-tag-picker";
import { LoadingState } from "./loading-state";
import { useCompletion } from "@/lib/completion-client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Bookmark as BookmarkIcon,
  ExternalLink,
  Globe,
  Loader2,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Star,
  Trash2,
  FileText,
  Check,
  Share2,
} from "lucide-react";
import { api, ApiError } from "@/lib/client";
import type { Bookmark, Page } from "@/lib/types";
import { sectionCache } from "@/lib/section-cache";
import { Button } from "./ui/button";
import { SectionHeading } from "./section-heading";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { Label } from "./ui/label";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import { useConfirm } from "./confirm-provider";
import { NotePicker } from "./note-picker";
import type { CapturedItem } from "./quick-capture";
function PreviewImage({
  src,
  kind,
}: {
  src: string;
  kind: "icon" | "thumbnail";
}) {
  const [failed, setFailed] = useState(false);
  return failed ? (
    <Globe size={kind === "icon" ? 16 : 28} strokeWidth={1.5} />
  ) : (
    // Saved previews are authenticated local images, not remote website requests.
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt="" loading="lazy" onError={() => setFailed(true)} />
  );
}
type BookmarkSummary = { total: number; collections: string[] };
type BookmarkList = {
  items: Bookmark[];
  next: string | null;
  total: number | null;
};
const scopeOf = (
  favorites: boolean,
  collection: string,
  readingState = "all",
) => `${favorites}|${collection}|${readingState}`;
const listKey = (scope: string) => `bookmarks:list:${scope}`;
const bookmarkParams = (
  query: string,
  favorites: boolean,
  collection: string,
  summary = false,
  readingState = "all",
) =>
  new URLSearchParams({
    readingState,
    ...(summary ? { summary: "1" } : { limit: "60" }),
    ...(query.trim() ? { q: query.trim() } : {}),
    ...(favorites ? { favorite: "1" } : {}),
    ...(collection === "unfiled"
      ? { unfiled: "1" }
      : collection !== "all"
        ? { collection: collection.slice(2) }
        : {}),
  });
const compareBookmarks = (a: Bookmark, b: Bookmark) =>
  b.createdAt - a.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
function mergeBookmarks(items: Bookmark[], incoming: Bookmark[]) {
  const replaced = new Set(incoming.map((item) => item.id));
  return [...items.filter((item) => !replaced.has(item.id)), ...incoming].sort(
    compareBookmarks,
  );
}
export function BookmarksPanel({
  onNavigation,
  registerGuard,
  initialQuery = "",
  focusCreate = false,
  onOpenNote,
}: {
  onNavigation: () => void;
  registerGuard: (guard: () => Promise<boolean>) => void;
  initialQuery?: string;
  focusCreate?: boolean;
  onOpenNote: (id: string) => Promise<boolean>;
}) {
  const router = useRouter();
  const warm = sectionCache.get<BookmarkList>(listKey(scopeOf(false, "all")));
  const [bookmarks, setBookmarks] = useState<Bookmark[]>(warm?.items ?? []);
  const [next, setNext] = useState<string | null>(warm?.next ?? null);
  const [listScope, setListScope] = useState(warm ? scopeOf(false, "all") : "");
  const [total, setTotal] = useState<number | null>(warm?.total ?? null);
  const [collections, setCollections] = useState<string[]>(
    () => sectionCache.get<string[]>("bookmarks:collections") ?? [],
  );
  const [loadingMore, setLoadingMore] = useState(false);
  const [url, setUrl] = useState("");
  const [newCollection, setNewCollection] = useState("");
  const [query, setQuery] = useState(initialQuery);
  const [collection, setCollection] = useState("all");
  const [favorites, setFavorites] = useState(false);
  const [readingState, setReadingState] = useState("all");
  const [editing, setEditing] = useState<Bookmark | null>(null);
  const [loading, setLoading] = useState(!warm);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const confirm = useConfirm();
  const unfiltered =
    !query.trim() &&
    !favorites &&
    collection === "all" &&
    readingState === "all";
  const invalidate = () => sectionCache.clear("bookmarks:list:", "overview");
  const refreshSummary = useCallback(async () => {
    try {
      const counts = await api<BookmarkSummary>(
        `bookmarks?${bookmarkParams(query, favorites, collection, true, readingState)}`,
      );
      setTotal(counts.total);
      setCollections(counts.collections);
    } catch {}
  }, [query, favorites, collection, readingState]);
  useEffect(() => {
    const received = (event: Event) => {
      const result = (event as CustomEvent<CapturedItem>).detail;
      if (result.type !== "bookmark") return;
      void refreshSummary();
      if (unfiltered)
        setBookmarks((items) => mergeBookmarks(items, [result.item]));
    };
    window.addEventListener("nivra:captured", received);
    return () => window.removeEventListener("nivra:captured", received);
  }, [unfiltered, refreshSummary]);
  useCreationFocus(input, !initialQuery, focusCreate);
  useEffect(() => {
    const leaving = (e: BeforeUnloadEvent) => {
      if (busy || url.trim() || newCollection.trim() || editing) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", leaving);
    return () => {
      window.removeEventListener("beforeunload", leaving);
    };
  }, [busy, url, newCollection, editing]);
  const view = `${query}\n${favorites}\n${collection}\n${readingState}`;
  const currentView = useRef(view);
  const loadVersion = useRef(0);
  const load = useCallback(
    async (signal?: AbortSignal) => {
      const version = ++loadVersion.current;
      currentView.current = view;
      setLoading(true);
      try {
        const [first, counts] = await Promise.all([
          api<Page<Bookmark>>(
            `bookmarks?${bookmarkParams(query, favorites, collection, false, readingState)}`,
            { signal },
          ),
          api<BookmarkSummary>(
            `bookmarks?${bookmarkParams(query, favorites, collection, true, readingState)}`,
            { signal },
          ),
        ]);
        if (signal?.aborted || version !== loadVersion.current) return;
        setBookmarks(first.items);
        setNext(first.next);
        setListScope(scopeOf(favorites, collection, readingState));
        setTotal(counts.total);
        setCollections(counts.collections);
        setError("");
      } catch (e) {
        if (!signal?.aborted && version === loadVersion.current)
          setError((e as Error).message);
      } finally {
        if (!signal?.aborted && version === loadVersion.current)
          setLoading(false);
      }
    },
    [query, favorites, collection, readingState, view],
  );
  useCompletion("bookmark", () => {
    void load();
  });
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(
      () => void load(controller.signal),
      query.trim() ? 180 : 0,
    );
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [load, query]);
  useEffect(() => {
    if (
      listScope === scopeOf(favorites, collection, readingState) &&
      !query.trim() &&
      !loading
    )
      sectionCache.set(listKey(listScope), { items: bookmarks, next, total });
    sectionCache.set("bookmarks:collections", collections);
  }, [
    bookmarks,
    next,
    total,
    collections,
    listScope,
    favorites,
    collection,
    readingState,
    query,
    loading,
  ]);
  async function loadMore() {
    if (!next || loadingMore) return;
    const started = view;
    const version = loadVersion.current;
    setLoadingMore(true);
    try {
      const more = await api<Page<Bookmark>>(
        `bookmarks?${bookmarkParams(query, favorites, collection, false, readingState)}&after=${encodeURIComponent(next)}`,
      );
      if (currentView.current !== started || version !== loadVersion.current)
        return;
      setBookmarks((items) => mergeBookmarks(items, more.items));
      setNext(more.next);
    } catch (e) {
      if (version === loadVersion.current) setError((e as Error).message);
    } finally {
      setLoadingMore(false);
    }
  }
  useEffect(() => {
    registerGuard(
      async () =>
        !busy &&
        (!(url.trim() || newCollection.trim() || editing) ||
          (await confirm({
            title: "Discard unfinished bookmark?",
            description:
              "Your link or changes have not been saved. Stay here to finish, or discard them before leaving.",
            action: "Discard",
          }))),
    );
    return () => registerGuard(async () => true);
  }, [busy, url, newCollection, editing, confirm, registerGuard]);
  async function mutate(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) await load();
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!url.trim() || busy) return;
    const submittedUrl = url;
    const submittedCollection = newCollection;
    await mutate(async () => {
      const saved = await api<Bookmark>("bookmarks", {
        method: "POST",
        body: JSON.stringify({
          url: url.trim(),
          collection: newCollection.trim(),
        }),
      });
      invalidate();
      setBookmarks((list) => mergeBookmarks(list, [saved]));
      void refreshSummary();
      setUrl((current) => (current === submittedUrl ? "" : current));
      setNewCollection((current) =>
        current === submittedCollection ? "" : current,
      );
      setQuery("");
      setCollection("all");
      setFavorites(false);
      setReadingState("all");
      returnToCreation(input.current);
      setNotice(
        saved.metadataStatus === "pending"
          ? "Link saved. Fetching its preview in the background."
          : saved.metadataStatus === "ready"
            ? "Bookmark saved."
            : "Link saved. This site’s preview could not be fetched; you can edit its details or retry from the card menu.",
      );
    });
  }
  async function update(
    item: Bookmark,
    changes: Partial<
      Pick<
        Bookmark,
        "title" | "description" | "collection" | "favorite" | "noteId"
      >
    >,
  ) {
    await mutate(async () => {
      const updated = await api<Bookmark>(`bookmarks/${item.id}`, {
        method: "PATCH",
        body: JSON.stringify({ revision: item.revision, ...changes }),
      });
      invalidate();
      setBookmarks((list) => mergeBookmarks(list, [updated]));
      if (query.trim()) await load();
      else void refreshSummary();
      if (changes.title !== undefined) setEditing(null);
    });
  }
  async function markRead(item: Bookmark) {
    return markReadItems([item], item.readAt == null);
  }
  async function markReadItems(items: Bookmark[], read: boolean) {
    await mutate(async () => {
      const result = await api<{
        items: {
          id: string;
          status: "updated" | "unchanged" | "conflict" | "not_found";
          bookmark?: Bookmark;
        }[];
      }>("bookmarks/read-state", {
        method: "POST",
        body: JSON.stringify({
          items: items.map((item) => ({
            id: item.id,
            revision: item.revision,
            read,
          })),
        }),
      });
      const updated = result.items.flatMap((entry) =>
        entry.bookmark ? [entry.bookmark] : [],
      );
      setBookmarks((current) => mergeBookmarks(current, updated));
      invalidate();
      void refreshSummary();
      const failed = result.items.filter((entry) => !entry.bookmark).length;
      if (failed)
        throw new Error(
          `${failed} ${failed === 1 ? "link changed" : "links changed"} or became unavailable. Updated links were saved; refresh before retrying the others.`,
        );
    });
  }
  const scope = scopeOf(favorites, collection, readingState);
  const cached = query.trim()
    ? undefined
    : sectionCache.get<BookmarkList>(listKey(scope));
  const ready = listScope === scope;
  const rows = ready ? bookmarks : cached?.items;
  const hasMore = ready ? next !== null : !!cached?.next;
  const shownTotal = ready ? total : (cached?.total ?? null);
  const visible = (rows ?? []).filter(
    (b) =>
      (!favorites || b.favorite) &&
      (readingState === "all" ||
        (readingState === "read" ? b.readAt != null : b.readAt == null)) &&
      (collection === "all" ||
        (collection === "unfiled"
          ? !b.collection
          : b.collection === collection.slice(2))),
  );
  return (
    <section className="tasks-panel bookmarks-panel">
      <div
        className="tasks-scroll"
        tabIndex={0}
        role="region"
        aria-label="Bookmarks"
      >
        <div className="bookmarks-content section-content">
          <SectionHeading
            title="Bookmarks"
            description="Keep useful links close, with a little context."
            onNavigation={onNavigation}
          />
          <form className="bookmark-create section-create" onSubmit={add}>
            <div className="bookmark-url">
              <Label htmlFor="bookmark-url">Link</Label>
              <Input
                id="bookmark-url"
                ref={input}
                type="url"
                inputMode="url"
                placeholder="https://…"
                value={url}
                maxLength={4096}
                disabled={!!editing}
                onKeyDown={guardComposition}
                onChange={(e) => setUrl(e.target.value)}
                required
              />
            </div>
            <div className="bookmark-collection">
              <Label htmlFor="bookmark-collection">
                Collection <span>(optional)</span>
              </Label>
              <Input
                id="bookmark-collection"
                placeholder="e.g. Reading"
                value={newCollection}
                maxLength={80}
                disabled={!!editing}
                onKeyDown={guardComposition}
                onChange={(e) => setNewCollection(e.target.value)}
              />
            </div>
            <Button type="submit" disabled={busy || !!editing || !url.trim()}>
              {busy ? (
                <Loader2 size={16} className="animate-spin" />
              ) : (
                <Plus size={16} />
              )}
              {busy ? "Saving…" : "Save link"}
            </Button>
          </form>
          {notice && (
            <p className="bookmark-notice" role="status">
              {notice}
            </p>
          )}
          <div className="bookmark-toolbar section-toolbar">
            <div className="bookmark-filters">
              <Button
                variant="ghost"
                aria-pressed={favorites}
                disabled={busy || !!editing}
                onClick={() => setFavorites(!favorites)}
              >
                <Star size={15} fill={favorites ? "currentColor" : "none"} />
                Favorites
              </Button>
              <Select
                value={collection}
                onValueChange={setCollection}
                disabled={busy || !!editing}
              >
                <SelectTrigger aria-label="Filter bookmark collection">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All collections</SelectItem>
                  <SelectItem value="unfiled">Unfiled</SelectItem>
                  {collections.map((c) => (
                    <SelectItem key={c} value={`c:${c}`}>
                      {c}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value={readingState}
                onValueChange={setReadingState}
                disabled={busy || !!editing}
              >
                <SelectTrigger aria-label="Filter bookmark reading state">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All links</SelectItem>
                  <SelectItem value="unread">Unread</SelectItem>
                  <SelectItem value="read">Read</SelectItem>
                </SelectContent>
              </Select>
              {readingState !== "all" && visible.length > 0 && (
                <Button
                  variant="ghost"
                  disabled={busy || !!editing}
                  onClick={() =>
                    void markReadItems(
                      visible.slice(0, 100),
                      readingState === "unread",
                    )
                  }
                >
                  Mark {Math.min(visible.length, 100)}{" "}
                  {readingState === "unread" ? "read" : "unread"}
                </Button>
              )}
              <Button
                variant="ghost"
                disabled={
                  busy || !!editing || !!url.trim() || !!newCollection.trim()
                }
                onClick={() => router.push("/capture")}
              >
                <Share2 size={15} />
                Save from browser
              </Button>
            </div>
            <div className="task-search">
              <Search size={15} />
              <Input
                disabled={busy || !!editing}
                maxLength={300}
                aria-label="Search bookmarks"
                placeholder="Search links, titles, collections…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
          </div>
          {error && (
            <div className="tasks-error" role="alert">
              <p>{error}</p>
              <Button
                variant="outline"
                disabled={busy || !!editing}
                onClick={() => void load()}
              >
                Retry
              </Button>
            </div>
          )}
          {rows === undefined && !error ? (
            <LoadingState kind="bookmarks" label="Loading bookmarks" />
          ) : visible.length ? (
            <ul
              className="bookmark-grid"
              aria-label="Saved bookmarks"
              aria-busy={loading}
            >
              {visible.map((item) => (
                <li key={item.id} className="bookmark-card">
                  {editing?.id === item.id ? (
                    <form
                      className="bookmark-edit"
                      onSubmit={(e) => {
                        e.preventDefault();
                        void update(item, {
                          title: editing.title.trim(),
                          description: editing.description,
                          collection: editing.collection.trim(),
                          noteId: editing.noteId,
                        });
                      }}
                    >
                      <Label htmlFor={`title-${item.id}`}>Title</Label>
                      <Input
                        id={`title-${item.id}`}
                        autoFocus
                        value={editing.title}
                        maxLength={300}
                        required
                        disabled={busy}
                        onChange={(e) =>
                          setEditing({ ...editing, title: e.target.value })
                        }
                      />
                      <Label htmlFor={`description-${item.id}`}>
                        Description
                      </Label>
                      <Textarea
                        id={`description-${item.id}`}
                        value={editing.description}
                        maxLength={2000}
                        disabled={busy}
                        onChange={(e) =>
                          setEditing({
                            ...editing,
                            description: e.target.value,
                          })
                        }
                      />
                      <Label htmlFor={`collection-${item.id}`}>
                        Collection
                      </Label>
                      <Input
                        id={`collection-${item.id}`}
                        value={editing.collection}
                        maxLength={80}
                        disabled={busy}
                        onChange={(e) =>
                          setEditing({ ...editing, collection: e.target.value })
                        }
                      />
                      <NotePicker
                        value={editing.noteId}
                        title={editing.noteTitle}
                        disabled={busy}
                        onChange={(id, title) =>
                          setEditing({
                            ...editing,
                            noteId: id,
                            noteTitle: title,
                          })
                        }
                      />
                      <div>
                        <Button
                          type="submit"
                          disabled={busy || !editing.title.trim()}
                        >
                          Save changes
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          disabled={busy}
                          onClick={() => setEditing(null)}
                        >
                          Cancel
                        </Button>
                      </div>
                    </form>
                  ) : (
                    <>
                      <a
                        className="bookmark-link"
                        href={item.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label={`Open ${item.title} in a new tab`}
                      >
                        <div
                          className={`bookmark-preview ${item.thumbnail ? "has-image" : ""}`}
                        >
                          {item.thumbnail ? (
                            <PreviewImage
                              key={item.thumbnail + item.revision}
                              src={item.thumbnail}
                              kind="thumbnail"
                            />
                          ) : (
                            <Globe size={28} strokeWidth={1.5} />
                          )}
                        </div>
                        <div className="bookmark-details">
                          <div className="bookmark-domain">
                            {item.icon ? (
                              <PreviewImage
                                key={item.icon + item.revision}
                                src={item.icon}
                                kind="icon"
                              />
                            ) : (
                              <Globe size={16} />
                            )}
                            <span>
                              {new URL(item.url).hostname.replace(/^www\./, "")}
                            </span>
                            <ExternalLink size={13} />
                          </div>
                          <h2>{item.title}</h2>
                          {item.description && <p>{item.description}</p>}
                          {item.metadataStatus === "pending" && (
                            <p role="status">Fetching preview…</p>
                          )}
                          {item.metadataStatus === "unavailable" && (
                            <p>
                              Preview unavailable. Retry from the card menu.
                            </p>
                          )}
                        </div>
                      </a>
                      <footer className="bookmark-card-footer">
                        <span>{item.collection || "Unfiled"}</span>
                        <Button
                          variant="ghost"
                          size="icon"
                          disabled={busy}
                          aria-label={`${item.favorite ? "Unfavorite" : "Favorite"} ${item.title}`}
                          aria-pressed={item.favorite}
                          onClick={() =>
                            void update(item, { favorite: !item.favorite })
                          }
                        >
                          <Star
                            size={16}
                            fill={item.favorite ? "currentColor" : "none"}
                          />
                        </Button>
                        <ItemTagPicker
                          type="bookmark"
                          id={item.id}
                          title={item.title}
                          disabled={busy || !!editing}
                          onChanged={() => {
                            invalidate();
                            return load();
                          }}
                        />
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              disabled={busy || !!editing}
                              aria-label={`Actions for ${item.title}`}
                            >
                              <MoreHorizontal size={16} />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem
                              onSelect={() => void markRead(item)}
                            >
                              <Check size={15} />
                              Mark {item.readAt ? "unread" : "read"}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onSelect={() =>
                                scheduleItem("bookmark", item.id, item.title)
                              }
                            >
                              <ScheduleIcon size={15} />
                              Schedule
                            </DropdownMenuItem>
                            <DropdownMenuItem onSelect={() => setEditing(item)}>
                              <Pencil size={15} />
                              Edit details
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              disabled={item.metadataStatus === "pending"}
                              onSelect={() =>
                                void mutate(async () => {
                                  const refreshed = await api<Bookmark>(
                                    `bookmarks/${item.id}/refresh`,
                                    {
                                      method: "POST",
                                      body: JSON.stringify({
                                        revision: item.revision,
                                      }),
                                    },
                                  );
                                  invalidate();
                                  setBookmarks((list) =>
                                    mergeBookmarks(list, [refreshed]),
                                  );
                                })
                              }
                            >
                              <RefreshCw size={15} />
                              Refresh preview
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onSelect={() =>
                                void (async () => {
                                  if (
                                    await confirm({
                                      title: "Delete this bookmark?",
                                      description:
                                        "The bookmark and its preview will move to Trash. You can restore them there.",
                                      action: "Delete bookmark",
                                    })
                                  )
                                    await mutate(async () => {
                                      await api(`bookmarks/${item.id}`, {
                                        method: "DELETE",
                                        body: JSON.stringify({
                                          revision: item.revision,
                                        }),
                                      });
                                      invalidate();
                                      setBookmarks((list) =>
                                        list.filter((b) => b.id !== item.id),
                                      );
                                      void refreshSummary();
                                    });
                                })()
                              }
                            >
                              <Trash2 size={15} />
                              Delete bookmark
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </footer>
                      {item.noteId && (
                        <button
                          className="bookmark-note-link linked-note-chip"
                          aria-label={`Open linked note ${item.noteTitle || "Untitled"}`}
                          disabled={busy || !!editing}
                          onClick={() => void onOpenNote(item.noteId!)}
                        >
                          <FileText size={13} />
                          {item.noteTitle || "Untitled"}
                        </button>
                      )}
                    </>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <div className="tasks-empty">
              <BookmarkIcon size={30} strokeWidth={1.5} />
              <h2>
                {query ||
                favorites ||
                collection !== "all" ||
                readingState !== "all"
                  ? "No matching bookmarks"
                  : "A home for your useful links."}
              </h2>
              <p>
                {query ||
                favorites ||
                collection !== "all" ||
                readingState !== "all"
                  ? "Try another search or collection."
                  : "Paste a link above. Nivra will save the details and preview."}
              </p>
            </div>
          )}
          {hasMore && (
            <div className="list-continuation">
              <Button
                variant="ghost"
                disabled={busy || loadingMore || !!editing}
                onClick={() => void loadMore()}
              >
                {loadingMore ? "Loading…" : "Load more bookmarks"}
              </Button>
            </div>
          )}
          {rows !== undefined && (
            <p className="task-summary" aria-live="polite">
              {shownTotal === null
                ? "\u00a0"
                : `${shownTotal} ${shownTotal === 1 ? "bookmark" : "bookmarks"}`}
              {busy && <Loader2 size={13} className="animate-spin" />}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
