import { remapDocument } from "@/lib/document";
import { exportBookmarkBundle } from "@/lib/server/bookmarks";
import { syncNoteLinks } from "@/lib/server/connections";
import { sqlite } from "@/lib/server/db";
import { safeName } from "@/lib/server/file-response";
import { HttpError } from "@/lib/server/http";
import { importItemTags, itemTags } from "@/lib/server/item-tags";
import { enqueueJob } from "@/lib/server/jobs";
import { bookmarkUrl, imageMime } from "@/lib/server/link-metadata";
import { getNote } from "@/lib/server/notes";
import { storage } from "@/lib/server/storage";
import { listTasks } from "@/lib/server/tasks";
import { calendarDate, documentInput } from "@/lib/server/validation";
import { tagColors } from "@/lib/tags";
import {
  taskRecurrenceRuleSchema,
  taskScheduleIssueSchema,
  taskScheduleSchema,
} from "../task-planning";
import {
  ArticleContentBoundsError,
  articleContentSchema,
  assertArticleContentTreeWithinBounds,
} from "../bookmark-reading";
import { journalPeriodSchema, writingPlainText } from "../writing";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { taskStages } from "../boards";
import {
  exportCalendarBundle,
  importCalendarBundle,
  portableCalendar,
  stageCalendarFiles,
} from "./calendar-bundle";

import type { ContentCommand, ContentResult } from "./content-service";
const result = (data: unknown, status = 200): ContentResult => ({
  data,
  status,
});
type Attachment = {
  id: string;
  note_id: string;
  name: string;
  mime: string;
  size: number;
  storage_key: string;
  created_at: number;
};
const filesFor = (id: string) =>
  sqlite()
    .prepare("SELECT * FROM attachments WHERE note_id=?")
    .all(id) as Attachment[];
