"use client";

import { useEffect, useRef, useState } from "react";
import {
  BookCopy,
  FileText,
  Loader2,
  Pencil,
  Plus,
  Star,
  X,
} from "lucide-react";
import { api, apiItems } from "@/lib/client";
import type { WritingTemplate } from "@/lib/types";
import { previewTemplateDocument } from "./template-editor";
import { NoteContent } from "./note-content";
import { Button } from "./ui/button";

type TemplateListItem = Omit<WritingTemplate, "document">;

export function TemplatePicker({
  kind,
  onClose,
  onInsert,
  onCreate,
  onEdit,
  onSaveCurrent,
  allowInsert = true,
  createLabel = "Create new note",
}: {
  kind: WritingTemplate["kind"];
  onClose: () => void;
  onInsert: (template: WritingTemplate) => Promise<void>;
  onCreate: (
    template: WritingTemplate,
    idempotencyKey: string,
  ) => Promise<void>;
  onEdit: (template?: WritingTemplate) => void;
  onSaveCurrent?: () => Promise<void> | void;
  allowInsert?: boolean;
  createLabel?: string;
}) {
  const [items, setItems] = useState<TemplateListItem[]>([]);
  const [selected, setSelected] = useState<WritingTemplate | null>(null);
  const [busy, setBusy] = useState(false);
  const [listLoading, setListLoading] = useState(true);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [preferences, setPreferences] = useState<{
    revision: number;
    defaultJournalTemplateId: string | null;
  } | null>(null);
  const createKey = useRef<{ templateId: string; value: string } | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const active = document.activeElement;
    openerRef.current = active instanceof HTMLElement ? active : null;
    headingRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    let active = true;
    void apiItems<TemplateListItem>(`templates?kind=${kind}&limit=100`)
      .then((templates) => {
        if (active) {
          setItems(templates);
          setListLoading(false);
        }
      })
      .catch((cause) => {
        if (active) {
          setError((cause as Error).message);
          setListLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [kind, retry]);

  useEffect(() => {
    if (kind !== "journal") return;
    let active = true;
    void api<{ revision: number; defaultJournalTemplateId: string | null }>(
      "writing/preferences",
    )
      .then((value) => {
        if (active) setPreferences(value);
      })
      .catch((cause) => {
        if (active) setError((cause as Error).message);
      });
    return () => {
      active = false;
    };
  }, [kind, retry]);

  async function select(item: TemplateListItem) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      setSelected(await api<WritingTemplate>(`templates/${item.id}`));
      createKey.current = null;
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function run(action: (template: WritingTemplate) => Promise<void>) {
    if (!selected || busy) return;
    setBusy(true);
    setError("");
    try {
      await action(selected);
      onClose();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function createSelected() {
    if (!selected || busy) return;
    let attempt = createKey.current;
    if (attempt?.templateId !== selected.id) {
      attempt = {
        templateId: selected.id,
        value: crypto.randomUUID(),
      };
      createKey.current = attempt;
    }
    setBusy(true);
    setError("");
    try {
      await onCreate(selected, attempt.value);
      createKey.current = null;
      onClose();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function toggleDefault(template: WritingTemplate) {
    if (!preferences || busy) return;
    setBusy(true);
    setError("");
    try {
      setPreferences(
        await api<{
          revision: number;
          defaultJournalTemplateId: string | null;
        }>("writing/preferences", {
          method: "PATCH",
          body: JSON.stringify({
            revision: preferences.revision,
            defaultJournalTemplateId:
              preferences.defaultJournalTemplateId === template.id
                ? null
                : template.id,
          }),
        }),
      );
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function saveCurrent() {
    if (!onSaveCurrent || busy) return;
    setBusy(true);
    setError("");
    try {
      await onSaveCurrent();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function closePicker() {
    onClose();
    window.requestAnimationFrame(() => {
      const candidates = [
        openerRef.current,
        document.querySelector<HTMLElement>(
          '.list-header [aria-label="Browse templates"]',
        ),
        document.querySelector<HTMLElement>(
          '.note-pane [aria-label="Note actions"]',
        ),
        document.querySelector<HTMLElement>(".note-title"),
        document.querySelector<HTMLElement>(
          '.desktop-navigation [aria-current="page"]',
        ),
      ];
      const target = candidates.find(
        (element) =>
          element?.isConnected &&
          element.getClientRects().length > 0 &&
          !element.matches(":disabled,[aria-disabled='true']"),
      );
      target?.focus({ preventScroll: true });
    });
  }

  return (
    <section
      className="writing-template-picker"
      aria-labelledby="template-picker-title"
    >
      <header className="writing-template-header">
        <div>
          <h2
            ref={headingRef}
            id="template-picker-title"
            tabIndex={-1}
            className="writing-template-focus-heading"
          >
            {kind === "journal" ? "Journal templates" : "Note templates"}
          </h2>
          <p>Choose a starting point or keep writing on a blank page.</p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Close templates"
          onClick={closePicker}
        >
          <X size={17} aria-hidden="true" />
        </Button>
      </header>
      <div className="writing-template-picker-actions">
        {onSaveCurrent && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void saveCurrent()}
            disabled={busy}
          >
            <BookCopy size={14} />
            Save current as template
          </Button>
        )}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => onEdit()}
        >
          <Plus size={14} />
          New template
        </Button>
      </div>
      {error ? (
        <div className="writing-template-empty" role="alert">
          <p>{error}</p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              setError("");
              setListLoading(true);
              setRetry((value) => value + 1);
            }}
          >
            Try again
          </Button>
        </div>
      ) : listLoading || (busy && !selected) ? (
        <p className="writing-template-empty" role="status">
          <Loader2 size={15} className="animate-spin" /> Loading templates…
        </p>
      ) : items.length ? (
        <div className="writing-template-picker-body">
          <ul
            className="writing-template-list"
            aria-label="Available templates"
          >
            {items.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  className={`writing-template-row ${selected?.id === item.id ? "is-selected" : ""}`}
                  onClick={() => void select(item)}
                  aria-pressed={selected?.id === item.id}
                >
                  <FileText size={16} aria-hidden="true" />
                  <span>
                    <strong>{item.name}</strong>
                    {item.description && <small>{item.description}</small>}
                  </span>
                  <span className="writing-template-row-meta">
                    {kind === "journal" &&
                      preferences?.defaultJournalTemplateId === item.id && (
                        <span className="writing-template-default">
                          Default
                        </span>
                      )}
                    <time dateTime={new Date(item.updatedAt).toISOString()}>
                      {new Intl.DateTimeFormat(undefined, {
                        month: "short",
                        day: "numeric",
                      }).format(item.updatedAt)}
                    </time>
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {selected && (
            <div className="writing-template-detail">
              <div className="writing-template-detail-heading">
                <div>
                  <h3>{selected.name}</h3>
                  {selected.description && <p>{selected.description}</p>}
                </div>
                {kind === "journal" && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={busy || !preferences}
                    onClick={() => void toggleDefault(selected)}
                  >
                    <Star
                      size={14}
                      fill={
                        preferences?.defaultJournalTemplateId === selected.id
                          ? "currentColor"
                          : "none"
                      }
                    />
                    {preferences?.defaultJournalTemplateId === selected.id
                      ? "Remove default"
                      : "Use by default"}
                  </Button>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Edit ${selected.name}`}
                  onClick={() => onEdit(selected)}
                >
                  <Pencil size={14} />
                </Button>
              </div>
              <div className="writing-template-preview">
                <NoteContent
                  blocks={
                    previewTemplateDocument(selected.document, "Untitled")
                      .blocks
                  }
                />
              </div>
              {selected.attachments?.length ? (
                <p className="writing-template-note">
                  {selected.attachments.length} attachment
                  {selected.attachments.length === 1 ? "" : "s"} included when
                  creating a new note.
                </p>
              ) : null}
              {error && (
                <p className="writing-inline-error" role="alert">
                  {error}
                </p>
              )}
              <div className="writing-template-actions">
                {allowInsert && (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => void run(onInsert)}
                    disabled={busy || !!selected.attachments?.length}
                    title={
                      selected.attachments?.length
                        ? "Create a new note to copy these attachments."
                        : undefined
                    }
                  >
                    Use in this note
                  </Button>
                )}
                <Button
                  type="button"
                  onClick={() => void createSelected()}
                  disabled={busy}
                >
                  {busy ? <Loader2 size={14} className="animate-spin" /> : null}
                  {createLabel}
                </Button>
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="writing-template-empty">
          <FileText size={19} aria-hidden="true" />
          <p>
            No templates yet. Save a note you use often, then start from it
            here.
          </p>
        </div>
      )}
    </section>
  );
}
