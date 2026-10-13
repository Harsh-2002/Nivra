"use client";
import {
  guardComposition,
  returnToCreation,
  useCreationFocus,
} from "@/lib/input-behavior";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DragDropProvider,
  useDroppable,
  type DragEndEvent,
} from "@dnd-kit/react";
import { SortableKeyboardPlugin } from "@dnd-kit/dom/sortable";
import { StyleInjector, defaultPreset } from "@dnd-kit/dom";
import { useCspNonce } from "@/lib/csp";
import { useSortable, isSortable } from "@dnd-kit/react/sortable";
import {
  GripVertical,
  MoreHorizontal,
  Plus,
  Search,
  CalendarDays,
  Repeat2,
  FileText,
  ListTodo,
  Columns3,
  Loader2,
  ArrowUp,
  ArrowDown,
} from "lucide-react";
import { api } from "@/lib/client";
import type { BoardDetail, Page, Task } from "@/lib/types";
import { taskStages, stageLabels, type TaskStage } from "@/lib/boards";
import { formatDate, localDate } from "@/lib/dates";
import { useCompletion } from "@/lib/completion-client";
import { sectionCache } from "@/lib/section-cache";
import { SectionHeading } from "./section-heading";
import { LoadingState } from "./loading-state";
import { TaskDetails } from "./task-details";
import { DatePicker } from "./date-picker";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "./ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { useConfirm } from "./confirm-provider";