function remapLinkedTaskBlocks(
  document: unknown,
  sourceNoteId: string,
  taskIds: Map<string, string>,
  links: Map<string, string | null>,
) {
  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(visit);
    if (!value || typeof value !== "object") return value;
    const block = value as Record<string, unknown>;
    const result = Object.fromEntries(
      Object.entries(block).map(([key, child]) => [key, visit(child)]),
    ) as Record<string, unknown>;
    if (block.type === "taskLink") {
      const props = (result.props ?? {}) as Record<string, unknown>;
      const sourceBlockId = typeof block.id === "string" ? block.id : "";
      const key = `${sourceNoteId}:${sourceBlockId}`;
      const sourceTaskId = links.has(key) ? links.get(key) : null;
      result.props = {
        taskId: sourceTaskId ? (taskIds.get(sourceTaskId) ?? null) : null,
        fallbackTitle:
          typeof props.fallbackTitle === "string" ? props.fallbackTitle : "",
        fallbackChecked: props.fallbackChecked === true,
      };
    }
    return result;
  };
  return visit(document);
}
function containsBlock(document: unknown, id: string, type: string): boolean {
  const visit = (value: unknown): boolean => {
    if (!Array.isArray(value)) return false;
    return value.some((entry) => {
      if (!entry || typeof entry !== "object") return false;
      const block = entry as Record<string, unknown>;
      return (block.id === id && block.type === type) || visit(block.children);
    });
  };
  return (
    !!document &&
    typeof document === "object" &&
    visit((document as { blocks?: unknown }).blocks)
  );
}
function blockIdsOfType(document: unknown, type: string): string[] {
  const ids: string[] = [];
  const visit = (value: unknown) => {
    if (!Array.isArray(value)) return;
    for (const entry of value) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const block = entry as Record<string, unknown>;
      if (block.type === type && typeof block.id === "string")
        ids.push(block.id);
      visit(block.children);
    }
  };
  if (document && typeof document === "object")
    visit((document as { blocks?: unknown }).blocks);
  return ids;
}
function containsType(document: unknown, type: string): boolean {
  const visit = (value: unknown): boolean => {
    if (!Array.isArray(value)) return false;
    return value.some((entry) => {
      if (!entry || typeof entry !== "object") return false;
      const block = entry as Record<string, unknown>;
      return block.type === type || visit(block.children);
    });
  };
  return (
    !!document &&
    typeof document === "object" &&
    visit((document as { blocks?: unknown }).blocks)
  );
}
function needNote(id: string) {
  const note = getNote(id);
  if (!note) throw new HttpError(404, "This note was not found.");
  return note;
}
function zipResponse(files: Record<string, Uint8Array>, name: string) {
  const bytes = zipSync(files);
  return new Response(bytes, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${safeName(name)}.zip"`,
      "Cache-Control": "no-store",
    },
  });
}
export async function executeTransfer(
  command: ContentCommand,
): Promise<ContentResult> {
  const { ownerId, input: payload, method } = command;
  const owner = { id: ownerId };
  const [area, id, action] = command.path;
  const database = sqlite();
  if (area === "export" && id === "bundle" && method === "GET") {
    const rows = database
      .prepare("SELECT id FROM notes WHERE owner_id=?")
      .all(owner.id) as {
      id: string;
    }[];
    const notes = rows.map((n) => needNote(n.id));
    const attachments = database
      .prepare(
        "SELECT a.* FROM attachments a JOIN notes n ON n.id=a.note_id WHERE n.owner_id=?",
      )
      .all(owner.id) as Attachment[];
    const bookmarkExport = await exportBookmarkBundle(owner.id);
    const calendarExport = await exportCalendarBundle(owner.id);
    const files: Record<string, Uint8Array> = {
      ...bookmarkExport.files,
      ...calendarExport.files,
    };
    const templates = (
      database
        .prepare(
          "SELECT id,name,description,kind,document,revision,created_at AS createdAt,updated_at AS updatedAt FROM writing_templates WHERE owner_id=? ORDER BY created_at,id",
        )
        .all(owner.id) as {
        id: string;
        document: string;
        [key: string]: unknown;
      }[]
    ).map((template) => ({
      ...template,
      document: JSON.parse(template.document),
    }));
    const templateAttachments = database
      .prepare(
        "SELECT id,template_id AS templateId,name,mime,size,created_at AS createdAt,storage_key AS storageKey FROM writing_template_attachments WHERE owner_id=? ORDER BY template_id,created_at,id",
      )
      .all(owner.id) as {
      id: string;
      storageKey: string;
      [key: string]: unknown;
    }[];
    for (const file of templateAttachments)
      files[`files/${file.id}`] = await storage.read(file.storageKey);
    const noteTaskLinks = database
      .prepare(
        "SELECT note_id AS noteId,block_id AS blockId,task_id AS taskId,created_at AS createdAt FROM note_task_links WHERE owner_id=? ORDER BY note_id,block_id",
      )
      .all(owner.id);
    const taskSteps = database
      .prepare(
        "SELECT id,task_id AS taskId,text,completed,position,revision,created_at AS createdAt,updated_at AS updatedAt FROM task_steps WHERE owner_id=? ORDER BY task_id,position,id",
      )
      .all(owner.id)
      .map((value) => {
        const step = value as Record<string, unknown>;
        return { ...step, completed: Boolean(step.completed) };
      });
    const writingPreferences = database
      .prepare(
        "SELECT default_journal_template_id AS defaultJournalTemplateId FROM writing_preferences WHERE owner_id=?",
      )
      .get(owner.id) as { defaultJournalTemplateId: string | null } | undefined;
    const bookmarkReading = {
      readStates: database
        .prepare(
          "SELECT id AS bookmarkId,read_at AS readAt,article_status AS articleStatus,article_generation AS articleGeneration,article_version AS articleVersion FROM bookmarks WHERE owner_id=? ORDER BY id",
        )
        .all(owner.id),
      articles: (
        database
          .prepare(
            "SELECT bookmark_id AS bookmarkId,version,source_url AS sourceUrl,captured_at AS capturedAt,title,byline,content_json AS content,plain_text AS plainText,fingerprint FROM bookmark_articles WHERE owner_id=? ORDER BY bookmark_id,version",
          )
          .all(owner.id) as { content: string; [key: string]: unknown }[]
      ).map((article) => ({
        ...article,
        content: JSON.parse(article.content),
      })),
      highlights: database
        .prepare(
          "SELECT id,bookmark_id AS bookmarkId,article_version AS articleVersion,quote,prefix,suffix,start_offset AS startOffset,end_offset AS endOffset,annotation,revision,created_at AS createdAt,updated_at AS updatedAt FROM bookmark_highlights WHERE owner_id=? ORDER BY bookmark_id,article_version,created_at,id",
        )
        .all(owner.id),
    };
    files["manifest.json"] = strToU8(
      JSON.stringify({
        format: "nivra",
        version: 5,
        boards: database
          .prepare(
            "SELECT id,name,archived_at AS archivedAt,revision,created_at AS createdAt,updated_at AS updatedAt FROM task_boards WHERE owner_id=?",
          )
          .all(owner.id),
        calendar: calendarExport.data,
        notes,
        tasks: listTasks(owner.id, true).map((task) => ({
          ...task,
          tags: itemTags("task", task.id),
        })),
        taskSteps,
        bookmarks: bookmarkExport.items,
        bookmarkReading,
        templates,
        templateAttachments: templateAttachments.map(
          ({ storageKey, ...file }) => {
            void storageKey;
            return file;
          },
        ),
        writingPreferences: writingPreferences ?? {
          defaultJournalTemplateId: null,
        },
        noteTaskLinks,
        history: (
          database
            .prepare(
              "SELECT v.note_id AS noteId,v.title,v.document,v.revision,v.created_at AS createdAt FROM note_versions v JOIN notes n ON n.id=v.note_id WHERE n.owner_id=? ORDER BY v.rowid",
            )
            .all(owner.id) as { document: string }[]
        ).map((v) => ({ ...v, document: JSON.parse(v.document) })),
        attachments: attachments.map((f) => ({
          id: f.id,
          note_id: f.note_id,
          name: f.name,
          mime: f.mime,
          size: f.size,
          created_at: f.created_at,
        })),
      }),
    );
    for (const file of attachments)
      files[`files/${file.id}`] = await storage.read(file.storage_key);
    return {
      response: zipResponse(
        files,
        `nivra-${new Date().toISOString().slice(0, 10)}`,
      ),
    };
  }
  if (area === "export" && id === "markdown" && action && method === "POST") {
    const note = needNote(action);
    let { markdown } = z
      .object({ markdown: z.string().max(8 * 1024 * 1024) })
      .parse(payload);
    const files: Record<string, Uint8Array> = {};
    for (const file of filesFor(action)) {
      const name = `files/${file.id}-${safeName(file.name)}`;
      files[name] = await storage.read(file.storage_key);
      markdown = markdown.replace(
        new RegExp(
          String.raw`(?:https?://[^/\s)]+)?/api/(?:v1|nivra)/files/${file.id}`,
          "g",
        ),
        name,
      );
    }
    const visit = async (blocks: Record<string, unknown>[]) => {
      for (const block of blocks) {
        if (block.type === "canvas") {
          const props = (block.props || {}) as { scene?: string };
          const scene = JSON.parse(
            props.scene ||
              '{"type":"excalidraw","version":2,"elements":[],"appState":{},"files":{}}',
          );
          for (const file of Object.values(scene.files || {}) as {
            attachmentId?: string;
            dataURL?: string;
          }[]) {
            if (file.attachmentId) {
              const attachment = filesFor(action).find(
                (f) => f.id === file.attachmentId,
              );
              if (!attachment)
                throw new HttpError(
                  400,
                  "An image in this drawing is missing.",
                );
              file.dataURL = `data:${attachment.mime};base64,${(await storage.read(attachment.storage_key)).toString("base64")}`;
              delete file.attachmentId;
            }
          }
          const sidecar = `drawings/${String(block.id)}.excalidraw`;
          if (!markdown.includes(sidecar))
            markdown += `\n\n[Editable drawing](${sidecar})`;
          files[sidecar] = strToU8(JSON.stringify(scene));
        }
        if (Array.isArray(block.children))
          await visit(block.children as Record<string, unknown>[]);
      }
    };
    await visit(note.document.blocks);
    files[`${safeName(note.title || "Untitled")}.md`] = strToU8(
      `# ${note.title || "Untitled"}\n\n${markdown}`,
    );
    return { response: zipResponse(files, note.title || "Untitled") };
  }
  if (area === "import" && id === "bundle" && method === "POST") {
    const bytes = payload as Uint8Array;
    let size = 0;
    let entries: Record<string, Uint8Array>;
    try {
      entries = unzipSync(bytes, {
        filter: (file) => {
          size += file.originalSize;
          if (size > 150 * 1024 * 1024 || file.originalSize > 100 * 1024 * 1024)
            throw new HttpError(
              413,
              "This archive expands beyond the import limit.",
            );
          return /^(manifest\.json|files\/[a-f0-9-]{36})$/.test(file.name);
        },
      });
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(400, "This file is not a valid Nivra archive.");
    }
    if (!entries["manifest.json"])
      throw new HttpError(400, "Choose a Nivra export bundle.");
    const importedManifest = JSON.parse(strFromU8(entries["manifest.json"]));
    const bookmarkReading =
      importedManifest && typeof importedManifest === "object"
        ? (importedManifest as Record<string, unknown>).bookmarkReading
        : undefined;
    const importedArticles =
      bookmarkReading && typeof bookmarkReading === "object"
        ? (bookmarkReading as Record<string, unknown>).articles
        : undefined;
    if (Array.isArray(importedArticles)) {
      if (importedArticles.length > 50_000)
        throw new HttpError(
          400,
          "The bundle contains too many saved articles.",
        );
      try {
        for (const article of importedArticles) {
          if (!article || typeof article !== "object") continue;
          assertArticleContentTreeWithinBounds(
            (article as Record<string, unknown>).content,
          );
        }
      } catch (error) {
        if (error instanceof ArticleContentBoundsError)
          throw new HttpError(
            400,
            "The bundle contains article content that is too deeply nested or too large.",
          );
        throw error;
      }
    }
    const manifest = z
      .object({
        format: z.literal("nivra"),
        version: z.union([
          z.literal(1),
          z.literal(2),
          z.literal(3),
          z.literal(4),
          z.literal(5),
        ]),
        calendar: portableCalendar.optional(),
        history: z
          .array(
            z.object({
              noteId: z.string().uuid(),
              title: z.string().max(300),
              document: documentInput,
              revision: z.number().int().positive(),
              createdAt: z.number().int().nonnegative(),
            }),
          )
          .max(100000)
          .default([]),
        bookmarks: z
          .array(
            z.object({
              id: z.string().uuid().optional(),
              tags: z
                .array(
                  z.object({
                    name: z.string().trim().min(1).max(50),
                    color: z.enum(tagColors),
                    aliases: z
                      .array(z.string().trim().min(1).max(80))
                      .max(10)
                      .optional(),
                  }),
                )
                .max(100)
                .default([]),
              url: z.string().max(4096).transform(bookmarkUrl),
              title: z.string().trim().min(1).max(300),
              description: z.string().max(2000),
              siteName: z.string().max(100),
              collection: z.string().trim().max(80),
              favorite: z.boolean(),
              metadataStatus: z.enum(["pending", "ready", "unavailable"]),
              trashedAt: z
                .number()
                .int()
                .nonnegative()
                .nullable()
                .default(null),
              titleEdited: z.boolean().default(true),
              descriptionEdited: z.boolean().default(true),
              createdAt: z.number().int().nonnegative(),
              updatedAt: z.number().int().nonnegative(),
              noteId: z.string().uuid().nullable().default(null),
              thumbnail: z
                .object({ id: z.string().uuid(), mime: z.string() })
                .nullable(),
              icon: z
                .object({ id: z.string().uuid(), mime: z.string() })
                .nullable(),
            }),
          )
          .max(10000)
          .default([]),
        boards: z
          .array(
            z.object({
              id: z.string().uuid(),
              name: z.string().trim().min(1).max(80),
              archivedAt: z.number().int().nonnegative().nullable(),
              createdAt: z.number().int().nonnegative(),
              updatedAt: z.number().int().nonnegative(),
            }),
          )
          .max(10000)
          .default([]),
        tasks: z
          .array(
            z.object({
              tags: z
                .array(
                  z.object({
                    name: z.string().trim().min(1).max(50),
                    color: z.enum(tagColors),
                    aliases: z
                      .array(z.string().trim().min(1).max(80))
                      .max(10)
                      .optional(),
                  }),
                )
                .max(100)
                .default([]),
              id: z.string().uuid().optional(),
              title: z.string().trim().min(1).max(300),
              completedAt: z.number().int().nonnegative().nullable(),
              boardId: z.string().uuid().nullable().default(null),
              status: z.enum(taskStages).optional(),
              openStage: z.enum(["todo", "in_progress"]).default("todo"),
              boardPosition: z.number().finite().default(0),
              trashedAt: z
                .number()
                .int()
                .nonnegative()
                .nullable()
                .default(null),
              createdAt: z.number().int().nonnegative(),
              updatedAt: z.number().int().nonnegative(),
              dueDate: calendarDate.nullable().default(null),
              plannedDate: calendarDate.nullable().default(null),
              recurrence: z
                .enum(["daily", "weekly", "monthly"])
                .nullable()
                .default(null),
              recurrenceDay: z
                .number()
                .int()
                .min(1)
                .max(31)
                .nullable()
                .default(null),
              schedule: taskScheduleSchema.nullable().optional().default(null),
              scheduleIssue: taskScheduleIssueSchema.optional().default(null),
              recurrenceRule: taskRecurrenceRuleSchema
                .nullable()
                .optional()
                .default(null),
              parentTaskId: z.string().uuid().nullable().default(null),
              noteId: z.string().uuid().nullable().default(null),
            }),
          )
          .max(10000)
          .default([]),
        taskSteps: z
          .array(
            z.object({
              id: z.string().uuid(),
              taskId: z.string().uuid(),
              text: z.string().trim().min(1).max(300),
              completed: z.boolean(),
              position: z.number().int().min(0).max(99),
              revision: z.number().int().positive(),
              createdAt: z.number().int().nonnegative(),
              updatedAt: z.number().int().nonnegative(),
            }),
          )
          .max(100000)
          .default([]),
        notes: z
          .array(
            z.object({
              id: z.string().uuid(),
              title: z.string().max(300),
              kind: z.enum(["note", "template"]).default("note"),
              dailyDate: calendarDate.nullable().default(null),
              journalPeriod: journalPeriodSchema
                .nullable()
                .optional()
                .default(null),
              journalPeriodStart: calendarDate
                .nullable()
                .optional()
                .default(null),
              editorWidth: z.enum(["standard", "wide"]).default("standard"),
              revision: z.number().int().positive().default(1),
              document: documentInput,
              favorite: z.boolean(),
              trashedAt: z.number().nullable(),
              createdAt: z.number(),
              updatedAt: z.number(),
              tags: z.array(
                z.object({
                  id: z.string().uuid(),
                  name: z.string().min(1).max(50),
                  color: z.enum(tagColors).default("gray"),
                  aliases: z
                    .array(z.string().trim().min(1).max(80))
                    .max(10)
                    .optional(),
                }),
              ),
            }),
          )
          .max(10000),
        noteTaskLinks: z
          .array(
            z.object({
              noteId: z.string().uuid(),
              blockId: z.string().min(1).max(128),
              taskId: z.string().uuid().nullable(),
              createdAt: z.number().int().nonnegative(),
            }),
          )
          .max(100000)
          .default([]),
        templates: z
          .array(
            z.object({
              id: z.string().uuid(),
              name: z.string().trim().min(1).max(80),
              description: z.string().max(2000).default(""),
              kind: z.enum(["note", "journal"]),
              document: documentInput,
              revision: z.number().int().positive().default(1),
              createdAt: z.number().int().nonnegative(),
              updatedAt: z.number().int().nonnegative(),
            }),
          )
          .max(10000)
          .default([]),
        templateAttachments: z
          .array(
            z.object({
              id: z.string().uuid(),
              templateId: z.string().uuid(),
              name: z.string().max(200),
              mime: z.string().max(200),
              size: z.number().int().nonnegative(),
              createdAt: z.number().int().nonnegative(),
            }),
          )
          .max(10000)
          .default([]),
        writingPreferences: z
          .object({ defaultJournalTemplateId: z.string().uuid().nullable() })
          .strict()
          .optional()
          .default({ defaultJournalTemplateId: null }),
        bookmarkReading: z
          .object({
            readStates: z
              .array(
                z.object({
                  bookmarkId: z.string().uuid(),
                  readAt: z.number().int().nonnegative().nullable(),
                  articleStatus: z
                    .enum(["pending", "ready", "unavailable"])
                    .default("unavailable"),
                  articleGeneration: z.number().int().nonnegative().default(0),
                  articleVersion: z.number().int().nonnegative().default(0),
                }),
              )
              .max(10000)
              .default([]),
            articles: z
              .array(
                z.object({
                  bookmarkId: z.string().uuid(),
                  version: z.number().int().positive(),
                  sourceUrl: z.string().url().max(4096),
                  capturedAt: z.number().int().nonnegative(),
                  title: z.string().max(300),
                  byline: z.string().max(200).nullable(),
                  content: articleContentSchema,
                  plainText: z.string().max(200000),
                  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
                }),
              )
              .max(50000)
              .default([]),
            highlights: z
              .array(
                z
                  .object({
                    id: z.string().uuid(),
                    bookmarkId: z.string().uuid(),
                    articleVersion: z.number().int().positive(),
                    quote: z.string().min(1).max(10000),
                    prefix: z.string().max(256),
                    suffix: z.string().max(256),
                    startOffset: z.number().int().min(0).max(200000),
                    endOffset: z.number().int().min(1).max(200000),
                    annotation: z.string().max(3000),
                    revision: z.number().int().positive(),
                    createdAt: z.number().int().nonnegative(),
                    updatedAt: z.number().int().nonnegative(),
                  })
                  .refine((value) => value.endOffset > value.startOffset),
              )
              .max(100000)
              .default([]),
          })
          .strict()
          .optional()
          .default({ readStates: [], articles: [], highlights: [] }),
        attachments: z
          .array(
            z.object({
              id: z.string().uuid(),
              note_id: z.string().uuid(),
              name: z.string().max(200),
              mime: z.string(),
              size: z.number().nonnegative(),
            }),
          )
          .max(10000),
      })
      .parse(importedManifest);
    const noteIds = new Map(manifest.notes.map((n) => [n.id, randomUUID()]));
    const templateIds = new Map(
      manifest.templates.map((item) => [item.id, randomUUID()]),
    );
    const sourceFileIds = [
      ...manifest.attachments.map((file) => file.id),
      ...manifest.templateAttachments.map((file) => file.id),
    ];
    const fileIds = new Map(sourceFileIds.map((id) => [id, randomUUID()]));
    const boardIds = new Map(
      manifest.boards.map((board) => [board.id, randomUUID()]),
    );
    if (boardIds.size !== manifest.boards.length)
      throw new HttpError(400, "The bundle contains duplicate boards.");
    for (const task of manifest.tasks) {
      if (task.boardId && !boardIds.has(task.boardId))
        throw new HttpError(400, "The bundle contains an unavailable board.");
      if (
        task.status &&
        (task.status === "done") !== (task.completedAt !== null)
      )
        throw new HttpError(
          400,
          "The bundle contains conflicting task states.",
        );
    }
    const taskIds = new Map(
      manifest.tasks.map((t) => [t.id || randomUUID(), randomUUID()]),
    );
    if (taskIds.size !== manifest.tasks.length)
      throw new HttpError(
        400,
        "The bundle contains duplicate task identifiers.",
      );
    if (templateIds.size !== manifest.templates.length)
      throw new HttpError(400, "The bundle contains duplicate templates.");
    if (fileIds.size !== sourceFileIds.length)
      throw new HttpError(
        400,
        "The bundle contains duplicate file identifiers.",
      );
    const stepIds = new Set<string>();
    const stepPositions = new Set<string>();
    for (const step of manifest.taskSteps) {
      const positionKey = `${step.taskId}:${step.position}`;
      if (
        !taskIds.has(step.taskId) ||
        stepIds.has(step.id) ||
        stepPositions.has(positionKey)
      )
        throw new HttpError(
          400,
          "The bundle contains invalid task checklist steps.",
        );
      stepIds.add(step.id);
      stepPositions.add(positionKey);
    }
    const linkKeys = new Set<string>();
    for (const link of manifest.noteTaskLinks) {
      const key = `${link.noteId}:${link.blockId}`;
      const note = manifest.notes.find((item) => item.id === link.noteId);
      if (
        !note ||
        note.journalPeriod ||
        note.dailyDate ||
        (link.taskId !== null && !taskIds.has(link.taskId)) ||
        linkKeys.has(key) ||
        !containsBlock(note.document, link.blockId, "taskLink")
      )
        throw new HttpError(400, "The bundle contains an invalid linked task.");
      linkKeys.add(key);
    }
    for (const note of manifest.notes) {
      const blockIds = blockIdsOfType(note.document, "taskLink");
      if (
        new Set(blockIds).size !== blockIds.length ||
        blockIds.some((blockId) => !linkKeys.has(`${note.id}:${blockId}`))
      )
        throw new HttpError(
          400,
          "The bundle contains an unregistered linked task.",
        );
    }
    for (const file of manifest.templateAttachments)
      if (
        !templateIds.has(file.templateId) ||
        !entries[`files/${file.id}`] ||
        entries[`files/${file.id}`].length !== file.size
      )
        throw new HttpError(
          400,
          "The bundle is missing a template attachment.",
        );
    if (
      manifest.writingPreferences.defaultJournalTemplateId &&
      manifest.templates.find(
        (item) =>
          item.id === manifest.writingPreferences.defaultJournalTemplateId,
      )?.kind !== "journal"
    )
      throw new HttpError(
        400,
        "The bundle has an invalid default journal template.",
      );
    const bookmarkSourceIds = new Set(
      manifest.bookmarks.flatMap((item) => (item.id ? [item.id] : [])),
    );
    const readStateIds = new Set<string>();
    for (const state of manifest.bookmarkReading.readStates) {
      if (
        !bookmarkSourceIds.has(state.bookmarkId) ||
        readStateIds.has(state.bookmarkId)
      )
        throw new HttpError(
          400,
          "The bundle contains invalid bookmark reading state.",
        );
      readStateIds.add(state.bookmarkId);
    }
    const articleKeys = new Set<string>();
    const articlesBySourceKey = new Map<
      string,
      (typeof manifest.bookmarkReading.articles)[number]
    >();
    for (const article of manifest.bookmarkReading.articles) {
      const key = `${article.bookmarkId}:${article.version}`;
      const sourceBookmark = manifest.bookmarks.find(
        (item) => item.id === article.bookmarkId,
      );
      if (
        !sourceBookmark ||
        article.sourceUrl !== sourceBookmark.url ||
        articleKeys.has(key)
      )
        throw new HttpError(
          400,
          "The bundle contains an invalid saved article.",
        );
      articleKeys.add(key);
      articlesBySourceKey.set(key, article);
    }
    for (const state of manifest.bookmarkReading.readStates)
      if (
        (state.articleVersion > 0 &&
          !articleKeys.has(`${state.bookmarkId}:${state.articleVersion}`)) ||
        (state.articleStatus === "ready" && state.articleVersion === 0)
      )
        throw new HttpError(
          400,
          "The bundle contains inconsistent bookmark reading state.",
        );
    const highlightIds = new Set<string>();
    const highlightTotals = new Map<string, { count: number; bytes: number }>();
    for (const highlight of manifest.bookmarkReading.highlights) {
      const article = articlesBySourceKey.get(
        `${highlight.bookmarkId}:${highlight.articleVersion}`,
      );
      const text = article?.plainText;
      if (
        !bookmarkSourceIds.has(highlight.bookmarkId) ||
        !articleKeys.has(
          `${highlight.bookmarkId}:${highlight.articleVersion}`,
        ) ||
        highlightIds.has(highlight.id) ||
        text === undefined ||
        highlight.endOffset > text.length ||
        text.slice(highlight.startOffset, highlight.endOffset) !==
          highlight.quote ||
        text.slice(
          Math.max(0, highlight.startOffset - highlight.prefix.length),
          highlight.startOffset,
        ) !== highlight.prefix ||
        text.slice(
          highlight.endOffset,
          highlight.endOffset + highlight.suffix.length,
        ) !== highlight.suffix
      )
        throw new HttpError(
          400,
          "The bundle contains an invalid article highlight.",
        );
      highlightIds.add(highlight.id);
      const total = highlightTotals.get(highlight.bookmarkId) ?? {
        count: 0,
        bytes: 0,
      };
      total.count++;
      total.bytes +=
        Buffer.byteLength(highlight.quote, "utf8") +
        Buffer.byteLength(highlight.annotation, "utf8");
      if (total.count > 1000 || total.bytes > 200_000)
        throw new HttpError(
          422,
          "The bundle exceeds the saved-highlight limit for a bookmark.",
        );
      highlightTotals.set(highlight.bookmarkId, total);
    }
    const historyCounts = new Map<string, number>();
    for (const v of manifest.history) {
      const count = (historyCounts.get(v.noteId) || 0) + 1;
      historyCounts.set(v.noteId, count);
      if (!noteIds.has(v.noteId) || count > 100)
        throw new HttpError(400, "The bundle contains invalid note history.");
    }
    for (const item of [...manifest.tasks, ...manifest.bookmarks])
      if (item.noteId && !noteIds.has(item.noteId))
        throw new HttpError(
          400,
          "The bundle contains an unavailable note connection.",
        );
    for (const task of manifest.tasks)
      if (task.recurrence && !task.dueDate)
        throw new HttpError(400, "A repeating task is missing its due date.");
    const parents = new Map<string, string>();
    const children = new Set<string>();
    for (const task of manifest.tasks) {
      if (!task.parentTaskId) continue;
      if (
        !task.id ||
        !taskIds.has(task.parentTaskId) ||
        children.has(task.parentTaskId)
      )
        throw new HttpError(
          400,
          "The bundle contains an invalid recurring occurrence.",
        );
      children.add(task.parentTaskId);
      parents.set(task.id, task.parentTaskId);
    }
    const checkedTasks = new Set<string>();
    for (const start of parents.keys()) {
      const chain = new Set<string>();
      let cursor: string | undefined = start;
      while (cursor && !checkedTasks.has(cursor)) {
        if (chain.has(cursor))
          throw new HttpError(
            400,
            "The bundle contains a recurring task cycle.",
          );
        chain.add(cursor);
        cursor = parents.get(cursor);
      }
      for (const task of chain) checkedTasks.add(task);
    }
    let dailyConflicts = 0;
    let journalConflicts = 0;
    if (noteIds.size !== manifest.notes.length)
      throw new HttpError(400, "The bundle contains duplicate identifiers.");
    const created: string[] = [];
    let calendarKeys = new Map<string, string>();
    const bookmarkIds = new Map<string, string>();
    const importedBookmarks: {
      item: (typeof manifest.bookmarks)[number];
      thumbnail: string | null;
      icon: string | null;
    }[] = [];
    if (
      new Set(manifest.bookmarks.map((b) => b.url)).size !==
      manifest.bookmarks.length
    )
      throw new HttpError(400, "The bundle contains duplicate bookmarks.");
    try {
      if (manifest.calendar)
        calendarKeys = await stageCalendarFiles(
          manifest.calendar,
          entries,
          created,
        );
      for (const item of manifest.bookmarks) {
        const existing = database
          .prepare("SELECT id FROM bookmarks WHERE owner_id=? AND url=?")
          .get(owner.id, item.url) as { id: string } | undefined;
        if (existing) {
          if (item.id) bookmarkIds.set(item.id, existing.id);
          continue;
        }
        const assets: { thumbnail: string | null; icon: string | null } = {
          thumbnail: null,
          icon: null,
        };
        for (const kind of ["thumbnail", "icon"] as const) {
          const asset = item[kind];
          if (!asset) continue;
          const bytes = entries[`files/${asset.id}`];
          if (
            !bytes ||
            imageMime(Buffer.from(bytes)) !== asset.mime ||
            bytes.length > 2 * 1024 * 1024
          )
            throw new HttpError(
              400,
              "The bundle has a missing or invalid bookmark preview.",
            );
          const key = randomUUID();
          await storage.write(key, bytes);
          created.push(key);
          assets[kind] = key;
        }
        importedBookmarks.push({ item, ...assets });
      }
      for (const file of manifest.attachments) {
        if (
          !noteIds.has(file.note_id) ||
          !entries[`files/${file.id}`] ||
          entries[`files/${file.id}`].length !== file.size
        )
          throw new HttpError(400, "The bundle is missing an attachment.");
        const newId = fileIds.get(file.id)!;
        await storage.write(newId, entries[`files/${file.id}`]);
        created.push(newId);
      }
      for (const file of manifest.templateAttachments) {
        const newId = fileIds.get(file.id)!;
        await storage.write(newId, entries[`files/${file.id}`]);
        created.push(newId);
      }
      database
        .transaction(() => {
          for (const note of manifest.notes) {
            const taskLinkMap = new Map(
              manifest.noteTaskLinks.map((link) => [
                `${link.noteId}:${link.blockId}`,
                link.taskId,
              ]),
            );
            const parsed = remapLinkedTaskBlocks(
              remapDocument(note.document, fileIds, noteIds),
              note.id,
              taskIds,
              taskLinkMap,
            ) as import("../types").Document;
            const wasTemplate = note.kind === "template";
            const journalPeriod = wasTemplate
              ? null
              : (note.journalPeriod ?? (note.dailyDate ? "daily" : null));
            const journalPeriodStart = wasTemplate
              ? null
              : (note.journalPeriodStart ?? note.dailyDate);
            if (journalPeriod && !journalPeriodStart)
              throw new HttpError(
                400,
                "A journal entry is missing its period date.",
              );
            const duplicatePeriod = Boolean(
              journalPeriod &&
              journalPeriodStart &&
              database
                .prepare(
                  "SELECT 1 FROM notes WHERE owner_id=? AND kind='note' AND journal_period=? AND journal_period_start=?",
                )
                .get(owner.id, journalPeriod, journalPeriodStart),
            );
            if (duplicatePeriod) {
              journalConflicts++;
              if (journalPeriod === "daily") dailyConflicts++;
            }
            const savedPeriod = duplicatePeriod ? null : journalPeriod;
            const savedPeriodStart = duplicatePeriod
              ? null
              : journalPeriodStart;
            const dailyDate = savedPeriod === "daily" ? savedPeriodStart : null;
            database
              .prepare(
                "INSERT INTO notes(id,owner_id,title,document,text,favorite,trashed_at,created_at,updated_at,kind,daily_date,revision,editor_width,journal_period,journal_period_start) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
              )
              .run(
                noteIds.get(note.id),
                owner.id,
                note.title,
                JSON.stringify(parsed),
                writingPlainText(parsed),
                Number(note.favorite),
                wasTemplate ? (note.trashedAt ?? Date.now()) : note.trashedAt,
                note.createdAt,
                note.updatedAt,
                "note",
                dailyDate,
                note.revision,
                note.editorWidth,
                savedPeriod,
                savedPeriodStart,
              );
            for (const tag of note.tags) {
              database
                .prepare(
                  "INSERT OR IGNORE INTO tags(id,name,color,aliases) VALUES(?,?,?,?)",
                )
                .run(
                  randomUUID(),
                  tag.name,
                  tag.color,
                  JSON.stringify(tag.aliases ?? []),
                );
              const existing = database
                .prepare("SELECT id FROM tags WHERE name=? COLLATE NOCASE")
                .get(tag.name) as { id: string };
              database
                .prepare("INSERT OR IGNORE INTO note_tags VALUES(?,?)")
                .run(noteIds.get(note.id), existing.id);
            }
          }
          for (const note of manifest.notes)
            syncNoteLinks(
              noteIds.get(note.id)!,
              remapLinkedTaskBlocks(
                remapDocument(note.document, fileIds, noteIds),
                note.id,
                taskIds,
                new Map(
                  manifest.noteTaskLinks.map((link) => [
                    `${link.noteId}:${link.blockId}`,
                    link.taskId,
                  ]),
                ),
              ) as import("../types").Document,
            );
          for (const v of manifest.history)
            database
              .prepare(
                "INSERT INTO note_versions(id,note_id,title,document,revision,created_at) VALUES(?,?,?,?,?,?)",
              )
              .run(
                randomUUID(),
                noteIds.get(v.noteId),
                v.title,
                JSON.stringify(
                  remapLinkedTaskBlocks(
                    remapDocument(v.document, fileIds, noteIds),
                    v.noteId,
                    taskIds,
                    new Map(
                      manifest.noteTaskLinks.map((link) => [
                        `${link.noteId}:${link.blockId}`,
                        link.taskId,
                      ]),
                    ),
                  ),
                ),
                v.revision,
                v.createdAt,
              );
          for (const { item, thumbnail, icon } of importedBookmarks) {
            const bookmarkId = randomUUID();
            if (item.id) bookmarkIds.set(item.id, bookmarkId);
            database
              .prepare(
                `INSERT INTO bookmarks(id,owner_id,url,title,description,site_name,collection,favorite,metadata_status,thumbnail_key,thumbnail_mime,icon_key,icon_mime,created_at,updated_at,note_id,title_edited,description_edited,trashed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
              )
              .run(
                bookmarkId,
                owner.id,
                item.url,
                item.title,
                item.description,
                item.siteName,
                item.collection,
                +item.favorite,
                item.metadataStatus,
                thumbnail,
                item.thumbnail?.mime || null,
                icon,
                item.icon?.mime || null,
                item.createdAt,
                item.updatedAt,
                item.noteId ? noteIds.get(item.noteId) : null,
                +item.titleEdited,
                +item.descriptionEdited,
                item.trashedAt,
              );
            if (!item.trashedAt && item.metadataStatus === "pending")
              enqueueJob(owner.id, "bookmark", bookmarkId);
            importItemTags("bookmark", bookmarkId, item.tags);
          }
          for (const board of manifest.boards)
            database
              .prepare(
                "INSERT INTO task_boards(id,owner_id,name,archived_at,created_at,updated_at) VALUES(?,?,?,?,?,?)",
              )
              .run(
                boardIds.get(board.id),
                owner.id,
                board.name,
                board.archivedAt,
                board.createdAt,
                board.updatedAt,
              );
          for (const [index, task] of manifest.tasks.entries()) {
            const assigned = task.id
              ? taskIds.get(task.id)
              : [...taskIds.values()][index];
            database
              .prepare(
                "INSERT INTO tasks(id,owner_id,title,completed_at,created_at,updated_at,due_date,planned_date,recurrence,recurrence_day,note_id,trashed_at,board_id,open_stage,board_position) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
              )
              .run(
                assigned,
                owner.id,
                task.title,
                task.completedAt,
                task.createdAt,
                task.updatedAt,
                task.dueDate,
                task.plannedDate,
                task.recurrence,
                task.recurrenceDay ||
                  (task.dueDate ? Number(task.dueDate.slice(8)) : null),
                task.noteId ? noteIds.get(task.noteId) : null,
                task.trashedAt,
                task.boardId ? boardIds.get(task.boardId) : null,
                task.status === "in_progress" ? "in_progress" : task.openStage,
                task.boardPosition,
              );
            importItemTags("task", assigned!, task.tags);
            const schedule = task.schedule;
            database
              .prepare(
                "UPDATE tasks SET schedule_start_local=?,schedule_timezone=?,schedule_duration_minutes=?,schedule_disambiguation=?,schedule_issue=?,recurrence_rule_json=? WHERE id=? AND owner_id=?",
              )
              .run(
                schedule?.start ?? null,
                schedule?.timezone ?? null,
                schedule?.durationMinutes ?? null,
                schedule?.disambiguation ?? null,
                task.scheduleIssue ?? null,
                task.recurrenceRule
                  ? JSON.stringify(task.recurrenceRule)
                  : null,
                assigned,
                owner.id,
              );
          }
          for (const task of manifest.tasks)
            if (task.id && task.parentTaskId) {
              if (!taskIds.has(task.parentTaskId))
                throw new HttpError(
                  400,
                  "The bundle contains an unavailable recurring occurrence.",
                );
              database
                .prepare("UPDATE tasks SET parent_task_id=? WHERE id=?")
                .run(taskIds.get(task.parentTaskId), taskIds.get(task.id));
            }
          for (const file of manifest.attachments)
            database
              .prepare("INSERT INTO attachments VALUES(?,?,?,?,?,?,?)")
              .run(
                fileIds.get(file.id),
                noteIds.get(file.note_id),
                file.name,
                file.mime,
                file.size,
                fileIds.get(file.id),
                Date.now(),
              );
          for (const step of manifest.taskSteps)
            database
              .prepare(
                "INSERT INTO task_steps(id,owner_id,task_id,text,completed,position,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
              )
              .run(
                randomUUID(),
                owner.id,
                taskIds.get(step.taskId),
                step.text,
                Number(step.completed),
                step.position,
                step.revision,
                step.createdAt,
                step.updatedAt,
              );
          for (const link of manifest.noteTaskLinks)
            database
              .prepare(
                "INSERT INTO note_task_links(owner_id,note_id,block_id,task_id,created_at) VALUES(?,?,?,?,?)",
              )
              .run(
                owner.id,
                noteIds.get(link.noteId),
                link.blockId,
                link.taskId ? taskIds.get(link.taskId) : null,
                link.createdAt,
              );
          const importedTemplateNames = new Set<string>();
          for (const template of manifest.templates) {
            const document = remapDocument(template.document, fileIds, noteIds);
            if (containsType(document, "taskLink"))
              throw new HttpError(
                400,
                "Templates cannot contain linked tasks.",
              );
            let name = template.name;
            let suffix = 2;
            while (
              importedTemplateNames.has(
                `${template.kind}:${name.toLocaleLowerCase()}`,
              ) ||
              database
                .prepare(
                  "SELECT 1 FROM writing_templates WHERE owner_id=? AND kind=? AND lower(name)=lower(?)",
                )
                .get(owner.id, template.kind, name)
            ) {
              const marker = ` (imported ${suffix++})`;
              name = `${template.name.slice(0, 80 - marker.length)}${marker}`;
            }
            importedTemplateNames.add(
              `${template.kind}:${name.toLocaleLowerCase()}`,
            );
            database
              .prepare(
                "INSERT INTO writing_templates(id,owner_id,name,description,kind,document,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
              )
              .run(
                templateIds.get(template.id),
                owner.id,
                name,
                template.description,
                template.kind,
                JSON.stringify(document),
                template.revision,
                template.createdAt,
                template.updatedAt,
              );
          }
          for (const file of manifest.templateAttachments)
            database
              .prepare(
                "INSERT INTO writing_template_attachments(id,owner_id,template_id,name,mime,size,storage_key,created_at) VALUES(?,?,?,?,?,?,?,?)",
              )
              .run(
                fileIds.get(file.id),
                owner.id,
                templateIds.get(file.templateId),
                file.name,
                file.mime,
                file.size,
                fileIds.get(file.id),
                file.createdAt,
              );
          const defaultTemplateId = manifest.writingPreferences
            .defaultJournalTemplateId
            ? (templateIds.get(
                manifest.writingPreferences.defaultJournalTemplateId,
              ) ?? null)
            : null;
          database
            .prepare(
              "INSERT INTO writing_preferences(owner_id,default_journal_template_id,revision,updated_at) VALUES(?,?,1,?) ON CONFLICT(owner_id) DO UPDATE SET default_journal_template_id=excluded.default_journal_template_id,revision=writing_preferences.revision+1,updated_at=excluded.updated_at",
            )
            .run(owner.id, defaultTemplateId, Date.now());
          const bookmarkVersionMap = new Map<string, number>();
          for (const article of manifest.bookmarkReading.articles) {
            const bookmarkId = bookmarkIds.get(article.bookmarkId);
            if (!bookmarkId) continue;
            const key = `${article.bookmarkId}:${article.version}`;
            const existingArticle = database
              .prepare(
                "SELECT version FROM bookmark_articles WHERE bookmark_id=? AND fingerprint=? LIMIT 1",
              )
              .get(bookmarkId, article.fingerprint) as
              { version: number } | undefined;
            const mappedVersion =
              existingArticle?.version ??
              (
                database
                  .prepare(
                    "SELECT coalesce(max(version),0)+1 AS version FROM bookmark_articles WHERE bookmark_id=?",
                  )
                  .get(bookmarkId) as { version: number }
              ).version;
            bookmarkVersionMap.set(key, mappedVersion);
            if (existingArticle) continue;
            database
              .prepare(
                "INSERT INTO bookmark_articles(bookmark_id,owner_id,version,source_url,captured_at,title,byline,content_json,plain_text,fingerprint) VALUES(?,?,?,?,?,?,?,?,?,?)",
              )
              .run(
                bookmarkId,
                owner.id,
                mappedVersion,
                article.sourceUrl,
                article.capturedAt,
                article.title,
                article.byline,
                JSON.stringify(article.content),
                article.plainText,
                article.fingerprint,
              );
          }
          for (const highlight of manifest.bookmarkReading.highlights) {
            const bookmarkId = bookmarkIds.get(highlight.bookmarkId);
            const articleVersion = bookmarkVersionMap.get(
              `${highlight.bookmarkId}:${highlight.articleVersion}`,
            );
            if (!bookmarkId || !articleVersion) continue;
            database
              .prepare(
                "INSERT INTO bookmark_highlights(id,owner_id,bookmark_id,article_version,quote,prefix,suffix,start_offset,end_offset,annotation,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
              )
              .run(
                randomUUID(),
                owner.id,
                bookmarkId,
                articleVersion,
                highlight.quote,
                highlight.prefix,
                highlight.suffix,
                highlight.startOffset,
                highlight.endOffset,
                highlight.annotation,
                highlight.revision,
                highlight.createdAt,
                highlight.updatedAt,
              );
          }
          for (const state of manifest.bookmarkReading.readStates) {
            const bookmarkId = bookmarkIds.get(state.bookmarkId);
            if (!bookmarkId) continue;
            const importedVersion = state.articleVersion
              ? bookmarkVersionMap.get(
                  `${state.bookmarkId}:${state.articleVersion}`,
                )
              : undefined;
            const maxVersion = (
              database
                .prepare(
                  "SELECT coalesce(max(version),0) AS version FROM bookmark_articles WHERE bookmark_id=?",
                )
                .get(bookmarkId) as { version: number }
            ).version;
            database
              .prepare(
                "UPDATE bookmarks SET read_at=CASE WHEN read_at IS NULL THEN ? WHEN ? IS NULL THEN read_at ELSE max(read_at,?) END,article_version=max(article_version,?),article_status=CASE WHEN ? > 0 THEN 'ready' WHEN ?='pending' AND article_status!='ready' THEN 'unavailable' ELSE article_status END WHERE id=? AND owner_id=?",
              )
              .run(
                state.readAt,
                state.readAt,
                state.readAt,
                importedVersion ?? maxVersion,
                maxVersion,
                state.articleStatus,
                bookmarkId,
                owner.id,
              );
          }
          if (manifest.calendar)
            importCalendarBundle(
              owner.id,
              manifest.calendar,
              { notes: noteIds, tasks: taskIds, bookmarks: bookmarkIds },
              calendarKeys,
            );
        })
        .immediate();
    } catch (error) {
      await Promise.all(created.map((key) => storage.delete(key)));
      throw error;
    }
    return result({
      imported: manifest.notes.length,
      importedTasks: manifest.tasks.length,
      importedBookmarks: importedBookmarks.length,
      dailyConflicts,
      journalConflicts,
    });
  }
  throw new HttpError(404, "This transfer operation was not found.");
}
