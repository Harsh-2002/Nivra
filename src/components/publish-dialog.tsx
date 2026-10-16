"use client";
import { useEffect, useState } from "react";
import { Copy, ExternalLink, Globe, Loader2 } from "lucide-react";
import { notify } from "@/lib/feedback";
import { api } from "@/lib/client";
import type { Note, Publication } from "@/lib/types";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "./ui/dialog";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { NoteReading } from "./published-reader";
import { useConfirm } from "./confirm-provider";
export function PublishDialog({
  note,
  onClose,
  beforeAction,
}: {
  note: Note;
  onClose: () => void;
  beforeAction: () => Promise<boolean>;
}) {
  const [publication, setPublication] = useState<Publication | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(false);
  const [error, setError] = useState("");
  const [origin, setOrigin] = useState("");
  const confirm = useConfirm();
  useEffect(() => {
    api<Publication | null>(`notes/${note.id}/publication`)
      .then((result) => {
        setPublication(result);
        setOrigin(location.origin);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [note.id]);
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      if (!(await beforeAction()))
        throw new Error("Save your note before publishing.");
      await action();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const link = publication ? `${origin}/share/${publication.token}` : "";
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent
        className={`publish-dialog ${preview ? "with-preview" : ""}`}
      >
        <header>
          <DialogTitle>
            {preview ? "Reader preview" : "Share your note"}
          </DialogTitle>
          <DialogDescription>
            {preview
              ? "This is how your current note will look when published."
              : "Publish a read-only snapshot with its images and files."}
          </DialogDescription>
        </header>
        {preview ? (
          <>
            <div className="publish-preview">
              <NoteReading title={note.title} document={note.document} />
            </div>
            <Button variant="outline" onClick={() => setPreview(false)}>
              Back to sharing
            </Button>
          </>
        ) : (
          <>
            {loading ? (
              <p className="settings-status">
                <Loader2 size={16} className="animate-spin" />
                Loading sharing settings…
              </p>
            ) : publication ? (
              <div className="publication-controls">
                <p className="publication-status">
                  <Globe size={16} />
                  Published
                  {publication.revision !== note.revision && (
                    <span>Changes waiting to publish</span>
                  )}
                </p>
                <Label htmlFor="publication-link">Share link</Label>
                <div className="publication-link">
                  <Input
                    id="publication-link"
                    value={link}
                    readOnly
                    onFocus={(e) => e.target.select()}
                  />
                  <Button
                    variant="outline"
                    size="icon"
                    aria-label="Copy share link"
                    onClick={async () => {
                      if (!navigator.clipboard) {
                        const input = window.document.getElementById(
                          "publication-link",
                        ) as HTMLInputElement;
                        input.focus();
                        input.select();
                        notify.message(
                          "Link selected. Use your device’s copy action.",
                        );
                        return;
                      }
                      try {
                        await navigator.clipboard.writeText(link);
                        notify.success("Link copied.");
                      } catch {
                        notify.error("Select the link to copy it.");
                      }
                    }}
                  >
                    <Copy size={16} />
                  </Button>
                  <Button variant="outline" size="icon" asChild>
                    <a
                      href={link}
                      target="_blank"
                      rel="noreferrer"
                      aria-label="Open published note"
                    >
                      <ExternalLink size={16} />
                    </a>
                  </Button>
                </div>
                <p className="field-hint">
                  Anyone with this link can read the published snapshot. Edits
                  stay private until you publish again.
                </p>
              </div>
            ) : (
              <p className="settings-description">
                Your note is private. Publishing creates a link anyone can open
                without an account.
              </p>
            )}
            <div className="publish-actions">
              <Button variant="outline" onClick={() => setPreview(true)}>
                Preview note
              </Button>
              <Button
                disabled={loading || busy}
                onClick={() =>
                  void run(async () => {
                    setPublication(
                      await api<Publication>(`notes/${note.id}/publication`, {
                        method: "POST",
                        body: JSON.stringify({ revision: note.revision }),
                      }),
                    );
                    notify.success("Note published.");
                  })
                }
              >
                {busy && <Loader2 size={15} className="animate-spin" />}
                {publication ? "Publish latest version" : "Publish note"}
              </Button>
            </div>
            {publication && (
              <Button
                className="unpublish-button"
                variant="ghost"
                disabled={busy}
                onClick={async () => {
                  if (
                    !(await confirm({
                      title: "Stop sharing this note?",
                      description:
                        "The current link stops working for everyone who has it. Publishing again creates a new link.",
                      action: "Stop sharing",
                    }))
                  )
                    return;
                  void run(async () => {
                    await api(`notes/${note.id}/publication`, {
                      method: "DELETE",
                    });
                    setPublication(null);
                    notify.success("Share link removed.");
                  });
                }}
              >
                Stop sharing
              </Button>
            )}
          </>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
