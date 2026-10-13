"use client";
import { useEffect, useMemo, useState } from "react";
import { Loader2, Search } from "lucide-react";
import type { Task } from "@/lib/types";
import type { TaskSchedule } from "@/lib/task-planning";
import { api } from "@/lib/client";
import { useConfirm } from "./confirm-provider";
import { ScheduleEditor, validateTaskSchedule } from "./schedule-editor";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "./ui/dialog";

type TaskPage = { items: Task[]; next: string | null };

function scheduleAt(
  date: string,
  time: string,
  timezone: string,
): TaskSchedule {
  return {
    start: date + "T" + time,
    timezone,
    durationMinutes: 30,
    disambiguation: "reject",
  };
}

export function CalendarTaskDialog({
  date,
  time,
  timezone,
  task: initialTask,
  onClose,
  onSaved,
  onDirty,
}: {
  date: string;
  time: string;
  timezone: string;
  task?: Task;
  onClose: () => void;
  onSaved: () => void;
  onDirty: (dirty: boolean) => void;
}) {
  const confirm = useConfirm();
  const [task, setTask] = useState<Task | null>(initialTask ?? null);
  const [schedule, setSchedule] = useState<TaskSchedule | null>(() =>
    initialTask?.schedule
      ? { ...initialTask.schedule }
      : scheduleAt(date, time, timezone),
  );
  const [plannedDate, setPlannedDate] = useState<string | null>(
    initialTask?.plannedDate ?? date,
  );
  const [title, setTitle] = useState("");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Task[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [searchError, setSearchError] = useState("");
  const validationError = useMemo(
    () => (schedule ? validateTaskSchedule(schedule) : ""),
    [schedule],
  );
  const [initialState] = useState(
    JSON.stringify({
      taskId: initialTask?.id ?? null,
      title: "",
      plannedDate: initialTask?.plannedDate ?? date,
      schedule: initialTask?.schedule ?? scheduleAt(date, time, timezone),
    }),
  );
  const dirty =
    JSON.stringify({
      taskId: task?.id ?? null,
      title,
      plannedDate,
      schedule,
    }) !== initialState;

  useEffect(() => {
    onDirty(dirty || busy);
    return () => onDirty(false);
  }, [dirty, busy, onDirty]);

  useEffect(() => {
    if (initialTask) return;
    const abort = new AbortController();
    const timer = setTimeout(
      () => {
        setLoading(true);
        setSearchError("");
        const params = new URLSearchParams({
          filter: "open",
          limit: "50",
          ...(query.trim() ? { q: query.trim() } : {}),
        });
        void api<TaskPage>("tasks?" + params, { signal: abort.signal })
          .then((page) =>
            setResults(page.items.filter((candidate) => !candidate.schedule)),
          )
          .catch((cause) => {
            if (!abort.signal.aborted) setSearchError((cause as Error).message);
          })
          .finally(() => {
            if (!abort.signal.aborted) setLoading(false);
          });
      },
      query.trim() ? 180 : 0,
    );
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [initialTask, query]);

  async function close() {
    if (busy) return;
    if (
      dirty &&
      !(await confirm({
        title: "Discard schedule changes?",
        description: "Your task and time changes have not been saved.",
        action: "Discard changes",
      }))
    )
      return;
    onClose();
  }

  async function save() {
    setError("");
    if (validationError) {
      setError(validationError);
      return;
    }
    if (!task && !title.trim()) {
      setError("Add a task title.");
      return;
    }
    setBusy(true);
    try {
      if (task) {
        await api<Task>("tasks/" + encodeURIComponent(task.id), {
          method: "PATCH",
          body: JSON.stringify({
            revision: task.revision,
            plannedDate,
            schedule,
          }),
        });
      } else {
        await api<Task>("tasks", {
          method: "POST",
          body: JSON.stringify({
            title: title.trim(),
            plannedDate,
            schedule,
            dueDate: null,
          }),
        });
      }
      onSaved();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) void close();
      }}
    >
      <DialogContent className="planning-task-dialog" showCloseButton={false}>
        <header className="planning-task-dialog-heading">
          <div>
            <DialogTitle>
              {initialTask
                ? "Schedule task"
                : task
                  ? "Reserve time for task"
                  : "Plan a task"}
            </DialogTitle>
            <DialogDescription>
              {date} at {time} · {timezone}
            </DialogDescription>
          </div>
        </header>
        <div className="planning-task-dialog-body">
          {initialTask ? (
            <div className="planning-selected-task">
              <strong>{initialTask.title}</strong>
              <span>Adjust this task’s reserved time.</span>
            </div>
          ) : task ? (
            <div className="planning-selected-task">
              <strong>{task.title}</strong>
              <span>Choose a time for this task.</span>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => setTask(null)}
              >
                Choose another task
              </Button>
            </div>
          ) : (
            <>
              <section
                className="planning-task-search"
                aria-labelledby="calendar-task-search-heading"
              >
                <h3 id="calendar-task-search-heading">Existing open tasks</h3>
                <div className="planning-task-search-input">
                  <Search size={16} aria-hidden="true" />
                  <Input
                    value={query}
                    maxLength={300}
                    aria-label="Find an open task"
                    placeholder="Search tasks…"
                    onChange={(event) => setQuery(event.target.value)}
                  />
                </div>
                {searchError && (
                  <p className="planning-inline-error" role="alert">
                    {searchError}
                  </p>
                )}
                {loading ? (
                  <p className="planning-inline-status" role="status">
                    Finding tasks…
                  </p>
                ) : results.length ? (
                  <ul className="planning-task-results">
                    {results.slice(0, 6).map((candidate) => (
                      <li key={candidate.id}>
                        <Button
                          variant="ghost"
                          className="planning-task-result"
                          disabled={busy}
                          onClick={() => {
                            setTask(candidate);
                            setPlannedDate(date);
                            setSchedule(scheduleAt(date, time, timezone));
                            setError("");
                          }}
                        >
                          {candidate.title}
                        </Button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="planning-inline-status">
                    {query.trim()
                      ? "No unscheduled tasks match."
                      : "No unscheduled tasks in these results. Search by title."}
                  </p>
                )}
              </section>
              <div className="planning-task-create-inline">
                <label htmlFor="calendar-new-task-title">
                  Or create a task
                </label>
                <Input
                  id="calendar-new-task-title"
                  value={title}
                  maxLength={300}
                  disabled={busy}
                  placeholder="What needs doing?"
                  onChange={(event) => setTitle(event.target.value)}
                  onKeyDown={(event) => {
                    if (
                      event.key === "Enter" &&
                      !event.nativeEvent.isComposing
                    ) {
                      event.preventDefault();
                      void save();
                    }
                  }}
                />
              </div>
            </>
          )}
          <ScheduleEditor
            id="calendar-new-task"
            schedule={schedule}
            plannedDate={plannedDate}
            timezone={timezone}
            disabled={busy}
            onScheduleChange={(value) => {
              setSchedule(value);
            }}
            onPlannedDateChange={(value) => {
              setPlannedDate(value);
              if (value)
                setSchedule(
                  (current) =>
                    current && {
                      ...current,
                      start: value + "T" + current.start.slice(11),
                    },
                );
            }}
          />
          {error && (
            <p className="planning-inline-error" role="alert">
              {error}
            </p>
          )}
        </div>
        <footer className="planning-task-dialog-footer">
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => void close()}
          >
            Cancel
          </Button>
          <Button
            disabled={busy || !!validationError || (!task && !title.trim())}
            onClick={() => void save()}
          >
            {busy && <Loader2 size={16} className="animate-spin" />}
            {initialTask ? "Save time" : task ? "Schedule task" : "Create task"}
          </Button>
        </footer>
      </DialogContent>
    </Dialog>
  );
}
