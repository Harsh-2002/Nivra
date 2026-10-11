"use client";
import { ThemeMenu } from "./theme-menu";
import { LoadingState } from "./loading-state";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  FileText,
  Star,
  Trash2,
  Search,
  Plus,
  SlidersHorizontal as SettingsIcon,
  PanelLeftClose,
  Menu,
  MoreHorizontal,
  Pencil,
  ArrowUpDown,
  RefreshCw,
  Loader2,
  ArrowRight,
  Grid2X2,
  Heart,
  NotebookPen,
  CalendarDays,
  StickyNote,
  SquareCheckBig,
  LibraryBig,
  Layers,
  Trash,
  Zap,
  ClipboardList,
} from "lucide-react";
import { notify } from "@/lib/feedback";
import { Mark } from "./auth-screen";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "./ui/dialog";
import { Sheet, SheetContent, SheetTitle } from "./ui/sheet";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { api, apiItems, authRequest } from "@/lib/client";
import type {
  Note,
  NoteSummary,
  Owner,
  Settings,
  Tag,
  SearchResult,
} from "@/lib/types";
import { localDate } from "@/lib/dates";
import { GlobalSearch, type SearchHandle } from "./global-search";
import {
  QuickCapture,
  type CaptureHandle,
  type CapturedItem,
} from "./quick-capture";
import { NotePane } from "./note-pane";
import { useConfirm } from "./confirm-provider";
import { TagColorPicker } from "./tag-color-picker";
import type { TagColor } from "@/lib/tags";
import { SettingsPanel } from "./settings-panel";
import { BookmarksPanel } from "./bookmarks-panel";
import { OverviewPanel } from "./overview-panel";
import { ItemCollection } from "./item-collection";
import { FeedbackOutlet } from "./inline-feedback";
import { TrashPanel } from "./trash-panel";
import { CalendarPanel } from "./calendar-panel";
import { TasksWorkspace } from "./tasks-workspace";
import { ArtifactsPanel } from "./artifacts-panel";
import { FormWorkspace } from "./form-workspace";
import { useCompletion, useCompletionStream } from "@/lib/completion-client";
import { sectionCache } from "@/lib/section-cache";
import { matches, shortcuts } from "@/lib/shortcuts";
import { Shortcut, ShortcutKeys } from "./shortcut";
import {
  workspacePath,
  workspaceView,
  workspaceSurface,
  cleanWorkspaceUrl,
  type WorkspaceView,
} from "@/lib/workspace-routes";

