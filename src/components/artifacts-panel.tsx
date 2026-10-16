"use client";
import { CalendarDays as ScheduleIcon } from "lucide-react";
import { scheduleItem } from "@/lib/schedule";
import { ArtifactPreview } from "./artifact-preview";
import { LoadingState } from "./loading-state";
import { useCompletion } from "@/lib/completion-client";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  ClipboardPaste,
  Copy,
  Download,
  FileText,
  Layers,
  Grid2X2,
  List as ListIcon,
  Loader2,
  MoreHorizontal,
  Search,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { notify } from "@/lib/feedback";
import { api } from "@/lib/client";
import {
  fromClipboard,
  fromTransfer,
  type Dropped,
} from "@/lib/artifacts-client";
import { sectionCache } from "@/lib/section-cache";
import type { Artifact, ArtifactDetail, Page } from "@/lib/types";
import { Button } from "./ui/button";
import { SectionHeading } from "./section-heading";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { ArtifactGallery } from "./artifact-gallery";
import { ArtifactViewer, artifactLabel, copyText } from "./artifact-viewer";
import { useConfirm } from "./confirm-provider";
import { shortcutParts, useIsApple } from "@/lib/shortcuts";

type Layout = "grid" | "list";
const layoutKey = "nivra-artifact-layout";
let layoutOverride: Layout | null = null;
const readLayout = (): Layout => {
  if (layoutOverride) return layoutOverride;
  try {
    const saved = localStorage.getItem(layoutKey);
    if (saved === "grid" || saved === "list") return saved;
  } catch {}
  return window.matchMedia("(max-width: 767px)").matches ? "list" : "grid";
};
const subscribeLayout = (changed: () => void) => {
  const media = window.matchMedia("(max-width: 767px)");
  const storage = (event: StorageEvent) => {
    if (event.key !== layoutKey && event.key !== null) return;
    layoutOverride = null;
    changed();
  };
  media.addEventListener("change", changed);
  window.addEventListener("storage", storage);
  window.addEventListener("nivra-artifact-layout", changed);
  return () => {
    media.removeEventListener("change", changed);
    window.removeEventListener("storage", storage);
    window.removeEventListener("nivra-artifact-layout", changed);
  };
};
const serverLayout = (): Layout => "grid";
const chooseLayout = (layout: Layout) => {
  layoutOverride = layout;
  try {
    localStorage.setItem(layoutKey, layout);
  } catch {}
  window.dispatchEvent(new Event("nivra-artifact-layout"));
};
type Kind = "all" | "image" | "text" | "file";
type Summary = { total: number; images: number; texts: number; files: number };
type List = { items: Artifact[]; next: string | null };
type Job = { id: string; label: string; source: Dropped; error?: string };
const listKey = (kind: Kind) => `artifacts:list:${kind}`;
const params = (query: string, kind: Kind, summary = false) =>
  new URLSearchParams({
    ...(summary ? { summary: "1" } : { limit: "60", context: "0" }),
    ...(query.trim() ? { q: query.trim() } : {}),
    ...(kind !== "all" && !summary ? { kind } : {}),
  });
const compare = (a: Artifact, b: Artifact) =>
  b.createdAt - a.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
function merge(items: Artifact[], incoming: Artifact[]) {
  const replaced = new Set(incoming.map((item) => item.id));
  return [...items.filter((item) => !replaced.has(item.id)), ...incoming].sort(
    compare,
  );
}
const withoutContent = (detail: ArtifactDetail | Artifact): Artifact => {
  const copy = { ...detail } as Partial<ArtifactDetail>;
  delete copy.content;
  return copy as Artifact;
};

