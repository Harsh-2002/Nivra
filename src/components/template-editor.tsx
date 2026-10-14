"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  Check,
  ChevronsUpDown,
  Eye,
  Loader2,
  Save,
  Trash2,
} from "lucide-react";
import { api } from "@/lib/client";
import { canonicalizeTaskLinks } from "@/lib/writing";
import {
  emptyDocument,
  type Document,
  type JournalPeriod,
  type NoteSummary,
  type WritingTemplate,
} from "@/lib/types";
import { useConfirm } from "./confirm-provider";
import { NoteContent } from "./note-content";
import { SectionHeading } from "./section-heading";
import { Button } from "./ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "./ui/command";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldSet,
  FieldTitle,
} from "./ui/field";
import { Input } from "./ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import { Textarea } from "./ui/textarea";
import type { EditorTools } from "./editor";

const Editor = dynamic(() => import("./editor"), {
  ssr: false,
  loading: () => (
    <div
      className="flex min-h-56 items-center justify-center text-sm text-muted-foreground"
      role="status"
    >
      Loading template…
    </div>
  ),
});

type Kind = WritingTemplate["kind"];
type Source = Pick<NoteSummary, "id" | "title" | "revision">;

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

const periods: JournalPeriod[] = ["daily", "weekly", "monthly"];

async function searchSources(kind: Kind, query: string): Promise<Source[]> {
  const params = new URLSearchParams({ q: query, limit: "15" });
  if (kind === "note") {
    params.set("view", "all");
    params.set("sort", "updated");
    const page = await api<{ items: Source[] }>(`notes?${params}`);
    return page.items;
  }
  const pages = await Promise.all(
    periods.map((period) =>
      api<{ items: (Source & { updatedAt: number })[] }>(
        `journals?${new URLSearchParams({ q: query, limit: "15", period })}`,
      ),
    ),
  );
  return pages
    .flatMap((page) => page.items)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 15);
}

