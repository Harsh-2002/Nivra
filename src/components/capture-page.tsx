"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, Check, Copy, Loader2, Plus } from "lucide-react";
import { api } from "@/lib/client";
import {
  bookmarklet,
  captureInput,
  emptyCapture,
  sharedCapture,
  type CaptureDraft,
} from "@/lib/capture";
import { AuthScreen } from "./auth-screen";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { Label } from "./ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import { useConfirm } from "./confirm-provider";
import { useTheme } from "next-themes";

type CaptureStatus = {
  setup: boolean;
  owner: { id: string } | null;
  methods: { password: boolean; passkey: boolean };
  installation?: { encrypted: boolean; locked: boolean; publicUrl: string };
  settings?: { theme: "light" | "dark" | "system" } | null;
};
type SavedCapture = {
  type: CaptureDraft["type"];
  id: string;
  noteId: string | null;
  alreadySaved: boolean;
};

export function CapturePage() {
  const [draft, setDraft] = useState<CaptureDraft>(emptyCapture);
  const [status, setStatus] = useState<CaptureStatus | null>(null);
  const [error, setError] = useState("");
  const [invalidField, setInvalidField] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<SavedCapture | null>(null);
  const [copied, setCopied] = useState(false);
  const [origin, setOrigin] = useState("");
  const [dirty, setDirty] = useState(false);
  const key = useRef("");
  const confirm = useConfirm();
  const incoming = useRef({ dirty, busy, confirm });
  const incomingGeneration = useRef(0);
  const mounted = useRef(true);
  const statusRequest = useRef<AbortController | null>(null);
  useEffect(() => {
    incoming.current.confirm = confirm;
  }, [confirm]);
  const { setTheme } = useTheme();
  const theme = useRef(setTheme);
  useEffect(() => {
    theme.current = setTheme;
  }, [setTheme]);
  const refresh = useCallback(async () => {
    if (!mounted.current) return;
    statusRequest.current?.abort();
    const request = new AbortController();
    statusRequest.current = request;
    try {
      const value = await api<CaptureStatus>("status", {
        signal: request.signal,
      });
      if (!mounted.current || request.signal.aborted) return;
      setStatus(value);
      if (value.settings) theme.current(value.settings.theme);
    } catch (cause) {
      if (mounted.current && !request.signal.aborted)
        setError((cause as Error).message);
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    let active = true;
    const receive = async () => {
      if (!active || !location.hash) return;
      const fragment = location.hash.slice(1);
      const generation = ++incomingGeneration.current;
      history.replaceState(
        history.state,
        "",
        location.pathname + location.search,
      );
      try {
        if (fragment.length > 150_000) throw new Error();
        const fields = new URLSearchParams(fragment);
        const received = sharedCapture({
          title: fields.get("title") || "",
          text: fields.get("text") || "",
          url: fields.get("url") || "",
        });
        if (incoming.current.busy) {
          setError(
            "Finish saving this capture, then open the shared link again.",
          );
          return;
        }
        if (
          incoming.current.dirty &&
          !(await incoming.current.confirm({
            title: "Replace this capture?",
            description: "Your unsaved link and text will be discarded.",
            action: "Replace",
          }))
        )
          return;
        if (!active || generation !== incomingGeneration.current) return;
        if (incoming.current.busy) {
          setError(
            "Finish saving this capture, then open the shared link again.",
          );
          return;
        }
        incoming.current.dirty = true;
        setDraft(received);
        setDirty(true);
        setSaved(null);
        setInvalidField(null);
        setError("");
        key.current = "";
      } catch {
        if (!active || generation !== incomingGeneration.current) return;
        setError(
          "This shared content could not be opened. Paste the link or text below.",
        );
      }
    };
    const onHashChange = () => void receive();
    window.addEventListener("hashchange", onHashChange);
    queueMicrotask(() => {
      if (!active) return;
      setOrigin(location.origin);
      void receive();
      void refresh();
    });
    return () => {
      active = false;
      mounted.current = false;
      statusRequest.current?.abort();
      window.removeEventListener("hashchange", onHashChange);
    };
  }, [refresh]);
  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => {
      if (incoming.current.dirty || incoming.current.busy) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, []);
  function change(update: Partial<CaptureDraft>) {
    incoming.current.dirty = true;
    setDraft((current) => ({ ...current, ...update }));
    setDirty(true);
    setSaved(null);
    key.current = "";
    setInvalidField(null);
    setError("");
  }
  async function save() {
    if (incoming.current.busy || !status?.owner) return;
    const parsed = captureInput.safeParse(draft);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message || "Check your capture.");
      const field = parsed.error.issues[0]?.path[0];
      setInvalidField(typeof field === "string" ? field : null);
      if (typeof field === "string")
        document.getElementById(`capture-${field}`)?.focus();
      return;
    }
    incoming.current.busy = true;
    setBusy(true);
    setError("");
    setInvalidField(null);
    key.current ||= crypto.randomUUID();
    try {
      const result = await api<SavedCapture>("capture", {
        method: "POST",
        headers: { "Idempotency-Key": key.current },
        body: JSON.stringify(parsed.data),
      });
      setSaved(result);
      incoming.current.dirty = false;
      setDirty(false);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      incoming.current.busy = false;
      setBusy(false);
    }
  }
  async function leave(path = "/bookmarks") {
    if (incoming.current.busy) return;
    if (
      incoming.current.dirty &&
      !(await confirm({
        title: "Discard this capture?",
        description: "Your unsaved link and text will be discarded.",
        action: "Discard",
      }))
    )
      return;
    incoming.current.dirty = false;
    setDirty(false);
    location.assign(path);
  }
  if (!status)
    return (
      <div className="capture-shell">
        <main className="capture-page">
          <h1>Capture</h1>
          {error ? (
            <>
              <p role="alert">{error}</p>
              <Button onClick={refresh}>Try again</Button>
            </>
          ) : (
            <p role="status">Opening capture…</p>
          )}
        </main>
      </div>
    );
  if (!status.owner)
    return (
      <AuthScreen
        setup={status.setup}
        installation={status.installation}
        methods={status.methods}
        onReady={() => void refresh()}
      />
    );
  const target = saved
    ? saved.type === "task"
      ? `/tasks?task=${saved.id}`
      : saved.type === "note"
        ? `/notes?note=${saved.id}`
        : "/bookmarks"
    : null;
  return (
    <div className="capture-shell">
      <main className="capture-page">
        <div className="capture-intro">
          <Button
            variant="ghost"
            className="capture-back"
            onClick={() => void leave()}
          >
            <ArrowLeft size={16} />
            Back to workspace
          </Button>
          <h1>Capture</h1>
          <p>Keep a link, thought or next action.</p>
        </div>
        <form
          className="capture-form"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <div>
            <Label htmlFor="capture-type">Save as</Label>
            <Select
              value={draft.type}
              disabled={busy}
              onValueChange={(value) =>
                change({ type: value as CaptureDraft["type"] })
              }
            >
              <SelectTrigger id="capture-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="bookmark">Bookmark</SelectItem>
                <SelectItem value="note">Note</SelectItem>
                <SelectItem value="task">Task</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {draft.type === "bookmark" && (
            <div>
              <Label htmlFor="capture-url">Link</Label>
              <Input
                id="capture-url"
                aria-invalid={invalidField === "url"}
                aria-describedby={
                  invalidField === "url" ? "capture-error" : undefined
                }
                type="url"
                inputMode="url"
                autoComplete="off"
                value={draft.url}
                disabled={busy}
                maxLength={4096}
                onChange={(event) => change({ url: event.target.value })}
              />
            </div>
          )}
          <div>
            <Label htmlFor="capture-title">
              {draft.type === "task" ? "Task" : "Title (optional)"}
            </Label>
            <Input
              id="capture-title"
              aria-invalid={invalidField === "title"}
              aria-describedby={
                invalidField === "title" ? "capture-error" : undefined
              }
              value={draft.title}
              disabled={busy}
              maxLength={300}
              onChange={(event) => change({ title: event.target.value })}
            />
          </div>
          {draft.type !== "task" && (
            <div>
              <Label htmlFor="capture-text">
                {draft.type === "bookmark"
                  ? "Selected passage (optional)"
                  : "Text"}
              </Label>
              <Textarea
                id="capture-text"
                aria-invalid={invalidField === "text"}
                aria-describedby={
                  invalidField === "text" ? "capture-error" : undefined
                }
                value={draft.text}
                rows={6}
                disabled={busy}
                maxLength={10_000}
                onChange={(event) => change({ text: event.target.value })}
              />
              {draft.type === "bookmark" && (
                <p className="capture-help">
                  A selected passage is saved as a note with its source link.
                </p>
              )}
            </div>
          )}
          {draft.type === "bookmark" && (
            <div>
              <Label htmlFor="capture-collection">Collection (optional)</Label>
              <Input
                id="capture-collection"
                value={draft.collection}
                maxLength={80}
                disabled={busy}
                onChange={(event) => change({ collection: event.target.value })}
              />
            </div>
          )}
          {error && (
            <p id="capture-error" role="alert">
              {error}
            </p>
          )}
          <div className="capture-actions">
            <Button type="submit" disabled={busy || !!saved}>
              {busy ? (
                <Loader2 size={16} className="animate-spin" />
              ) : saved ? (
                <Check size={16} />
              ) : (
                <Plus size={16} />
              )}
              {busy ? "Saving…" : saved ? "Saved" : "Save"}
            </Button>
            {target && (
              <Button
                type="button"
                variant="outline"
                onClick={() => void leave(target)}
              >
                Open {saved?.type}
              </Button>
            )}
            {saved?.noteId && saved.type === "bookmark" && (
              <Button
                type="button"
                variant="ghost"
                onClick={() => void leave(`/notes?note=${saved.noteId}`)}
              >
                Open saved passage
              </Button>
            )}
          </div>
          {saved && (
            <p role="status">
              {saved.alreadySaved
                ? "This link was already saved."
                : "Capture saved."}
              {saved.noteId && saved.type === "bookmark"
                ? " Your passage is saved as a note."
                : ""}
            </p>
          )}
        </form>
        <details className="capture-setup">
          <summary>Save from your browser</summary>
          <p>
            Copy the bookmarklet into the URL of a browser bookmark. Open a
            page, select any text you want to keep, then use that bookmark.
          </p>
          <Button
            variant="outline"
            disabled={!origin}
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(bookmarklet(origin));
                setCopied(true);
              } catch {
                setError(
                  "Clipboard access was unavailable. Use the link or text fields above.",
                );
              }
            }}
          >
            <Copy size={16} />
            {copied ? "Copied" : "Copy bookmarklet"}
          </Button>
          <p role="status" className="sr-only">
            {copied ? "Bookmarklet copied." : ""}
          </p>
          <p>
            Installed apps can receive links from the system share menu where
            supported. On other devices, paste the link here.
          </p>
        </details>
      </main>
    </div>
  );
}