type ColumnPage = Page<Task> & { earlier?: boolean };
const emptyPages = (): Record<TaskStage, ColumnPage> => ({
  todo: { items: [], next: null },
  in_progress: { items: [], next: null },
  done: { items: [], next: null },
});
function Column({
  stage,
  count,
  children,
  active,
}: {
  stage: TaskStage;
  count: number;
  children: React.ReactNode;
  active: boolean;
}) {
  const { ref, isDropTarget } = useDroppable({
    id: stage,
    type: "column",
    accept: "task",
  });
  return (
    <section
      ref={ref}
      className={`kanban-column ${active ? "is-active" : ""} ${isDropTarget ? "is-drop-target" : ""}`}
      aria-label={`${stageLabels[stage]} column`}
    >
      <header>
        <h2>{stageLabels[stage]}</h2>
        <span>{count}</span>
      </header>
      <div
        className="kanban-column-scroll"
        tabIndex={0}
        role="region"
        aria-label={`${stageLabels[stage]} cards`}
      >
        {children}
      </div>
    </section>
  );
}
function Card({
  task,
  index,
  disabled,
  ordering,
  onOpen,
  onMove,
  onReorder,
  onRemove,
  onDelete,
}: {
  task: Task;
  index: number;
  disabled: boolean;
  ordering: boolean;
  onOpen: () => void;
  onMove: (status: TaskStage) => void;
  onReorder: (direction: "up" | "down" | "top" | "bottom") => void;
  onRemove: () => void;
  onDelete: () => void;
}) {
  const { ref, handleRef, isDragSource } = useSortable({
    id: task.id,
    index,
    group: task.status,
    type: "task",
    accept: "task",
    disabled: disabled || !ordering,
    transition: null,
    // React owns column children; avoid moving their DOM nodes outside reconciliation.
    plugins: [SortableKeyboardPlugin],
  });
  const overdue =
    !!task.dueDate && task.dueDate < localDate() && task.status !== "done";
  return (
    <article
      ref={ref}
      data-task-id={task.id}
      className={`kanban-card ${isDragSource ? "is-dragging" : ""}`}
    >
      <div className="kanban-card-top">
        <Button
          variant="ghost"
          size="icon"
          className="kanban-handle"
          ref={handleRef}
          disabled={disabled || !ordering}
          aria-label={`Reorder ${task.title}`}
        >
          <GripVertical size={15} />
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Actions for ${task.title}`}
              disabled={disabled}
            >
              <MoreHorizontal size={16} />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={onOpen}>Task details</DropdownMenuItem>
            {taskStages
              .filter((s) => s !== task.status)
              .map((s) => (
                <DropdownMenuItem key={s} onSelect={() => onMove(s)}>
                  Move to {stageLabels[s]}
                </DropdownMenuItem>
              ))}
            <DropdownMenuItem
              disabled={!ordering || index === 0}
              onSelect={() => onReorder("up")}
            >
              <ArrowUp size={14} />
              Move earlier
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!ordering}
              onSelect={() => onReorder("down")}
            >
              <ArrowDown size={14} />
              Move later
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!ordering}
              onSelect={() => onReorder("top")}
            >
              Move to top
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!ordering}
              onSelect={() => onReorder("bottom")}
            >
              Move to bottom
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onRemove}>
              Remove from board
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onDelete}>Delete task</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <button
        className="kanban-card-title"
        disabled={disabled}
        onClick={onOpen}
      >
        {task.title}
      </button>
      {(task.dueDate ||
        task.schedule ||
        task.scheduleIssue ||
        task.recurrence ||
        task.recurrenceRule ||
        task.noteId ||
        task.stepProgress?.total) && (
        <div className="kanban-card-meta">
          {task.dueDate && (
            <span className={overdue ? "is-overdue" : ""}>
              <CalendarDays size={12} />
              {overdue ? "Overdue · " : ""}
              {formatDate(task.dueDate)}
            </span>
          )}
          {task.schedule && (
            <span>
              <CalendarDays size={12} />
              {formatDate(task.schedule.start.slice(0, 10))} ·{" "}
              {task.schedule.start.slice(11, 16)}
            </span>
          )}
          {!task.schedule && task.scheduleIssue === "needs-scheduling" && (
            <span>
              <CalendarDays size={12} />
              Needs a time
            </span>
          )}
          {task.recurrence && (
            <span title={task.recurrence + " recurrence"}>
              <Repeat2 size={13} />
              Repeats {task.recurrence}
            </span>
          )}
          {task.recurrenceRule && (
            <span>
              <Repeat2 size={13} />
              <span>
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
              </span>
            </span>
          )}
          {!!task.stepProgress?.total && (
            <span
              aria-label={
                task.stepProgress.completed +
                " of " +
                task.stepProgress.total +
                " steps complete"
              }
            >
              <ListTodo size={13} />
              {task.stepProgress.completed}/{task.stepProgress.total} steps
            </span>
          )}
          {task.noteId && (
            <span title={task.noteTitle ?? "Linked note"}>
              <FileText size={13} />
              <span className="sr-only">Linked note</span>
            </span>
          )}
        </div>
      )}
      {!!task.tags?.length && (
        <div className="kanban-tags">
          {task.tags.slice(0, 3).map((t) => (
            <span key={t.id}>{t.name}</span>
          ))}
          {task.tags.length > 3 && <span>+{task.tags.length - 3}</span>}
        </div>
      )}
    </article>
  );
}
export function KanbanPanel({
  board,
  controls,
  stage,
  onStage,
  onNavigation,
  registerGuard,
  onOpenNote,
  initialTaskId,
  onBoardChanged,
  onNewBoard,
  boardLoading = false,
  hideEmpty = false,
}: {
  board: BoardDetail | null;
  controls: React.ReactNode;
  stage: TaskStage;
  onStage: (stage: TaskStage) => void;
  onNavigation: () => void;
  registerGuard: (guard: () => Promise<boolean>) => void;
  onOpenNote: (id: string) => Promise<boolean>;
  initialTaskId?: string;
  onBoardChanged: () => void;
  onNewBoard: () => void;
  boardLoading?: boolean;
  hideEmpty?: boolean;
}) {
  const confirm = useConfirm();
  const nonce = useCspNonce();
  const plugins = useMemo(
    () => [...defaultPreset.plugins, StyleInjector.configure({ nonce })],
    [nonce],
  );
  const [pages, setPages] = useState(emptyPages),
    [counts, setCounts] = useState<Record<TaskStage, number>>({
      todo: 0,
      in_progress: 0,
      done: 0,
    }),
    [loading, setLoading] = useState(true),
    [loadedView, setLoadedView] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [announcement, setAnnouncement] = useState(""),
    [query, setQuery] = useState(""),
    [title, setTitle] = useState(""),
    [due, setDue] = useState<string | null>(null),
    [planned, setPlanned] = useState<string | null>(null),
    [selected, setSelected] = useState<Task | null>(null),
    [dirty, setDirty] = useState(false),
    [finder, setFinder] = useState(false),
    [findQuery, setFindQuery] = useState(""),
    [found, setFound] = useState<Task[]>([]),
    [finding, setFinding] = useState(false),
    [findError, setFindError] = useState(""),
    [small, setSmall] = useState(false);
  const dragging = useRef(false),
    pendingRefresh = useRef(false),
    request = useRef(0),
    busyRef = useRef(false),
    stateRef = useRef(pages),
    input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    stateRef.current = pages;
    busyRef.current = busy;
  }, [pages, busy]);
  const id = board?.id;
  useEffect(() => {
    const media = matchMedia("(max-width: 767px)");
    const change = () => setSmall(media.matches);
    change();
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  useCreationFocus(
    input,
    !!board && board.archivedAt === null && !initialTaskId,
  );
  const view = `${id}|${query}|${small ? stage : "all"}`;
  const route = useCallback(
    (s: TaskStage, limit = 50, after?: string | null) =>
      `tasks?boardId=${id}&status=${s}&order=board&limit=${limit}&q=${encodeURIComponent(query)}${after ? `&after=${encodeURIComponent(after)}` : ""}`,
    [id, query],
  );
  const load = useCallback(
    async (signal?: AbortSignal) => {
      if (!id) {
        setLoading(false);
        return;
      }
      const generation = ++request.current;
      setLoading(true);
      try {
        const stages = small ? [stage] : taskStages;
        const [summary, ...columns] = await Promise.all([
          api<BoardDetail>(`boards/${id}?q=${encodeURIComponent(query)}`, {
            signal,
          }),
          ...stages.map((s) => api<Page<Task>>(route(s), { signal })),
        ]);
        if (signal?.aborted || request.current !== generation) return;
        setLoadedView(view);
        setCounts((summary as BoardDetail).counts);
        setPages(() => {
          const fresh = emptyPages();
          stages.forEach((s, i) => {
            fresh[s] = columns[i] as Page<Task>;
          });
          return fresh;
        });
        setError("");
      } catch (e) {
        if (!signal?.aborted && request.current === generation)
          setError((e as Error).message);
      } finally {
        if (!signal?.aborted && request.current === generation)
          setLoading(false);
      }
    },
    [id, query, small, stage, route, view],
  );
  useEffect(() => {
    const abort = new AbortController();
    const timer = setTimeout(() => void load(abort.signal), query ? 180 : 0);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [load, query]);
  useCompletion(undefined, () => {
    if (dragging.current || busyRef.current || dirty) {
      pendingRefresh.current = true;
      return;
    }
    void load();
    onBoardChanged();
  });
  useEffect(() => {
    const taskId =
      initialTaskId ?? new URL(location.href).searchParams.get("task");
    if (!taskId) {
      const timer = setTimeout(() => setSelected(null), 0);
      return () => clearTimeout(timer);
    }
    const abort = new AbortController();
    void api<Task>(`tasks/${taskId}`, { signal: abort.signal })
      .then((t) => {
        if (!abort.signal.aborted) setSelected(t);
      })
      .catch((e) => {
        if (!abort.signal.aborted) setError(e.message);
      });
    return () => abort.abort();
  }, [initialTaskId]);
  const unfinished = !!title.trim() || dirty;
  useEffect(() => {
    registerGuard(
      async () =>
        !busy &&
        (!unfinished ||
          (await confirm({
            title: "Discard task changes?",
            description: "Your unfinished task changes have not been saved.",
            action: "Discard",
          }))),
    );
    return () => registerGuard(async () => true);
  }, [registerGuard, busy, unfinished, confirm]);
  useEffect(() => {
    const leaving = (e: BeforeUnloadEvent) => {
      if (unfinished || busy) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    addEventListener("beforeunload", leaving);
    return () => removeEventListener("beforeunload", leaving);
  }, [unfinished, busy]);
  useEffect(() => {
    if (!finder) return;
    const abort = new AbortController();
    const timer = setTimeout(() => {
      setFinding(true);
      setFound([]);
      setFindError("");
      void Promise.all([
        api<Page<Task>>(
          `tasks?filter=open&limit=15&q=${encodeURIComponent(findQuery)}`,
          { signal: abort.signal },
        ),
        api<Page<Task>>(
          `tasks?filter=completed&limit=15&q=${encodeURIComponent(findQuery)}`,
          { signal: abort.signal },
        ),
      ])
        .then((results) => {
          if (!abort.signal.aborted)
            setFound(
              results
                .flatMap((p) => p.items)
                .filter((t) => t.boardId !== id)
                .sort((a, b) => b.createdAt - a.createdAt)
                .slice(0, 20),
            );
        })
        .catch((e) => {
          if (!abort.signal.aborted) setFindError(e.message);
        })
        .finally(() => {
          if (!abort.signal.aborted) setFinding(false);
        });
    }, 150);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [finder, findQuery, id]);
  function open(task: Task) {
    setSelected(task);
    const url = new URL(location.href);
    url.searchParams.set("task", task.id);
    history.pushState({}, "", url);
    window.dispatchEvent(new Event("nivra:tasks-navigation"));
  }
  function close() {
    setSelected(null);
    const url = new URL(location.href);
    url.searchParams.delete("task");
    history.replaceState({}, "", url);
    window.dispatchEvent(new Event("nivra:tasks-navigation"));
    if (pendingRefresh.current) {
      pendingRefresh.current = false;
      void load();
    }
  }
  async function mutate(action: () => Promise<void>, reload = true) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      await action();
      sectionCache.clear("tasks:", "overview");
      if (reload) {
        await load();
        onBoardChanged();
      }
      pendingRefresh.current = false;
    } catch (e) {
      setError((e as Error).message);
      await load();
      setError((e as Error).message);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  async function move(
    task: Task,
    status: TaskStage,
    beforeId?: string | null,
    boardId: string | null = id ?? null,
  ) {
    await mutate(async () => {
      setPages((old) => {
        const next = emptyPages();
        taskStages.forEach((s) => {
          next[s] = {
            ...old[s],
            items: old[s].items.filter((t) => t.id !== task.id),
          };
        });
        if (boardId === id) {
          const items = next[status].items;
          const at =
            beforeId === null
              ? items.length
              : beforeId === undefined
                ? 0
                : Math.max(
                    0,
                    items.findIndex((t) => t.id === beforeId),
                  );
          items.splice(at, 0, {
            ...task,
            status,
            completedAt: status === "done" ? Date.now() : null,
          });
        }
        return next;
      });
      await api<Task>(`tasks/${task.id}/move`, {
        method: "POST",
        body: JSON.stringify({
          revision: task.revision,
          boardId,
          status,
          ...(beforeId !== undefined ? { beforeId } : {}),
        }),
      });
      setAnnouncement(`${task.title} moved to ${stageLabels[status]}.`);
    });
  }
  async function anchor(s: TaskStage, index: number, exclude: string) {
    const page = stateRef.current[s];
    const items = page.items.filter((t) => t.id !== exclude);
    if (items[index]) return items[index].id;
    if (page.next) {
      const following = await api<Page<Task>>(route(s, 1, page.next));
      return following.items[0]?.id ?? null;
    }
    return null;
  }
  async function reorder(
    task: Task,
    index: number,
    direction: "up" | "down" | "top" | "bottom",
  ) {
    try {
      const before =
        direction === "top"
          ? undefined
          : direction === "bottom"
            ? null
            : await anchor(
                task.status,
                direction === "up" ? index - 1 : index + 1,
                task.id,
              );
      await move(task, task.status, before);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function dragged(event: DragEndEvent) {
    try {
      dragging.current = false;
      const { source, target } = event.operation;
      if (!event.canceled && source && target && isSortable(source)) {
        const task = taskStages
          .flatMap((s) => stateRef.current[s].items)
          .find((t) => t.id === source.id);
        const destination = taskStages
          .flatMap((s) => stateRef.current[s].items)
          .find((t) => t.id === target.id);
        const group = taskStages.includes(target.id as TaskStage)
          ? (target.id as TaskStage)
          : destination?.status;
        if (task && group && target.id !== source.id) {
          const before = destination
            ? await anchor(
                group,
                stateRef.current[group].items.findIndex(
                  (t) => t.id === destination.id,
                ),
                task.id,
              )
            : null;
          await move(task, group as TaskStage, before);
          return;
        }
      }
      if (pendingRefresh.current) {
        pendingRefresh.current = false;
        void load();
      }
    } catch (e) {
      await load();
      setError((e as Error).message);
    }
  }
  async function more(s: TaskStage) {
    const page = pages[s];
    if (!page.next) return;
    const generation = request.current;
    await mutate(async () => {
      const next = await api<Page<Task>>(route(s, 50, page.next));
      if (request.current !== generation) return;
      setPages((old) => ({
        ...old,
        [s]: {
          items: [...old[s].items, ...next.items].slice(-200),
          next: next.next,
          earlier:
            old[s].earlier || old[s].items.length + next.items.length > 200,
        },
      }));
    }, false);
  }
  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim() || !id || busyRef.current) return;
    const submittedTitle = title;
    await mutate(async () => {
      await api<Task>("tasks", {
        method: "POST",
        body: JSON.stringify({
          title: title.trim(),
          boardId: id,
          dueDate: due,
          plannedDate: planned,
        }),
      });
      setTitle((current) => (current === submittedTitle ? "" : current));
      setDue(null);
      setPlanned(null);
      returnToCreation(input.current);
    });
  }
  async function addExisting(task: Task) {
    if (
      task.boardId &&
      !(await confirm({
        title: "Move this task?",
        description: `Move “${task.title}” from ${task.boardName ?? "its board"} to ${board?.name}?`,
        action: "Move task",
      }))
    )
      return;
    setFinder(false);
    await move(task, task.status);
  }
  return (
    <section className="tasks-panel kanban-panel" aria-label="Tasks board">
      <div className="kanban-content section-content">
        <SectionHeading
          title="Tasks"
          description="A place for what you want to get done."
          onNavigation={onNavigation}
        />
        {controls}
        {boardLoading ? (
          <LoadingState kind="tasks" label="Loading board" />
        ) : !board ? (
          !hideEmpty && (
            <div className="tasks-empty kanban-empty">
              <Columns3 size={30} />
              <h2>Give your project a board.</h2>
              <p>
                Choose a board or create one to organize tasks into To do, In
                progress and Done.
              </p>
              <Button onClick={onNewBoard}>
                <Plus size={16} />
                Create board
              </Button>
            </div>
          )
        ) : (
          <>
            {board.archivedAt === null && (
              <>
                <form
                  className="task-create section-create"
                  onSubmit={(e) => void add(e)}
                >
                  <div className="section-create-field">
                    <Label htmlFor="board-new-task">Task</Label>
                    <Input
                      ref={input}
                      id="board-new-task"
                      aria-label="New task"
                      value={title}
                      onChange={(e) => setTitle(e.target.value)}
                      placeholder="What needs doing?"
                      maxLength={300}
                      onKeyDown={guardComposition}
                    />
                  </div>
                  <Button type="submit" disabled={busy || !title.trim()}>
                    <Plus size={16} />
                    Add task
                  </Button>
                </form>
                <div className="task-create-dates">
                  <DatePicker
                    label="Planned date"
                    value={planned}
                    onChange={setPlanned}
                    disabled={busy}
                  />
                  <DatePicker value={due} onChange={setDue} disabled={busy} />
                </div>
              </>
            )}
            <div className="kanban-toolbar">
              <div
                className="kanban-stage-tabs"
                role="group"
                aria-label="Board stage"
              >
                {taskStages.map((s) => (
                  <Button
                    key={s}
                    variant="ghost"
                    aria-pressed={stage === s}
                    disabled={busy || dirty}
                    onClick={() => onStage(s)}
                  >
                    {stageLabels[s]}
                    <span>{counts[s]}</span>
                  </Button>
                ))}
              </div>
              <div className="kanban-toolbar-actions">
                {board.archivedAt === null && (
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() => {
                      setFinding(true);
                      setFound([]);
                      setFindError("");
                      setFinder(true);
                      setFindQuery("");
                    }}
                  >
                    <Plus size={15} />
                    Add existing
                  </Button>
                )}
                <div className="task-search section-search">
                  <Search size={15} />
                  <Input
                    aria-label="Search board tasks"
                    placeholder="Search this board…"
                    value={query}
                    disabled={busy || dirty}
                    onChange={(e) => {
                      setQuery(e.target.value);
                      setPages(emptyPages());
                      setLoading(true);
                    }}
                  />
                </div>
              </div>
            </div>
            {error && (
              <div className="tasks-error" role="alert">
                <p>{error}</p>
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => void load()}
                >
                  Retry
                </Button>
              </div>
            )}
            <p className="sr-only" role="status">
              {announcement}
            </p>
            <DragDropProvider
              plugins={plugins}
              onBeforeDragStart={(event) => {
                if (busy || query || board.archivedAt !== null)
                  event.preventDefault();
              }}
              onDragStart={() => {
                dragging.current = true;
              }}
              onDragEnd={(event) => void dragged(event)}
            >
              <div className="kanban-grid" aria-busy={loading || busy}>
                {taskStages.map((s) => (
                  <Column
                    key={s}
                    stage={s}
                    count={counts[s]}
                    active={stage === s}
                  >
                    {loading &&
                    loadedView !== view &&
                    !pages[s].items.length ? (
                      <LoadingState
                        kind="tasks"
                        label={`Loading ${stageLabels[s]} tasks`}
                      />
                    ) : (
                      <>
                        {pages[s].earlier && (
                          <Button
                            variant="ghost"
                            disabled={busy}
                            onClick={() => void load()}
                          >
                            Back to first cards
                          </Button>
                        )}
                        {pages[s].items.map((task, index) => (
                          <Card
                            key={task.id}
                            task={task}
                            index={index}
                            disabled={busy}
                            ordering={!query && board.archivedAt === null}
                            onOpen={() => open(task)}
                            onMove={(status) => void move(task, status)}
                            onReorder={(direction) =>
                              void reorder(task, index, direction)
                            }
                            onRemove={() =>
                              void move(task, task.status, undefined, null)
                            }
                            onDelete={() =>
                              void confirm({
                                title: "Delete this task?",
                                description:
                                  "The task will move to Trash. You can restore it there.",
                                action: "Delete task",
                              }).then((ok) => {
                                if (ok)
                                  void mutate(async () => {
                                    await api(`tasks/${task.id}`, {
                                      method: "DELETE",
                                      body: JSON.stringify({
                                        revision: task.revision,
                                      }),
                                    });
                                  });
                              })
                            }
                          />
                        ))}
                        {!pages[s].items.length && (
                          <div className="kanban-column-empty">
                            <p>
                              {query
                                ? "No matching tasks."
                                : s === "todo"
                                  ? "Ready for your next task."
                                  : s === "in_progress"
                                    ? "Move a task here when you start."
                                    : "Finished tasks appear here."}
                            </p>
                          </div>
                        )}
                        {pages[s].next && (
                          <Button
                            variant="ghost"
                            className="kanban-more"
                            disabled={busy}
                            onClick={() => void more(s)}
                          >
                            {busy ? (
                              <Loader2 size={14} className="animate-spin" />
                            ) : null}
                            Load more tasks
                          </Button>
                        )}
                      </>
                    )}
                  </Column>
                ))}
              </div>
            </DragDropProvider>
          </>
        )}
      </div>
      {selected && (
        <TaskDetails
          key={selected.id}
          task={selected}
          onClose={close}
          onDirty={setDirty}
          onOpenNote={onOpenNote}
          onSaved={(updated) => {
            setSelected(updated);
            void load();
            onBoardChanged();
          }}
        />
      )}
      {finder && (
        <Dialog open onOpenChange={setFinder}>
          <DialogContent className="task-finder-dialog">
            <DialogTitle>Add existing task</DialogTitle>
            <DialogDescription>
              Choose a task to move into {board?.name}.
            </DialogDescription>
            <Input
              aria-label="Find existing tasks"
              placeholder="Search tasks…"
              value={findQuery}
              onChange={(e) => {
                setFindQuery(e.target.value);
                setFinding(true);
                setFound([]);
              }}
            />
            <div className="task-finder-results">
              {finding ? (
                <p role="status">Searching tasks…</p>
              ) : findError ? (
                <p role="alert">{findError}</p>
              ) : found.length ? (
                found.map((t) => (
                  <button key={t.id} onClick={() => void addExisting(t)}>
                    <span>{t.title}</span>
                    <small>
                      {t.boardName ?? "Unassigned"} · {stageLabels[t.status]}
                    </small>
                  </button>
                ))
              ) : (
                <p>No available tasks. Try another search.</p>
              )}
            </div>
          </DialogContent>
        </Dialog>
      )}
    </section>
  );
}
