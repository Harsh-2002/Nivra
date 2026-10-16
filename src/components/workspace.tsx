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
  ChevronLeft,
  ChevronRight,
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
  LayoutTemplate,
  Tags,
} from "lucide-react";
import { notify } from "@/lib/feedback";
import { Mark } from "./auth-screen";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { DatePicker } from "./date-picker";
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
  JournalPeriod,
} from "@/lib/types";
import { localDate, validDate } from "@/lib/dates";
import { GlobalSearch, type SearchHandle } from "./global-search";
import {
  QuickCapture,
  type CaptureHandle,
  type CapturedItem,
} from "./quick-capture";
import { NotePane } from "./note-pane";
import type { TemplateSource } from "./templates-panel";
import { useConfirm } from "./confirm-provider";
import { TagColorPicker } from "./tag-color-picker";
import type { TagColor } from "@/lib/tags";
import { SettingsPanel } from "./settings-panel";
import { OverviewPanel } from "./overview-panel";
import { ItemCollection } from "./item-collection";
import { NavigationIcon } from "./navigation-icon";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import { FeedbackOutlet } from "./inline-feedback";
import {
  ArtifactsPanel,
  BookmarksPanel,
  CalendarPanel,
  FormWorkspace,
  TagSuggestionsPanel,
  TasksWorkspace,
  TemplatesPanel,
  TrashPanel,
  preloadPanel,
} from "./lazy-panels";
import { useCompletion, useCompletionStream } from "@/lib/completion-client";
import { sectionCache } from "@/lib/section-cache";
import { matches, shortcuts } from "@/lib/shortcuts";
import { Shortcut, ShortcutKeys } from "./shortcut";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "./ui/tooltip";
import {
  workspacePath,
  workspaceView,
  workspaceSurface,
  cleanWorkspaceUrl,
  type WorkspaceView,
} from "@/lib/workspace-routes";