function SourcePicker({
  kind,
  value,
  disabled,
  onChange,
}: {
  kind: Kind;
  value: Source | null;
  disabled: boolean;
  onChange: (source: Source) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Source[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!open) return;
    let active = true;
    const timer = setTimeout(() => {
      searchSources(kind, query.trim())
        .then((items) => {
          if (!active) return;
          setResults(items);
          setError("");
        })
        .catch((cause) => {
          if (active) setError((cause as Error).message);
        });
    }, 180);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [kind, open, query]);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-label={
            kind === "journal" ? "Journal entry to copy" : "Note to copy"
          }
          aria-expanded={open}
          disabled={disabled}
          className="h-11 w-full justify-between font-normal"
        >
          <span className="truncate">
            {value
              ? value.title || "Untitled"
              : kind === "journal"
                ? "Choose a journal entry"
                : "Choose a note"}
          </span>
          <ChevronsUpDown className="opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-(--radix-popover-trigger-width) min-w-64 p-0"
      >
        <Command shouldFilter={false}>
          <CommandInput
            aria-label={
              kind === "journal" ? "Search journal entries" : "Search notes"
            }
            placeholder={
              kind === "journal" ? "Search entries…" : "Search notes…"
            }
            value={query}
            onValueChange={setQuery}
          />
          <CommandList>
            {error ? (
              <p className="p-3 text-sm text-destructive" role="alert">
                {error}
              </p>
            ) : results === null ? (
              <p className="p-3 text-sm text-muted-foreground" role="status">
                Searching…
              </p>
            ) : (
              <>
                <CommandEmpty>No matches.</CommandEmpty>
                <CommandGroup>
                  {results.map((item) => (
                    <CommandItem
                      key={item.id}
                      value={item.id}
                      onSelect={() => {
                        onChange(item);
                        setOpen(false);
                      }}
                    >
                      <span className="truncate">
                        {item.title || "Untitled"}
                      </span>
                      {value?.id === item.id && <Check className="ml-auto" />}
                    </CommandItem>
                  ))}
                </CommandGroup>
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

export function TemplateEditor({
  kind: initialKind,
  initial,
  registerGuard,
  onNavigation,
  onClose,
  onSaved,
  onDeleted,
}: {
  kind: Kind;
  initial?: WritingTemplate;
  registerGuard: (guard: () => Promise<boolean>) => void;
  onNavigation: () => void;
  onClose: () => void;
  onSaved: (template: WritingTemplate) => void;
  onDeleted: (id: string) => void;
}) {
  const confirm = useConfirm();
  const [kind, setKind] = useState<Kind>(initialKind);
  const [name, setName] = useState(initial?.name || "");
  const [description, setDescription] = useState(initial?.description || "");
  const [document, setDocument] = useState<Document>(
    initial?.document || emptyDocument,
  );
  const [origin, setOrigin] = useState<"blank" | "item">("blank");
  const [source, setSource] = useState<Source | null>(null);
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const nameRef = useRef<HTMLInputElement>(null);
  const [finished, setFinished] = useState(false);
  const [baseline] = useState(() =>
    JSON.stringify(templateSafeDocument(initial?.document || emptyDocument)),
  );
  const fromItem = !initial && origin === "item";
  const dirty =
    !finished &&
    (name !== (initial?.name || "") ||
      description !== (initial?.description || "") ||
      !!source ||
      JSON.stringify(templateSafeDocument(document)) !== baseline);

  useEffect(() => {
    if (window.matchMedia("(pointer: fine)").matches)
      nameRef.current?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    registerGuard(
      async () =>
        !busy &&
        (!dirty ||
          (await confirm({
            title: "Discard unsaved template?",
            description:
              "Your changes have not been saved. Stay here to finish, or discard them before leaving.",
            action: "Discard",
          }))),
    );
    return () => registerGuard(async () => true);
  }, [busy, dirty, confirm, registerGuard]);

  async function close() {
    if (busy) return;
    if (
      dirty &&
      !(await confirm({
        title: "Discard unsaved template?",
        description:
          "Your changes have not been saved. Stay here to finish, or discard them.",
        action: "Discard",
      }))
    )
      return;
    setFinished(true);
    onClose();
  }

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!name.trim() || busy) return;
    if (fromItem && !source) {
      setError(
        kind === "journal"
          ? "Choose the journal entry to copy."
          : "Choose the note to copy.",
      );
      return;
    }
    setBusy(true);
    setError("");
    try {
      const body = {
        name: name.trim(),
        description: description.trim(),
      };
      const result = initial
        ? await api<WritingTemplate>(`templates/${initial.id}`, {
            method: "PATCH",
            body: JSON.stringify({
              revision: initial.revision,
              ...body,
              document: canonicalizeTaskLinks(templateSafeDocument(document)),
            }),
          })
        : await api<WritingTemplate>("templates", {
            method: "POST",
            body: JSON.stringify({
              ...body,
              kind,
              ...(fromItem && source
                ? { sourceNoteId: source.id, sourceRevision: source.revision }
                : {
                    document: canonicalizeTaskLinks(
                      templateSafeDocument(document),
                    ),
                  }),
            }),
          });
      setFinished(true);
      onSaved(result);
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
      setFinished(true);
      onDeleted(initial.id);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const noTools: (tools: EditorTools) => void = () => {};
  const title = initial ? "Edit template" : "New template";

  return (
    <section className="tasks-panel">
      <div
        className="tasks-scroll"
        tabIndex={0}
        role="region"
        aria-label={title}
      >
        <div className="section-content template-editor-page">
          <Button
            type="button"
            variant="ghost"
            className="-ml-3 mb-2 h-11 self-start md:h-9"
            aria-label="Back to templates"
            disabled={busy}
            onClick={() => void close()}
          >
            <ArrowLeft />
            Templates
          </Button>
          <SectionHeading
            title={title}
            description={
              initial
                ? "Changes apply to notes you create from this template later."
                : "A reusable starting point you can create notes or journal entries from."
            }
            onNavigation={onNavigation}
          />
          <form
            className="template-editor-form"
            onSubmit={(event) => void save(event)}
          >
            <FieldGroup>
              <div className="grid gap-5 md:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor="template-name">Name</FieldLabel>
                  <Input
                    ref={nameRef}
                    id="template-name"
                    className="h-11"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    maxLength={80}
                    required
                    disabled={busy}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="template-kind">Type</FieldLabel>
                  <Select
                    value={kind}
                    onValueChange={(value) => {
                      setKind(value as Kind);
                      setSource(null);
                    }}
                    disabled={busy || !!initial}
                  >
                    <SelectTrigger
                      id="template-kind"
                      className="w-full data-[size=default]:h-11"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="note">Note template</SelectItem>
                      <SelectItem value="journal">Journal template</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
              </div>
              <Field>
                <FieldLabel htmlFor="template-description">
                  Description
                  <span className="font-normal text-muted-foreground">
                    (optional)
                  </span>
                </FieldLabel>
                <Textarea
                  id="template-description"
                  className="min-h-20"
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  maxLength={500}
                  disabled={busy}
                />
              </Field>
              {!initial && (
                <Field>
                  <FieldLabel htmlFor="template-origin">Start from</FieldLabel>
                  <Select
                    value={origin}
                    onValueChange={(value) => {
                      setOrigin(value as "blank" | "item");
                      setSource(null);
                    }}
                    disabled={busy}
                  >
                    <SelectTrigger
                      id="template-origin"
                      className="w-full data-[size=default]:h-11"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="blank">A blank page</SelectItem>
                      <SelectItem value="item">
                        {kind === "journal"
                          ? "An existing journal entry"
                          : "An existing note"}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  {fromItem && (
                    <>
                      <SourcePicker
                        kind={kind}
                        value={source}
                        disabled={busy}
                        onChange={setSource}
                      />
                      <FieldDescription>
                        The content and its attachments are copied into the
                        template. Later edits to the original do not change it.
                      </FieldDescription>
                    </>
                  )}
                </Field>
              )}
              {!fromItem && (
                <FieldSet>
                  <div className="flex items-center justify-between gap-3">
                    <FieldTitle id="template-content-label">
                      Template content
                    </FieldTitle>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="h-11 md:h-8"
                      aria-controls="template-editor-content"
                      onClick={() => setPreview((value) => !value)}
                    >
                      <Eye />
                      {preview ? "Edit content" : "Preview"}
                    </Button>
                  </div>
                  <div
                    id="template-editor-content"
                    role="region"
                    aria-labelledby="template-content-label"
                    className="template-editor-content writing-surface"
                  >
                    {preview ? (
                      <NoteContent
                        blocks={
                          previewTemplateDocument(document, "Untitled").blocks
                        }
                      />
                    ) : (
                      <Editor
                        document={document}
                        onChange={setDocument}
                        onTools={noTools}
                        editable={!busy}
                        noteId={initial?.id || ""}
                        allowUpload={false}
                        contentLabel="Template content"
                      />
                    )}
                  </div>
                  <FieldDescription>
                    Use {"{{date}}"}, {"{{time}}"} and {"{{title}}"} to fill in
                    the current values. Linked tasks become unchecked checklist
                    items.
                  </FieldDescription>
                </FieldSet>
              )}
              {error && (
                <p className="text-sm text-destructive" role="alert">
                  {error}
                </p>
              )}
              <div className="template-editor-actions">
                {initial && (
                  <Button
                    type="button"
                    variant="ghost"
                    className="mr-auto h-11 md:h-9"
                    onClick={() => void remove()}
                    disabled={busy}
                  >
                    <Trash2 />
                    Delete
                  </Button>
                )}
                <Button
                  type="button"
                  variant="outline"
                  className="h-11 md:h-9"
                  onClick={() => void close()}
                  disabled={busy}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  className="h-11 md:h-9"
                  disabled={busy || !name.trim()}
                >
                  {busy ? <Loader2 className="animate-spin" /> : <Save />}
                  {initial ? "Save changes" : "Save template"}
                </Button>
              </div>
            </FieldGroup>
          </form>
        </div>
      </div>
    </section>
  );
}
