"use client";
import { CalendarDays as ScheduleIcon } from "lucide-react";
import { scheduleItem } from "@/lib/schedule";
import { useCompletion } from "@/lib/completion-client";
import { LoadingState } from "./loading-state";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import dynamic from "next/dynamic";
import {
  ArrowLeft,
  Check,
  Copy,
  Download,
  Loader2,
  MoreHorizontal,
  Paperclip,
  RotateCcw,
  Star,
  Tag as TagIcon,
  Trash2,
  X,
  AlertCircle,
  Share2,
  History,
  AlignCenter,
  MoveHorizontal,
  CalendarDays,
  Zap,
  ListTodo,
} from "lucide-react";
import { FeedbackOutlet } from "./inline-feedback";
import { notify } from "@/lib/feedback";
import { Button } from "./ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { remapDocument } from "@/lib/document";
import { api, ApiError, downloadRequest } from "@/lib/client";
import type { Note, Tag, SearchResult, Task } from "@/lib/types";
import { localDate } from "@/lib/dates";
import { HistoryDialog } from "./history-dialog";
import { NoteConnections } from "./note-connections";
import type { EditorTools, TaskSelection } from "./editor";
import type { TaskLinkActions } from "./task-link-block";
import { useConfirm } from "./confirm-provider";
import { PublishDialog } from "./publish-dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { JournalReview } from "./journal-review";

