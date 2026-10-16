"use client";
import {
  guardComposition,
  returnToCreation,
  useCreationFocus,
} from "@/lib/input-behavior";
import { TaskEditFields } from "./task-edit-fields";
import { ItemTagPicker } from "./item-tag-picker";
import { LoadingState } from "./loading-state";
import { useCompletion } from "@/lib/completion-client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  CheckCheck,
  ListTodo,
  Loader2,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Trash2,
  CalendarDays,
  Repeat2,
  FileText,
  Eye,
} from "lucide-react";
import { api, ApiError } from "@/lib/client";
import type { Page, Task } from "@/lib/types";
import type { TaskRecurrenceRule, TaskSchedule } from "@/lib/task-planning";
import { sectionCache } from "@/lib/section-cache";
import { formatDate, localDate, type Recurrence } from "@/lib/dates";
import { DatePicker } from "./date-picker";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import { Button } from "./ui/button";
import { SectionHeading } from "./section-heading";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Checkbox } from "./ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { useConfirm } from "./confirm-provider";
import type { CapturedItem } from "./quick-capture";
import { TaskDetails } from "./task-details";
import { validateTaskSchedule } from "./schedule-editor";

type TaskCounts = { open: number; completed: number };
type TaskList = { items: Task[]; next: string | null };
const listKey = (filter: string, boardId?: string) =>
  `tasks:list:${boardId ?? "all"}:${filter}`;
const taskParams = (filter: string, query: string, boardId?: string) =>
  new URLSearchParams({
    filter,
    ...(boardId ? { boardId } : {}),
    limit: "60",
    ...(query.trim() ? { q: query.trim() } : {}),
  });
const compareTasks = (a: Task, b: Task) =>
  b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
