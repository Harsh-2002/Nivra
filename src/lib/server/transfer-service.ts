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
import {
  calendarDate,
  documentInput,
  plainText,
} from "@/lib/server/validation";
import { tagColors } from "@/lib/tags";
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
    const rows = database.prepare("SELECT id FROM notes").all() as {
      id: string;
    }[];
    const notes = rows.map((n) => needNote(n.id));
    const attachments = database
      .prepare("SELECT * FROM attachments")
      .all() as Attachment[];
    const bookmarkExport = await exportBookmarkBundle(owner.id);
    const calendarExport = await exportCalendarBundle(owner.id);
    const files: Record<string, Uint8Array> = {
      ...bookmarkExport.files,
      ...calendarExport.files,
      "manifest.json": strToU8(
        JSON.stringify({
          format: "nivra",
          version: 4,
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
          bookmarks: bookmarkExport.items,
          history: (
            database
              .prepare(
                "SELECT note_id AS noteId,title,document,revision,created_at AS createdAt FROM note_versions ORDER BY rowid",
              )
              .all() as { document: string }[]
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
      ),
    };
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
    const manifest = z
      .object({
        format: z.literal("nivra"),
        version: z.union([
          z.literal(1),
          z.literal(2),
          z.literal(3),
          z.literal(4),
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
              parentTaskId: z.string().uuid().nullable().default(null),
              noteId: z.string().uuid().nullable().default(null),
            }),
          )
          .max(10000)
          .default([]),
        notes: z
          .array(
            z.object({
              id: z.string().uuid(),
              title: z.string().max(300),
              kind: z.enum(["note", "template"]).default("note"),
              dailyDate: calendarDate.nullable().default(null),
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
      .parse(JSON.parse(strFromU8(entries["manifest.json"])));
    const noteIds = new Map(manifest.notes.map((n) => [n.id, randomUUID()]));
    const fileIds = new Map(
      manifest.attachments.map((f) => [f.id, randomUUID()]),
    );
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
    if (
      noteIds.size !== manifest.notes.length ||
      fileIds.size !== manifest.attachments.length
    )
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
      database
        .transaction(() => {
          for (const note of manifest.notes) {
            const parsed = remapDocument(note.document, fileIds, noteIds);
            const wasTemplate = note.kind === "template";
            const dailyDate =
              !wasTemplate &&
              note.dailyDate &&
              !database
                .prepare(
                  "SELECT 1 FROM notes WHERE owner_id=? AND daily_date=?",
                )
                .get(owner.id, note.dailyDate)
                ? note.dailyDate
                : null;
            if (note.dailyDate && !dailyDate) dailyConflicts++;
            database
              .prepare(
                "INSERT INTO notes(id,owner_id,title,document,text,favorite,trashed_at,created_at,updated_at,kind,daily_date,revision,editor_width) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
              )
              .run(
                noteIds.get(note.id),
                owner.id,
                note.title,
                JSON.stringify(parsed),
                plainText(parsed.blocks),
                Number(note.favorite),
                wasTemplate ? (note.trashedAt ?? Date.now()) : note.trashedAt,
                note.createdAt,
                note.updatedAt,
                "note",
                dailyDate,
                note.revision,
                note.editorWidth,
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
              remapDocument(note.document, fileIds, noteIds),
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
                JSON.stringify(remapDocument(v.document, fileIds, noteIds)),
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
    });
  }
  throw new HttpError(404, "This transfer operation was not found.");
}
