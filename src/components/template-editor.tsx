"use client";

import dynamic from "next/dynamic";
import { useState } from "react";
import { Eye, Loader2, Save, Trash2, X } from "lucide-react";
import { api } from "@/lib/client";
import { canonicalizeTaskLinks } from "@/lib/writing";
import {
  emptyDocument,
  type Document,
  type WritingTemplate,
} from "@/lib/types";
import { useConfirm } from "./confirm-provider";
import { NoteContent } from "./note-content";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Textarea } from "./ui/textarea";
import type { EditorTools } from "./editor";

const Editor = dynamic(() => import("./editor"), {
  ssr: false,
  loading: () => (
    <div className="writing-template-editor-loading" role="status">
      Loading template…
    </div>
  ),
});

type Kind = WritingTemplate["kind"];

function templateSafeDocument(document: Document): Document {
  const visit = (blocks: unknown[]): unknown[] =>
    blocks.map((value) => {
      if (!value || typeof value !== "object") return value;
      const block = value as Record<string, unknown>;
      const props = (block.props || {}) as Record<string, unknown>;
      const children = Array.isArray(block.children)
        ? visit(block.children)
        : block.children;
      if (block.type === "taskLink") {
        const title =
          typeof props.fallbackTitle === "string" ? props.fallbackTitle : "";
        return {
          ...block,
          type: "checkListItem",
          props: { checked: false },
          content: title ? [{ type: "text", text: title, styles: {} }] : [],
          ...(children ? { children } : {}),
        };
      }
      return { ...block, ...(children ? { children } : {}) };
    });
  return {
    schemaVersion: 1,
    blocks: visit(document.blocks) as Document["blocks"],
  };
}

export function previewTemplateDocument(
  document: Document,
  title = "Untitled",
): Document {
  const now = new Date();
  const tokens: Record<string, string> = {
    date: new Intl.DateTimeFormat(undefined, {
      year: "numeric",
      month: "long",
      day: "numeric",
    }).format(now),
    time: new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit",
    }).format(now),
    title,
  };
  const replace = (value: unknown): unknown => {
    if (typeof value === "string")
      return value.replace(
        /\{\{\s*(date|time|title)\s*\}\}/gi,
        (match, key: string) => tokens[key.toLowerCase()] ?? match,
      );
    if (Array.isArray(value)) return value.map(replace);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([key, child]) => [key, replace(child)]),
      );
    return value;
  };
  return templateSafeDocument(replace(document) as Document);
}

export function insertableTemplateBlocks(
  document: Document,
): Document["blocks"] {
  const stripIds = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stripIds);
    if (!value || typeof value !== "object") return value;
    const block = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(block)
        .filter(([key]) => key !== "id")
        .map(([key, child]) => [key, stripIds(child)]),
    );
  };
  return stripIds(templateSafeDocument(document).blocks) as Document["blocks"];
}

export function TemplateEditor({
  kind,
  initial,
  source,
  onClose,
  onSaved,
  onDeleted,
}: {
  kind: Kind;
  initial?: WritingTemplate;
  source?: { noteId: string; revision: number };
  onClose: () => void;
  onSaved: (template: WritingTemplate) => void;
  onDeleted?: (id: string) => void;
}) {
  const confirm = useConfirm();
  const [name, setName] = useState(initial?.name || "");
  const [description, setDescription] = useState(initial?.description || "");
  const [document, setDocument] = useState<Document>(
    initial?.document || emptyDocument,
  );
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const isSource = !!source && !initial;

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      const saved = initial
        ? await api<WritingTemplate>(`templates/${initial.id}`, {
            method: "PATCH",
            body: JSON.stringify({
              revision: initial.revision,
              name: name.trim(),
              description: description.trim(),
              document: canonicalizeTaskLinks(templateSafeDocument(document)),
            }),
          })
        : await api<WritingTemplate>("templates", {
            method: "POST",
            body: JSON.stringify({
              name: name.trim(),
              description: description.trim(),
              kind,
              ...(source
                ? {
                    sourceNoteId: source.noteId,
                    sourceRevision: source.revision,
                  }
                : {
                    document: canonicalizeTaskLinks(
                      templateSafeDocument(document),
                    ),
                  }),
            }),
          });
      onSaved(saved);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!initial || busy) return;
    const allowed = await confirm({
      title: `Delete “${initial.name}”?`,
      description:
        "This removes the template. Notes already created from it stay unchanged.",
      action: "Delete template",
    });
    if (!allowed) return;
    setBusy(true);
    setError("");
    try {
      await api(`templates/${initial.id}`, {
        method: "DELETE",
        body: JSON.stringify({ revision: initial.revision }),
      });
      onDeleted?.(initial.id);
      onClose();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const noTools: (tools: EditorTools) => void = () => {};

  return (
    <section
      className="writing-template-editor"
      aria-labelledby="template-editor-title"
    >
      <header className="writing-template-header">
        <div>
          <h2 id="template-editor-title">
            {initial
              ? "Edit template"
              : isSource
                ? "Save as template"
                : "New template"}
          </h2>
          <p>
            {kind === "journal"
              ? "A starting point for journal entries."
              : "A reusable starting point for notes."}
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Close template editor"
          onClick={onClose}
        >
          <X size={17} />
        </Button>
      </header>
      <form
        className="writing-template-form"
        onSubmit={(event) => void save(event)}
      >
        <div className="writing-template-fields">
          <div className="writing-template-field">
            <Label htmlFor="template-name">Name</Label>
            <Input
              id="template-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={80}
              required
              disabled={busy}
            />
          </div>
          <div className="writing-template-field">
            <Label htmlFor="template-description">
              Description{" "}
              <span className="text-muted-foreground">(optional)</span>
            </Label>
            <Textarea
              id="template-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              maxLength={500}
              disabled={busy}
            />
          </div>
        </div>
        {isSource ? (
          <p className="writing-template-note">
            The current note and its attachments will be copied into this
            template.
          </p>
        ) : (
          <div className="writing-template-content">
            <div className="writing-template-content-heading">
              <Label>Template content</Label>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setPreview((value) => !value)}
              >
                <Eye size={14} />
                {preview ? "Edit content" : "Preview"}
              </Button>
            </div>
            {preview ? (
              <div className="writing-template-preview">
                <NoteContent
                  blocks={previewTemplateDocument(document, "Untitled").blocks}
                />
              </div>
            ) : (
              <Editor
                document={document}
                onChange={setDocument}
                onTools={noTools}
                editable={!busy}
                noteId={initial?.id || ""}
                allowUpload={false}
              />
            )}
            <p className="writing-template-note">
              Use &#123;&#123;date&#125;&#125;, &#123;&#123;time&#125;&#125; and
              &#123;&#123;title&#125;&#125; to fill in the current values.
              Linked tasks become unchecked checklist items.
            </p>
          </div>
        )}
        {error && (
          <p className="writing-inline-error" role="alert">
            {error}
          </p>
        )}
        <footer className="writing-template-actions">
          {initial && (
            <Button
              type="button"
              variant="ghost"
              className="mr-auto"
              onClick={() => void remove()}
              disabled={busy}
            >
              <Trash2 size={14} />
              Delete
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={busy || !name.trim()}>
            {busy ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Save size={14} />
            )}
            {initial ? "Save changes" : "Save template"}
          </Button>
        </footer>
      </form>
    </section>
  );
}
