"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  Eye,
  LayoutTemplate,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Star,
  Trash2,
} from "lucide-react";
import { api } from "@/lib/client";
import { useCompletion } from "@/lib/completion-client";
import {
  starterTemplates,
  type StarterTemplate,
} from "@/lib/starter-templates";
import type { JournalPeriod, Page, WritingTemplate } from "@/lib/types";
import { useConfirm } from "./confirm-provider";
import { LoadingState } from "./loading-state";
import { NoteContent } from "./note-content";
import { SectionHeading } from "./section-heading";
import { TemplateEditor, previewTemplateDocument } from "./template-editor";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "./ui/empty";
import { Input } from "./ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";

type TemplateListItem = Omit<WritingTemplate, "document"> & {
  attachmentCount?: number;
};
type Preferences = {
  revision: number;
  defaultJournalTemplateId: string | null;
};
type Editing = { kind: WritingTemplate["kind"]; template?: WritingTemplate };

const kindNames: Record<WritingTemplate["kind"], string> = {
  note: "Note",
  journal: "Journal",
};
const periodNames: Record<JournalPeriod, string> = {
  daily: "Today’s entry",
  weekly: "This week’s entry",
  monthly: "This month’s entry",
};
const pageLimit = 100;
const listCap = 500;

export type TemplateSource = Pick<WritingTemplate, "id" | "revision" | "kind">;

