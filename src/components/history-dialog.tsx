"use client";
import { useCallback, useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { History, Loader2, RotateCcw } from "lucide-react";
import { api } from "@/lib/client";
import type { Note, NoteVersion } from "@/lib/types";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "./ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import { useConfirm } from "./confirm-provider";
import { formatDateTime } from "@/lib/dates";
const Editor = dynamic(() => import("./editor"), {
  ssr: false,
  loading: () => (
    <p className="picker-message" role="status">
      Loading version preview…
    </p>
  ),
});
export function HistoryDialog({
  note,
  onClose,
  onRestore,
}: {
  note: Note;
  onClose: () => void;
  onRestore: (id: string) => Promise<void>;
}) {
  const [versions, setVersions] = useState<NoteVersion[]>([]);
  const [selected, setSelected] = useState("");
  const [preview, setPreview] = useState<NoteVersion | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const confirm = useConfirm();
  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const list = await api<NoteVersion[]>(`notes/${note.id}/history`);
      setVersions(list);
      setSelected(list[0]?.id || "");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [note.id]);
  useEffect(() => {
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [load]);
  useEffect(() => {
    if (!selected) return;
    const controller = new AbortController();
    void api<NoteVersion>(`notes/${note.id}/history/${selected}`, {
      signal: controller.signal,
    })
      .then((v) => {
        if (!controller.signal.aborted) setPreview(v);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError((e as Error).message);
      });
    return () => controller.abort();
  }, [selected, note.id]);
  async function restore() {
    if (!preview || busy) return;
    if (
      !(await confirm({
        title: "Restore this version?",
        description:
          "Your current content will be kept in version history so you can return to it.",
        action: "Restore version",
      }))
    )
      return;
    setBusy(true);
    setError("");
    try {
      await onRestore(preview.id);
      onClose();
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
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent className="history-dialog">
        <DialogTitle>Version history</DialogTitle>
        <DialogDescription>
          Earlier checkpoints of this note. Your current content stays
          recoverable when you restore.
        </DialogDescription>
        {error && (
          <div className="history-error" role="alert">
            <p>{error}</p>
            <Button
              variant="outline"
              onClick={() => void load()}
              disabled={busy}
            >
              Retry
            </Button>
          </div>
        )}
        {loading ? (
          <p className="picker-message" role="status">
            <Loader2 size={16} className="animate-spin" />
            Loading history…
          </p>
        ) : !versions.length ? (
          <div className="history-empty">
            <History size={26} />
            <p>No earlier versions yet.</p>
            <small>
              Editing checkpoints are kept automatically, up to 100 per note.
            </small>
          </div>
        ) : (
          <>
            <Select
              value={selected}
              onValueChange={(id) => {
                setPreview(null);
                setError("");
                setSelected(id);
              }}
              disabled={busy}
            >
              <SelectTrigger aria-label="Saved versions">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {versions.map((v) => (
                  <SelectItem key={v.id} value={v.id}>
                    {formatDateTime(v.createdAt)} · Revision {v.revision}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="history-preview">
              {preview?.document && preview.id === selected ? (
                <>
                  <h2>{preview.title || "Untitled"}</h2>
                  <Editor
                    key={preview.id}
                    document={preview.document}
                    noteId={note.id}
                    editable={false}
                    contentLabel="Version content"
                    onChange={() => {}}
                    onTools={() => {}}
                  />
                </>
              ) : !error ? (
                <p role="status">Loading preview…</p>
              ) : null}
            </div>
            <div className="history-footer">
              <span>
                {versions.length} saved{" "}
                {versions.length === 1 ? "checkpoint" : "checkpoints"}
              </span>
              <Button
                disabled={
                  busy ||
                  !preview ||
                  preview.id !== selected ||
                  !!note.trashedAt
                }
                onClick={() => void restore()}
              >
                <RotateCcw size={15} />
                {busy ? "Restoring…" : "Restore version"}
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