function mergeTasks(items: Task[], incoming: Task[]) {
  const replaced = new Set(incoming.map((task) => task.id));
  return [...items.filter((task) => !replaced.has(task.id)), ...incoming].sort(
    compareTasks,
  );
}
export function TasksPanel({
  onNavigation,
  controls,
  creationDisabled = false,
  boardId,
  registerGuard,
  initialQuery = "",
  initialTaskId,
  initialFilter = "open",
  focusCreate = false,
  onOpenNote,
}: {
  onNavigation: () => void;
  controls?: React.ReactNode;
  creationDisabled?: boolean;
  boardId?: string;
  registerGuard: (guard: () => Promise<boolean>) => void;
  initialQuery?: string;
  initialTaskId?: string;
  initialFilter?: "open" | "completed";
  focusCreate?: boolean;
  onOpenNote: (id: string) => Promise<boolean>;
}) {
  const warm = sectionCache.get<TaskList>(listKey(initialFilter, boardId));
  const [tasks, setTasks] = useState<Task[]>(warm?.items ?? []);
  const [next, setNext] = useState<string | null>(warm?.next ?? null);
  const [listFilter, setListFilter] = useState(warm ? initialFilter : "");
  const [counts, setCounts] = useState<TaskCounts | null>(
    () =>
      sectionCache.get<TaskCounts>(`tasks:counts:${boardId ?? "all"}`) ?? null,
  );
  const [loadingMore, setLoadingMore] = useState(false);
  const [title, setTitle] = useState("");
  const [query, setQuery] = useState(initialQuery);
  const [filter, setFilter] = useState<"open" | "completed">(initialFilter);
  const [editing, setEditing] = useState<Task | null>(null);
  const [reminderDirty, setReminderDirty] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [createDate, setCreateDate] = useState<string | null>(null);
  const [createPlanned, setCreatePlanned] = useState<string | null>(null);
  const [editPlanned, setEditPlanned] = useState<string | null>(null);
  const [editDate, setEditDate] = useState<string | null>(null);
  const [editRepeat, setEditRepeat] = useState<Recurrence | null>(null);
  const [editRecurrenceRule, setEditRecurrenceRule] =
    useState<TaskRecurrenceRule | null>(null);
  const [editSchedule, setEditSchedule] = useState<TaskSchedule | null>(null);
  const [detailTask, setDetailTask] = useState<Task | null>(null);
  const [detailDirty, setDetailDirty] = useState(false);
  const [editNote, setEditNote] = useState<{
    id: string | null;
    title: string | null;
  }>({ id: null, title: null });
  const [loading, setLoading] = useState(!warm);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!initialTaskId) return;
    const abort = new AbortController();
    void api<Task>(`tasks/${initialTaskId}`, { signal: abort.signal })
      .then((task) => {
        if (!abort.signal.aborted) setDetailTask(task);
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError((e as Error).message);
      });
    return () => abort.abort();
  }, [initialTaskId]);
  const invalidate = () => sectionCache.clear("tasks:list:", "overview");
  const confirm = useConfirm();
  const refreshCounts = useCallback(async () => {
    try {
      setCounts(
        await api<TaskCounts>(
          `tasks?summary=1${boardId ? `&boardId=${boardId}` : ""}`,
        ),
      );
    } catch {}
  }, [boardId]);
  useEffect(() => {
    const received = (event: Event) => {
      const result = (event as CustomEvent<CapturedItem>).detail;
      if (result.type !== "task") return;
      void refreshCounts();
      if (
        filter === "open" &&
        !query.trim() &&
        (!boardId || result.item.boardId === boardId)
      )
        setTasks((items) => mergeTasks(items, [result.item]));
    };
    window.addEventListener("nivra:captured", received);
    return () => window.removeEventListener("nivra:captured", received);
  }, [filter, query, next, refreshCounts, boardId]);
  const editDirty =
    !!editing &&
    (reminderDirty ||
      editTitle !== editing.title ||
      editDate !== editing.dueDate ||
      editPlanned !== editing.plannedDate ||
      editRepeat !== editing.recurrence ||
      JSON.stringify(editRecurrenceRule) !==
        JSON.stringify(editing.recurrenceRule) ||
      JSON.stringify(editSchedule) !== JSON.stringify(editing.schedule) ||
      editNote.id !== editing.noteId);
  useCreationFocus(
    input,
    !creationDisabled && !initialTaskId && !initialQuery,
    focusCreate,
  );
  const view = `${boardId ?? "all"}\n${filter}\n${query}`;
  const currentView = useRef(view);
  const loadVersion = useRef(0);
  const pendingRefresh = useRef(false);
  const load = useCallback(
    async (signal?: AbortSignal) => {
      const version = ++loadVersion.current;
      currentView.current = view;
      setLoading(true);
      try {
        const [first, summary] = await Promise.all([
          api<Page<Task>>(`tasks?${taskParams(filter, query, boardId)}`, {
            signal,
          }),
          api<TaskCounts>(
            `tasks?summary=1${boardId ? `&boardId=${boardId}` : ""}`,
            { signal },
          ),
        ]);
        if (signal?.aborted || version !== loadVersion.current) return;
        setTasks(first.items);
        setNext(first.next);
        setListFilter(filter);
        setCounts(summary);
        setError("");
      } catch (e) {
        if (!signal?.aborted && version === loadVersion.current)
          setError((e as Error).message);
      } finally {
        if (!signal?.aborted && version === loadVersion.current)
          setLoading(false);
      }
    },
    [filter, query, view, boardId],
  );
  useCompletion(undefined, () => {
    if (editing || detailDirty) pendingRefresh.current = true;
    else void load();
  });
  useEffect(() => {
    if (!editing && !detailDirty && pendingRefresh.current) {
      pendingRefresh.current = false;
      void load();
    }
  }, [editing, detailDirty, load]);
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
    if (listFilter === filter && !query.trim() && !loading)
      sectionCache.set(listKey(filter, boardId), { items: tasks, next });
    if (counts) sectionCache.set(`tasks:counts:${boardId ?? "all"}`, counts);
  }, [tasks, next, counts, listFilter, filter, query, loading, boardId]);
  async function loadMore() {
    if (!next || loadingMore) return;
    const started = view;
    const version = loadVersion.current;
    setLoadingMore(true);
    try {
      const more = await api<Page<Task>>(
        `tasks?${taskParams(filter, query, boardId)}&after=${encodeURIComponent(next)}`,
      );
      if (currentView.current !== started || version !== loadVersion.current)
        return;
      setTasks((items) => mergeTasks(items, more.items));
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
        (!(title.trim() || editDirty || detailDirty) ||
          (await confirm({
            title: "Discard unfinished task?",
            description:
              "Your task text has not been saved. Stay here to finish it, or discard it before leaving.",
            action: "Discard",
          }))),
    );
    return () => registerGuard(async () => true);
  }, [busy, title, editDirty, detailDirty, registerGuard, confirm]);
  useEffect(() => {
    const leaving = (e: BeforeUnloadEvent) => {
      if (busy || title.trim() || editDirty || detailDirty) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", leaving);
    return () => {
      window.removeEventListener("beforeunload", leaving);
    };
  }, [busy, title, editDirty, detailDirty]);
  async function mutate(action: () => Promise<void>) {
    setBusy(true);
    setError("");
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
    if (!title.trim() || busy) return;
    const submittedTitle = title;
    await mutate(async () => {
      const task = await api<Task>("tasks", {
        method: "POST",
        body: JSON.stringify({
          title: title.trim(),
          dueDate: createDate,
          plannedDate: createPlanned,
          boardId,
        }),
      });
      invalidate();
      if (filter === "open" && !query.trim())
        setTasks((items) => mergeTasks(items, [task]));
      setTitle((current) => (current === submittedTitle ? "" : current));
      setCreateDate(null);
      setCreatePlanned(null);
      setFilter("open");
      setQuery("");
      void refreshCounts();
      returnToCreation(input.current);
    });
  }
  async function update(
    task: Task,
    change: {
      title?: string;
      completed?: boolean;
      dueDate?: string | null;
      plannedDate?: string | null;
      recurrence?: Recurrence | null;
      recurrenceRule?: TaskRecurrenceRule | null;
      schedule?: TaskSchedule | null;
      noteId?: string | null;
    },
  ) {
    await mutate(async () => {
      if (editing?.id === task.id && reminderDirty)
        throw Error("Save your reminder changes before saving the task.");
      const scheduleError = validateTaskSchedule(change.schedule ?? null);
      if (change.schedule && scheduleError) throw Error(scheduleError);
      const updated = await api<Task>(`tasks/${task.id}`, {
        method: "PATCH",
        body: JSON.stringify({ revision: task.revision, ...change }),
      });
      invalidate();
      setTasks((items) => mergeTasks(items, [updated]));
      if (change.completed && task.recurrence) await load();
      else void refreshCounts();
      if (change.title !== undefined) setEditing(null);
    });
  }
  const today = localDate();
  const cached = query.trim()
    ? undefined
    : sectionCache.get<TaskList>(listKey(filter, boardId));
  const ready = listFilter === filter;
  const rows = ready ? tasks : cached?.items;
  const hasMore = ready ? next !== null : !!cached?.next;
  const displayedRows =
    editing &&
    editing.id === initialTaskId &&
    !(rows ?? []).some((task) => task.id === editing.id)
      ? [editing, ...(rows ?? [])]
      : (rows ?? []);
  const visible = displayedRows
    .filter((t) =>
      filter === "completed" ? t.completedAt !== null : t.completedAt === null,
    )
    .sort(compareTasks);
  return (
    <section className="tasks-panel">
      <div
        className="tasks-scroll"
        tabIndex={0}
        role="region"
        aria-label="Tasks"
      >
        <div className="tasks-content section-content">
          <SectionHeading
            title="Tasks"
            description="A place for what you want to get done."
            onNavigation={onNavigation}
          />
          {controls}
          <form className="task-create section-create" onSubmit={add}>
            <div className="section-create-field">
              <Label htmlFor="task-title">Task</Label>
              <Input
                id="task-title"
                ref={input}
                aria-label="New task"
                placeholder="What needs doing?"
                value={title}
                maxLength={300}
                disabled={!!editing || creationDisabled}
                onKeyDown={guardComposition}
                onChange={(e) => setTitle(e.target.value)}
              />
            </div>
            <Button
              type="submit"
              disabled={busy || !!editing || creationDisabled || !title.trim()}
            >
              {busy ? (
                <Loader2 size={16} className="animate-spin" />
              ) : (
                <Plus size={16} />
              )}
              {busy ? "Adding…" : "Add task"}
            </Button>
          </form>
          <div className="task-create-dates">
            <DatePicker
              label="Planned date"
              value={createPlanned}
              onChange={setCreatePlanned}
              disabled={busy || !!editing || creationDisabled}
            />
            <DatePicker
              value={createDate}
              onChange={setCreateDate}
              disabled={busy || !!editing || creationDisabled}
            />
          </div>
          <div className="tasks-toolbar section-toolbar">
            <div className="task-filters" role="group" aria-label="Task status">
              <Button
                variant="ghost"
                aria-pressed={filter === "open"}
                disabled={busy || !!editing}
                onClick={() => setFilter("open")}
              >
                Open<span>{counts?.open}</span>
              </Button>
              <Button
                variant="ghost"
                aria-pressed={filter === "completed"}
                disabled={busy || !!editing}
                onClick={() => setFilter("completed")}
              >
                Completed<span>{counts?.completed}</span>
              </Button>
            </div>
            <div className="section-filter-select">
              <Select
                value={filter}
                onValueChange={(value) => setFilter(value as typeof filter)}
                disabled={busy || !!editing}
              >
                <SelectTrigger aria-label="Task status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="open">
                    Open · {counts?.open ?? "…"}
                  </SelectItem>
                  <SelectItem value="completed">
                    Completed · {counts?.completed ?? "…"}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="task-search">
              <Search size={15} />
              <Input
                disabled={busy || !!editing}
                aria-label="Search tasks"
                placeholder="Search tasks…"
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
            <LoadingState kind="tasks" label="Loading tasks" />
          ) : visible.length ? (
            <ul
              className="task-list"
              aria-busy={loading}
              aria-label={`${filter === "open" ? "Open" : "Completed"} tasks`}
            >
              {visible.map((task) => (
                <li
                  key={task.id}
                  className={`task-row ${task.completedAt !== null ? "is-complete" : ""}`}
                >
                  <div className="task-check">
                    <Checkbox
                      checked={task.completedAt !== null}
                      disabled={busy || !!editing}
                      aria-label={`${task.completedAt !== null ? "Reopen" : "Complete"} ${task.title}`}
                      onCheckedChange={(checked) =>
                        void update(task, { completed: checked === true })
                      }
                    />
                  </div>
                  {editing?.id === task.id ? (
                    <form
                      className="task-edit"
                      onSubmit={(e) => {
                        e.preventDefault();
                        if (editTitle.trim())
                          void update(task, {
                            title: editTitle.trim(),
                            dueDate: editDate,
                            plannedDate: editPlanned,
                            recurrence: editRepeat,
                            recurrenceRule: editRecurrenceRule,
                            schedule: editSchedule,
                            noteId: editNote.id,
                          });
                      }}
                    >
                      <TaskEditFields
                        task={task}
                        title={editTitle}
                        setTitle={setEditTitle}
                        dueDate={editDate}
                        setDueDate={setEditDate}
                        plannedDate={editPlanned}
                        setPlannedDate={setEditPlanned}
                        recurrence={editRepeat}
                        setRecurrence={setEditRepeat}
                        recurrenceRule={editRecurrenceRule}
                        setRecurrenceRule={setEditRecurrenceRule}
                        schedule={editSchedule}
                        setSchedule={setEditSchedule}
                        note={editNote}
                        setNote={setEditNote}
                        disabled={busy}
                        onReminderDirty={setReminderDirty}
                      />
                      <div className="task-edit-actions">
                        <Button
                          type="submit"
                          disabled={busy || !editTitle.trim()}
                        >
                          Save
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
                    <div className="task-copy">
                      <button
                        type="button"
                        className="task-row-open"
                        aria-label={"Open details for " + task.title}
                        disabled={busy || !!editing}
                        onClick={() => setDetailTask(task)}
                      >
                        <span className="task-title">{task.title}</span>
                        <span className="task-metadata">
                          {task.plannedDate && (
                            <span className="task-date">
                              Planned {formatDate(task.plannedDate)}
                            </span>
                          )}
                          {task.schedule && (
                            <span>
                              {task.schedule.start.slice(11, 16)} ·{" "}
                              {task.schedule.durationMinutes} min
                            </span>
                          )}
                          {task.scheduleIssue === "needs-scheduling" && (
                            <span className="planning-inline-status">
                              Needs a time
                            </span>
                          )}
                          {task.dueDate && (
                            <span
                              className={
                                task.completedAt === null &&
                                task.dueDate < today
                                  ? "is-overdue"
                                  : ""
                              }
                            >
                              <CalendarDays size={12} />
                              {task.completedAt === null && task.dueDate < today
                                ? "Overdue · "
                                : ""}
                              {task.dueDate === today
                                ? "Today"
                                : formatDate(task.dueDate)}
                            </span>
                          )}
                          {task.recurrence && (
                            <span>
                              <Repeat2 size={12} />
                              {task.recurrence === "daily"
                                ? "Daily"
                                : task.recurrence === "weekly"
                                  ? "Weekly"
                                  : "Monthly"}
                            </span>
                          )}
                          {task.recurrenceRule && (
                            <span>
                              <Repeat2 size={12} />
                              Every {task.recurrenceRule.interval}{" "}
                              {
                                {
                                  daily: "day",
                                  weekly: "week",
                                  monthly: "month",
                                  yearly: "year",
                                }[task.recurrenceRule.frequency]
                              }
                              {task.recurrenceRule.interval === 1 ? "" : "s"}
                              {task.recurrenceRule.anchor === "completion"
                                ? " · after completion"
                                : " · from due date"}
                            </span>
                          )}
                          {task.stepProgress && task.stepProgress.total > 0 && (
                            <span>
                              {task.stepProgress.completed}/
                              {task.stepProgress.total} steps
                            </span>
                          )}
                        </span>
                      </button>
                      {task.noteId && (
                        <button
                          type="button"
                          className="linked-note-chip"
                          aria-label={`Open linked note ${task.noteTitle || "Untitled"}`}
                          disabled={busy}
                          onClick={() => void onOpenNote(task.noteId!)}
                        >
                          <FileText size={12} />
                          {task.noteTitle || "Untitled"}
                        </button>
                      )}
                    </div>
                  )}
                  <ItemTagPicker
                    type="task"
                    id={task.id}
                    title={task.title}
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
                        aria-label={`Actions for ${task.title}`}
                        disabled={busy || !!editing}
                      >
                        <MoreHorizontal size={16} />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onSelect={() => setDetailTask(task)}>
                        <Eye size={15} />
                        View details
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onSelect={() => {
                          setEditing(task);
                          setEditTitle(task.title);
                          setEditDate(task.dueDate);
                          setEditPlanned(task.plannedDate);
                          setEditRepeat(task.recurrence);
                          setEditRecurrenceRule(task.recurrenceRule ?? null);
                          setEditSchedule(task.schedule ?? null);
                          setEditNote({
                            id: task.noteId,
                            title: task.noteTitle,
                          });
                        }}
                      >
                        <Pencil size={15} />
                        Edit task
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onSelect={() =>
                          void (async () => {
                            if (
                              await confirm({
                                title: "Delete this task?",
                                description:
                                  "The task will move to Trash. You can restore it there.",
                                action: "Delete task",
                              })
                            )
                              await mutate(async () => {
                                await api(`tasks/${task.id}`, {
                                  method: "DELETE",
                                  body: JSON.stringify({
                                    revision: task.revision,
                                  }),
                                });
                                invalidate();
                                setTasks((items) =>
                                  items.filter((item) => item.id !== task.id),
                                );
                                void refreshCounts();
                                if (editing?.id === task.id) setEditing(null);
                              });
                          })()
                        }
                      >
                        <Trash2 size={15} />
                        Delete task
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </li>
              ))}
            </ul>
          ) : (
            <div className="tasks-empty">
              {query ? (
                <Search size={28} strokeWidth={1.5} />
              ) : filter === "completed" ? (
                <CheckCheck size={30} strokeWidth={1.5} />
              ) : (
                <ListTodo size={30} strokeWidth={1.5} />
              )}
              <h2>
                {query
                  ? "No matching tasks"
                  : filter === "completed"
                    ? "Your finished tasks will live here."
                    : counts && counts.open + counts.completed
                      ? "Everything is checked off."
                      : "Make room for your next step."}
              </h2>
              <p>
                {query
                  ? "Try another search."
                  : filter === "completed"
                    ? "Check off an open task to keep track of your progress."
                    : "Add a task above. Check it off when you’re done."}
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
                {loadingMore ? "Loading…" : "Load more tasks"}
              </Button>
            </div>
          )}
          {rows !== undefined && (
            <p className="task-summary" aria-live="polite">
              {counts
                ? `${counts.open} open · ${counts.completed} completed`
                : "\u00a0"}
              {busy && <Loader2 size={13} className="animate-spin" />}
            </p>
          )}
        </div>
      </div>
      {detailTask && (
        <TaskDetails
          key={detailTask.id}
          task={detailTask}
          onClose={() => {
            setDetailTask(null);
            setDetailDirty(false);
          }}
          onDirty={setDetailDirty}
          onOpenNote={onOpenNote}
          onSaved={(updated) => {
            setDetailTask(updated);
            setTasks((items) => mergeTasks(items, [updated]));
            invalidate();
            void refreshCounts();
          }}
        />
      )}
    </section>
  );
}