const Editor = dynamic(() => import("./editor"), {
  ssr: false,
  loading: () => <LoadingState kind="editor" label="Loading editor" />,
});
type Props = {
  initial: Note;
  focusTerms?: string[];
  onCapture: () => void;
  tags: Tag[];
  onSaved: (note: Note) => void;
  onBack: () => void;
  backLabel?: string;
  onOpen: (note: Note) => void;
  onDeleted: () => void;
  registerGuard: (guard: () => Promise<boolean>) => void;
  onNavigateNote: (id: string) => Promise<boolean>;
  onNavigateItem: (item: SearchResult) => Promise<boolean>;
};
export function NotePane({
  initial,
  focusTerms,
  onCapture,
  tags,
  onSaved,
  onBack,
  backLabel = "Back to notes",
  onOpen,
  onDeleted,
  registerGuard,
  onNavigateNote,
  onNavigateItem,
}: Props) {
  const [note, setNote] = useState(initial);
  const current = useRef(initial);
  const capturePending = useRef(false);
  const [state, setState] = useState<
    "saved" | "saving" | "dirty" | "error" | "conflict"
  >("saved");
  const [error, setError] = useState("");
  const [sharing, setSharing] = useState(false);
  const [history, setHistory] = useState(false);
  const confirm = useConfirm();
  const version = useRef(0);
  const savedVersion = useRef(0);
  const saving = useRef<Promise<boolean> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);
  const blocked = useRef(false);
  const tools = useRef<EditorTools | null>(null);
  const uploadRef = useRef<HTMLInputElement>(null);
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const [taskDraft, setTaskDraft] = useState<{
    selection: TaskSelection;
    title: string;
    idempotencyKey: string;
  } | null>(null);
  const [taskMutationPending, setTaskMutationPending] = useState(false);
  const [taskLinkError, setTaskLinkError] = useState("");
  const taskTitleRef = useRef<HTMLInputElement>(null);
  const taskLinkMutation = useRef(false);
  const [mobileJournalPane, setMobileJournalPane] = useState<
    "writing" | "activity"
  >("writing");
  useLayoutEffect(() => {
    const title = titleRef.current;
    if (!title) return;
    let width = 0;
    let active = true;
    let frame = 0;
    const resize = () => {
      if (!active || title.getBoundingClientRect().width <= 0) return;
      title.style.height = "auto";
      title.style.height = `${title.scrollHeight}px`;
    };
    resize();
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width <= 0 || entry.contentRect.width === width)
        return;
      width = entry.contentRect.width;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(resize);
    });
    observer.observe(title);
    void document.fonts.ready.then(resize);
    return () => {
      active = false;
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [note.title]);
  const flushRef = useRef<() => Promise<boolean>>(async () => true);
  const setTools = useCallback((value: EditorTools) => {
    tools.current = value;
  }, []);
  const flush = useCallback(async (): Promise<boolean> => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    if (saving.current) {
      await saving.current;
      if (blocked.current) return false;
      return flushRef.current();
    }
    if (savedVersion.current === version.current) return true;
    if (blocked.current) return false;
    const snapshot = current.current;
    const checkpoint = version.current;
    setState("saving");
    const promise = (async () => {
      try {
        const result = await api<Note>(`notes/${snapshot.id}`, {
          method: "PATCH",
          body: JSON.stringify({
            revision: snapshot.revision,
            title: snapshot.title,
            document: snapshot.document,
            favorite: snapshot.favorite,
            editorWidth: snapshot.editorWidth,
            tags: snapshot.tags.map((t) => t.id),
          }),
        });
        savedVersion.current = checkpoint;
        current.current = {
          ...current.current,
          revision: result.revision,
          updatedAt: result.updatedAt,
        };
        if (mounted.current) {
          setNote(current.current);
          setState(checkpoint === version.current ? "saved" : "dirty");
          setError("");
        }
        onSaved(result);
        return true;
      } catch (e) {
        if (mounted.current) {
          const conflict = e instanceof ApiError && e.status === 409;
          setState(conflict ? "conflict" : "error");
          setError((e as Error).message);
          blocked.current = conflict;
        }
        return false;
      } finally {
        saving.current = null;
      }
    })();
    saving.current = promise;
    const success = await promise;
    if (success && savedVersion.current !== version.current)
      return flushRef.current();
    return success;
  }, [onSaved]);
  useEffect(() => {
    flushRef.current = flush;
    registerGuard(flush);
  }, [flush, registerGuard]);
  useEffect(() => {
    mounted.current = true;
    const unload = (e: BeforeUnloadEvent) => {
      if (version.current !== savedVersion.current) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    const reconnect = () => {
      void flushRef.current();
    };
    window.addEventListener("beforeunload", unload);
    window.addEventListener("online", reconnect);
    return () => {
      mounted.current = false;
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
      window.removeEventListener("beforeunload", unload);
      window.removeEventListener("online", reconnect);
    };
  }, []);
  useCompletion("content", (event) => {
    if (taskLinkMutation.current) return;
    if (
      (event.kind && event.kind !== "content") ||
      (event.target && event.target !== current.current.id)
    )
      return;
    const id = current.current.id;
    void api<Note>(`notes/${id}`)
      .then(async (latest) => {
        if (saving.current) await saving.current;
        if (
          !mounted.current ||
          current.current.id !== id ||
          latest.revision <= current.current.revision
        )
          return;
        if (version.current !== savedVersion.current) {
          blocked.current = true;
          setState("conflict");
          setError(
            "This note changed elsewhere. Your edits are kept here; save them as a new note or reload the latest version.",
          );
        } else if (latest.trashedAt) onDeleted();
        else onOpen(latest);
      })
      .catch(() => {});
  });
  function change(update: Partial<Note>) {
    if (
      update.document &&
      tools.current?.matchesDocument(current.current.document)
    )
      return;
    current.current = { ...current.current, ...update };
    setNote(current.current);
    version.current++;
    setState(blocked.current ? "conflict" : "dirty");
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    timer.current = setTimeout(() => {
      void flushRef.current();
    }, 750);
  }
  function applyCanonicalNote(result: Note) {
    current.current = result;
    setNote(result);
    tools.current?.syncDocument(result.document);
    version.current++;
    savedVersion.current = version.current;
    setState("saved");
    setError("");
    onSaved(result);
  }
  async function recoverTaskLinkConflict(): Promise<
    "reloaded" | "deleted" | "conflict" | "failed"
  > {
    const id = current.current.id;
    const expectedVersion = version.current;
    try {
      const latest = await api<Note>(`notes/${id}`);
      if (!mounted.current || current.current.id !== id) return "failed";
      if (
        version.current !== expectedVersion ||
        version.current !== savedVersion.current
      ) {
        blocked.current = true;
        setState("conflict");
        setError(
          "This note changed elsewhere. Your edits are kept here; save them as a new note or reload the latest version.",
        );
        return "conflict";
      }
      if (latest.trashedAt) return "deleted";
      applyCanonicalNote(latest);
      return "reloaded";
    } catch {
      return "failed";
    }
  }
  function beginLinkedTask() {
    const selection = tools.current?.taskSelection();
    if (!selection) {
      setTaskLinkError("Select text, or place the cursor in a checklist item.");
      return;
    }
    setTaskLinkError("");
    setTaskDraft({
      selection,
      title: selection.title,
      idempotencyKey: crypto.randomUUID(),
    });
    requestAnimationFrame(() => taskTitleRef.current?.focus());
  }
  async function createLinkedTask(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const draft = taskDraft;
    if (!draft || !draft.title.trim() || taskMutationPending) return;
    setTaskMutationPending(true);
    taskLinkMutation.current = true;
    setTaskLinkError("");
    try {
      if (!(await flush())) {
        setTaskLinkError(
          "Resolve the note save before creating a linked task.",
        );
        return;
      }
      const result = await api<{ note: Note; task: Task; created: boolean }>(
        `notes/${current.current.id}/tasks`,
        {
          method: "POST",
          body: JSON.stringify({
            revision: current.current.revision,
            blockId: draft.selection.blockId,
            title: draft.title.trim(),
            ...(draft.selection.selectedText
              ? { selectedText: draft.selection.selectedText }
              : {}),
            idempotencyKey: draft.idempotencyKey,
          }),
        },
      );
      applyCanonicalNote(result.note);
      setTaskDraft(null);
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        const recovered = await recoverTaskLinkConflict();
        if (recovered === "deleted") {
          onDeleted();
          return;
        }
        if (recovered === "reloaded") {
          setTaskDraft(null);
          setTaskLinkError(
            "This note changed elsewhere. The latest version is loaded; choose a block again.",
          );
          return;
        }
      }
      setTaskLinkError((error as Error).message);
    } finally {
      taskLinkMutation.current = false;
      setTaskMutationPending(false);
    }
  }
  async function unlinkTask(blockId: string) {
    if (taskMutationPending) return;
    setTaskMutationPending(true);
    taskLinkMutation.current = true;
    setTaskLinkError("");
    try {
      if (!(await flush())) {
        setTaskLinkError("Resolve the note save before unlinking this task.");
        return;
      }
      const result = await api<{ note: Note }>(
        `notes/${current.current.id}/tasks/${blockId}`,
        {
          method: "DELETE",
          body: JSON.stringify({ revision: current.current.revision }),
        },
      );
      applyCanonicalNote(result.note);
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        const recovered = await recoverTaskLinkConflict();
        if (recovered === "deleted") {
          onDeleted();
          return;
        }
        if (recovered === "reloaded") {
          setTaskLinkError(
            "This note changed elsewhere. The latest version is loaded.",
          );
          return;
        }
      }
      setTaskLinkError((error as Error).message);
    } finally {
      taskLinkMutation.current = false;
      setTaskMutationPending(false);
    }
  }
  const taskLinkActions: TaskLinkActions = {
    onOpen: (id, title, completed) => {
      void onNavigateItem({
        id,
        type: "task",
        title,
        excerpt: "",
        updatedAt: 0,
        completed,
      });
    },
    onUnlink: unlinkTask,
  };
  async function action(run: () => Promise<void>, requireSave = true) {
    try {
      if (requireSave && !(await flush())) return;
      await run();
    } catch (e) {
      notify.error((e as Error).message);
    }
  }
  async function toggleTrash() {
    await action(async () => {
      const result = await api<Note>(`notes/${note.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          revision: current.current.revision,
          trashed: !note.trashedAt,
        }),
      });
      current.current = result;
      setNote(result);
      onSaved(result);
      onDeleted();
    });
  }
  async function permanentDelete() {
    if (
      !(await confirm({
        title: "Delete this note permanently?",
        description:
          "This removes the note and its files. This cannot be undone.",
        action: "Delete permanently",
      }))
    )
      return;
    await action(async () => {
      await api(`notes/${note.id}`, { method: "DELETE" });
      onDeleted();
    });
  }
  async function saveCopy() {
    await action(async () => {
      const result = await api<
        Note & { attachmentMap: Record<string, string> }
      >(`notes/${note.id}/duplicate`, {
        method: "POST",
      });
      const document = remapDocument(
        current.current.document,
        new Map(Object.entries(result.attachmentMap)),
      );
      const updated = await api<Note>(`notes/${result.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          revision: result.revision,
          title: `${current.current.title || "Untitled"} (copy)`,
          document,
        }),
      });
      savedVersion.current = version.current;
      onSaved(updated);
      onOpen(updated);
      notify.success("Your edits were saved as a new note.");
    }, false);
  }
  async function upload(file: File) {
    await action(async () => {
      const form = new FormData();
      form.set("note", note.id);
      form.set("file", file);
      const result = await api<{ url: string; mime: string; name: string }>(
        "files",
        { method: "POST", body: form },
      );
      const type = result.mime.startsWith("image/") ? "image" : "file";
      change({
        document: {
          ...current.current.document,
          blocks: [
            ...current.current.document.blocks,
            {
              type,
              props: { url: result.url, name: result.name, caption: "" },
            },
            { type: "paragraph", content: [] },
          ],
        },
      });
      setEditorKey((n) => n + 1);
      notify.success("File attached.");
    });
  }
  const [editorKey, setEditorKey] = useState(0);
  return (
    <section className="note-pane" data-note-id={note.id}>
      {sharing && (
        <PublishDialog
          note={note}
          beforeAction={flush}
          onClose={() => setSharing(false)}
        />
      )}
      {history && (
        <HistoryDialog
          note={note}
          onClose={() => setHistory(false)}
          onRestore={async (id) => {
            if (!(await flush()))
              throw new Error("Save your edits before restoring a version.");
            const restored = await api<Note>(
              `notes/${note.id}/history/${id}/restore`,
              {
                method: "POST",
                body: JSON.stringify({ revision: current.current.revision }),
              },
            );
            onSaved(restored);
            onOpen(restored);
            notify.success(
              "Version restored. Your previous content is kept in history.",
            );
          }}
        />
      )}
      {error && (
        <div className="save-error" role="alert">
          <span>{error} Your edits are still here.</span>
          <div>
            {state !== "conflict" && (
              <Button size="sm" variant="outline" onClick={() => void flush()}>
                Try again
              </Button>
            )}
            <Button size="sm" variant="outline" onClick={() => void saveCopy()}>
              Save as new note
            </Button>
            {state === "conflict" && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  void (async () => {
                    if (
                      await confirm({
                        title: "Discard unsaved edits?",
                        description:
                          "Reloading replaces your local edits with the saved version.",
                        action: "Reload note",
                      })
                    )
                      await action(async () => {
                        savedVersion.current = version.current;
                        onOpen(await api<Note>(`notes/${note.id}`));
                      }, false);
                  })()
                }
              >
                Reload
              </Button>
            )}
          </div>
        </div>
      )}
      {taskLinkError && (
        <div className="writing-inline-error" role="alert">
          <span>{taskLinkError}</span>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Dismiss linked task message"
            onClick={() => setTaskLinkError("")}
          >
            <X size={15} />
          </Button>
        </div>
      )}
      {note.trashedAt && (
        <div className="trash-banner">
          <span>This note is in trash.</span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void toggleTrash()}
          >
            <RotateCcw size={14} />
            Restore
          </Button>
        </div>
      )}
      <div className="note-scroll">
        <div
          className={`writing-layout ${note.journalPeriod && !note.trashedAt ? "is-journal" : ""}`}
          data-mobile-pane={mobileJournalPane}
        >
          <div className="writing-main">
            <div className="writing-surface" data-width={note.editorWidth}>
              <FeedbackOutlet />
              <header className="note-tools">
                <div className="flex items-center gap-2">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="mobile-back"
                    aria-label={backLabel}
                    onClick={onBack}
                  >
                    <ArrowLeft size={18} />
                  </Button>
                </div>
                <div className="flex items-center gap-1">
                  {!note.trashedAt && (
                    <>
                      <span className={`save-status ${state}`} role="status">
                        {state === "saving" ? (
                          <Loader2 size={12} className="animate-spin" />
                        ) : state === "saved" ? (
                          <Check size={12} />
                        ) : state === "error" || state === "conflict" ? (
                          <AlertCircle size={12} />
                        ) : null}
                        {state === "saved"
                          ? "Saved"
                          : state === "saving"
                            ? "Saving"
                            : "Unsaved"}
                      </span>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label="Share and publish note"
                        title="Share and publish"
                        disabled={!!note.trashedAt || taskMutationPending}
                        onClick={() =>
                          void action(async () => setSharing(true))
                        }
                      >
                        <Share2 size={17} />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={
                          note.favorite
                            ? "Remove from favorites"
                            : "Add to favorites"
                        }
                        onClick={() => change({ favorite: !note.favorite })}
                        disabled={!!note.trashedAt || taskMutationPending}
                      >
                        <Star
                          size={17}
                          fill={note.favorite ? "currentColor" : "none"}
                        />
                      </Button>
                    </>
                  )}
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label="Note actions"
                        disabled={taskMutationPending}
                      >
                        <MoreHorizontal size={19} />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent
                      align="end"
                      onCloseAutoFocus={(event) => {
                        if (capturePending.current) {
                          event.preventDefault();
                          capturePending.current = false;
                          onCapture();
                        }
                      }}
                    >
                      {!note.trashedAt && (
                        <>
                          <DropdownMenuLabel className="note-width-control">
                            Page width
                          </DropdownMenuLabel>
                          <DropdownMenuRadioGroup
                            className="note-width-control"
                            value={note.editorWidth}
                            onValueChange={(value) =>
                              change({
                                editorWidth:
                                  value === "wide" ? "wide" : "standard",
                              })
                            }
                          >
                            <DropdownMenuRadioItem value="standard">
                              <AlignCenter size={15} />
                              Standard
                            </DropdownMenuRadioItem>
                            <DropdownMenuRadioItem value="wide">
                              <MoveHorizontal size={15} />
                              Wide
                            </DropdownMenuRadioItem>
                          </DropdownMenuRadioGroup>
                          <DropdownMenuSeparator className="note-width-control" />
                          <DropdownMenuSeparator />
                          <DropdownMenuItem onSelect={beginLinkedTask}>
                            <ListTodo size={15} />
                            Create linked task
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            onSelect={() =>
                              scheduleItem(
                                note.journalPeriod || note.dailyDate
                                  ? "journal"
                                  : "note",
                                note.id,
                                note.title,
                              )
                            }
                          >
                            <ScheduleIcon size={15} />
                            Schedule
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onSelect={() =>
                              void action(async () => setHistory(true))
                            }
                          >
                            <History size={15} />
                            Version history
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            disabled={!!note.trashedAt}
                            onSelect={() =>
                              void action(async () => setSharing(true))
                            }
                          >
                            <Share2 size={15} />
                            Share & publish
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onSelect={() =>
                              void action(async () => {
                                const result = await api<Note>(
                                  `notes/${note.id}/duplicate`,
                                  { method: "POST" },
                                );
                                onSaved(result);
                                onOpen(result);
                              })
                            }
                          >
                            <Copy size={15} />
                            Duplicate note
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onSelect={() => uploadRef.current?.click()}
                            disabled={!!note.trashedAt}
                          >
                            <Paperclip size={15} />
                            Attach a file
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onSelect={() => {
                              capturePending.current = true;
                            }}
                          >
                            <Zap size={15} />
                            Quick
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onSelect={() =>
                              void action(async () => {
                                if (!tools.current)
                                  throw new Error(
                                    "The editor is still loading.",
                                  );
                                await downloadRequest(
                                  `export/markdown/${note.id}`,
                                  `${note.title || "Untitled"}.zip`,
                                  {
                                    method: "POST",
                                    headers: {
                                      "Content-Type": "application/json",
                                    },
                                    body: JSON.stringify({
                                      markdown: tools.current.markdown(),
                                    }),
                                  },
                                );
                              })
                            }
                          >
                            <Download size={15} />
                            Export Markdown package
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                        </>
                      )}
                      <DropdownMenuItem onSelect={() => void toggleTrash()}>
                        {note.trashedAt ? (
                          <>
                            <RotateCcw size={15} />
                            Restore note
                          </>
                        ) : (
                          <>
                            <Trash2 size={15} />
                            Move to trash
                          </>
                        )}
                      </DropdownMenuItem>
                      {note.trashedAt && (
                        <DropdownMenuItem
                          variant="destructive"
                          onSelect={() => void permanentDelete()}
                        >
                          <Trash2 size={15} />
                          Delete permanently
                        </DropdownMenuItem>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </header>
              <div className="note-date">
                {note.journalPeriod || note.dailyDate ? (
                  <span className="note-kind">
                    <CalendarDays size={14} />
                    Journal · {note.journalPeriod || "daily"} ·{" "}
                  </span>
                ) : null}
                {new Date(note.createdAt).toLocaleDateString(undefined, {
                  month: "long",
                  day: "numeric",
                  year: "numeric",
                })}
              </div>
              <textarea
                ref={titleRef}
                rows={1}
                className="note-title"
                aria-label="Note title"
                value={note.title}
                onChange={(e) =>
                  change({ title: e.target.value.replaceAll("\n", " ") })
                }
                placeholder="Untitled"
                maxLength={300}
                disabled={!!note.trashedAt || taskMutationPending}
              />
              <div className="note-tags">
                {note.tags.map((tag) => (
                  <span
                    key={tag.id}
                    className="tag-chip"
                    data-color={
                      tags.find((item) => item.id === tag.id)?.color ||
                      tag.color
                    }
                  >
                    <span
                      className="tag-dot"
                      data-color={
                        tags.find((item) => item.id === tag.id)?.color ||
                        tag.color
                      }
                    />
                    <span className="tag-chip-label">{tag.name}</span>
                    {!note.trashedAt && (
                      <button
                        aria-label={`Remove ${tag.name} tag`}
                        disabled={taskMutationPending}
                        onClick={() =>
                          change({
                            tags: note.tags.filter((t) => t.id !== tag.id),
                          })
                        }
                      >
                        <X size={11} />
                      </button>
                    )}
                  </span>
                ))}
                {!note.trashedAt && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        className="add-tag"
                        disabled={taskMutationPending}
                      >
                        <TagIcon size={13} />
                        {note.tags.length ? "Add tag" : "Add tags"}
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start">
                      {tags.length ? (
                        tags.map((tag) => (
                          <DropdownMenuItem
                            key={tag.id}
                            onSelect={(e) => {
                              e.preventDefault();
                              change({
                                tags: note.tags.some((t) => t.id === tag.id)
                                  ? note.tags.filter((t) => t.id !== tag.id)
                                  : [...note.tags, tag],
                              });
                            }}
                          >
                            <span className="tag-dot" data-color={tag.color} />
                            <span className="flex-1">{tag.name}</span>
                            {note.tags.some((t) => t.id === tag.id) && (
                              <Check size={14} />
                            )}
                          </DropdownMenuItem>
                        ))
                      ) : (
                        <div className="menu-hint">
                          Create a tag in the sidebar first.
                        </div>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
              </div>
              {taskDraft && (
                <form
                  className="writing-task-compose"
                  onSubmit={(event) => void createLinkedTask(event)}
                >
                  <div className="writing-task-compose-field">
                    <Label htmlFor="linked-task-title">Task title</Label>
                    <Input
                      ref={taskTitleRef}
                      id="linked-task-title"
                      value={taskDraft.title}
                      onChange={(event) =>
                        setTaskDraft({
                          ...taskDraft,
                          title: event.target.value,
                          idempotencyKey:
                            taskDraft.title === event.target.value
                              ? taskDraft.idempotencyKey
                              : crypto.randomUUID(),
                        })
                      }
                      maxLength={300}
                      required
                      disabled={taskMutationPending}
                      aria-describedby="linked-task-help"
                    />
                    <p id="linked-task-help">
                      The selected text stays in the note and links to this
                      task.
                    </p>
                  </div>
                  <div className="writing-task-compose-actions">
                    <Button
                      type="submit"
                      disabled={taskMutationPending || !taskDraft.title.trim()}
                    >
                      {taskMutationPending && (
                        <Loader2 size={14} className="animate-spin" />
                      )}
                      Create task
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      disabled={taskMutationPending}
                      onClick={() => setTaskDraft(null)}
                    >
                      Cancel
                    </Button>
                  </div>
                </form>
              )}
              <Editor
                key={editorKey}
                document={note.document}
                focusTerms={focusTerms}
                noteId={note.id}
                onChange={(document) => change({ document })}
                onTools={setTools}
                editable={!note.trashedAt && !taskMutationPending}
                onOpenNote={onNavigateNote}
                taskLinkActions={taskLinkActions}
              />
              {!note.trashedAt && (
                <NoteConnections
                  noteId={note.id}
                  revision={note.revision}
                  onOpenNote={onNavigateNote}
                  onOpenItem={onNavigateItem}
                />
              )}
            </div>
          </div>
          {note.journalPeriod && !note.trashedAt && (
            <JournalReview
              noteId={note.id}
              date={note.journalPeriodStart || note.dailyDate || localDate()}
              period={note.journalPeriod}
              onOpenNote={onNavigateNote}
              onOpenItem={onNavigateItem}
              mobilePane={mobileJournalPane}
              onMobilePaneChange={setMobileJournalPane}
            />
          )}
        </div>
      </div>
      <input
        ref={uploadRef}
        type="file"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void upload(file);
          e.target.value = "";
        }}
      />
    </section>
  );
}
