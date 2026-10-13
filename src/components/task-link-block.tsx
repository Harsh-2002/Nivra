"use client";

import { createContext, useContext, useRef, useState } from "react";
import { createReactBlockSpec } from "@blocknote/react";
import { ExternalLink, LoaderCircle, Unlink } from "lucide-react";
import { api, ApiError } from "@/lib/client";
import { useCompletion } from "@/lib/completion-client";
import type { Task } from "@/lib/types";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";

export type TaskLinkActions = {
  onOpen: (taskId: string, title: string, completed: boolean) => void;
  onUnlink: (blockId: string) => Promise<void>;
};

export const TaskLinkActionsContext = createContext<TaskLinkActions | null>(
  null,
);

type TaskLinkProps = {
  taskId: string | null;
  fallbackTitle: string;
  fallbackChecked: boolean;
  taskAvailable?: boolean;
  taskTitle?: string;
  taskCompleted?: boolean;
  taskRevision?: number;
};

export function TaskLinkBlock({
  blockId,
  taskId,
  fallbackTitle,
  fallbackChecked,
  taskAvailable,
  taskTitle,
  taskCompleted,
  taskRevision,
  editable,
}: TaskLinkProps & { blockId: string; editable: boolean }) {
  const actions = useContext(TaskLinkActionsContext);
  const [task, setTask] = useState<Task | null>(null);
  const [availabilityOverride, setAvailabilityOverride] = useState<{
    taskId: string;
    available: boolean;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const taskRef = useRef<Task | null>(null);

  function receive(next: Task) {
    if (
      taskRef.current?.id === next.id &&
      next.revision < taskRef.current.revision
    )
      return;
    taskRef.current = next;
    setTask(next);
    setAvailabilityOverride({ taskId: next.id, available: true });
  }

  async function refresh() {
    if (!taskId) {
      return;
    }
    try {
      receive(await api<Task>(`tasks/${taskId}`));
    } catch (error) {
      if (error instanceof ApiError && error.status === 404)
        setAvailabilityOverride({ taskId, available: false });
      taskRef.current = null;
      setTask(null);
    }
  }

  useCompletion("content", (event) => {
    if (taskId && event.target === taskId) void refresh();
  });

  async function toggle(checked: boolean) {
    if (!taskId || busy || !available) return;
    setBusy(true);
    setMessage("");
    try {
      let current = taskRef.current?.id === taskId ? taskRef.current : null;
      let revision =
        current && (!taskRevision || current.revision >= taskRevision)
          ? current.revision
          : taskRevision;
      if (!revision) {
        current = await api<Task>(`tasks/${taskId}`);
        receive(current);
        revision = current.revision;
      }
      receive(
        await api<Task>(`tasks/${taskId}`, {
          method: "PATCH",
          body: JSON.stringify({
            revision,
            completed: checked,
          }),
        }),
      );
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        await refresh();
        setMessage("This task changed elsewhere. Its latest state is shown.");
      } else {
        setMessage("Could not update the task. Try again.");
      }
    } finally {
      setBusy(false);
    }
  }

  const currentTask =
    task?.id === taskId && (!taskRevision || task.revision >= taskRevision)
      ? task
      : null;
  const title =
    currentTask?.title || taskTitle || fallbackTitle || "Untitled task";
  const checked = currentTask
    ? currentTask.completedAt !== null
    : taskRevision
      ? (taskCompleted ?? fallbackChecked)
      : fallbackChecked;
  const available =
    availabilityOverride?.taskId === taskId
      ? availabilityOverride.available
      : (taskAvailable ?? true);
  const disabled =
    !editable || !available || !(currentTask?.revision || taskRevision) || busy;

  return (
    <div className="writing-task-link" contentEditable={false}>
      <span className="writing-task-link-check-hit">
        <Checkbox
          aria-label={`${checked ? "Mark incomplete" : "Complete"}: ${title}`}
          checked={checked}
          disabled={disabled}
          onCheckedChange={(value) => void toggle(value === true)}
        />
      </span>
      {available ? (
        <button
          type="button"
          className="writing-task-link-title"
          disabled={!taskId || !actions}
          onClick={() => taskId && actions?.onOpen(taskId, title, checked)}
          aria-label={`Open task: ${title}`}
        >
          <span className={checked ? "is-complete" : ""}>{title}</span>
          <ExternalLink size={13} aria-hidden="true" />
        </button>
      ) : (
        <span className="writing-task-link-title is-unavailable">
          <span>{title}</span>
          <span className="writing-task-link-status">Unavailable</span>
        </span>
      )}
      {busy && (
        <LoaderCircle size={14} className="animate-spin" aria-hidden="true" />
      )}
      {editable && actions && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              aria-label={`Actions for ${title}`}
              className="writing-task-link-menu"
            >
              <span aria-hidden="true">···</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => actions.onUnlink(blockId)}>
              <Unlink size={14} />
              Unlink task
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <span className="sr-only" role="status" aria-live="polite">
        {message}
      </span>
    </div>
  );
}

export const taskLinkBlockSpec = createReactBlockSpec(
  {
    type: "taskLink",
    propSchema: {
      taskId: { default: "" },
      fallbackTitle: { default: "" },
      fallbackChecked: { default: false },
      taskAvailable: { default: true },
      taskTitle: { default: "" },
      taskCompleted: { default: false },
      taskRevision: { default: 0 },
    },
    content: "none",
  },
  {
    render: ({ block, editor }) => (
      <TaskLinkBlock
        blockId={block.id}
        taskId={block.props.taskId || null}
        fallbackTitle={block.props.fallbackTitle}
        fallbackChecked={block.props.fallbackChecked}
        taskAvailable={block.props.taskAvailable}
        taskTitle={block.props.taskTitle}
        taskCompleted={block.props.taskCompleted}
        taskRevision={block.props.taskRevision}
        editable={editor.isEditable}
      />
    ),
    toExternalHTML: ({ block }) => (
      <li>
        <input type="checkbox" defaultChecked={block.props.fallbackChecked} />
        {block.props.fallbackTitle || "Linked task"}
      </li>
    ),
  },
)();