function NavigationTooltip({
  enabled,
  label,
  children,
}: {
  enabled: boolean;
  label: string;
  children: React.ReactElement;
}) {
  const [tooltipState, setTooltipState] = useState({ enabled, open: false });
  if (tooltipState.enabled !== enabled) {
    setTooltipState({ enabled, open: false });
  }
  return (
    <Tooltip
      open={enabled && tooltipState.open}
      onOpenChange={(nextOpen) =>
        setTooltipState({ enabled, open: enabled && nextOpen })
      }
    >
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      {enabled && (
        <TooltipContent side="right" sideOffset={8}>
          {label}
        </TooltipContent>
      )}
    </Tooltip>
  );
}

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
  const [journalPeriod, setJournalPeriodState] = useState<JournalPeriod>(() => {
    if (typeof window === "undefined") return "daily";
    const value = new URL(window.location.href).searchParams.get("period");
    return value === "weekly" || value === "monthly" ? value : "daily";
  });
  const [journalDate, setJournalDateState] = useState(() => {
    if (typeof window === "undefined") return localDate();
    const value = new URL(window.location.href).searchParams.get("date");
    return value && validDate(value) ? value : localDate();
  });
  const journalPeriodRef = useRef(journalPeriod);
  const journalDateRef = useRef(journalDate);
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
      if (next === "journal") {
        url.searchParams.set("period", journalPeriodRef.current);
        url.searchParams.set("date", journalDateRef.current);
      }
      window.history.pushState(null, "", url);
    }
    acceptedUrl.current = window.location.href;
  }, []);
  const updateJournalContext = useCallback(
    (period: JournalPeriod, date: string) => {
      journalPeriodRef.current = period;
      journalDateRef.current = date;
      setJournalPeriodState(period);
      setJournalDateState(date);
      routeSequence.current++;
      setViewState("journal");
      const url = new URL(window.location.href);
      url.pathname = workspacePath("journal");
      url.searchParams.delete("note");
      url.searchParams.delete("tag");
      url.searchParams.set("period", period);
      url.searchParams.set("date", date);
      window.history.pushState(null, "", url);
      acceptedUrl.current = url.href;
    },
    [],
  );
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
  const journalNext = useRef<string | null>(null);
  const [moreError, setMoreError] = useState("");
  const [error, setError] = useState("");
  const [opening, setOpening] = useState(false);
  const [sidebar, setSidebar] = useState(true);
  const [drawer, setDrawer] = useState(false);
  const [navigationContent, setNavigationContent] =
    useState<HTMLDivElement | null>(null);
  const desktopNavigation = useRef<HTMLElement>(null);
  const navigationAction = useRef<(() => void) | null>(null);
  const tagMenuAction = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (sidebar || !tag) return;
    const navigation = desktopNavigation.current;
    if (!navigation || !navigation.getClientRects().length) return;
    let frame = 0;
    let previousWidth = Number.NaN;
    let stableFrames = 0;
    const revealSelectedTag = () => {
      const width = navigation.getBoundingClientRect().width;
      if (width > 64.5 || width !== previousWidth) {
        previousWidth = width;
        stableFrames = 0;
        frame = window.requestAnimationFrame(revealSelectedTag);
        return;
      }
      if (stableFrames < 2) {
        stableFrames += 1;
        frame = window.requestAnimationFrame(revealSelectedTag);
        return;
      }
      const scrollArea =
        navigation?.querySelector<HTMLElement>(".navigation-scroll");
      const selectedTag = navigation?.querySelector<HTMLElement>(
        ".tag-nav-row.active",
      );
      if (!scrollArea || !selectedTag || !scrollArea.clientHeight) return;
      const tagScrollArea = selectedTag.closest<HTMLElement>(".tag-navigation");
      if (tagScrollArea?.clientHeight) {
        const area = tagScrollArea.getBoundingClientRect();
        const row = selectedTag.getBoundingClientRect();
        const top = area.top + tagScrollArea.clientTop;
        const bottom = top + tagScrollArea.clientHeight;
        if (row.bottom > bottom) tagScrollArea.scrollTop += row.bottom - bottom;
        else if (row.top < top) tagScrollArea.scrollTop -= top - row.top;
      }
      const area = scrollArea.getBoundingClientRect();
      const row = selectedTag.getBoundingClientRect();
      const top = area.top + scrollArea.clientTop;
      const bottom = top + scrollArea.clientHeight;
      if (row.bottom > bottom) scrollArea.scrollTop += row.bottom - bottom;
      else if (row.top < top) scrollArea.scrollTop -= top - row.top;
    };
    frame = window.requestAnimationFrame(revealSelectedTag);
    return () => window.cancelAnimationFrame(frame);
  }, [sidebar, tag, tags.length]);
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
  const loadRequest = useRef<AbortController | null>(null);
  const loadMounted = useRef(true);
  useEffect(() => {
    loadMounted.current = true;
    return () => {
      loadMounted.current = false;
      loadRequest.current?.abort();
    };
  }, []);
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
    if (!loadMounted.current) return;
    const seq = ++loadSequence.current;
    loadRequest.current?.abort();
    const controller = new AbortController();
    loadRequest.current = controller;
    setError("");
    setLoading(true);
    try {
      const isJournalList = view === "journal" && !tag;
      const params = new URLSearchParams(
        isJournalList
          ? {
              period: journalPeriod,
              limit: "60",
              ...(search ? { q: search } : {}),
            }
          : {
              view,
              sort,
              q: search,
              limit: "61",
              preview: "1",
              ...(tag ? { tag } : {}),
            },
      );
      const [listResult, allTags] = await Promise.all([
        isJournalList
          ? api<{ items: NoteSummary[]; next: string | null }>(
              `journals?${params}`,
              { signal: controller.signal },
            )
          : view === "all" && !tag
            ? apiItems<NoteSummary>(`notes?${params}`, {
                signal: controller.signal,
              })
            : Promise.resolve(null),
        apiItems<Tag>("tags", { signal: controller.signal }),
      ]);
      if (
        loadMounted.current &&
        !controller.signal.aborted &&
        seq === loadSequence.current
      ) {
        const list = Array.isArray(listResult)
          ? listResult
          : (listResult?.items ?? []);
        if (isJournalList && !Array.isArray(listResult))
          journalNext.current = listResult?.next ?? null;
        else journalNext.current = null;
        const loaded = list.slice(0, 60);
        loadedNotes.current = loaded;
        setNotes(loaded);
        setListScope(
          view === "journal"
            ? `${view}|${tag}|${journalPeriod}`
            : `${view}|${tag}`,
        );
        setHasMore(
          isJournalList && !Array.isArray(listResult)
            ? !!listResult?.next
            : list.length > 60,
        );
        setMoreError("");
        setLoadingMore(false);
        setTags(allTags);
      }
    } catch (e) {
      if (
        loadMounted.current &&
        !controller.signal.aborted &&
        seq === loadSequence.current
      )
        setError((e as Error).message);
    } finally {
      if (
        loadMounted.current &&
        !controller.signal.aborted &&
        seq === loadSequence.current
      )
        setLoading(false);
    }
  }, [view, tag, search, sort, journalPeriod]);
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
    const currentListScope =
      view === "journal" ? `${view}|${tag}|${journalPeriod}` : `${view}|${tag}`;
    if (loadingMore || loading || !hasMore || listScope !== currentListScope)
      return;
    const seq = loadSequence.current;
    const controller = loadRequest.current;
    setLoadingMore(true);
    setMoreError("");
    try {
      const isJournalList = view === "journal" && !tag;
      const params = new URLSearchParams(
        isJournalList
          ? {
              period: journalPeriod,
              limit: "60",
              ...(journalNext.current ? { after: journalNext.current } : {}),
              ...(search ? { q: search } : {}),
            }
          : {
              view,
              sort,
              q: search,
              limit: "61",
              preview: "1",
              offset: String(notes.length),
              ...(tag ? { tag } : {}),
            },
      );
      const listResult = isJournalList
        ? await api<{ items: NoteSummary[]; next: string | null }>(
            `journals?${params}`,
            { signal: controller?.signal },
          )
        : await apiItems<NoteSummary>(`notes?${params}`, {
            signal: controller?.signal,
          });
      if (
        !loadMounted.current ||
        controller?.signal.aborted ||
        seq !== loadSequence.current
      )
        return;
      const list =
        isJournalList && !Array.isArray(listResult)
          ? listResult.items
          : (listResult as NoteSummary[]);
      if (isJournalList && !Array.isArray(listResult))
        journalNext.current = listResult.next;
      setNotes((previous) => [
        ...previous,
        ...list
          .slice(0, 60)
          .filter((note) => !previous.some((item) => item.id === note.id)),
      ]);
      setHasMore(
        isJournalList && !Array.isArray(listResult)
          ? !!listResult.next
          : list.length > 60,
      );
    } catch (e) {
      if (
        loadMounted.current &&
        !controller?.signal.aborted &&
        seq === loadSequence.current
      )
        setMoreError((e as Error).message);
    } finally {
      if (
        loadMounted.current &&
        !controller?.signal.aborted &&
        seq === loadSequence.current
      )
        setLoadingMore(false);
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
      listScope !==
        (view === "journal"
          ? `${view}|${tag}|${journalPeriod}`
          : `${view}|${tag}`) ||
      search ||
      loading
    )
      return;
    // A list that no longer matches the last server copy was edited locally, so other cached sections are stale.
    if (notes !== loadedNotes.current) sectionCache.clear("notes:", "overview");
    sectionCache.set(`notes:${listScope}|${sort}`, { notes, hasMore });
  }, [
    notes,
    hasMore,
    listScope,
    view,
    tag,
    search,
    sort,
    loading,
    journalPeriod,
  ]);
  useEffect(() => () => sectionCache.clear(), []);
  const onSaved = useCallback((note: Note) => {
    setNotes((previous) =>
      previous.map((n) => (n.id === note.id ? { ...n, ...note } : n)),
    );
  }, []);
  function adoptJournalContext(
    note: Pick<Note, "journalPeriod" | "journalPeriodStart" | "dailyDate">,
  ) {
    if (!note.journalPeriod) return;
    const period = note.journalPeriod;
    const date = note.journalPeriodStart || note.dailyDate || localDate();
    journalPeriodRef.current = period;
    journalDateRef.current = date;
    setJournalPeriodState(period);
    setJournalDateState(date);
  }
  async function open(note: Pick<NoteSummary, "id">) {
    if (active?.id === note.id) return;
    if (!(await guard.current())) {
      notify.error("Save your current edits before switching notes.");
      return;
    }
    setOpening(true);
    try {
      const opened = await api<Note>(`notes/${note.id}`);
      adoptJournalContext(opened);
      setActive(opened);
      setFocusTerms([]);
      setGeneration((n) => n + 1);
    } catch (e) {
      notify.error((e as Error).message);
    } finally {
      setOpening(false);
    }
  }
  const adopt = (note: Note) => {
    adoptJournalContext(note);
    setFocusTerms([]);
    setView(note.journalPeriod ? "journal" : "all");
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
    const sequence = routeSequence.current;
    await preloadPanel(next, 300);
    if (sequence !== routeSequence.current) return false;
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
        adoptJournalContext(note);
        setView(
          requestedView &&
            ["all", "journal", "favorites"].includes(requestedView)
            ? requestedView
            : note.journalPeriod
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
    if (view === "journal") {
      url.searchParams.set("period", journalPeriod);
      url.searchParams.set("date", journalDate);
    } else {
      url.searchParams.delete("period");
      if (view !== "calendar") url.searchParams.delete("date");
    }
    if (active) url.searchParams.set("note", active.id);
    else url.searchParams.delete("note");
    if (tag) url.searchParams.set("tag", tag);
    else url.searchParams.delete("tag");
    window.history.replaceState(null, "", url);
    acceptedUrl.current = url.href;
  }, [active, view, tag, journalPeriod, journalDate]);
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
        const restoredPeriod = target.searchParams.get("period");
        if (
          restoredPeriod === "daily" ||
          restoredPeriod === "weekly" ||
          restoredPeriod === "monthly"
        ) {
          journalPeriodRef.current = restoredPeriod;
          setJournalPeriodState(restoredPeriod);
        } else if (workspaceView(target.pathname) === "journal") {
          journalPeriodRef.current = "daily";
          setJournalPeriodState("daily");
        }
        const restoredDate = target.searchParams.get("date");
        if (restoredDate && validDate(restoredDate)) {
          journalDateRef.current = restoredDate;
          setJournalDateState(restoredDate);
        } else if (workspaceView(target.pathname) === "journal") {
          journalDateRef.current = localDate();
          setJournalDateState(localDate());
        }
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
  async function writeJournal(
    date: string,
    period: JournalPeriod,
    templateId?: string | null,
    templateRevision?: number,
  ) {
    if (!(await guard.current())) return false;
    try {
      const note = await api<Note>("journals", {
        method: "POST",
        body: JSON.stringify({
          date,
          period,
          ...(templateId !== undefined ? { templateId } : {}),
          ...(templateRevision !== undefined ? { templateRevision } : {}),
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }),
      });
      adopt(note);
      setDrawer(false);
      return true;
    } catch (e) {
      notify.error((e as Error).message);
      return false;
    }
  }
  async function today() {
    return writeJournal(localDate(), "daily");
  }
  async function changeJournalContext(period: JournalPeriod, date: string) {
    if (!(await guard.current())) {
      notify.error(
        "Save your current edits before changing the journal period.",
      );
      return;
    }
    setActive(null);
    guard.current = async () => true;
    updateJournalContext(period, date);
  }
  async function createFromTemplate(
    template: TemplateSource,
    idempotencyKey: string,
    period?: JournalPeriod,
  ) {
    if (template.kind === "journal") {
      const created = await writeJournal(
        localDate(),
        period ?? "daily",
        template.id,
        template.revision,
      );
      if (!created) throw new Error("The journal entry could not be created.");
      return;
    }
    if (!(await guard.current()))
      throw new Error("Save your current edits first.");
    const result = await api<{ note: Note; created: boolean }>(
      `templates/${template.id}/apply`,
      {
        method: "POST",
        body: JSON.stringify({
          revision: template.revision,
          idempotencyKey,
        }),
      },
    );
    setView("all");
    setTag("");
    setActive(result.note);
    setGeneration((value) => value + 1);
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
    if (result.type === "note" || result.type === "journal")
      return navigateNote(
        result.id,
        result.matchTerms,
        result.type === "journal" ? "journal" : undefined,
      );
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
    setSectionTarget({
      query: result.type === "task" ? "" : result.title,
      completed: result.completed,
      openId: result.type === "task" ? result.id : undefined,
    });
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
        <span className="workspace-brand-label">Nivra</span>
      </header>
      <TooltipProvider delayDuration={350}>
        <div
          className="navigation-scroll"
          tabIndex={0}
          role="region"
          aria-label="Navigation links"
        >
          <NavigationTooltip enabled={!sidebar && !drawer} label="Search">
            <button
              className="nav-item workspace-search"
              aria-label="Search"
              onClick={() => {
                setDrawer(false);
                globalSearch.current?.open();
              }}
            >
              <Search size={18} />
              <span className="nav-item-label">Search</span>
              <Shortcut chord={shortcuts.search} className="nav-shortcut" />
            </button>
          </NavigationTooltip>
          <nav aria-label="Workspace navigation">
            {[
              { id: "overview", label: "Overview", Icon: Grid2X2 },
              { id: "favorites", label: "Favorites", Icon: Heart },
              { id: "all", label: "Notes", Icon: StickyNote },
              { id: "journal", label: "Journal", Icon: NotebookPen },
              { id: "templates", label: "Templates", Icon: LayoutTemplate },
              { id: "tasks", label: "Tasks", Icon: SquareCheckBig },
              { id: "calendar", label: "Calendar", Icon: CalendarDays },
              { id: "bookmarks", label: "Bookmarks", Icon: LibraryBig },
              { id: "artifacts", label: "Artifacts", Icon: Layers },
              { id: "forms", label: "Forms", Icon: ClipboardList },
              { id: "trash", label: "Trash", Icon: Trash },
            ].map(({ id, label, Icon }) => (
              <NavigationTooltip
                key={id}
                enabled={!sidebar && !drawer}
                label={label}
              >
                <button
                  className={`nav-item ${view === id && !tag ? "active" : ""}`}
                  aria-label={label}
                  aria-current={view === id && !tag ? "page" : undefined}
                  onClick={() => void filter(id)}
                  onPointerEnter={() => void preloadPanel(id)}
                  onFocus={() => void preloadPanel(id)}
                >
                  <Icon size={18} strokeWidth={1.6} />
                  <span className="nav-item-label">{label}</span>
                </button>
              </NavigationTooltip>
            ))}
          </nav>
          <div className="tags-heading">
            <span className="tags-label">Tags</span>
            <NavigationTooltip enabled={!sidebar && !drawer} label="Create tag">
              <Button
                variant="ghost"
                size="icon"
                aria-label="Create tag"
                onClick={() =>
                  afterNavigation(() => setTagDialog({ name: "" }))
                }
              >
                <Plus size={14} />
              </Button>
            </NavigationTooltip>
          </div>
          <NavigationTooltip
            enabled={!sidebar && !drawer}
            label="Tag suggestions"
          >
            <button
              className={`nav-item tags-suggestions-row ${view === "tag-suggestions" && !tag ? "active" : ""}`}
              aria-label="Tag suggestions"
              aria-current={
                view === "tag-suggestions" && !tag ? "page" : undefined
              }
              onClick={() =>
                afterNavigation(() => void filter("tag-suggestions"))
              }
              onPointerEnter={() => void preloadPanel("tag-suggestions")}
              onFocus={() => void preloadPanel("tag-suggestions")}
            >
              <Tags size={18} strokeWidth={1.6} />
              <span className="nav-item-label">Tag suggestions</span>
            </button>
          </NavigationTooltip>
          <div className="tag-navigation">
            {tags.map((item) => (
              <div
                key={item.id}
                className={`tag-nav-row ${tag === item.id ? "active" : ""}`}
                data-color={item.color}
              >
                <NavigationTooltip
                  enabled={!sidebar && !drawer}
                  label={item.name}
                >
                  <button
                    aria-label={item.name}
                    aria-pressed={tag === item.id}
                    onClick={() => void filter("all", item.id)}
                  >
                    <span className="tag-dot" data-color={item.color} />
                    <span className="tag-nav-label">{item.name}</span>
                  </button>
                </NavigationTooltip>
                <DropdownMenu modal={false}>
                  <DropdownMenuTrigger asChild>
                    <button
                      aria-label={`Actions for ${item.name}`}
                      title={`Actions for ${item.name}`}
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
                onClick={() =>
                  afterNavigation(() => setTagDialog({ name: "" }))
                }
              >
                Give your ideas a little order.
                <br />
                <span>Create your first tag</span>
              </button>
            )}
          </div>
        </div>
        <div className="navigation-bottom">
          <NavigationTooltip enabled={!sidebar && !drawer} label="Quick">
            <button
              className="nav-item"
              aria-label="Quick"
              onClick={() => {
                setDrawer(false);
                capture.current?.open();
              }}
            >
              <Zap size={18} />
              <span className="nav-item-label">Quick</span>
              <Shortcut chord={shortcuts.capture} className="nav-shortcut" />
            </button>
          </NavigationTooltip>
          <footer className="navigation-footer">
            <NavigationTooltip enabled={!sidebar && !drawer} label="Settings">
              <button
                className="nav-item"
                aria-label="Settings"
                onClick={() => {
                  setDrawer(false);
                  setSettingsOpen(true);
                }}
              >
                <SettingsIcon size={18} />
                <span className="nav-item-label">Settings</span>
              </button>
            </NavigationTooltip>
            <ThemeMenu />
            {!drawer && (
              <Button
                variant="ghost"
                size="icon"
                aria-label={sidebar ? "Collapse sidebar" : "Expand sidebar"}
                title={sidebar ? "Collapse sidebar" : "Expand sidebar"}
                className="collapse-sidebar"
                onClick={() => setSidebar((open) => !open)}
              >
                {sidebar ? (
                  <ChevronLeft size={16} aria-hidden="true" />
                ) : (
                  <ChevronRight size={16} aria-hidden="true" />
                )}
              </Button>
            )}
          </footer>
        </div>
      </TooltipProvider>
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
  const scope =
    view === "journal" ? `${view}|${tag}|${journalPeriod}` : `${view}|${tag}`;
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
      className={`workspace ${active ? "has-note" : ""}`}
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
      <aside
        ref={desktopNavigation}
        className={`desktop-navigation ${sidebar ? "" : "is-collapsed"}`}
      >
        {navigation}
      </aside>
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
          onNavigate={(destination, options) => {
            void filter(destination).then((changed) => {
              if (changed) {
                setSectionTarget({
                  query: options?.query ?? "",
                  ...(destination === "artifacts" && options?.openId
                    ? { openId: options.openId }
                    : {}),
                });
                if (
                  destination === "calendar" &&
                  (options?.date || options?.openId)
                ) {
                  const url = new URL("/calendar", window.location.href);
                  if (options.date) url.searchParams.set("date", options.date);
                  if (options.openId)
                    url.searchParams.set("event", options.openId);
                  if (options.occurrence)
                    url.searchParams.set("occurrence", options.occurrence);
                  window.history.replaceState(null, "", url);
                  acceptedUrl.current = url.href;
                }
                if (
                  destination === "forms" &&
                  options?.formId &&
                  options?.openId
                ) {
                  const url = new URL(
                    `/forms/${options.formId}/responses/${options.openId}`,
                    window.location.href,
                  );
                  window.history.replaceState(null, "", url);
                  acceptedUrl.current = url.href;
                  window.dispatchEvent(new Event("nivra:forms-route"));
                }
                setGeneration((n) => n + 1);
              }
            });
          }}
          onCreate={(kind) => void searchCommand(kind)}
        />
      ) : view === "tag-suggestions" ? (
        <TagSuggestionsPanel
          beforeAction={() => guard.current()}
          onSelect={selectResult}
          onNavigation={() =>
            window.innerWidth < 1024 ? setDrawer(true) : setSidebar(true)
          }
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
      ) : view === "templates" ? (
        <TemplatesPanel
          registerGuard={registerGuard}
          onCreate={createFromTemplate}
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
            item.type === "note" || item.type === "journal"
              ? void open(item)
              : void selectResult({
                  ...item,
                  matchTerms: [],
                  excerpt: item.excerpt,
                })
          }
          opening={opening}
          onReviewSuggestions={() => void filter("tag-suggestions")}
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
                <div className="list-header-top">
                  <div className="list-header-title">
                    <h1>{title}</h1>
                    <span
                      className={`note-count ${shownNotes ? "" : "is-pending"}`}
                    >
                      {rows.length}
                      {shownHasMore ? "+" : ""}
                    </span>
                  </div>
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
                    <NavigationIcon />
                  </Button>
                </div>
                <div className="list-header-actions">
                  {view === "journal" && (
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Write a journal entry"
                      title="Write a journal entry"
                      onClick={() =>
                        void writeJournal(journalDate, journalPeriod)
                      }
                    >
                      <Plus size={16} />
                    </Button>
                  )}
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label="Sort notes"
                      >
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
                </div>
              </header>
              <p className="list-description">
                {view === "journal"
                  ? `One entry for each ${journalPeriod === "daily" ? "day" : journalPeriod === "weekly" ? "week" : "month"} you write.`
                  : "Write and organize your ideas."}
              </p>
              {view === "journal" && (
                <div className="journal-period-controls">
                  <Label className="sr-only" htmlFor="journal-period">
                    Journal period
                  </Label>
                  <Select
                    value={journalPeriod}
                    onValueChange={(value) =>
                      void changeJournalContext(
                        value as JournalPeriod,
                        journalDate,
                      )
                    }
                  >
                    <SelectTrigger
                      id="journal-period"
                      aria-label="Journal period"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="daily">Day</SelectItem>
                      <SelectItem value="weekly">Week</SelectItem>
                      <SelectItem value="monthly">Month</SelectItem>
                    </SelectContent>
                  </Select>
                  <DatePicker
                    label="Journal date"
                    allowClear={false}
                    value={journalDate}
                    onChange={(date) => {
                      if (date) void changeJournalContext(journalPeriod, date);
                    }}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      void changeJournalContext(journalPeriod, localDate())
                    }
                  >
                    Today
                  </Button>
                </div>
              )}
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
                          ? `One entry for each ${journalPeriod === "daily" ? "day" : journalPeriod === "weekly" ? "week" : "month"} you write.`
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
                      <div className="journal-empty-actions">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() =>
                            void writeJournal(journalDate, journalPeriod)
                          }
                        >
                          <Plus size={14} />
                          Write entry
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() =>
                            void writeJournal(journalDate, journalPeriod, null)
                          }
                        >
                          Start blank
                        </Button>
                      </div>
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
                      ? `Your ${journalPeriod === "daily" ? "daily" : journalPeriod === "weekly" ? "weekly" : "monthly"} journal.`
                      : "Room for your next idea."}
                  </h2>
                  <p>
                    {view === "journal"
                      ? `Open an entry to reflect, or start a ${journalPeriod === "daily" ? "daily" : journalPeriod === "weekly" ? "weekly" : "monthly"} entry.`
                      : "Pick a note to keep going, or start something new."}
                  </p>
                  {view === "journal" ? (
                    <div className="journal-empty-actions">
                      <Button
                        variant="outline"
                        onClick={() =>
                          void writeJournal(journalDate, journalPeriod)
                        }
                      >
                        Create journal entry
                        <ArrowRight size={15} />
                      </Button>
                      <Button
                        variant="ghost"
                        onClick={() =>
                          void writeJournal(journalDate, journalPeriod, null)
                        }
                      >
                        Start blank
                      </Button>
                    </div>
                  ) : (
                    <Button variant="outline" onClick={() => void create()}>
                      Create a note
                      <ArrowRight size={15} />
                    </Button>
                  )}
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