export function Workspace({
  owner,
  initialSettings,
  initialView = "overview",
  onSignOut,
}: {
  owner: Owner;
  initialSettings: Settings;
  initialView?: WorkspaceView;
  onSignOut: () => void;
}) {
  useCompletionStream(onSignOut);
  const [notes, setNotes] = useState<NoteSummary[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [active, setActive] = useState<Note | null>(null);
  const [focusTerms, setFocusTerms] = useState<string[]>([]);
  const [view, setViewState] = useState<string>(() =>
    typeof window === "undefined"
      ? initialView
      : (workspaceView(window.location.pathname) ?? initialView),
  );
  const acceptedUrl = useRef(
    typeof window === "undefined"
      ? ""
      : workspaceSurface(window.location.pathname)
        ? new URL("/overview", window.location.href).href
        : window.location.href,
  );
  const routeSequence = useRef(0);
  const setView = useCallback((next: string) => {
    routeSequence.current++;
    setViewState(next);
    const url = new URL(window.location.href);
    const path = workspacePath(next);
    if (url.pathname !== path) {
      url.pathname = path;
      url.search = "";
      url.hash = "";
      window.history.pushState(null, "", url);
    }
    acceptedUrl.current = window.location.href;
  }, []);
  const [tag, setTag] = useState(() =>
    typeof window === "undefined"
      ? ""
      : new URL(window.location.href).searchParams.get("tag") || "",
  );
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState("updated");
  const [listScope, setListScope] = useState("");
  const loadedNotes = useRef<NoteSummary[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState("");
  const [error, setError] = useState("");
  const [opening, setOpening] = useState(false);
  const [sidebar, setSidebar] = useState(true);
  const [drawer, setDrawer] = useState(false);
  const [navigationContent, setNavigationContent] =
    useState<HTMLDivElement | null>(null);
  const navigationAction = useRef<(() => void) | null>(null);
  const tagMenuAction = useRef<(() => void) | null>(null);
  function afterNavigation(action: () => void, fromMenu = false) {
    if (!drawer) {
      if (fromMenu) tagMenuAction.current = action;
      else {
        tagMenuAction.current = null;
        action();
      }
      return;
    }
    navigationAction.current = action;
    setDrawer(false);
  }
  const [settingsOpen, setSettingsOpen] = useState(false);
  const globalSearch = useRef<SearchHandle>(null);
  const capture = useRef<CaptureHandle>(null);
  const captured = (result: CapturedItem) => {
    if (result.type === "note") void load();
    window.dispatchEvent(new CustomEvent("nivra:captured", { detail: result }));
  };
  const [sectionTarget, setSectionTarget] = useState<{
    query: string;
    completed?: boolean;
    focusCreate?: boolean;
    openId?: string;
  }>({ query: "" });
  const initialLink = useRef(false);
  const [tagDialog, setTagDialog] = useState<{
    id?: string;
    name: string;
    color?: TagColor;
    aliases?: string[];
    aliasesInput?: string;
  } | null>(null);
  const [tagBusy, setTagBusy] = useState(false);
  const confirm = useConfirm();
  const [generation, setGeneration] = useState(0);
  const guard = useRef<() => Promise<boolean>>(async () => true);
  const searchRef = useRef<HTMLInputElement>(null);
  const loadSequence = useRef(0);
  const registerGuard = useCallback((value: () => Promise<boolean>) => {
    guard.current = value;
  }, []);
  useEffect(() => {
    const handler = async (event: Event) => {
      const item = (
        event as CustomEvent<{ type: string; id: string; title: string }>
      ).detail;
      if (!(await guard.current())) return;
      setView("calendar");
      setTag("");
      setActive(null);
      setDrawer(false);
      guard.current = async () => true;
      const url = new URL(window.location.href);
      for (const key of ["note", "tag", "event", "occurrence"])
        url.searchParams.delete(key);
      url.searchParams.set("new", "1");
      url.searchParams.set("link", item.id);
      url.searchParams.set("linkType", item.type);
      url.searchParams.set("linkTitle", item.title);
      window.history.replaceState(null, "", url);
      acceptedUrl.current = url.href;
      setGeneration((n) => n + 1);
    };
    window.addEventListener("nivra:schedule", handler);
    return () => window.removeEventListener("nivra:schedule", handler);
  }, [setView]);
  useEffect(() => {
    const timer = setTimeout(() => setSearch(query), 180);
    return () => clearTimeout(timer);
  }, [query]);
  const load = useCallback(async () => {
    await Promise.resolve();
    const seq = ++loadSequence.current;
    setError("");
    setLoading(true);
    try {
      const params = new URLSearchParams({
        view,
        sort,
        q: search,
        limit: "61",
        preview: "1",
        ...(tag ? { tag } : {}),
      });
      const [list, allTags] = await Promise.all([
        ["all", "journal"].includes(view) && !tag
          ? apiItems<NoteSummary>(
              `${view === "journal" ? "journals" : "notes"}?${params}`,
            )
          : Promise.resolve([]),
        apiItems<Tag>("tags"),
      ]);
      if (seq === loadSequence.current) {
        const loaded = list.slice(0, 60);
        loadedNotes.current = loaded;
        setNotes(loaded);
        setListScope(`${view}|${tag}`);
        setHasMore(list.length > 60);
        setMoreError("");
        setLoadingMore(false);
        setTags(allTags);
      }
    } catch (e) {
      if (seq === loadSequence.current) setError((e as Error).message);
    } finally {
      if (seq === loadSequence.current) setLoading(false);
    }
  }, [view, tag, search, sort]);
  const completionRefresh = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  useCompletion("content", (event) => {
    if (event.kind && event.kind !== "content") return;
    clearTimeout(completionRefresh.current);
    completionRefresh.current = setTimeout(() => {
      void load();
    }, 150);
  });
  useEffect(() => () => clearTimeout(completionRefresh.current), [load]);
  const loadMore = async () => {
    if (loadingMore || loading || !hasMore || listScope !== `${view}|${tag}`)
      return;
    const seq = loadSequence.current;
    setLoadingMore(true);
    setMoreError("");
    try {
      const params = new URLSearchParams({
        view,
        sort,
        q: search,
        limit: "61",
        preview: "1",
        offset: String(notes.length),
        ...(tag ? { tag } : {}),
      });
      const list = await apiItems<NoteSummary>(
        `${view === "journal" ? "journals" : "notes"}?${params}`,
      );
      if (seq !== loadSequence.current) return;
      setNotes((previous) => [
        ...previous,
        ...list
          .slice(0, 60)
          .filter((note) => !previous.some((item) => item.id === note.id)),
      ]);
      setHasMore(list.length > 60);
    } catch (e) {
      if (seq === loadSequence.current) setMoreError((e as Error).message);
    } finally {
      if (seq === loadSequence.current) setLoadingMore(false);
    }
  };
  useEffect(() => {
    const timer = setTimeout(() => {
      void load();
    }, 0);
    return () => clearTimeout(timer);
  }, [load]);
  useEffect(() => {
    if (
      !["all", "journal"].includes(view) ||
      tag ||
      listScope !== `${view}|${tag}` ||
      search ||
      loading
    )
      return;
    // A list that no longer matches the last server copy was edited locally, so other cached sections are stale.
    if (notes !== loadedNotes.current) sectionCache.clear("notes:", "overview");
    sectionCache.set(`notes:${listScope}|${sort}`, { notes, hasMore });
  }, [notes, hasMore, listScope, view, tag, search, sort, loading]);
  useEffect(() => () => sectionCache.clear(), []);
  const onSaved = useCallback((note: Note) => {
    setNotes((previous) =>
      previous.map((n) => (n.id === note.id ? { ...n, ...note } : n)),
    );
  }, []);
  async function open(note: Pick<NoteSummary, "id">) {
    if (active?.id === note.id) return;
    if (!(await guard.current())) {
      notify.error("Save your current edits before switching notes.");
      return;
    }
    setOpening(true);
    try {
      setActive(await api<Note>(`notes/${note.id}`));
      setFocusTerms([]);
      setGeneration((n) => n + 1);
    } catch (e) {
      notify.error((e as Error).message);
    } finally {
      setOpening(false);
    }
  }
  const adopt = (note: Note) => {
    setFocusTerms([]);
    setView(note.dailyDate ? "journal" : "all");
    setTag("");
    setQuery("");
    setActive(note);
    setGeneration((n) => n + 1);
    void load();
  };
  async function create() {
    if (!(await guard.current())) {
      notify.error("Save your current edits before creating a note.");
      return false;
    }
    try {
      const note = await api<Note>("notes", { method: "POST", body: "{}" });
      setView("all");
      setTag("");
      setQuery("");
      setActive(note);
      setFocusTerms([]);
      setGeneration((n) => n + 1);
      setNotes((n) => [note, ...n]);
      setDrawer(false);
      return true;
    } catch (e) {
      notify.error((e as Error).message);
      return false;
    }
  }
  const back = async () => {
    if (await guard.current()) {
      setActive(null);
      guard.current = async () => true;
      void load();
    } else notify.error("Your edits haven’t been saved yet.");
  };
  const filter = async (next: string, tagId = "") => {
    if (!(await guard.current())) return false;
    const previous = new URL(window.location.href);
    notify.dismiss();
    setSectionTarget({ query: "" });
    setView(next);
    setTag(tagId);
    setActive(null);
    guard.current = async () => true;
    setDrawer(false);
    const url = new URL(window.location.href);
    url.searchParams.delete("note");
    if (tagId) url.searchParams.set("tag", tagId);
    else url.searchParams.delete("tag");
    if (url.href !== previous.href && url.pathname === previous.pathname)
      window.history.pushState(null, "", url);
    else window.history.replaceState(null, "", url);
    acceptedUrl.current = url.href;
    if (next === "forms") window.dispatchEvent(new Event("nivra:forms-route"));
    return true;
  };
  const navigateNote = useCallback(
    async (id: string, terms: string[] = [], requestedView?: WorkspaceView) => {
      if (!(await guard.current())) return false;
      try {
        const note = await api<Note>(`notes/${id}`);
        if (note.trashedAt) {
          notify.error(
            "This linked note is in trash. Restore it to open the connection.",
          );
          return false;
        }
        setView(
          requestedView &&
            ["all", "journal", "favorites"].includes(requestedView)
            ? requestedView
            : note.dailyDate
              ? "journal"
              : "all",
        );
        setTag("");
        setQuery("");
        setActive(note);
        setFocusTerms(terms);
        setGeneration((n) => n + 1);
        setDrawer(false);
        return true;
      } catch (e) {
        notify.error((e as Error).message);
        return false;
      }
    },
    [
      setGeneration,
      setActive,
      setFocusTerms,
      setView,
      setTag,
      setQuery,
      setDrawer,
    ],
  );
  useEffect(() => {
    if (initialLink.current) return;
    const id = new URL(window.location.href).searchParams.get("note");
    const requestedView = workspaceView(window.location.pathname) ?? undefined;
    const timer = setTimeout(() => {
      initialLink.current = true;
      if (id && /^[a-f0-9-]{36}$/.test(id))
        void navigateNote(id, [], requestedView);
    }, 0);
    return () => clearTimeout(timer);
  }, [navigateNote]);
  useEffect(() => {
    const url = cleanWorkspaceUrl(new URL(window.location.href));
    if (workspaceSurface(url.pathname)) return;
    if (view === "forms") return;
    url.pathname = workspacePath(view);
    if (active) url.searchParams.set("note", active.id);
    else url.searchParams.delete("note");
    if (tag) url.searchParams.set("tag", tag);
    else url.searchParams.delete("tag");
    window.history.replaceState(null, "", url);
    acceptedUrl.current = url.href;
  }, [active, view, tag]);
  useEffect(() => {
    const updated = () => {
      acceptedUrl.current = window.location.href;
    };
    window.addEventListener("nivra:route-updated", updated);
    return () => window.removeEventListener("nivra:route-updated", updated);
  }, []);
  useEffect(() => {
    const restore = () => {
      const target = new URL(window.location.href);
      if (
        workspaceSurface(target.pathname) ||
        target.href === acceptedUrl.current
      )
        return;
      const previous = acceptedUrl.current;
      const sequence = ++routeSequence.current;
      void (async () => {
        const allowed = await guard.current();
        if (sequence !== routeSequence.current) return;
        if (!allowed) {
          window.history.pushState(null, "", previous);
          notify.error("Your edits haven’t been saved yet.");
          return;
        }
        acceptedUrl.current = target.href;
        if (
          workspaceView(target.pathname) === "forms" &&
          workspaceView(new URL(previous).pathname) === "forms"
        ) {
          window.dispatchEvent(new Event("nivra:forms-route"));
          return;
        }
        if (
          workspaceView(target.pathname) === "tasks" &&
          workspaceView(new URL(previous).pathname) === "tasks"
        ) {
          window.dispatchEvent(new Event("nivra:tasks-route"));
          return;
        }
        notify.dismiss();
        setViewState(workspaceView(target.pathname) ?? "overview");
        if (workspaceView(target.pathname) === "forms")
          window.dispatchEvent(new Event("nivra:forms-route"));
        if (workspaceView(target.pathname) === "calendar")
          setGeneration((n) => n + 1);
        setTag(target.searchParams.get("tag") || "");
        setQuery("");
        setSectionTarget({ query: "" });
        setActive(null);
        setDrawer(false);
        guard.current = async () => true;
        const id = target.searchParams.get("note");
        if (id && /^[a-f0-9-]{36}$/.test(id))
          await navigateNote(
            id,
            [],
            workspaceView(target.pathname) ?? undefined,
          );
      })();
    };
    const tasksNavigation = () => {
      acceptedUrl.current = window.location.href;
    };
    window.addEventListener("nivra:tasks-navigation", tasksNavigation);
    window.addEventListener("popstate", restore);
    return () => {
      window.removeEventListener("popstate", restore);
      window.removeEventListener("nivra:tasks-navigation", tasksNavigation);
    };
  }, [navigateNote]);
  async function today() {
    if (!(await guard.current())) return false;
    try {
      const note = await api<Note>("journals", {
        method: "POST",
        body: JSON.stringify({ date: localDate() }),
      });
      adopt(note);
      setDrawer(false);
      return true;
    } catch (e) {
      notify.error((e as Error).message);
      return false;
    }
  }
  async function selectResult(result: SearchResult) {
    if (result.type === "form" || result.type === "response") {
      if (!(await filter("forms"))) return false;
      const url = new URL(
        result.type === "response"
          ? `/forms/${result.formId}/responses/${result.id}`
          : `/forms/${result.id}/build`,
        window.location.href,
      );
      window.history.replaceState(null, "", url);
      acceptedUrl.current = url.href;
      window.dispatchEvent(new Event("nivra:forms-route"));
      return true;
    }
    if (result.type === "note")
      return navigateNote(result.id, result.matchTerms);
    if (result.type === "event") {
      if (!(await filter("calendar"))) return false;
      const url = new URL(window.location.href);
      url.searchParams.set("event", result.id);
      window.history.replaceState(null, "", url);
      setGeneration((n) => n + 1);
      return true;
    }
    if (result.type === "artifact") {
      if (!(await filter("artifacts"))) return false;
      setSectionTarget({ query: "", openId: result.id });
      setGeneration((n) => n + 1);
      return true;
    }
    if (!(await filter(result.type === "task" ? "tasks" : "bookmarks")))
      return false;
    setSectionTarget({ query: result.title, completed: result.completed });
    setGeneration((n) => n + 1);
    return true;
  }
  async function searchCommand(
    command: "note" | "task" | "bookmark" | "daily",
  ) {
    if (command === "note") return create();
    if (command === "daily") return today();
    if (!(await filter(command === "task" ? "tasks" : "bookmarks")))
      return false;
    setSectionTarget({ query: "", focusCreate: true });
    setGeneration((n) => n + 1);
    return true;
  }
  async function logout() {
    await authRequest("sign-out", {});
    sectionCache.clear();
    onSignOut();
  }
  useEffect(() => {
    const keyboard = (e: KeyboardEvent) => {
      if (matches(e, shortcuts.search)) {
        e.preventDefault();
        setDrawer(false);
        globalSearch.current?.toggle();
      }
      if (view !== "trash" && matches(e, shortcuts.newNote)) {
        e.preventDefault();
        void create();
      }
      if (matches(e, shortcuts.capture)) {
        if (
          document.querySelector(
            '[data-slot="dialog-content"],[data-slot="alert-dialog-content"]',
          )
        )
          return;
        e.preventDefault();
        setDrawer(false);
        capture.current?.open();
      }
    };
    window.addEventListener("keydown", keyboard);
    return () => window.removeEventListener("keydown", keyboard);
  });
  async function saveTag(e: React.FormEvent) {
    e.preventDefault();
    if (!tagDialog) return;
    setTagBusy(true);
    try {
      await api(tagDialog.id ? `tags/${tagDialog.id}` : "tags", {
        method: tagDialog.id ? "PATCH" : "POST",
        body: JSON.stringify({
          name: tagDialog.name,
          color: tagDialog.color || "gray",
          aliases: (
            tagDialog.aliasesInput ??
            tagDialog.aliases?.join(",") ??
            ""
          )
            .split(",")
            .map((word) => word.trim())
            .filter(Boolean),
        }),
      });
      setTagDialog(null);
      sectionCache.clear();
      await load();
      window.dispatchEvent(new Event("nivra:tags-changed"));
    } catch (e) {
      notify.error((e as Error).message);
    } finally {
      setTagBusy(false);
    }
  }
  async function deleteTag(item: Tag) {
    if (
      !(await confirm({
        title: `Delete “${item.name}”?`,
        description: "The tag will be removed. Your items will be kept.",
        action: "Delete tag",
      }))
    )
      return;
    if (!(await guard.current())) return;
    try {
      await api(`tags/${item.id}`, { method: "DELETE" });
      sectionCache.clear();
      if (tag === item.id) await filter(view);
      if (active) adopt(await api<Note>(`notes/${active.id}`));
      await load();
      window.dispatchEvent(new Event("nivra:tags-changed"));
      if (tag === item.id && window.innerWidth < 1024)
        requestAnimationFrame(() => {
          if (document.activeElement !== document.body) return;
          document
            .querySelector<HTMLElement>(
              '.workspace button[aria-label="Open navigation"]',
            )
            ?.focus({ preventScroll: true });
        });
    } catch (e) {
      notify.error((e as Error).message);
    }
  }
  const navigation = (
    <div className="navigation">
      <header className="workspace-brand">
        <Mark small />
        <span>Nivra</span>
      </header>
      <div
        className="navigation-scroll"
        tabIndex={0}
        role="region"
        aria-label="Navigation links"
      >
        <button
          className="nav-item workspace-search"
          aria-label="Search"
          onClick={() => {
            setDrawer(false);
            globalSearch.current?.open();
          }}
        >
          <Search size={16} />
          Search
          <Shortcut chord={shortcuts.search} className="nav-shortcut" />
        </button>
        <nav aria-label="Workspace navigation">
          {[
            { id: "overview", label: "Overview", Icon: Grid2X2 },
            { id: "favorites", label: "Favorites", Icon: Heart },
            { id: "all", label: "Notes", Icon: StickyNote },
            { id: "journal", label: "Journal", Icon: NotebookPen },
            { id: "tasks", label: "Tasks", Icon: SquareCheckBig },
            { id: "calendar", label: "Calendar", Icon: CalendarDays },
            { id: "bookmarks", label: "Bookmarks", Icon: LibraryBig },
            { id: "artifacts", label: "Artifacts", Icon: Layers },
            { id: "forms", label: "Forms", Icon: ClipboardList },
            { id: "trash", label: "Trash", Icon: Trash },
          ].map(({ id, label, Icon }) => (
            <button
              key={id}
              className={`nav-item ${view === id && !tag ? "active" : ""}`}
              aria-current={view === id && !tag ? "page" : undefined}
              onClick={() => void filter(id)}
            >
              <Icon size={18} strokeWidth={1.6} />
              {label}
            </button>
          ))}
        </nav>
        <div className="tags-heading">
          <span>Tags</span>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Create tag"
            onClick={() => afterNavigation(() => setTagDialog({ name: "" }))}
          >
            <Plus size={14} />
          </Button>
        </div>
        <div className="tag-navigation">
          {tags.map((item) => (
            <div
              key={item.id}
              className={`tag-nav-row ${tag === item.id ? "active" : ""}`}
            >
              <button onClick={() => void filter("all", item.id)}>
                <span className="tag-dot" data-color={item.color} />
                <span>{item.name}</span>
              </button>
              <DropdownMenu modal={false}>
                <DropdownMenuTrigger asChild>
                  <button
                    aria-label={`Actions for ${item.name}`}
                    className="tag-menu"
                  >
                    <MoreHorizontal size={14} />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="start"
                  portalContainer={drawer ? navigationContent : undefined}
                  onCloseAutoFocus={() => {
                    const action = tagMenuAction.current;
                    tagMenuAction.current = null;
                    if (action) requestAnimationFrame(action);
                  }}
                >
                  <DropdownMenuItem
                    onSelect={() =>
                      afterNavigation(() => setTagDialog(item), true)
                    }
                  >
                    <Pencil size={14} />
                    Edit tag
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() =>
                      afterNavigation(() => void deleteTag(item), true)
                    }
                  >
                    <Trash2 size={14} />
                    Delete tag
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          ))}
          {!tags.length && (
            <button
              className="empty-tags"
              onClick={() => afterNavigation(() => setTagDialog({ name: "" }))}
            >
              Give your ideas a little order.
              <br />
              <span>Create your first tag</span>
            </button>
          )}
        </div>
      </div>
      <div className="navigation-bottom">
        <button
          className="nav-item"
          onClick={() => {
            setDrawer(false);
            capture.current?.open();
          }}
        >
          <Zap size={16} />
          Quick
          <Shortcut chord={shortcuts.capture} className="nav-shortcut" />
        </button>
        <footer className="navigation-footer">
          <button
            className="nav-item"
            onClick={() => {
              setDrawer(false);
              setSettingsOpen(true);
            }}
          >
            <SettingsIcon size={16} />
            Settings
          </button>
          <ThemeMenu />
          <Button
            variant="ghost"
            size="icon"
            aria-label="Collapse sidebar"
            className="collapse-sidebar"
            onClick={() => setSidebar(false)}
          >
            <PanelLeftClose size={16} />
          </Button>
        </footer>
      </div>
    </div>
  );
  const title = tag
    ? tags.find((t) => t.id === tag)?.name || "Tagged items"
    : view === "favorites"
      ? "Favorites"
      : view === "trash"
        ? "Trash"
        : view === "journal"
          ? "Journal"
          : "All notes";
  const scope = `${view}|${tag}`;
  const cachedList = search
    ? undefined
    : sectionCache.get<{ notes: NoteSummary[]; hasMore: boolean }>(
        `notes:${scope}|${sort}`,
      );
  const listReady = listScope === scope;
  const shownNotes = listReady ? notes : cachedList?.notes;
  const shownHasMore = listReady ? hasMore : !!cachedList?.hasMore;
  const rows = shownNotes ?? [];
  return (
    <main
      id="workspace-content"
      className={`workspace ${active ? "has-note" : ""} ${sidebar ? "" : "rail-hidden"}`}
    >
      <a
        className="skip-link"
        href="#workspace-content"
        onClick={(event) => {
          event.preventDefault();
          const content = Array.from(
            event.currentTarget.parentElement?.querySelectorAll<HTMLElement>(
              ".note-pane, .section-content, .notes-list, .schedule-scroll",
            ) ?? [],
          ).find((element) => element.getClientRects().length > 0);
          if (content) {
            content.tabIndex = -1;
            content.focus({ preventScroll: true });
          }
        }}
      >
        Skip to content
      </a>
      {sidebar && <aside className="desktop-navigation">{navigation}</aside>}
      <Sheet open={drawer} onOpenChange={setDrawer}>
        <SheetContent
          ref={setNavigationContent}
          side="left"
          className="mobile-navigation"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            const action = navigationAction.current;
            navigationAction.current = null;
            if (
              !action &&
              document.querySelector(
                '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]',
              )
            )
              return;
            document
              .querySelector<HTMLElement>(
                '.workspace button[aria-label="Open navigation"]',
              )
              ?.focus({ preventScroll: true });
            if (action) requestAnimationFrame(action);
          }}
        >
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          {navigation}
        </SheetContent>
      </Sheet>
      {view === "overview" ? (
        <OverviewPanel
          onNavigation={() =>
            window.innerWidth < 1024 ? setDrawer(true) : setSidebar(true)
          }
          onOpenNote={navigateNote}
          onSection={(section, query = "") => {
            void filter(section).then((changed) => {
              if (changed) {
                setSectionTarget({ query });
                setGeneration((n) => n + 1);
              }
            });
          }}
          onCreate={(kind) => void searchCommand(kind)}
        />
      ) : view === "calendar" ? (
        <CalendarPanel
          key={generation}
          registerGuard={registerGuard}
          onWriteJournal={async (date) => {
            if (!(await guard.current())) return;
            adopt(
              await api<Note>("journals", {
                method: "POST",
                body: JSON.stringify({ date }),
              }),
            );
          }}
          onNavigation={() =>
            window.innerWidth < 1024 ? setDrawer(true) : setSidebar(true)
          }
          onOpenItem={(item) => {
            if (item.type === "form") {
              void filter("forms").then((changed) => {
                if (!changed) return;
                const url = new URL(
                  `/forms/${item.sourceId}/${item.label === "Closes" ? "share" : "responses"}`,
                  window.location.href,
                );
                if (item.id.startsWith("form-responses:")) {
                  url.searchParams.set("date", item.date);
                  url.searchParams.set(
                    "timezone",
                    Intl.DateTimeFormat().resolvedOptions().timeZone,
                  );
                }
                window.history.replaceState(null, "", url);
                acceptedUrl.current = url.href;
                window.dispatchEvent(new Event("nivra:forms-route"));
              });
              return;
            }
            if (item.type === "note" || item.type === "journal")
              void navigateNote(
                item.sourceId,
                [],
                item.type === "journal" ? "journal" : "all",
              );
            else
              void filter(
                item.type === "task"
                  ? "tasks"
                  : item.type === "bookmark"
                    ? "bookmarks"
                    : "artifacts",
              ).then((changed) => {
                if (changed) {
                  setSectionTarget({
                    query: item.title,
                    completed: item.completed,
                    openId: item.sourceId,
                  });
                  setGeneration((n) => n + 1);
                }
              });
          }}
        />
      ) : view === "forms" ? (
        <FormWorkspace
          registerGuard={registerGuard}
          onNavigation={() =>
            window.innerWidth < 1024 ? setDrawer(true) : setSidebar(true)
          }
        />
      ) : view === "tasks" ? (
        <TasksWorkspace
          key={generation}
          registerGuard={registerGuard}
          initialQuery={sectionTarget.query}
          initialTaskId={sectionTarget.openId}
          initialFilter={sectionTarget.completed ? "completed" : "open"}
          focusCreate={sectionTarget.focusCreate}
          onOpenNote={navigateNote}
          onNavigation={() =>
            window.innerWidth < 1024 ? setDrawer(true) : setSidebar(true)
          }
        />
      ) : view === "bookmarks" ? (
        <BookmarksPanel
          key={generation}
          registerGuard={registerGuard}
          initialQuery={sectionTarget.query}
          focusCreate={sectionTarget.focusCreate}
          onOpenNote={navigateNote}
          onNavigation={() =>
            window.innerWidth < 1024 ? setDrawer(true) : setSidebar(true)
          }
        />
      ) : view === "trash" ? (
        <TrashPanel
          onNavigation={() =>
            window.innerWidth < 1024 ? setDrawer(true) : setSidebar(true)
          }
        />
      ) : view === "artifacts" ? (
        <ArtifactsPanel
          key={generation}
          registerGuard={registerGuard}
          initialQuery={sectionTarget.query}
          openId={sectionTarget.openId}
          onNavigation={() =>
            window.innerWidth < 1024 ? setDrawer(true) : setSidebar(true)
          }
        />
      ) : (tag || view === "favorites") && !active ? (
        <ItemCollection
          key={tag || "favorites"}
          tag={tag || undefined}
          title={title}
          onOpen={(item) =>
            item.type === "note"
              ? void open(item)
              : void selectResult({
                  ...item,
                  matchTerms: [],
                  excerpt: item.excerpt,
                })
          }
          opening={opening}
          onNavigation={() =>
            window.innerWidth < 1024 ? setDrawer(true) : setSidebar(true)
          }
        />
      ) : (
        <>
          {!tag && view !== "favorites" && (
            <section className="notes-list">
              <FeedbackOutlet />
              <header className="list-header">
                <div>
                  <h1>{title}</h1>
                  <span
                    className={`note-count ${shownNotes ? "" : "is-pending"}`}
                  >
                    {rows.length}
                    {shownHasMore ? "+" : ""}
                  </span>
                </div>
                {view === "journal" && (
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Write today’s entry"
                    title="Write today’s entry"
                    onClick={() => void today()}
                  >
                    <Plus size={16} />
                  </Button>
                )}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" aria-label="Sort notes">
                      <ArrowUpDown size={15} />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {[
                      { value: "updated", label: "Last edited" },
                      { value: "created", label: "Date created" },
                      { value: "title", label: "Title" },
                    ].map((item) => (
                      <DropdownMenuItem
                        key={item.value}
                        onSelect={() => setSort(item.value)}
                      >
                        {item.label}
                        {sort === item.value && (
                          <span className="ml-auto">✓</span>
                        )}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
                <Button
                  variant="ghost"
                  size="icon"
                  className="menu-toggle"
                  aria-label="Open navigation"
                  onClick={() =>
                    window.innerWidth < 1024
                      ? setDrawer(true)
                      : setSidebar(true)
                  }
                >
                  <Menu size={18} />
                </Button>
              </header>
              <p className="list-description">
                {view === "journal"
                  ? "One entry for each day you write."
                  : "Write and organize your ideas."}
              </p>
              <div className="search-field">
                <Search size={15} />
                <Input
                  ref={searchRef}
                  aria-label={
                    view === "journal"
                      ? "Search journal entries"
                      : "Search notes"
                  }
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={
                    view === "journal"
                      ? "Search journal entries…"
                      : "Search your notes…"
                  }
                />
              </div>
              <div
                className="note-list-scroll"
                tabIndex={0}
                role="region"
                aria-label={
                  view === "journal" ? "Journal entries" : "Note list"
                }
              >
                {error ? (
                  <div className="list-empty">
                    <p role="alert">{error}</p>
                    <Button variant="outline" size="sm" onClick={load}>
                      <RefreshCw size={14} />
                      Try again
                    </Button>
                  </div>
                ) : shownNotes === undefined ? (
                  <LoadingState
                    kind="notes"
                    label={`Loading ${view === "journal" ? "journal entries" : "notes"}`}
                  />
                ) : !rows.length ? (
                  <div className="list-empty">
                    {view === "journal" ? (
                      <NotebookPen size={25} />
                    ) : (
                      <FileText size={25} />
                    )}
                    <h2>
                      {query
                        ? view === "journal"
                          ? "No matching journal entries"
                          : "No matching notes"
                        : view === "journal"
                          ? "Your journal is empty"
                          : "A fresh page awaits"}
                    </h2>
                    <p>
                      {query
                        ? "Try a different word."
                        : view === "journal"
                          ? "One entry for each day you write."
                          : "Start with a thought. The rest will follow."}
                    </p>
                    {view === "all" && !query && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void create()}
                      >
                        <Plus size={14} />
                        Create a note
                      </Button>
                    )}
                    {view === "journal" && !query && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void today()}
                      >
                        <Plus size={14} />
                        Write today’s entry
                      </Button>
                    )}
                  </div>
                ) : (
                  rows.map((note) => (
                    <button
                      className={`note-list-item ${active?.id === note.id ? "selected" : ""}`}
                      key={note.id}
                      onClick={() => void open(note)}
                    >
                      <div>
                        <strong>{note.title || "Untitled"}</strong>
                        {note.favorite && (
                          <Star size={12} fill="currentColor" />
                        )}
                      </div>
                      <p>
                        {note.text.replace(/\s+/g, " ").slice(0, 110) ||
                          "An idea waiting to happen…"}
                      </p>
                      <footer>
                        <time>
                          {new Date(note.updatedAt).toLocaleDateString(
                            undefined,
                            {
                              month: "short",
                              day: "numeric",
                            },
                          )}
                        </time>
                        {note.tags.slice(0, 2).map((tag) => (
                          <span key={tag.id}>
                            <span className="tag-dot" data-color={tag.color} />
                            <span className="tag-name">{tag.name}</span>
                          </span>
                        ))}
                      </footer>
                    </button>
                  ))
                )}
                {!error && shownHasMore && (
                  <div className="note-list-more">
                    {moreError && <p role="alert">{moreError}</p>}
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={loading || loadingMore}
                      onClick={() => void loadMore()}
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
            </section>
          )}
          {active ? (
            <NotePane
              key={`${active.id}-${generation}`}
              initial={active}
              focusTerms={focusTerms}
              onCapture={() => capture.current?.open()}
              tags={tags}
              onSaved={onSaved}
              backLabel={
                tag
                  ? "Back to tagged items"
                  : view === "favorites"
                    ? "Back to favorites"
                    : view === "journal"
                      ? "Back to journal"
                      : "Back to notes"
              }
              onBack={() => void back()}
              onOpen={adopt}
              onDeleted={() => {
                setActive(null);
                guard.current = async () => true;
                void load();
              }}
              registerGuard={registerGuard}
              onNavigateNote={navigateNote}
              onNavigateItem={selectResult}
            />
          ) : (
            <section className="workspace-empty">
              {opening ? (
                <Loader2 className="animate-spin" aria-label="Opening note" />
              ) : (
                <>
                  <div className="empty-illustration">
                    {view === "journal" ? (
                      <NotebookPen size={38} strokeWidth={1} />
                    ) : (
                      <FileText size={38} strokeWidth={1} />
                    )}
                  </div>
                  <h2>
                    {view === "journal"
                      ? "Your journal, one day at a time."
                      : "Room for your next idea."}
                  </h2>
                  <p>
                    {view === "journal"
                      ? "Open an entry to reflect, or start today’s journal."
                      : "Pick a note to keep going, or start something new."}
                  </p>
                  <Button
                    variant="outline"
                    onClick={() =>
                      view === "journal" ? void today() : void create()
                    }
                  >
                    {view === "journal"
                      ? "Create journal entry"
                      : "Create a note"}
                    <ArrowRight size={15} />
                  </Button>
                  {view !== "journal" && (
                    <span className="shortcut-hint">
                      <ShortcutKeys chord={shortcuts.newNote} />
                      <span>to create a note</span>
                    </span>
                  )}
                </>
              )}
            </section>
          )}
        </>
      )}
      <Dialog
        open={!!tagDialog}
        onOpenChange={(open) => {
          if (!open) setTagDialog(null);
        }}
      >
        <DialogContent
          onCloseAutoFocus={(event) => {
            if (window.innerWidth >= 1024) return;
            event.preventDefault();
            document
              .querySelector<HTMLElement>(
                '.workspace button[aria-label="Open navigation"]',
              )
              ?.focus({ preventScroll: true });
          }}
        >
          <DialogTitle>
            {tagDialog?.id ? "Edit tag" : "Create a tag"}
          </DialogTitle>
          <DialogDescription>
            A simple way to connect related ideas.
          </DialogDescription>
          <form className="space-y-4" onSubmit={saveTag}>
            <Input
              aria-label="Tag name"
              autoFocus
              maxLength={50}
              required
              value={tagDialog?.name || ""}
              onChange={(e) =>
                setTagDialog((previous) =>
                  previous ? { ...previous, name: e.target.value } : previous,
                )
              }
              placeholder="e.g. Personal, Projects, Reading"
            />
            <div className="field">
              <Label htmlFor="tag-aliases">
                Matching words{" "}
                <span className="text-muted-foreground">(optional)</span>
              </Label>
              <Input
                id="tag-aliases"
                aria-describedby="tag-aliases-hint"
                maxLength={830}
                value={
                  tagDialog?.aliasesInput ??
                  tagDialog?.aliases?.join(", ") ??
                  ""
                }
                placeholder="e.g. SQLite, queries, indexes"
                onChange={(event) =>
                  setTagDialog((previous) =>
                    previous
                      ? { ...previous, aliasesInput: event.target.value }
                      : previous,
                  )
                }
              />
              <p className="field-hint" id="tag-aliases-hint">
                Up to 10 words or phrases, separated by commas. Helps tag
                suggestions match your vocabulary.
              </p>
            </div>
            <TagColorPicker
              value={tagDialog?.color || "gray"}
              onChange={(color) =>
                setTagDialog((previous) =>
                  previous ? { ...previous, color } : previous,
                )
              }
            />
            <Button type="submit" disabled={tagBusy}>
              {tagBusy && <Loader2 size={14} className="animate-spin" />}
              {tagDialog?.id ? "Save tag" : "Create tag"}
            </Button>
          </form>
        </DialogContent>
      </Dialog>
      <GlobalSearch ref={globalSearch} onSelect={selectResult} />
      <QuickCapture ref={capture} onCaptured={captured} />
      <SettingsPanel
        onSelect={selectResult}
        open={settingsOpen}
        onOpen={() => setSettingsOpen(true)}
        onClose={() => setSettingsOpen(false)}
        owner={owner}
        initial={initialSettings}
        onSignOut={logout}
        beforeAction={() => guard.current()}
        onImported={async () => {
          sectionCache.clear();
          await load();
          if (view === "tasks" || view === "bookmarks")
            setGeneration((value) => value + 1);
        }}
      />
    </main>
  );
}
