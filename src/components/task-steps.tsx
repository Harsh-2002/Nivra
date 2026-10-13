"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Check,
  Loader2,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import type { Task, TaskStep } from "@/lib/types";
import { ApiError, api } from "@/lib/client";
import { guardComposition } from "@/lib/input-behavior";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Input } from "./ui/input";
import { useConfirm } from "./confirm-provider";

type StepsResponse = { taskRevision: number; items: TaskStep[] };
type StepMutation = { task: Task; step?: TaskStep; items?: TaskStep[] };

export function TaskSteps({
  task,
  onTaskChange,
}: {
  task: Task;
  onTaskChange: (task: Task) => void;
}) {
  const confirm = useConfirm();
  const [items, setItems] = useState<TaskStep[]>(task.steps ?? []);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [error, setError] = useState("");
  const addInput = useRef<HTMLInputElement>(null);
  const reloadController = useRef<AbortController | null>(null);
  const version = useRef(0);
  const taskChange = useRef(onTaskChange);
  useEffect(() => {
    taskChange.current = onTaskChange;
  }, [onTaskChange]);

  const reload = useCallback(async () => {
    reloadController.current?.abort();
    const controller = new AbortController();
    reloadController.current = controller;
    const { signal } = controller;
    const ticket = ++version.current;
    try {
      const result = await api<StepsResponse>(
        `tasks/${encodeURIComponent(task.id)}/steps`,
        { signal },
      );
      if (signal.aborted || ticket !== version.current) return;
      setItems(result.items);
      setLoaded(true);
      setLoadError("");
      setError("");
      if (result.taskRevision !== task.revision) {
        const current = await api<Task>(
          `tasks/${encodeURIComponent(task.id)}`,
          {
            signal,
          },
        );
        if (!signal.aborted && ticket === version.current)
          taskChange.current(current);
      }
    } catch (cause) {
      if (!signal.aborted && ticket === version.current) {
        setLoaded(true);
        setLoadError((cause as Error).message);
      }
    } finally {
      if (reloadController.current === controller)
        reloadController.current = null;
    }
  }, [task.id, task.revision]);

  useEffect(() => {
    const timer = setTimeout(() => void reload(), 0);
    return () => {
      clearTimeout(timer);
      reloadController.current?.abort();
      reloadController.current = null;
    };
  }, [reload]);

  async function refreshAfterConflict(cause: unknown) {
    if (cause instanceof ApiError && cause.status === 409) {
      reloadController.current?.abort();
      const controller = new AbortController();
      reloadController.current = controller;
      const ticket = ++version.current;
      try {
        const [current, steps] = await Promise.all([
          api<Task>(`tasks/${encodeURIComponent(task.id)}`, {
            signal: controller.signal,
          }),
          api<StepsResponse>(`tasks/${encodeURIComponent(task.id)}/steps`, {
            signal: controller.signal,
          }),
        ]);
        if (!controller.signal.aborted && ticket === version.current) {
          taskChange.current(current);
          setItems(steps.items);
          setLoaded(true);
          setLoadError("");
        }
      } catch {
        if (!controller.signal.aborted && ticket === version.current)
          setError(
            "This task changed elsewhere. Reload it before trying again.",
          );
      } finally {
        if (reloadController.current === controller)
          reloadController.current = null;
      }
    }
  }

  async function createStep() {
    const text = draft.trim();
    if (!text || busy || items.length >= 100) return;
    setBusy(true);
    setError("");
    try {
      const result = await api<StepMutation>(
        `tasks/${encodeURIComponent(task.id)}/steps`,
        {
          method: "POST",
          body: JSON.stringify({ revision: task.revision, text }),
        },
      );
      taskChange.current(result.task);
      if (result.step) setItems((current) => [...current, result.step!]);
      setDraft((current) => (current.trim() === text ? "" : current));
      requestAnimationFrame(() => addInput.current?.focus());
    } catch (cause) {
      await refreshAfterConflict(cause);
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function patchStep(
    step: TaskStep,
    change: Partial<Pick<TaskStep, "text" | "completed">>,
  ) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await api<StepMutation>(
        `tasks/${encodeURIComponent(task.id)}/steps/${encodeURIComponent(step.id)}`,
        {
          method: "PATCH",
          body: JSON.stringify({ revision: task.revision, ...change }),
        },
      );
      taskChange.current(result.task);
      if (result.step)
        setItems((current) =>
          current.map((item) => (item.id === step.id ? result.step! : item)),
        );
      if (change.text !== undefined) {
        setEditing(null);
        requestAnimationFrame(() =>
          document
            .getElementById(`task-step-text-${task.id}-${step.id}`)
            ?.focus(),
        );
      }
    } catch (cause) {
      await refreshAfterConflict(cause);
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function move(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (busy || target < 0 || target >= items.length) return;
    const stepIds = items.map((item) => item.id);
    [stepIds[index], stepIds[target]] = [stepIds[target], stepIds[index]];
    setBusy(true);
    setError("");
    try {
      const result = await api<StepMutation>(
        `tasks/${encodeURIComponent(task.id)}/steps/reorder`,
        {
          method: "POST",
          body: JSON.stringify({ revision: task.revision, stepIds }),
        },
      );
      taskChange.current(result.task);
      if (result.items) setItems(result.items);
      const movedIndex = target;
      const movedId = items[index].id;
      const control = movedIndex > 0 ? "up" : "down";
      requestAnimationFrame(() =>
        document
          .getElementById(`task-step-move-${control}-${task.id}-${movedId}`)
          ?.focus(),
      );
    } catch (cause) {
      await refreshAfterConflict(cause);
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function removeStep(step: TaskStep) {
    if (
      busy ||
      !(await confirm({
        title: "Remove this step?",
        description: "The step will be removed from this task.",
        action: "Remove step",
      }))
    )
      return;
    setBusy(true);
    setError("");
    try {
      const result = await api<StepMutation>(
        `tasks/${encodeURIComponent(task.id)}/steps/${encodeURIComponent(step.id)}`,
        {
          method: "DELETE",
          body: JSON.stringify({ revision: task.revision }),
        },
      );
      taskChange.current(result.task);
      const index = items.findIndex((item) => item.id === step.id);
      const focusStepId = items[index + 1]?.id ?? items[index - 1]?.id;
      setItems((current) => current.filter((item) => item.id !== step.id));
      requestAnimationFrame(() => {
        const nextFocus = focusStepId
          ? document.getElementById(`task-step-text-${task.id}-${focusStepId}`)
          : null;
        (nextFocus ?? addInput.current)?.focus();
      });
    } catch (cause) {
      await refreshAfterConflict(cause);
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const completed = items.filter((item) => item.completed).length;
  function retryLoad() {
    setLoadError("");
    setError("");
    setLoaded(false);
    void reload();
  }
  return (
    <section
      className="planning-steps"
      aria-labelledby={`task-steps-heading-${task.id}`}
      aria-busy={busy}
    >
      <div className="planning-section-heading">
        <div>
          <h3 id={`task-steps-heading-${task.id}`}>Checklist</h3>
          {loaded && !loadError && (
            <p>
              {items.length
                ? `${completed} of ${items.length} complete`
                : "Break this task into smaller steps, if useful."}
            </p>
          )}
        </div>
      </div>
      {!loaded ? (
        <p className="planning-inline-status" role="status">
          Loading checklist…
        </p>
      ) : loadError ? (
        <div className="planning-checklist-load-error">
          <p className="planning-inline-error" role="alert">
            {loadError}
          </p>
          <Button type="button" variant="outline" onClick={retryLoad}>
            Retry loading checklist
          </Button>
        </div>
      ) : items.length > 0 ? (
        <ol
          className="planning-step-list"
          aria-label={`${task.title} checklist`}
        >
          {items.map((step, index) => (
            <li key={step.id} className="planning-step-row">
              <div className="planning-step-check">
                <Checkbox
                  id={`task-step-${task.id}-${step.id}`}
                  checked={step.completed}
                  disabled={busy}
                  aria-label={`${step.completed ? "Reopen" : "Complete"} step: ${step.text}`}
                  onCheckedChange={(value) =>
                    void patchStep(step, { completed: value === true })
                  }
                />
              </div>
              {editing === step.id ? (
                <div className="planning-step-edit">
                  <Input
                    autoFocus
                    value={editText}
                    maxLength={300}
                    aria-label={`Edit step: ${step.text}`}
                    disabled={busy}
                    onChange={(event) => setEditText(event.target.value)}
                    onKeyDown={(event) => {
                      guardComposition(event);
                      if (
                        event.key === "Enter" &&
                        !event.shiftKey &&
                        !event.nativeEvent.isComposing
                      ) {
                        event.preventDefault();
                        if (editText.trim())
                          void patchStep(step, { text: editText.trim() });
                      }
                      if (event.key === "Escape") {
                        event.preventDefault();
                        setEditing(null);
                        requestAnimationFrame(() =>
                          document
                            .getElementById(
                              `task-step-text-${task.id}-${step.id}`,
                            )
                            ?.focus(),
                        );
                      }
                    }}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label="Save step"
                    disabled={busy || !editText.trim()}
                    onClick={() =>
                      void patchStep(step, { text: editText.trim() })
                    }
                  >
                    <Check size={16} />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label="Cancel step edit"
                    disabled={busy}
                    onClick={() => {
                      setEditing(null);
                      requestAnimationFrame(() =>
                        document
                          .getElementById(
                            `task-step-text-${task.id}-${step.id}`,
                          )
                          ?.focus(),
                      );
                    }}
                  >
                    <X size={16} />
                  </Button>
                </div>
              ) : (
                <button
                  id={`task-step-text-${task.id}-${step.id}`}
                  type="button"
                  className={`planning-step-text ${step.completed ? "is-complete" : ""}`}
                  aria-label={`Edit step: ${step.text}`}
                  disabled={busy}
                  onClick={() => {
                    setEditing(step.id);
                    setEditText(step.text);
                  }}
                >
                  {step.text}
                </button>
              )}
              <div
                className="planning-step-actions"
                aria-label={`Actions for ${step.text}`}
              >
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  id={`task-step-move-up-${task.id}-${step.id}`}
                  aria-label={`Move ${step.text} up`}
                  disabled={busy || index === 0}
                  onClick={() => void move(index, -1)}
                >
                  <ArrowUp size={15} />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  id={`task-step-move-down-${task.id}-${step.id}`}
                  aria-label={`Move ${step.text} down`}
                  disabled={busy || index === items.length - 1}
                  onClick={() => void move(index, 1)}
                >
                  <ArrowDown size={15} />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove ${step.text}`}
                  disabled={busy}
                  onClick={() => void removeStep(step)}
                >
                  <Trash2 size={15} />
                </Button>
              </div>
            </li>
          ))}
        </ol>
      ) : (
        <p className="planning-inline-status">No steps yet.</p>
      )}
      <div className="planning-step-add">
        <Input
          ref={addInput}
          value={draft}
          maxLength={300}
          aria-label="Add a checklist step"
          placeholder={
            items.length >= 100 ? "Checklist limit reached" : "Add a step"
          }
          disabled={busy || !loaded || !!loadError || items.length >= 100}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            guardComposition(event);
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              void createStep();
            }
          }}
        />
        <Button
          type="button"
          variant="outline"
          aria-label="Add checklist step"
          disabled={
            busy ||
            !loaded ||
            !!loadError ||
            !draft.trim() ||
            items.length >= 100
          }
          onClick={() => void createStep()}
        >
          {busy ? (
            <Loader2 size={16} className="animate-spin" />
          ) : (
            <Plus size={16} />
          )}
          <span>Add step</span>
        </Button>
      </div>
      {items.length >= 100 && (
        <p className="planning-inline-status">
          A task can have up to 100 steps.
        </p>
      )}
      {error && (
        <p className="planning-inline-error" role="alert">
          {error}
        </p>
      )}
      <p className="sr-only" role="status" aria-live="polite">
        {busy
          ? "Saving checklist"
          : `${completed} of ${items.length} checklist steps complete`}
      </p>
    </section>
  );
}
