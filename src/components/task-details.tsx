"use client";
import { useEffect, useState } from "react";
import { Pencil, X } from "lucide-react";
import type { Task } from "@/lib/types";
import type { Recurrence } from "@/lib/dates";
import type { TaskRecurrenceRule, TaskSchedule } from "@/lib/task-planning";
import { formatDate } from "@/lib/dates";
import { taskStages, stageLabels, type TaskStage } from "@/lib/boards";
import { api } from "@/lib/client";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "./ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import { TaskEditFields } from "./task-edit-fields";
import { TaskSteps } from "./task-steps";
import { BoardPicker } from "./board-picker";
import { ItemTagPicker } from "./item-tag-picker";
import { useConfirm } from "./confirm-provider";
import { validateTaskSchedule } from "./schedule-editor";
export function TaskDetails({
  task,
  onClose,
  onSaved,
  onDirty,
  onOpenNote,
}: {
  task: Task;
  onClose: () => void;
  onSaved: (task: Task) => void;
  onDirty: (dirty: boolean) => void;
  onOpenNote: (id: string) => Promise<boolean>;
}) {
  const confirm = useConfirm();
  const [current, setCurrent] = useState(task),
    [editing, setEditing] = useState(false),
    [title, setTitle] = useState(task.title),
    [due, setDue] = useState(task.dueDate),
    [planned, setPlanned] = useState(task.plannedDate),
    [repeat, setRepeat] = useState<Recurrence | null>(task.recurrence),
    [recurrenceRule, setRecurrenceRule] = useState<TaskRecurrenceRule | null>(
      task.recurrenceRule ?? null,
    ),
    [schedule, setSchedule] = useState<TaskSchedule | null>(
      task.schedule ?? null,
    ),
    [note, setNote] = useState({ id: task.noteId, title: task.noteTitle }),
    [board, setBoard] = useState({
      id: task.boardId,
      name: task.boardName ?? "Board",
    }),
    [status, setStatus] = useState<TaskStage>(task.status),
    [reminderDirty, setReminderDirty] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const dirty =
    editing &&
    (title !== current.title ||
      due !== current.dueDate ||
      planned !== current.plannedDate ||
      repeat !== current.recurrence ||
      JSON.stringify(recurrenceRule) !==
        JSON.stringify(current.recurrenceRule ?? null) ||
      JSON.stringify(schedule) !== JSON.stringify(current.schedule ?? null) ||
      note.id !== current.noteId ||
      board.id !== current.boardId ||
      status !== current.status ||
      reminderDirty);
  useEffect(() => {
    onDirty(dirty || busy);
    return () => onDirty(false);
  }, [dirty, busy, onDirty]);
  async function discard() {
    if (busy) return false;
    if (
      dirty &&
      !(await confirm({
        title: "Discard task changes?",
        description: "Your changes have not been saved.",
        action: "Discard",
      }))
    )
      return false;
    return true;
  }
  function reset() {
    setTitle(current.title);
    setDue(current.dueDate);
    setPlanned(current.plannedDate);
    setRepeat(current.recurrence);
    setRecurrenceRule(current.recurrenceRule ?? null);
    setSchedule(current.schedule ?? null);
    setNote({ id: current.noteId, title: current.noteTitle });
    setBoard({ id: current.boardId, name: current.boardName ?? "Board" });
    setStatus(current.status);
    setReminderDirty(false);
    setError("");
    setEditing(false);
  }
  async function close() {
    if (await discard()) onClose();
  }
  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !title.trim()) return;
    if (reminderDirty) {
      setError("Save your reminder changes before saving the task.");
      return;
    }
    const scheduleError = validateTaskSchedule(schedule);
    if (schedule && scheduleError) {
      setError(scheduleError);
      return;
    }
    setBusy(true);
    setError("");
    try {
      await api<Task>(`tasks/${current.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          revision: current.revision,
          title: title.trim(),
          dueDate: due,
          plannedDate: planned,
          recurrence: recurrenceRule ? null : repeat,
          recurrenceRule,
          schedule,
          noteId: note.id,
          boardId: board.id,
          status,
        }),
      });
      const updated = await api<Task>(`tasks/${current.id}`);
      setCurrent(updated);
      setEditing(false);
      onSaved(updated);
    } catch (e) {
      setError((e as Error).message);
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
      <DialogContent className="task-details-dialog" showCloseButton={false}>
        <header className="task-details-header">
          <div>
            <DialogTitle>{editing ? "Edit task" : "Task details"}</DialogTitle>
            <DialogDescription>
              {current.boardName ?? "Your tasks"}
            </DialogDescription>
          </div>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Close task details"
            disabled={busy}
            onClick={() => void close()}
          >
            <X size={18} />
          </Button>
        </header>
        <form
          className="task-details-body"
          id="task-details-form"
          onSubmit={(e) => void save(e)}
        >
          {error && (
            <p role="alert" className="tasks-error">
              {error}
            </p>
          )}
          {editing ? (
            <>
              <TaskEditFields
                task={current}
                title={title}
                setTitle={setTitle}
                dueDate={due}
                setDueDate={setDue}
                plannedDate={planned}
                setPlannedDate={setPlanned}
                recurrence={repeat}
                setRecurrence={setRepeat}
                recurrenceRule={recurrenceRule}
                setRecurrenceRule={setRecurrenceRule}
                schedule={schedule}
                setSchedule={setSchedule}
                note={note}
                setNote={setNote}
                disabled={busy}
                onReminderDirty={setReminderDirty}
              />
              <div className="task-schedule-controls">
                <BoardPicker
                  value={board.id}
                  name={board.name}
                  allowAll
                  emptyLabel="No board"
                  disabled={busy}
                  onChange={(b) =>
                    setBoard({ id: b?.id ?? null, name: b?.name ?? "" })
                  }
                />
                <Select
                  value={status}
                  disabled={busy}
                  onValueChange={(v) => setStatus(v as TaskStage)}
                >
                  <SelectTrigger aria-label="Task stage">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {taskStages.map((s) => (
                      <SelectItem key={s} value={s}>
                        {stageLabels[s]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </>
          ) : (
            <>
              <h2 className="task-details-title">{current.title}</h2>
              <dl className="task-details-metadata">
                <div>
                  <dt>Stage</dt>
                  <dd>{stageLabels[current.status]}</dd>
                </div>
                {current.boardName && (
                  <div>
                    <dt>Board</dt>
                    <dd>{current.boardName}</dd>
                  </div>
                )}
                {current.plannedDate && (
                  <div>
                    <dt>Planned</dt>
                    <dd>{formatDate(current.plannedDate)}</dd>
                  </div>
                )}
                {current.schedule && (
                  <div>
                    <dt>Reserved time</dt>
                    <dd>
                      {current.schedule.start.slice(11)} ·{" "}
                      {current.schedule.durationMinutes} minutes ·{" "}
                      {current.schedule.timezone}
                    </dd>
                  </div>
                )}
                {current.scheduleIssue === "needs-scheduling" && (
                  <div>
                    <dt>Schedule</dt>
                    <dd>Choose a time to place this task on the calendar.</dd>
                  </div>
                )}
                {current.dueDate && (
                  <div>
                    <dt>Due</dt>
                    <dd>{formatDate(current.dueDate)}</dd>
                  </div>
                )}
                {current.recurrence && (
                  <div>
                    <dt>Repeats</dt>
                    <dd>{current.recurrence}</dd>
                  </div>
                )}
                {current.recurrenceRule && (
                  <div>
                    <dt>Repeats</dt>
                    <dd>
                      Every {current.recurrenceRule.interval}{" "}
                      {
                        {
                          daily: "day",
                          weekly: "week",
                          monthly: "month",
                          yearly: "year",
                        }[current.recurrenceRule.frequency]
                      }
                      {current.recurrenceRule.interval === 1 ? "" : "s"}
                      {current.recurrenceRule.frequency === "weekly" &&
                        current.recurrenceRule.weekdays.length > 0 &&
                        " on " +
                          current.recurrenceRule.weekdays
                            .map(
                              (weekday) =>
                                [
                                  "Sunday",
                                  "Monday",
                                  "Tuesday",
                                  "Wednesday",
                                  "Thursday",
                                  "Friday",
                                  "Saturday",
                                ][weekday],
                            )
                            .join(", ")}
                      {current.recurrenceRule.anchor === "completion"
                        ? " after completion"
                        : " from its due date"}
                      {current.recurrenceRule.until
                        ? " until " + formatDate(current.recurrenceRule.until)
                        : ""}
                    </dd>
                  </div>
                )}
                {current.noteId && (
                  <div>
                    <dt>Linked note</dt>
                    <dd>
                      <Button
                        variant="ghost"
                        onClick={() => void onOpenNote(current.noteId!)}
                        type="button"
                      >
                        {current.noteTitle || "Untitled"}
                      </Button>
                    </dd>
                  </div>
                )}
              </dl>
              {!!current.tags?.length && (
                <div className="kanban-tags">
                  {current.tags.map((t) => (
                    <span key={t.id}>{t.name}</span>
                  ))}
                </div>
              )}
              <ItemTagPicker
                type="task"
                id={current.id}
                title={current.title}
                compact={false}
                onChanged={async () => {
                  const updated = await api<Task>(`tasks/${current.id}`);
                  setCurrent(updated);
                  onSaved(updated);
                }}
              />
              <TaskSteps
                task={current}
                onTaskChange={(updated) => {
                  setCurrent(updated);
                  onSaved(updated);
                }}
              />
            </>
          )}
        </form>
        <footer className="task-details-footer">
          {editing ? (
            <>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void discard().then((ok) => {
                    if (ok) reset();
                  })
                }
              >
                Cancel
              </Button>
              <Button
                type="submit"
                form="task-details-form"
                key="save-task"
                disabled={busy || !title.trim() || reminderDirty}
              >
                {busy ? "Saving…" : "Save task"}
              </Button>
            </>
          ) : (
            <>
              <Button
                type="button"
                variant="outline"
                onClick={() => void close()}
              >
                Close
              </Button>
              <Button
                type="button"
                key="edit-task"
                onClick={(event) => {
                  event.preventDefault();
                  reset();
                  setEditing(true);
                }}
              >
                <Pencil size={15} />
                Edit task
              </Button>
            </>
          )}
        </footer>
      </DialogContent>
    </Dialog>
  );
}