export function TemplatesPanel({
  registerGuard,
  onNavigation,
  onCreate,
}: {
  registerGuard: (guard: () => Promise<boolean>) => void;
  onNavigation: () => void;
  onCreate: (
    template: TemplateSource,
    idempotencyKey: string,
    period?: JournalPeriod,
  ) => Promise<void>;
}) {
  const confirm = useConfirm();
  const [items, setItems] = useState<TemplateListItem[] | null>(null);
  const [preferences, setPreferences] = useState<Preferences | null>(null);
  const [kind, setKind] = useState("all");
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [preview, setPreview] = useState<WritingTemplate | null>(null);
  const [starterPreview, setStarterPreview] = useState<StarterTemplate | null>(
    null,
  );
  const [notice, setNotice] = useState("");
  const noticeRef = useRef<HTMLParagraphElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const sequence = useRef(0);
  const attempt = useRef<{ key: string; id: string } | null>(null);

  const load = useCallback(async () => {
    const current = ++sequence.current;
    try {
      const collected: TemplateListItem[] = [];
      let after: string | null = null;
      do {
        const params = new URLSearchParams({ limit: String(pageLimit) });
        if (after) params.set("after", after);
        const page: Page<TemplateListItem> = await api(`templates?${params}`);
        collected.push(...page.items);
        after = page.next;
      } while (after && collected.length < listCap);
      const defaults = await api<Preferences>("writing/preferences");
      if (current !== sequence.current) return;
      setItems(collected);
      setPreferences(defaults);
      setError("");
    } catch (cause) {
      if (current === sequence.current) setError((cause as Error).message);
    }
  }, []);

  useEffect(() => {
    const requests = sequence;
    const timer = setTimeout(() => void load(), 0);
    return () => {
      clearTimeout(timer);
      requests.current++;
    };
  }, [load]);
  useEffect(() => {
    if (error) errorRef.current?.scrollIntoView({ block: "nearest" });
  }, [error]);
  useEffect(() => {
    if (!notice) return;
    noticeRef.current?.focus({ preventScroll: false });
  }, [notice]);
  useCompletion(undefined, () => {
    if (!editing) void load();
  });

  async function mutate<T>(action: () => Promise<T>) {
    if (busy) return undefined;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      return await action();
    } catch (cause) {
      setError((cause as Error).message);
      return undefined;
    } finally {
      setBusy(false);
    }
  }
  async function open(template: TemplateListItem, mode: "preview" | "edit") {
    const full = await mutate(() =>
      api<WritingTemplate>(`templates/${template.id}`),
    );
    if (!full) return;
    if (mode === "preview") setPreview(full);
    else setEditing({ kind: full.kind, template: full });
  }
  async function create(template: TemplateListItem, period?: JournalPeriod) {
    if (attempt.current?.id !== `${template.id}:${period ?? ""}`)
      attempt.current = {
        id: `${template.id}:${period ?? ""}`,
        key: crypto.randomUUID(),
      };
    const key = attempt.current.key;
    const created = await mutate(async () => {
      await onCreate(template, key, period);
      return true;
    });
    if (created) attempt.current = null;
  }
  async function toggleDefault(template: TemplateListItem) {
    if (!preferences) return;
    const next = await mutate(() =>
      api<Preferences>("writing/preferences", {
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
    if (next) setPreferences(next);
  }
  async function addStarter(starter: StarterTemplate) {
    const added = await mutate(() =>
      api<WritingTemplate>("templates", {
        method: "POST",
        body: JSON.stringify({
          name: starter.name,
          description: starter.description,
          kind: starter.kind,
          document: starter.document,
        }),
      }),
    );
    if (!added) return;
    setStarterPreview(null);
    setNotice(`Added “${starter.name}” to your templates.`);
    await load();
  }
  async function remove(template: TemplateListItem) {
    const allowed = await confirm({
      title: `Delete “${template.name}”?`,
      description:
        "This removes the template. Notes already created from it stay unchanged.",
      action: "Delete template",
    });
    if (!allowed) return;
    const deleted = await mutate(() =>
      api(`templates/${template.id}`, {
        method: "DELETE",
        body: JSON.stringify({ revision: template.revision }),
      }),
    );
    if (deleted) {
      setNotice(`Deleted “${template.name}”.`);
      await load();
    }
  }

  const needle = query.trim().toLowerCase();
  const visible = (items ?? []).filter(
    (item) =>
      (kind === "all" || item.kind === kind) &&
      (!needle ||
        item.name.toLowerCase().includes(needle) ||
        item.description.toLowerCase().includes(needle)),
  );
  const filtered = !!needle || kind !== "all";
  const starters = starterTemplates.filter(
    (starter) =>
      (kind === "all" || starter.kind === kind) &&
      (!needle ||
        starter.name.toLowerCase().includes(needle) ||
        starter.description.toLowerCase().includes(needle)) &&
      !(items ?? []).some(
        (item) => item.name === starter.name && item.kind === starter.kind,
      ),
  );
  const shown = preview ?? starterPreview;

  if (editing)
    return (
      <TemplateEditor
        key={editing.template?.id ?? "new"}
        kind={editing.kind}
        initial={editing.template}
        registerGuard={registerGuard}
        onNavigation={onNavigation}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          void load();
        }}
        onDeleted={() => {
          setEditing(null);
          void load();
        }}
      />
    );

  return (
    <section className="tasks-panel">
      <div
        className="tasks-scroll"
        tabIndex={0}
        role="region"
        aria-label="Templates"
      >
        <div className="section-content">
          <SectionHeading
            title="Templates"
            description="Reusable starting points for notes and journal entries."
            onNavigation={onNavigation}
          />
          <div className="mb-6 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 md:grid-cols-[auto_minmax(0,1fr)_auto]">
            <Select value={kind} onValueChange={setKind}>
              <SelectTrigger
                className="w-full min-w-0 data-[size=default]:h-11 md:w-auto md:min-w-36"
                aria-label="Template type"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All templates</SelectItem>
                <SelectItem value="note">Note templates</SelectItem>
                <SelectItem value="journal">Journal templates</SelectItem>
              </SelectContent>
            </Select>
            <div className="relative col-span-2 row-start-2 min-w-0 md:col-span-1 md:row-start-auto md:max-w-sm">
              <Search
                className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden="true"
              />
              <Input
                aria-label="Search templates"
                placeholder="Search templates…"
                value={query}
                maxLength={300}
                onChange={(event) => setQuery(event.target.value)}
                className="h-11 pl-9"
              />
            </div>
            <Button
              className="col-start-2 row-start-1 h-11 md:col-start-auto md:row-start-auto"
              disabled={busy || !items}
              onClick={() =>
                setEditing({ kind: kind === "journal" ? "journal" : "note" })
              }
            >
              <Plus />
              New template
            </Button>
          </div>
          {notice && (
            <p
              ref={noticeRef}
              tabIndex={-1}
              role="status"
              className="mb-5 text-sm outline-none"
            >
              {notice}
            </p>
          )}
          {error && (
            <div
              ref={errorRef}
              className="mb-5 flex flex-wrap items-center gap-3"
              role="alert"
            >
              <p className="text-sm text-destructive">{error}</p>
              <Button variant="outline" onClick={() => void load()}>
                Try again
              </Button>
            </div>
          )}
          {items === null ? (
            !error && <LoadingState kind="trash" label="Loading templates" />
          ) : !visible.length ? (
            <Empty className="border">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <LayoutTemplate />
                </EmptyMedia>
                <EmptyTitle>
                  {filtered ? "No matching templates" : "No templates yet"}
                </EmptyTitle>
                <EmptyDescription>
                  {filtered
                    ? "Try another search or template type."
                    : "Create a template for notes or journal entries you write again and again."}
                </EmptyDescription>
              </EmptyHeader>
              <Button
                variant="outline"
                onClick={() => {
                  if (filtered) {
                    setQuery("");
                    setKind("all");
                  } else setEditing({ kind: "note" });
                }}
              >
                {filtered ? "Clear filters" : "New template"}
              </Button>
            </Empty>
          ) : (
            <>
              <ul
                className="space-y-3 md:space-y-0"
                aria-label="Templates"
                aria-busy={busy}
              >
                {visible.map((item) => {
                  const isDefault =
                    preferences?.defaultJournalTemplateId === item.id;
                  return (
                    <li
                      key={item.id}
                      className="grid grid-cols-1 gap-3 rounded-xl border px-4 py-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-center md:gap-x-3 md:rounded-none md:border-0 md:border-t md:py-4"
                    >
                      <div className="min-w-0">
                        <div className="flex min-w-0 flex-wrap items-center gap-2">
                          <h2 className="min-w-0 text-sm font-medium [overflow-wrap:anywhere]">
                            {item.name}
                          </h2>
                          <Badge variant="secondary">
                            {kindNames[item.kind]}
                          </Badge>
                          {isDefault && (
                            <Badge variant="outline">Default</Badge>
                          )}
                        </div>
                        {item.description && (
                          <p className="mt-1 line-clamp-2 text-sm text-muted-foreground [overflow-wrap:anywhere]">
                            {item.description}
                          </p>
                        )}
                        <p className="mt-1 text-xs text-muted-foreground">
                          Updated{" "}
                          <time
                            dateTime={new Date(item.updatedAt).toISOString()}
                          >
                            {new Date(item.updatedAt).toLocaleDateString(
                              undefined,
                              {
                                month: "short",
                                day: "numeric",
                                year: "numeric",
                              },
                            )}
                          </time>
                          {item.attachmentCount
                            ? ` · ${item.attachmentCount} ${item.attachmentCount === 1 ? "attachment" : "attachments"}`
                            : ""}
                        </p>
                      </div>
                      <div className="flex items-center gap-2 [&>button:first-child]:flex-1 md:[&>button:first-child]:flex-none">
                        {item.kind === "journal" ? (
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button
                                variant="outline"
                                className="h-11 md:h-9"
                                disabled={busy}
                              >
                                Write entry
                                <ChevronDown />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              {(
                                Object.keys(periodNames) as JournalPeriod[]
                              ).map((period) => (
                                <DropdownMenuItem
                                  key={period}
                                  onSelect={() => void create(item, period)}
                                >
                                  {periodNames[period]}
                                </DropdownMenuItem>
                              ))}
                            </DropdownMenuContent>
                          </DropdownMenu>
                        ) : (
                          <Button
                            variant="outline"
                            className="h-11 md:h-9"
                            disabled={busy}
                            onClick={() => void create(item)}
                          >
                            Create note
                          </Button>
                        )}
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-11 md:size-8"
                              disabled={busy}
                              aria-label={`Actions for ${item.name}`}
                            >
                              <MoreHorizontal />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem
                              onSelect={() => void open(item, "preview")}
                            >
                              <Eye />
                              Preview
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onSelect={() => void open(item, "edit")}
                            >
                              <Pencil />
                              Edit
                            </DropdownMenuItem>
                            {item.kind === "journal" && (
                              <DropdownMenuItem
                                disabled={!preferences}
                                onSelect={() => void toggleDefault(item)}
                              >
                                <Star />
                                {isDefault
                                  ? "Remove default"
                                  : "Use by default"}
                              </DropdownMenuItem>
                            )}
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              variant="destructive"
                              onSelect={() => void remove(item)}
                            >
                              <Trash2 />
                              Delete
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </li>
                  );
                })}
              </ul>
              <p className="mt-5 text-sm text-muted-foreground tabular-nums">
                {visible.length.toLocaleString()}{" "}
                {visible.length === 1 ? "template" : "templates"}
              </p>
            </>
          )}
          {items !== null && starters.length > 0 && (
            <div className="mt-10">
              <h2 className="text-base font-medium">Starter templates</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Add one to your templates, then edit it to suit you.
              </p>
              <ul className="mt-4 space-y-3 md:space-y-0">
                {starters.map((starter) => (
                  <li
                    key={`${starter.kind}:${starter.name}`}
                    className="grid grid-cols-1 gap-3 rounded-xl border px-4 py-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-center md:gap-x-3 md:rounded-none md:border-0 md:border-t md:py-4"
                  >
                    <div className="min-w-0">
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <h3 className="min-w-0 text-sm font-medium [overflow-wrap:anywhere]">
                          {starter.name}
                        </h3>
                        <Badge variant="secondary">
                          {kindNames[starter.kind]}
                        </Badge>
                      </div>
                      <p className="mt-1 line-clamp-2 text-sm text-muted-foreground [overflow-wrap:anywhere]">
                        {starter.description}
                      </p>
                    </div>
                    <div className="grid grid-cols-2 gap-2 md:flex md:items-center">
                      <Button
                        variant="outline"
                        className="h-11 md:h-9"
                        disabled={busy}
                        aria-label={`Preview ${starter.name}`}
                        onClick={() => setStarterPreview(starter)}
                      >
                        <Eye />
                        Preview
                      </Button>
                      <Button
                        variant="outline"
                        className="h-11 md:h-9"
                        disabled={busy}
                        aria-label={`Add ${starter.name} to my templates`}
                        onClick={() => void addStarter(starter)}
                      >
                        <Plus />
                        Add
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
      <Dialog
        open={!!shown}
        onOpenChange={(open) => {
          if (!open) {
            setPreview(null);
            setStarterPreview(null);
          }
        }}
      >
        <DialogContent className="max-h-[calc(100dvh-4rem)] grid-rows-[auto_minmax(0,1fr)_auto] sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{shown?.name}</DialogTitle>
            <DialogDescription>
              {shown?.description ||
                `${shown ? kindNames[shown.kind] : ""} template preview`}
            </DialogDescription>
          </DialogHeader>
          <div
            className="template-preview scroll-shadow-y min-h-0 overflow-y-auto rounded-lg border p-4"
            tabIndex={0}
            role="region"
            aria-label={`${shown?.name ?? "Template"} preview`}
          >
            {shown && (
              <NoteContent
                blocks={previewTemplateDocument(
                  shown.document,
                  "Untitled",
                ).blocks.filter(
                  (block) =>
                    block.type !== "paragraph" ||
                    (Array.isArray(block.content) && block.content.length > 0),
                )}
              />
            )}
          </div>
          <DialogFooter>
            {starterPreview ? (
              <Button
                disabled={busy}
                onClick={() => void addStarter(starterPreview)}
              >
                <Plus />
                Add to my templates
              </Button>
            ) : (
              <Button
                variant="outline"
                onClick={() => {
                  if (!preview) return;
                  setEditing({ kind: preview.kind, template: preview });
                  setPreview(null);
                }}
              >
                <Pencil />
                Edit
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