export function ArtifactsPanel({
  onNavigation,
  registerGuard,
  initialQuery = "",
  openId = null,
}: {
  onNavigation: () => void;
  registerGuard: (guard: () => Promise<boolean>) => void;
  initialQuery?: string;
  openId?: string | null;
}) {
  const layout = useSyncExternalStore(
    subscribeLayout,
    readLayout,
    serverLayout,
  );
  const apple = useIsApple();
  const confirm = useConfirm();
  const warm = sectionCache.get<List>(listKey("all"));
  const [items, setItems] = useState<Artifact[]>(warm?.items ?? []);
  const [next, setNext] = useState<string | null>(warm?.next ?? null);
  const [listKind, setListKind] = useState<Kind | "">(warm ? "all" : "");
  const [summary, setSummary] = useState<Summary | null>(
    () => sectionCache.get<Summary>("artifacts:summary") ?? null,
  );
  const [query, setQuery] = useState(initialQuery);
  const [kind, setKind] = useState<Kind>("all");
  const [loading, setLoading] = useState(!warm);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [jobs, setJobs] = useState<Job[]>([]);
  const [composer, setComposer] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [viewing, setViewing] = useState<string | null>(openId);
  const [notice, setNotice] = useState("");
  const chain = useRef(Promise.resolve());
  const fileInput = useRef<HTMLInputElement>(null);

  const view = `${kind}\n${query}`;
  const currentView = useRef(view);
  const loadVersion = useRef(0);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      const version = ++loadVersion.current;
      currentView.current = view;
      setLoading(true);
      try {
        const [first, counts] = await Promise.all([
          api<Page<Artifact>>(`artifacts?${params(query, kind)}`, { signal }),
          api<Summary>(`artifacts?${params("", "all", true)}`, { signal }),
        ]);
        if (signal?.aborted || version !== loadVersion.current) return;
        setItems(first.items);
        setNext(first.next);
        setListKind(kind);
        setSummary(counts);
        setError("");
      } catch (e) {
        if (!signal?.aborted && version === loadVersion.current)
          setError((e as Error).message);
      } finally {
        if (!signal?.aborted && version === loadVersion.current)
          setLoading(false);
      }
    },
    [kind, query, view],
  );
  useCompletion("artifact", () => {
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
    if (listKind === kind && !query.trim() && !loading)
      sectionCache.set(listKey(kind), { items, next });
    if (summary) sectionCache.set("artifacts:summary", summary);
  }, [items, next, summary, listKind, kind, query, loading]);
  const refreshSummary = useCallback(async () => {
    try {
      setSummary(await api<Summary>(`artifacts?${params("", "all", true)}`));
    } catch {}
  }, []);
  async function loadMore() {
    if (!next || loadingMore) return;
    const started = view;
    const version = loadVersion.current;
    setLoadingMore(true);
    try {
      const more = await api<Page<Artifact>>(
        `artifacts?${params(query, kind)}&after=${encodeURIComponent(next)}`,
      );
      if (currentView.current !== started || version !== loadVersion.current)
        return;
      setItems((list) => merge(list, more.items));
      setNext(more.next);
    } catch (e) {
      if (version === loadVersion.current) setError((e as Error).message);
    } finally {
      setLoadingMore(false);
    }
  }
  const invalidate = () => sectionCache.clear("artifacts:list:", "overview");

  async function send(source: Dropped) {
    if (typeof source === "string")
      return api<Artifact>("artifacts", {
        method: "POST",
        body: JSON.stringify({ text: source }),
      });
    const form = new FormData();
    form.set("file", source);
    return api<Artifact>("artifacts", { method: "POST", body: form });
  }
  function save(sources: Dropped[]) {
    for (const source of sources) {
      const job: Job = {
        id: crypto.randomUUID(),
        label: typeof source === "string" ? "Text" : source.name || "File",
        source,
      };
      setJobs((list) => [...list, job]);
      chain.current = chain.current.then(() => run(job));
    }
  }
  async function run(job: Job) {
    try {
      const saved = await send(job.source);
      invalidate();
      setJobs((list) => list.filter((entry) => entry.id !== job.id));
      if (kind === "all" || kind === saved.kind)
        setItems((list) => merge(list, [saved]));
      void refreshSummary();
      setNotice(`Saved ${job.label}.`);
      setTimeout(() => setNotice(""), 3500);
    } catch (e) {
      setJobs((list) =>
        list.map((entry) =>
          entry.id === job.id
            ? { ...entry, error: (e as Error).message }
            : entry,
        ),
      );
    }
  }
  // Paste works anywhere on this page unless the person is typing in a field.
  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("input,textarea,select,[contenteditable='true']"))
        return;
      if (document.querySelector('[data-slot="dialog-content"]')) return;
      const sources = fromTransfer(event.clipboardData);
      if (!sources.length) return;
      event.preventDefault();
      save(sources);
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  });
  async function pasteButton() {
    try {
      const sources = await fromClipboard();
      if (!sources.length)
        return notify.message("The clipboard has no text or image to save.");
      save(sources);
    } catch {
      notify.error(
        "Your browser did not allow clipboard access. Use the keyboard shortcut, Upload or Add text.",
      );
    }
  }
  useEffect(() => {
    registerGuard(
      async () =>
        (!composer?.trim() && jobs.length === 0) ||
        (await confirm({
          title: "Leave without saving?",
          description: "Something here has not finished saving yet.",
          action: "Leave",
        })),
    );
    return () => registerGuard(async () => true);
  }, [composer, jobs, confirm, registerGuard]);
  useEffect(() => {
    const leaving = (e: BeforeUnloadEvent) => {
      if (composer?.trim() || jobs.length > 0) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", leaving);
    return () => window.removeEventListener("beforeunload", leaving);
  }, [composer, jobs]);
  async function remove(item: Artifact) {
    if (
      !(await confirm({
        title: "Delete this artifact?",
        description:
          "The artifact and its extracted text will move to Trash. You can restore them there.",
        action: "Delete artifact",
      }))
    )
      return;
    try {
      await api(`artifacts/${item.id}`, {
        method: "DELETE",
        body: JSON.stringify({ revision: item.revision }),
      });
      removed(item.id);
    } catch (e) {
      notify.error((e as Error).message);
    }
  }
  function removed(id: string) {
    invalidate();
    setItems((list) => list.filter((item) => item.id !== id));
    void refreshSummary();
  }
  const changed = useCallback((item: Artifact) => {
    invalidate();
    setItems((list) =>
      list.map((entry) =>
        entry.id === item.id ? withoutContent(item) : entry,
      ),
    );
  }, []);
  async function copyOf(item: Artifact) {
    try {
      await copyText(
        (await api<ArtifactDetail>(`artifacts/${item.id}`)).content,
      );
    } catch (e) {
      notify.error((e as Error).message);
    }
  }
  const cached = query.trim()
    ? undefined
    : sectionCache.get<List>(listKey(kind));
  const ready = listKind === kind;
  const rows = ready ? items : cached?.items;
  const hasMore = ready ? next !== null : !!cached?.next;
  const visible = (rows ?? []).filter(
    (item) => kind === "all" || item.kind === kind,
  );
  const shortcut = shortcutParts({ key: "V", code: "KeyV" }, apple).join(
    apple ? " " : "+",
  );
  const chips: [Kind, string, number | undefined][] = [
    ["all", "All", summary?.total],
    ["image", "Images", summary?.images],
    ["text", "Text", summary?.texts],
    ["file", "Files", summary?.files],
  ];
  return (
    <section
      className={`tasks-panel artifacts-panel ${dragging ? "is-dragging" : ""}`}
      onDragOver={(e) => {
        if (
          e.dataTransfer.types.some(
            (type) => type === "Files" || type === "text/plain",
          )
        ) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null))
          setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        save(fromTransfer(e.dataTransfer));
      }}
    >
      <div
        className="tasks-scroll"
        tabIndex={0}
        role="region"
        aria-label="Artifacts"
      >
        <div className="artifacts-content section-content">
          <SectionHeading
            title="Artifacts"
            description="Screenshots, text and files, ready to find again."
            onNavigation={onNavigation}
          />
          <div
            className="artifact-drop"
            role="group"
            aria-label="Add to artifacts"
          >
            <p>
              Drop files here or paste with <kbd>{shortcut}</kbd>.
            </p>
            <div className="artifact-drop-actions">
              <Button variant="outline" onClick={() => void pasteButton()}>
                <ClipboardPaste size={15} />
                Paste
              </Button>
              <Button
                variant="default"
                onClick={() => fileInput.current?.click()}
              >
                <Upload size={15} />
                Upload
              </Button>
              <Button
                variant="outline"
                onClick={() => setComposer(composer ?? "")}
              >
                <FileText size={15} />
                Add text
              </Button>
            </div>
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                save([...(e.target.files ?? [])]);
                e.target.value = "";
              }}
            />
          </div>
          {composer !== null && (
            <form
              className="artifact-composer"
              onSubmit={(e) => {
                e.preventDefault();
                if (!composer.trim()) return;
                save([composer]);
                setComposer(null);
              }}
            >
              <Textarea
                autoFocus
                aria-label="Text to save"
                placeholder="Type or paste anything…"
                value={composer}
                maxLength={200000}
                onChange={(e) => setComposer(e.target.value)}
              />
              <div>
                <Button type="submit" disabled={!composer.trim()}>
                  Save
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setComposer(null)}
                >
                  Cancel
                </Button>
              </div>
            </form>
          )}
          {jobs.length > 0 && (
            <ul className="artifact-jobs" aria-label="Saving">
              {jobs.map((job) => (
                <li key={job.id} className={job.error ? "has-error" : ""}>
                  {job.error ? (
                    <X size={14} />
                  ) : (
                    <Loader2 size={14} className="animate-spin" />
                  )}
                  <span>{job.label}</span>
                  <em role={job.error ? "alert" : undefined}>
                    {job.error || "Saving…"}
                  </em>
                  {job.error && (
                    <>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setJobs((list) =>
                            list.map((entry) =>
                              entry.id === job.id
                                ? { ...entry, error: undefined }
                                : entry,
                            ),
                          );
                          chain.current = chain.current.then(() => run(job));
                        }}
                      >
                        Retry
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`Dismiss ${job.label}`}
                        onClick={() =>
                          setJobs((list) =>
                            list.filter((entry) => entry.id !== job.id),
                          )
                        }
                      >
                        <X size={14} />
                      </Button>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
          <div className="tasks-toolbar artifact-toolbar section-toolbar">
            <div
              className="task-filters artifact-filters"
              role="group"
              aria-label="Artifact type"
            >
              {chips.map(([id, label, count]) => (
                <Button
                  key={id}
                  variant="ghost"
                  aria-pressed={kind === id}
                  onClick={() => setKind(id)}
                >
                  {label}
                  <span>{count}</span>
                </Button>
              ))}
            </div>
            <div className="artifact-type-select">
              <Select
                value={kind}
                onValueChange={(value) => setKind(value as Kind)}
              >
                <SelectTrigger aria-label="Artifact type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {chips.map(([id, label, count]) => (
                    <SelectItem key={id} value={id}>
                      {label} · {count ?? "…"}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="artifact-view-controls">
              <div className="task-search">
                <Search size={15} aria-hidden="true" />
                <Input
                  aria-label="Search artifacts"
                  placeholder="Search artifacts…"
                  value={query}
                  maxLength={300}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </div>
              <div
                className="artifact-layout-switch"
                role="group"
                aria-label="Artifact layout"
              >
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Grid view"
                  title="Grid view"
                  aria-pressed={layout === "grid"}
                  onClick={() => chooseLayout("grid")}
                >
                  <Grid2X2 size={17} />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="List view"
                  title="List view"
                  aria-pressed={layout === "list"}
                  onClick={() => chooseLayout("list")}
                >
                  <ListIcon size={17} />
                </Button>
              </div>
            </div>
          </div>
          {error && (
            <div className="tasks-error" role="alert">
              <p>{error}</p>
              <Button variant="outline" onClick={() => void load()}>
                Retry
              </Button>
            </div>
          )}
          {rows === undefined && !error ? (
            <LoadingState
              kind={layout === "grid" ? "gallery" : "artifact-list"}
              label="Loading artifacts"
            />
          ) : visible.length ? (
            <ArtifactGallery loading={loading} layout={layout}>
              {visible.map((item) => {
                const label = item.name || artifactLabel(item);
                return (
                  <li key={item.id} className={`artifact-card is-${item.kind}`}>
                    <button
                      className="artifact-open"
                      onClick={() => setViewing(item.id)}
                      aria-label={`Open ${label}`}
                    >
                      <ArtifactPreview
                        key={`${item.id}:${item.updatedAt}`}
                        item={item}
                      />
                      <span className="artifact-details">
                        <strong className="artifact-card-title" title={label}>
                          {label}
                        </strong>
                      </span>
                    </button>
                    <div className="artifact-card-footer">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="artifact-menu"
                            aria-label={`Actions for ${label}`}
                          >
                            <MoreHorizontal size={16} />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            onSelect={() =>
                              scheduleItem(
                                "artifact",
                                item.id,
                                item.name || item.title,
                              )
                            }
                          >
                            <ScheduleIcon size={15} />
                            Schedule
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onSelect={() => setViewing(item.id)}
                          >
                            <Search size={15} />
                            Open
                          </DropdownMenuItem>
                          {(item.kind === "text" || item.preview) && (
                            <DropdownMenuItem
                              onSelect={() => void copyOf(item)}
                            >
                              <Copy size={15} />
                              Copy text
                            </DropdownMenuItem>
                          )}
                          {item.kind !== "text" && (
                            <DropdownMenuItem asChild>
                              <a
                                href={`/api/v1/artifacts/${item.id}/file`}
                                download={item.name}
                              >
                                <Download size={15} />
                                Download
                              </a>
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuItem onSelect={() => void remove(item)}>
                            <Trash2 size={15} />
                            Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </li>
                );
              })}
            </ArtifactGallery>
          ) : (
            <div className="tasks-empty">
              {query ? (
                <Search size={28} strokeWidth={1.5} />
              ) : (
                <Layers size={30} strokeWidth={1.5} />
              )}
              <h2>{query ? "No matching artifacts" : "Nothing saved yet"}</h2>
              <p>
                {query
                  ? "Text inside images is searched once it has been read. Try another word."
                  : "Paste a screenshot or drop a file to start your collection."}
              </p>
            </div>
          )}
          {hasMore && rows !== undefined && (
            <div className="list-continuation">
              <Button
                variant="ghost"
                disabled={loadingMore}
                onClick={() => void loadMore()}
              >
                {loadingMore ? "Loading…" : "Load more artifacts"}
              </Button>
            </div>
          )}
          <p className="task-summary" aria-live="polite">
            {notice || " "}
          </p>
        </div>
      </div>
      <ArtifactViewer
        id={viewing}
        onClose={() => setViewing(null)}
        onChange={changed}
        onDeleted={removed}
      />
    </section>
  );
}
