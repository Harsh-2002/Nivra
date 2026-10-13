import { createHash, randomUUID } from "node:crypto";
import { remapDocument } from "../document";
import {
  canonicalizeTaskLinks,
  journalPeriodStart,
  type JournalPeriod,
  type TaskLinkBlockProps,
  writingPlainText,
} from "../writing";
import type { Document, Note, Page, Task } from "../types";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { writingInputs } from "./writing-contract";
import { db, sqlite } from "./db";
import {
  attachments,
  notes,
  writingPreferences,
  writingTemplateAttachments,
  writingTemplates,
} from "./schema";
import { HttpError } from "./http";
import { checkpoint } from "./note-history";
import { getNote } from "./notes";
import { syncNoteLinks } from "./connections";
import {
  createJournalPeriod,
  journalByPeriod,
  journalReview,
  journalsOnThisDay,
  listJournalPage,
  navigateJournal,
} from "./journal";
import { getTask } from "./tasks";
import { storage } from "./storage";
import { storageOperation } from "./storage-operations";
import type { ContentCommand, ContentResult } from "./content-service";
import { decodeCursor, encodeCursor } from "./pagination";

type Template = {
  id: string;
  ownerId: string;
  name: string;
  description: string;
  kind: "note" | "journal";
  document: Document;
  revision: number;
  createdAt: number;
  updatedAt: number;
};
type AttachmentRow = {
  id: string;
  name: string;
  mime: string;
  size: number;
  storageKey: string;
};
type StagedCopy = AttachmentRow & { createdAt: number };

function result(data: unknown, status = 200): ContentResult {
  return { data, status };
}

function digest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function cleanDocument(document: Document): Document {
  return canonicalizeTaskLinks(document);
}

function collectAttachmentReferences(document: Document) {
  const references = new Set<string>();
  const visit = (value: unknown, key = "") => {
    if (Array.isArray(value))
      return value.forEach((entry) => visit(entry, key));
    if (value && typeof value === "object")
      return Object.entries(value).forEach(([name, entry]) =>
        visit(entry, name),
      );
    if (typeof value !== "string") return;
    if (key === "attachmentId" && /^[a-f0-9-]{36}$/i.test(value)) {
      references.add(value);
      return;
    }
    if (["url", "href", "preview"].includes(key)) {
      const match = value.match(
        /\/api\/(?:v1|nivra)\/files\/([a-f0-9-]{36})(?:[?#].*)?$/i,
      );
      if (match) references.add(match[1]);
    }
  };
  visit(document);
  return references;
}

function mapTaskLinks(
  document: Document,
  map: (block: Record<string, unknown>) => Record<string, unknown>,
): Document {
  const visit = (
    blocks: Record<string, unknown>[],
  ): Record<string, unknown>[] =>
    blocks.map((value) => {
      const block = { ...value };
      if (block.type === "taskLink") return map(block);
      if (Array.isArray(block.children))
        block.children = visit(block.children as Record<string, unknown>[]);
      return block;
    });
  return { ...document, blocks: visit(document.blocks) };
}

function checklistSnapshot(
  block: Record<string, unknown>,
  props: TaskLinkBlockProps,
) {
  return {
    ...block,
    type: "checkListItem",
    props: { checked: props.fallbackChecked },
    content: [{ type: "text", text: props.fallbackTitle, styles: {} }],
  };
}

function snapshotUnknownTaskLinks(document: Document): Document {
  return mapTaskLinks(document, (block) => {
    const props = block.props as Partial<TaskLinkBlockProps> | undefined;
    return checklistSnapshot(block, {
      taskId: null,
      fallbackTitle:
        typeof props?.fallbackTitle === "string" ? props.fallbackTitle : "",
      fallbackChecked: false,
    });
  });
}

export function materializeTaskLinks(
  document: Document,
  owner: string,
  noteId: string,
): Document {
  const propsByBlock = new Map<
    string,
    {
      taskId: string | null;
      title?: string;
      checked?: boolean;
      revision?: number;
      available: boolean;
    }
  >();
  const links = sqlite()
    .prepare(
      "SELECT l.block_id AS blockId,l.task_id AS taskId,t.title,t.completed_at AS completedAt,t.revision,t.trashed_at AS trashedAt FROM note_task_links l LEFT JOIN tasks t ON t.id=l.task_id AND t.owner_id=l.owner_id WHERE l.owner_id=? AND l.note_id=?",
    )
    .all(owner, noteId) as {
    blockId: string;
    taskId: string | null;
    title: string | null;
    completedAt: number | null;
    revision: number | null;
    trashedAt: number | null;
  }[];
  for (const link of links) {
    propsByBlock.set(link.blockId, {
      taskId: link.taskId,
      available: Boolean(
        link.taskId && link.title !== null && link.trashedAt === null,
      ),
      ...(link.title !== null && link.trashedAt === null
        ? { title: link.title }
        : {}),
      ...(link.completedAt !== null && link.trashedAt === null
        ? { checked: true }
        : link.title !== null && link.trashedAt === null
          ? { checked: false }
          : {}),
      ...(link.revision !== null && link.trashedAt === null
        ? { revision: link.revision }
        : {}),
    });
  }
  return mapTaskLinks(document, (block) => {
    const props = (block.props ?? {}) as Record<string, unknown>;
    const linked =
      typeof block.id === "string" ? propsByBlock.get(block.id) : undefined;
    const fallbackTitle =
      typeof props.fallbackTitle === "string" ? props.fallbackTitle : "";
    const fallbackChecked = props.fallbackChecked === true;
    const output: Record<string, unknown> = {
      ...block,
      props: {
        taskId: linked ? linked.taskId : null,
        taskAvailable: linked?.available ?? false,
        fallbackTitle,
        fallbackChecked,
        ...(linked?.available && linked.title !== undefined
          ? { taskTitle: linked.title }
          : {}),
        ...(linked?.available && linked.checked !== undefined
          ? { taskCompleted: linked.checked }
          : {}),
        ...(linked?.available && linked.revision !== undefined
          ? { taskRevision: linked.revision }
          : {}),
      },
    };
    return output;
  });
}

export function canonicalizeExistingTaskLinks(
  document: Document,
  owner: string,
  noteId: string,
): Document {
  const links = sqlite()
    .prepare(
      "SELECT block_id AS blockId,task_id AS taskId FROM note_task_links WHERE owner_id=? AND note_id=?",
    )
    .all(owner, noteId) as { blockId: string; taskId: string | null }[];
  const byBlockId = new Map(links.map((link) => [link.blockId, link]));
  const seen = new Set<string>();
  const visit = (blocks: unknown) => {
    if (!Array.isArray(blocks)) return;
    for (const value of blocks) {
      if (!value || typeof value !== "object") continue;
      const block = value as Record<string, unknown>;
      if (block.type === "taskLink") {
        if (typeof block.id !== "string" || seen.has(block.id))
          throw new HttpError(
            409,
            "Linked task blocks must keep unique block identities.",
          );
        seen.add(block.id);
        if (!byBlockId.has(block.id))
          throw new HttpError(
            409,
            "Create linked tasks with the note’s task action before saving this block.",
          );
      }
      visit(block.children);
    }
  };
  visit(document.blocks);
  return mapTaskLinks(canonicalizeTaskLinks(document), (block) => {
    const link = byBlockId.get(String(block.id));
    if (!link)
      throw new HttpError(
        409,
        "Create linked tasks with the note’s task action before saving this block.",
      );
    const props = (block.props ?? {}) as Record<string, unknown>;
    return { ...block, props: { ...props, taskId: link.taskId } };
  });
}

export function freezeTaskLinks(
  document: Document,
  owner: string,
  noteId: string,
): Document {
  const live = materializeTaskLinks(document, owner, noteId);
  return mapTaskLinks(live, (block) => {
    const props = (block.props ?? {}) as Record<string, unknown>;
    return checklistSnapshot(block, {
      taskId: null,
      fallbackTitle:
        typeof props.taskTitle === "string"
          ? props.taskTitle
          : typeof props.fallbackTitle === "string"
            ? props.fallbackTitle
            : "",
      fallbackChecked:
        typeof props.taskCompleted === "boolean"
          ? props.taskCompleted
          : props.fallbackChecked === true,
    });
  });
}

function removeDerivedTaskProps(document: Document) {
  return cleanDocument(document);
}

function blockText(block: Record<string, unknown>) {
  const content = Array.isArray(block.content)
    ? block.content
        .map((part) =>
          part &&
          typeof part === "object" &&
          typeof (part as Record<string, unknown>).text === "string"
            ? (part as Record<string, unknown>).text
            : "",
        )
        .join(" ")
    : "";
  return content.replace(/\s+/g, " ").trim();
}

function splitTextBlock(block: Record<string, unknown>, selected: string) {
  if (
    !Array.isArray(block.content) ||
    (Array.isArray(block.children) && block.children.length > 0)
  )
    throw new HttpError(400, "Select text within one simple text block.");
  const content = block.content as Record<string, unknown>[];
  if (
    content.some(
      (item) => item.type !== "text" || typeof item.text !== "string",
    )
  )
    throw new HttpError(400, "This selection includes a non-text element.");
  const full = content.map((item) => item.text as string).join("");
  const start = full.indexOf(selected);
  if (start < 0 || full.indexOf(selected, start + selected.length) >= 0)
    throw new HttpError(409, "Select a unique text range within this block.");
  const end = start + selected.length;
  const slice = (from: number, to: number) => {
    const result: Record<string, unknown>[] = [];
    let offset = 0;
    for (const item of content) {
      const text = item.text as string;
      const nextOffset = offset + text.length;
      const localStart = Math.max(from, offset) - offset;
      const localEnd = Math.min(to, nextOffset) - offset;
      if (localEnd > localStart) {
        result.push({ ...item, text: text.slice(localStart, localEnd) });
      }
      offset = nextOffset;
    }
    return result;
  };
  return {
    before: slice(0, start),
    after: slice(end, full.length),
  };
}

function blockById(
  blocks: Record<string, unknown>[],
  id: string,
):
  | {
      block: Record<string, unknown>;
      parent: Record<string, unknown>[];
      index: number;
    }
  | undefined {
  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index];
    if (block.id === id) return { block, parent: blocks, index };
    if (Array.isArray(block.children)) {
      const found = blockById(block.children as Record<string, unknown>[], id);
      if (found) return found;
    }
  }
  return undefined;
}

function taskTitleFromInput(
  block: Record<string, unknown>,
  selectedText?: string,
) {
  const title = selectedText ?? blockText(block);
  const normalized = title.replace(/\s+/g, " ").trim();
  if (!normalized)
    throw new HttpError(400, "Choose non-empty text for the task.");
  if (normalized.length > 300)
    throw new HttpError(400, "Task titles can contain up to 300 characters.");
  return normalized;
}

function taskFromRow(owner: string, id: string): Task | null {
  try {
    return getTask(owner, id);
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) return null;
    throw error;
  }
}

function convertLinkedTask(
  owner: string,
  noteId: string,
  input: {
    revision: number;
    blockId: string;
    title?: string;
    selectedText?: string;
    idempotencyKey: string;
  },
) {
  const database = sqlite();
  const requestHash = digest({
    blockId: input.blockId,
    title: input.title ?? null,
    selectedText: input.selectedText ?? null,
  });
  return database
    .transaction(() => {
      const row = database
        .prepare(
          "SELECT id,title,document,text,revision,kind,daily_date AS dailyDate,journal_period AS journalPeriod,trashed_at AS trashedAt FROM notes WHERE id=? AND owner_id=?",
        )
        .get(noteId, owner) as
        | (Omit<
            Note,
            "tags" | "favorite" | "editorWidth" | "createdAt" | "updatedAt"
          > & { document: Document | string })
        | undefined;
      if (!row || row.trashedAt !== null)
        throw new HttpError(404, "This note was not found.");
      if (row.dailyDate || row.journalPeriod)
        throw new HttpError(
          400,
          "Linked tasks can only be created from a note.",
        );
      const replay = database
        .prepare(
          "SELECT request_hash AS requestHash,block_id AS blockId,task_id AS taskId FROM note_task_idempotency WHERE owner_id=? AND note_id=? AND idempotency_key=?",
        )
        .get(owner, noteId, input.idempotencyKey) as
        | { requestHash: string; blockId: string; taskId: string | null }
        | undefined;
      if (replay) {
        if (replay.requestHash !== requestHash)
          throw new HttpError(
            409,
            "This idempotency key was used for another task.",
          );
        const task = replay.taskId ? taskFromRow(owner, replay.taskId) : null;
        if (!task)
          throw new HttpError(
            409,
            "The task created by this request is no longer available.",
          );
        return {
          note: getNote(noteId)!,
          task,
          created: false,
        };
      }
      if (row.revision !== input.revision)
        throw new HttpError(
          409,
          "This note changed. Reload it before creating a task.",
        );
      const document = removeDerivedTaskProps(
        typeof row.document === "string"
          ? (JSON.parse(row.document) as Document)
          : row.document,
      );
      const found = blockById(document.blocks, input.blockId);
      if (!found) throw new HttpError(404, "This note block was not found.");
      if (found.block.type === "taskLink")
        throw new HttpError(
          409,
          "This note block is already linked to a task.",
        );
      const sourceTitle = taskTitleFromInput(found.block, input.selectedText);
      const title = input.title?.trim() || sourceTitle;
      if (title.length > 300)
        throw new HttpError(
          400,
          "Task titles can contain up to 300 characters.",
        );
      let checked = false;
      let replacementBlocks: Record<string, unknown>[];
      if (input.selectedText !== undefined) {
        const text = splitTextBlock(found.block, input.selectedText);
        checked = false;
        const taskBlockId = randomUUID().replaceAll("-", "");
        const taskBlock: Record<string, unknown> = {
          id: taskBlockId,
          type: "taskLink",
          props: { taskId: null, fallbackTitle: title, fallbackChecked: false },
          content: [],
        };
        replacementBlocks = [];
        if (text.before.length)
          replacementBlocks.push({ ...found.block, content: text.before });
        replacementBlocks.push(taskBlock);
        if (text.after.length)
          replacementBlocks.push({
            ...found.block,
            id: randomUUID().replaceAll("-", ""),
            content: text.after,
          });
        found.parent.splice(found.index, 1, ...replacementBlocks);
        input = { ...input, blockId: taskBlockId };
      } else if (found.block.type === "checkListItem") {
        checked =
          (found.block.props as Record<string, unknown> | undefined)
            ?.checked === true;
        found.block.type = "taskLink";
        found.block.props = {
          taskId: null,
          fallbackTitle: title,
          fallbackChecked: checked,
        };
        found.block.content = [];
      } else {
        throw new HttpError(
          400,
          "Convert a checklist item or select text within a simple text block.",
        );
      }
      const id = randomUUID();
      const linkedBlock = blockById(document.blocks, input.blockId)?.block;
      if (!linkedBlock || linkedBlock.type !== "taskLink")
        throw new HttpError(500, "The linked task block could not be saved.");
      linkedBlock.props = {
        ...(linkedBlock.props as Record<string, unknown>),
        taskId: id,
      };
      const now = Date.now();
      database
        .prepare(
          "INSERT INTO tasks(id,owner_id,title,completed_at,revision,created_at,updated_at,board_id,open_stage,board_position,trashed_at,due_date,planned_date,recurrence,recurrence_day,schedule_start_local,schedule_timezone,schedule_duration_minutes,schedule_disambiguation,schedule_issue,recurrence_rule_json,parent_task_id,note_id) VALUES(?,?,?,?,1,?,?,NULL,?,0,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,?)",
        )
        .run(id, owner, title, checked ? now : null, now, now, "todo", noteId);
      const serialized = JSON.stringify(document);
      const text = writingPlainText(document);
      const update = database
        .prepare(
          "UPDATE notes SET document=?,text=?,revision=revision+1,updated_at=? WHERE id=? AND owner_id=? AND revision=? AND trashed_at IS NULL",
        )
        .run(serialized, text, now, noteId, owner, input.revision);
      if (!update.changes)
        throw new HttpError(
          409,
          "This note changed. Reload it before creating a task.",
        );
      database
        .prepare(
          "INSERT INTO note_task_links(owner_id,note_id,block_id,task_id,created_at) VALUES(?,?,?,?,?)",
        )
        .run(owner, noteId, input.blockId, id, now);
      database
        .prepare(
          "INSERT INTO note_task_idempotency(owner_id,note_id,idempotency_key,request_hash,block_id,task_id,created_at) VALUES(?,?,?,?,?,?,?)",
        )
        .run(
          owner,
          noteId,
          input.idempotencyKey,
          requestHash,
          input.blockId,
          id,
          now,
        );
      const updated = getNote(noteId)!;
      checkpoint(updated, true);
      syncNoteLinks(noteId, document);
      database
        .prepare(
          "INSERT INTO completion_events(owner_id,kind,target_id,status,created_at) VALUES(?,?,?,?,?)",
        )
        .run(owner, "content", id, "changed", now);
      database
        .prepare(
          "INSERT INTO completion_events(owner_id,kind,target_id,status,created_at) VALUES(?,?,?,?,?)",
        )
        .run(owner, "content", noteId, "changed", now);
      database
        .prepare(
          "DELETE FROM completion_events WHERE id <= (SELECT coalesce(max(id),0)-1000 FROM completion_events)",
        )
        .run();
      return { note: updated, task: taskFromRow(owner, id), created: true };
    })
    .immediate();
}

function unlinkTask(
  owner: string,
  noteId: string,
  input: { revision: number; blockId: string },
) {
  const database = sqlite();
  return database
    .transaction(() => {
      const note = database
        .prepare(
          "SELECT id,document,revision,daily_date AS dailyDate,journal_period AS journalPeriod,trashed_at AS trashedAt FROM notes WHERE id=? AND owner_id=?",
        )
        .get(noteId, owner) as
        | {
            id: string;
            document: Document | string;
            revision: number;
            dailyDate: string | null;
            journalPeriod: string | null;
            trashedAt: number | null;
          }
        | undefined;
      if (!note || note.trashedAt !== null)
        throw new HttpError(404, "This note was not found.");
      if (note.dailyDate || note.journalPeriod)
        throw new HttpError(
          400,
          "Linked tasks can only be removed from a note.",
        );
      if (note.revision !== input.revision)
        throw new HttpError(
          409,
          "This note changed. Reload it before unlinking the task.",
        );
      const currentDocument =
        typeof note.document === "string"
          ? (JSON.parse(note.document) as Document)
          : note.document;
      const found = blockById(currentDocument.blocks, input.blockId);
      if (!found || found.block.type !== "taskLink")
        throw new HttpError(404, "This linked task was not found.");
      const props = found.block.props as Record<string, unknown> | undefined;
      const live = database
        .prepare(
          "SELECT l.task_id AS taskId,t.title,t.completed_at AS completedAt,t.trashed_at AS trashedAt FROM note_task_links l LEFT JOIN tasks t ON t.id=l.task_id AND t.owner_id=l.owner_id WHERE l.owner_id=? AND l.note_id=? AND l.block_id=?",
        )
        .get(owner, noteId, input.blockId) as
        | {
            taskId: string | null;
            title: string | null;
            completedAt: number | null;
            trashedAt: number | null;
          }
        | undefined;
      const activeTask =
        live &&
        live.taskId !== null &&
        live.title !== null &&
        live.trashedAt === null
          ? live
          : undefined;
      const fallbackTitle =
        typeof activeTask?.title === "string"
          ? activeTask.title
          : typeof props?.fallbackTitle === "string"
            ? props.fallbackTitle
            : "";
      const snapshot = checklistSnapshot(found.block, {
        taskId: null,
        fallbackTitle,
        fallbackChecked: activeTask
          ? activeTask.completedAt !== null
          : props?.fallbackChecked === true,
      });
      found.parent.splice(found.index, 1, snapshot);
      const document = removeDerivedTaskProps(currentDocument);
      const now = Date.now();
      const changed = database
        .prepare(
          "UPDATE notes SET document=?,text=?,revision=revision+1,updated_at=? WHERE id=? AND owner_id=? AND revision=? AND trashed_at IS NULL",
        )
        .run(
          JSON.stringify(document),
          writingPlainText(document),
          now,
          noteId,
          owner,
          input.revision,
        );
      if (!changed.changes)
        throw new HttpError(
          409,
          "This note changed. Reload it before unlinking the task.",
        );
      database
        .prepare(
          "DELETE FROM note_task_links WHERE owner_id=? AND note_id=? AND block_id=?",
        )
        .run(owner, noteId, input.blockId);
      if (live?.taskId)
        database
          .prepare(
            "UPDATE tasks SET note_id=NULL WHERE id=? AND owner_id=? AND note_id=?",
          )
          .run(live.taskId, owner, noteId);
      const updated = getNote(noteId)!;
      checkpoint(updated, true);
      syncNoteLinks(noteId, document);
      const recordCompletion = database.prepare(
        "INSERT INTO completion_events(owner_id,kind,target_id,status,created_at) VALUES(?,?,?,?,?)",
      );
      if (live?.taskId)
        recordCompletion.run(owner, "content", live.taskId, "changed", now);
      recordCompletion.run(owner, "content", noteId, "changed", now);
      database
        .prepare(
          "DELETE FROM completion_events WHERE id <= (SELECT coalesce(max(id),0)-1000 FROM completion_events)",
        )
        .run();
      return updated;
    })
    .immediate();
}

function ownedNote(owner: string, id: string) {
  const note = sqlite()
    .prepare(
      "SELECT id FROM notes WHERE id=? AND owner_id=? AND kind='note' AND trashed_at IS NULL",
    )
    .get(id, owner) as { id: string } | undefined;
  if (!note) throw new HttpError(404, "This note was not found.");
  return getNote(id)!;
}

function templateRow(owner: string, id: string): Template {
  const row = db()
    .select()
    .from(writingTemplates)
    .where(
      and(eq(writingTemplates.id, id), eq(writingTemplates.ownerId, owner)),
    )
    .get();
  if (!row) throw new HttpError(404, "This writing template was not found.");
  return row as Template;
}

function templateAttachmentRows(owner: string, templateId: string) {
  return sqlite()
    .prepare(
      "SELECT id,name,mime,size,storage_key AS storageKey,created_at AS createdAt FROM writing_template_attachments WHERE owner_id=? AND template_id=? ORDER BY created_at,id",
    )
    .all(owner, templateId) as (AttachmentRow & { createdAt: number })[];
}

function fileRowsForNote(owner: string, noteId: string) {
  return sqlite()
    .prepare(
      "SELECT a.id,a.name,a.mime,a.size,a.storage_key AS storageKey,a.created_at AS createdAt FROM attachments a JOIN notes n ON n.id=a.note_id WHERE a.note_id=? AND n.owner_id=? ORDER BY a.created_at,a.id",
    )
    .all(noteId, owner) as (AttachmentRow & { createdAt: number })[];
}

async function stageAttachmentCopies(
  rows: (AttachmentRow & { createdAt?: number })[],
) {
  const copies: StagedCopy[] = [];
  const mapping = new Map<string, string>();
  try {
    for (const row of rows) {
      const newId = randomUUID();
      const bytes = await storageOperation(async () => {
        const value = await storage.read(row.storageKey);
        await storage.write(newId, value);
        return value.length;
      });
      mapping.set(row.id, newId);
      copies.push({
        id: newId,
        name: row.name,
        mime: row.mime,
        size: bytes,
        storageKey: newId,
        createdAt: Date.now(),
      });
    }
    return { copies, mapping };
  } catch (error) {
    await discardCopies(copies);
    throw error;
  }
}

async function discardCopies(copies: { storageKey: string }[]) {
  await Promise.all(
    copies.map((file) =>
      storageOperation(() => storage.delete(file.storageKey)).catch(
        () => undefined,
      ),
    ),
  );
}

function referencesBoundFiles(document: Document, rows: AttachmentRow[]) {
  const references = collectAttachmentReferences(document);
  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const id of references)
    if (!byId.has(id))
      throw new HttpError(
        400,
        "This document refers to an attachment that is not available.",
      );
  return [...references].map((id) => byId.get(id)!);
}

function safeTemplateDocument(
  document: Document,
  owner?: string,
  noteId?: string,
) {
  const clean = cleanDocument(document);
  return owner && noteId
    ? freezeTaskLinks(clean, owner, noteId)
    : snapshotUnknownTaskLinks(clean);
}

function templateSnapshotFromNote(
  document: Document,
  owner: string,
  noteId: string,
): Document {
  const live = materializeTaskLinks(cleanDocument(document), owner, noteId);
  return mapTaskLinks(live, (block) => {
    const props = (block.props ?? {}) as Record<string, unknown>;
    return checklistSnapshot(block, {
      taskId: null,
      fallbackTitle:
        typeof props.taskTitle === "string"
          ? props.taskTitle
          : typeof props.fallbackTitle === "string"
            ? props.fallbackTitle
            : "",
      fallbackChecked: false,
    });
  });
}

function templateAttachmentResponse(owner: string, id: string) {
  return templateAttachmentRows(owner, id).map(
    ({ id: fileId, name, mime, size }) => ({
      id: fileId,
      name,
      mime,
      size,
    }),
  );
}

function templateDetail(owner: string, id: string) {
  const template = templateRow(owner, id);
  return {
    id: template.id,
    name: template.name,
    description: template.description,
    kind: template.kind,
    document: template.document,
    revision: template.revision,
    createdAt: template.createdAt,
    updatedAt: template.updatedAt,
    attachments: templateAttachmentResponse(owner, id),
  };
}

async function createTemplate(
  owner: string,
  input: ReturnType<typeof writingInputs.templateCreate.parse>,
) {
  let document: Document;
  let sourceFiles: (AttachmentRow & { createdAt?: number })[] = [];
  let sourceRevision: number | undefined;
  if (input.sourceNoteId) {
    const note = ownedNote(owner, input.sourceNoteId);
    if ((note.journalPeriod ? "journal" : "note") !== input.kind)
      throw new HttpError(
        400,
        "Choose a source item that matches this template type.",
      );
    if (note.revision !== input.sourceRevision)
      throw new HttpError(
        409,
        "This note changed. Reload it before saving the template.",
      );
    sourceRevision = note.revision;
    document = templateSnapshotFromNote(note.document, owner, note.id);
    sourceFiles = referencesBoundFiles(
      document,
      fileRowsForNote(owner, note.id),
    );
  } else {
    document = safeTemplateDocument(input.document!);
    if (collectAttachmentReferences(document).size)
      throw new HttpError(
        400,
        "Save a note with its files to include attachments in a template.",
      );
  }
  const { copies, mapping } = await stageAttachmentCopies(sourceFiles);
  const templateDocument = remapDocument(document, mapping);
  const id = randomUUID();
  const now = Date.now();
  try {
    sqlite()
      .transaction(() => {
        if (input.sourceNoteId) {
          const stillCurrent = sqlite()
            .prepare(
              "SELECT revision FROM notes WHERE id=? AND owner_id=? AND trashed_at IS NULL",
            )
            .get(input.sourceNoteId, owner) as { revision: number } | undefined;
          if (!stillCurrent || stillCurrent.revision !== sourceRevision)
            throw new HttpError(
              409,
              "This note changed. Reload it before saving the template.",
            );
        }
        db()
          .insert(writingTemplates)
          .values({
            id,
            ownerId: owner,
            name: input.name,
            description: input.description,
            kind: input.kind,
            document: templateDocument,
            createdAt: now,
            updatedAt: now,
          })
          .run();
        for (const file of copies)
          db()
            .insert(writingTemplateAttachments)
            .values({
              id: file.id,
              ownerId: owner,
              templateId: id,
              name: file.name,
              mime: file.mime,
              size: file.size,
              storageKey: file.storageKey,
              createdAt: file.createdAt,
            })
            .run();
      })
      .immediate();
  } catch (error) {
    await discardCopies(copies);
    throw error;
  }
  return templateDetail(owner, id);
}

function listTemplates(
  owner: string,
  input: ReturnType<typeof writingInputs.templateList.parse>,
): Page<
  Omit<Template, "document" | "ownerId"> & { attachmentCount: number }
> & {
  total: number;
} {
  const limit = input.limit;
  const where = ["owner_id=?"];
  const args: (string | number)[] = [owner];
  if (input.kind) {
    where.push("kind=?");
    args.push(input.kind);
  }
  const cursor = decodeCursor(input.after ?? null, ["number", "string"]);
  if (cursor) {
    where.push("(updated_at,id)<(?,?)");
    args.push(...cursor);
  }
  const rows = sqlite()
    .prepare(
      `SELECT id,name,description,kind,revision,created_at AS createdAt,updated_at AS updatedAt,(SELECT count(*) FROM writing_template_attachments f WHERE f.owner_id=writing_templates.owner_id AND f.template_id=writing_templates.id) AS attachmentCount FROM writing_templates WHERE ${where.join(" AND ")} ORDER BY updated_at DESC,id DESC LIMIT ?`,
    )
    .all(...args, limit + 1) as (Omit<Template, "document" | "ownerId"> & {
    attachmentCount: number;
  })[];
  const count = sqlite()
    .prepare(
      `SELECT count(*) AS total FROM writing_templates WHERE ${input.kind ? "owner_id=? AND kind=?" : "owner_id=?"}`,
    )
    .get(...(input.kind ? [owner, input.kind] : [owner])) as { total: number };
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return {
    items,
    next:
      rows.length > limit && last
        ? encodeCursor([last.updatedAt, last.id])
        : null,
    total: count.total,
  };
}

function updateTemplate(
  owner: string,
  id: string,
  input: ReturnType<typeof writingInputs.templateUpdate.parse>,
) {
  return sqlite()
    .transaction(() => {
      const current = templateRow(owner, id);
      if (current.revision !== input.revision)
        throw new HttpError(
          409,
          "This template changed. Reload it before editing.",
        );
      const document = input.document
        ? safeTemplateDocument(input.document)
        : current.document;
      const existing = templateAttachmentRows(owner, id);
      const references = collectAttachmentReferences(document);
      const byId = new Map(existing.map((file) => [file.id, file]));
      for (const fileId of references)
        if (!byId.has(fileId))
          throw new HttpError(
            400,
            "This template document refers to an unknown file.",
          );
      const removed = existing.filter((file) => !references.has(file.id));
      const updated = db()
        .update(writingTemplates)
        .set({
          name: input.name ?? current.name,
          description: input.description ?? current.description,
          document,
          revision: input.revision + 1,
          updatedAt: Date.now(),
        })
        .where(
          and(
            eq(writingTemplates.id, id),
            eq(writingTemplates.ownerId, owner),
            eq(writingTemplates.revision, input.revision),
          ),
        )
        .returning()
        .get();
      if (!updated)
        throw new HttpError(
          409,
          "This template changed. Reload it before editing.",
        );
      for (const file of removed)
        sqlite()
          .prepare(
            "DELETE FROM writing_template_attachments WHERE owner_id=? AND template_id=? AND id=?",
          )
          .run(owner, id, file.id);
      return { updated: updated as Template, removed };
    })
    .immediate();
}

async function deleteTemplate(owner: string, id: string, revision: number) {
  const files = templateAttachmentRows(owner, id);
  sqlite()
    .transaction(() => {
      const current = templateRow(owner, id);
      if (current.revision !== revision)
        throw new HttpError(
          409,
          "This template changed. Reload it before deleting.",
        );
      sqlite()
        .prepare(
          "UPDATE writing_preferences SET default_journal_template_id=NULL,revision=revision+1,updated_at=? WHERE owner_id=? AND default_journal_template_id=?",
        )
        .run(Date.now(), owner, id);
      const changed = sqlite()
        .prepare(
          "DELETE FROM writing_templates WHERE id=? AND owner_id=? AND revision=?",
        )
        .run(id, owner, revision);
      if (!changed.changes)
        throw new HttpError(
          409,
          "This template changed. Reload it before deleting.",
        );
    })
    .immediate();
  await discardCopies(files);
  return { ok: true };
}

function substituteTemplateTokens(
  document: Document,
  values: { date: string; time: string; title: string },
): Document {
  const replacements: Record<string, string> = {
    "{{date}}": values.date,
    "{{time}}": values.time,
    "{{title}}": values.title,
  };
  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(visit);
    if (!value || typeof value !== "object") return value;
    const object = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(object).map(([key, item]) => [
        key,
        key === "text" && typeof item === "string"
          ? Object.entries(replacements).reduce(
              (text, [token, replacement]) =>
                text.replaceAll(token, replacement),
              item,
            )
          : visit(item),
      ]),
    );
  };
  return visit(document) as Document;
}

function localClock(timezone: string, now = Date.now()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const values = Object.fromEntries(
    parts.map(({ type, value }) => [type, value]),
  );
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    time: `${values.hour}:${values.minute}`,
  };
}

function preference(owner: string) {
  const row = db()
    .select()
    .from(writingPreferences)
    .where(eq(writingPreferences.ownerId, owner))
    .get();
  return {
    revision: row?.revision ?? 0,
    defaultJournalTemplateId: row?.defaultJournalTemplateId ?? null,
  };
}

function updatePreference(
  owner: string,
  input: ReturnType<typeof writingInputs.writingPreferences.parse>,
) {
  return sqlite()
    .transaction(() => {
      if (input.defaultJournalTemplateId) {
        const template = sqlite()
          .prepare(
            "SELECT id FROM writing_templates WHERE id=? AND owner_id=? AND kind='journal'",
          )
          .get(input.defaultJournalTemplateId, owner);
        if (!template)
          throw new HttpError(400, "Choose one of your journal templates.");
      }
      const current = preference(owner);
      if (current.revision !== input.revision)
        throw new HttpError(
          409,
          "Writing preferences changed. Reload them before saving.",
        );
      const now = Date.now();
      if (current.revision === 0) {
        db()
          .insert(writingPreferences)
          .values({
            ownerId: owner,
            defaultJournalTemplateId: input.defaultJournalTemplateId,
            revision: 1,
            updatedAt: now,
          })
          .run();
      } else {
        const changed = db()
          .update(writingPreferences)
          .set({
            defaultJournalTemplateId: input.defaultJournalTemplateId,
            revision: current.revision + 1,
            updatedAt: now,
          })
          .where(
            and(
              eq(writingPreferences.ownerId, owner),
              eq(writingPreferences.revision, input.revision),
            ),
          )
          .run();
        if (!changed.changes)
          throw new HttpError(
            409,
            "Writing preferences changed. Reload them before saving.",
          );
      }
      return preference(owner);
    })
    .immediate();
}

function insertNote(
  owner: string,
  title: string,
  document: Document,
  date: string | null,
  period: JournalPeriod | null,
) {
  const id = randomUUID();
  const now = Date.now();
  const periodStart = period ? journalPeriodStart(date!, period) : null;
  db()
    .insert(notes)
    .values({
      id,
      ownerId: owner,
      title,
      document,
      text: writingPlainText(document),
      dailyDate: period === "daily" ? periodStart : null,
      journalPeriod: period,
      journalPeriodStart: periodStart,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  syncNoteLinks(id, document);
  return getNote(id)!;
}

function addNoteFiles(owner: string, noteId: string, files: StagedCopy[]) {
  for (const file of files)
    db()
      .insert(attachments)
      .values({
        id: file.id,
        noteId,
        name: file.name,
        mime: file.mime,
        size: file.size,
        storageKey: file.storageKey,
        createdAt: file.createdAt,
      })
      .run();
}

function addTemplateApplication(
  owner: string,
  templateId: string,
  key: string,
  requestHash: string,
  noteId: string,
) {
  sqlite()
    .prepare(
      "INSERT INTO writing_template_applications(owner_id,template_id,idempotency_key,request_hash,note_id,created_at) VALUES(?,?,?,?,?,?)",
    )
    .run(owner, templateId, key, requestHash, noteId, Date.now());
}

function priorApplication(
  owner: string,
  templateId: string,
  key: string,
  requestHash: string,
) {
  const row = sqlite()
    .prepare(
      "SELECT request_hash AS requestHash,note_id AS noteId FROM writing_template_applications WHERE owner_id=? AND template_id=? AND idempotency_key=?",
    )
    .get(owner, templateId, key) as
    { requestHash: string; noteId: string | null } | undefined;
  if (!row) return undefined;
  if (row.requestHash !== requestHash)
    throw new HttpError(
      409,
      "This idempotency key was used for another template request.",
    );
  if (!row.noteId)
    throw new HttpError(
      409,
      "The original template result is no longer available.",
    );
  const note = sqlite()
    .prepare(
      "SELECT id FROM notes WHERE id=? AND owner_id=? AND trashed_at IS NULL",
    )
    .get(row.noteId, owner) as { id: string } | undefined;
  if (!note)
    throw new HttpError(
      409,
      "The original template result is no longer available.",
    );
  return getNote(row.noteId)!;
}

async function applyTemplate(
  owner: string,
  id: string,
  input: ReturnType<typeof writingInputs.templateApply.parse>,
) {
  const requestHash = digest({
    revision: input.revision,
    title: input.title ?? null,
    date: input.date ?? null,
    period: input.period ?? null,
    timezone: input.timezone,
  });
  const replay = priorApplication(owner, id, input.idempotencyKey, requestHash);
  if (replay) return { note: replay, created: false };
  const template = templateRow(owner, id);
  if (template.revision !== input.revision)
    throw new HttpError(
      409,
      "This template changed. Reload it before applying it.",
    );
  if (template.kind === "journal" && !input.date)
    throw new HttpError(400, "Choose a date for this journal template.");
  if (template.kind === "note" && (input.date || input.period))
    throw new HttpError(400, "A date is only used for journal templates.");
  const clock = localClock(input.timezone);
  const title = input.title?.trim() || template.name;
  const period = template.kind === "journal" ? (input.period ?? "daily") : null;
  if (period && journalByPeriod(owner, input.date!, period))
    throw new HttpError(409, "A journal entry already exists for this period.");
  const rawFiles = templateAttachmentRows(owner, id);
  const selectedFiles = referencesBoundFiles(template.document, rawFiles);
  const { copies, mapping } = await stageAttachmentCopies(selectedFiles);
  const replaced = substituteTemplateTokens(template.document, {
    date: input.date ?? clock.date,
    time: clock.time,
    title,
  });
  const document = remapDocument(cleanDocument(replaced), mapping);
  try {
    const outcome = sqlite()
      .transaction(() => {
        const replay = priorApplication(
          owner,
          id,
          input.idempotencyKey,
          requestHash,
        );
        if (replay) return { note: replay, created: false };
        const currentTemplate = sqlite()
          .prepare(
            "SELECT revision FROM writing_templates WHERE id=? AND owner_id=?",
          )
          .get(id, owner) as { revision: number } | undefined;
        if (!currentTemplate || currentTemplate.revision !== input.revision)
          throw new HttpError(
            409,
            "This template changed. Reload it before applying it.",
          );
        if (period) {
          const existing = journalByPeriod(owner, input.date!, period);
          if (existing)
            throw new HttpError(
              409,
              "A journal entry already exists for this period.",
            );
        }
        const note = insertNote(
          owner,
          title,
          document,
          input.date ?? null,
          period,
        );
        addNoteFiles(owner, note.id, copies);
        addTemplateApplication(
          owner,
          id,
          input.idempotencyKey,
          requestHash,
          note.id,
        );
        return { note, created: true };
      })
      .immediate();
    if (!outcome.created) await discardCopies(copies);
    return outcome;
  } catch (error) {
    await discardCopies(copies);
    throw error;
  }
}

async function createJournalFromInput(
  owner: string,
  input: ReturnType<typeof writingInputs.journalCreate.parse>,
) {
  const current = journalByPeriod(owner, input.date, input.period);
  const selectedId =
    input.templateId === null
      ? null
      : (input.templateId ?? preference(owner).defaultJournalTemplateId);
  if (current) {
    if (current.trashedAt !== null)
      throw new HttpError(409, "Restore this journal entry from Trash first.");
    if (input.document || input.templateId)
      throw new HttpError(
        409,
        "This journal entry already exists. Read its revision before editing.",
      );
    return { note: current, created: false };
  }
  if (input.templateId === null) {
    return {
      note: createJournalPeriod(owner, input.date, input.period),
      created: true,
    };
  }
  if (!selectedId && !input.document)
    return {
      note: createJournalPeriod(owner, input.date, input.period),
      created: true,
    };
  if (input.document) {
    const document = safeTemplateDocument(input.document);
    if (collectAttachmentReferences(document).size)
      throw new HttpError(
        400,
        "Attach files to a note before creating a journal from them.",
      );
    const note = createJournalPeriod(owner, input.date, input.period, document);
    return { note, created: true };
  }
  const template = templateRow(owner, selectedId!);
  if (template.kind !== "journal")
    throw new HttpError(400, "Choose a journal template.");
  if (
    input.templateRevision !== undefined &&
    input.templateRevision !== template.revision
  )
    throw new HttpError(
      409,
      "This template changed. Reload it before creating the journal.",
    );
  const clock = localClock(input.timezone);
  const title = template.name;
  const files = referencesBoundFiles(
    template.document,
    templateAttachmentRows(owner, template.id),
  );
  const { copies, mapping } = await stageAttachmentCopies(files);
  const replaced = substituteTemplateTokens(template.document, {
    date: input.date,
    time: clock.time,
    title,
  });
  const document = remapDocument(cleanDocument(replaced), mapping);
  try {
    const created = sqlite()
      .transaction(() => {
        const currentTemplate = sqlite()
          .prepare(
            "SELECT revision FROM writing_templates WHERE id=? AND owner_id=? AND kind='journal'",
          )
          .get(template.id, owner) as { revision: number } | undefined;
        if (!currentTemplate || currentTemplate.revision !== template.revision)
          throw new HttpError(
            409,
            "This template changed. Reload it before creating the journal.",
          );
        if (journalByPeriod(owner, input.date, input.period))
          throw new HttpError(
            409,
            "This journal entry already exists. Read its revision before editing.",
          );
        const note = insertNote(
          owner,
          title,
          document,
          input.date,
          input.period,
        );
        addNoteFiles(owner, note.id, copies);
        return note;
      })
      .immediate();
    return { note: created, created: true };
  } catch (error) {
    await discardCopies(copies);
    throw error;
  }
}

function journalPreferences(command: ContentCommand): ContentResult {
  if (command.method === "GET") return result(preference(command.ownerId));
  const value = writingInputs.writingPreferences.parse(command.input);
  return result(updatePreference(command.ownerId, value));
}

function parseQuery<T extends z.ZodTypeAny>(
  schema: T,
  query?: URLSearchParams,
): z.infer<T> {
  return schema.parse(Object.fromEntries(query ?? []));
}

export async function executeWriting(
  command: ContentCommand,
): Promise<ContentResult | null> {
  const { path, method, ownerId: owner } = command;
  const [area, id, action, subId] = path;
  const query = command.query ?? new URLSearchParams();

  if (area === "writing" && id === "preferences" && path.length === 2) {
    if (method !== "GET" && method !== "PATCH")
      throw new HttpError(
        405,
        "This writing preference operation is not supported.",
      );
    return journalPreferences(command);
  }
  if (
    area === "notes" &&
    id &&
    action === "tasks" &&
    path.length === 3 &&
    method === "POST"
  ) {
    const input = writingInputs.linkedTaskCreate.parse(command.input);
    const value = convertLinkedTask(owner, id, input);
    return result(value, value.created ? 201 : 200);
  }
  if (
    area === "notes" &&
    id &&
    action === "tasks" &&
    subId &&
    path.length === 4 &&
    method === "DELETE"
  ) {
    const input = writingInputs.unlinkTask.parse(command.input);
    return result({
      note: unlinkTask(owner, id, { revision: input.revision, blockId: subId }),
    });
  }
  if (area === "templates") {
    if (method === "GET" && !id) {
      const input = parseQuery(writingInputs.templateList, query);
      return result(listTemplates(owner, input));
    }
    if (method === "POST" && !id)
      return result(
        await createTemplate(
          owner,
          writingInputs.templateCreate.parse(command.input),
        ),
        201,
      );
    if (id && !action && method === "GET")
      return result(templateDetail(owner, id));
    if (id && !action && method === "PATCH") {
      const input = writingInputs.templateUpdate.parse(command.input);
      const { updated, removed } = updateTemplate(owner, id, input);
      await discardCopies(removed);
      return result(templateDetail(owner, updated.id));
    }
    if (id && !action && method === "DELETE") {
      const input = z
        .object({ revision: z.number().int().positive() })
        .strict()
        .parse(command.input);
      return result(await deleteTemplate(owner, id, input.revision));
    }
    if (id && action === "apply" && method === "POST") {
      const value = await applyTemplate(
        owner,
        id,
        writingInputs.templateApply.parse(command.input),
      );
      return result(value, value.created ? 201 : 200);
    }
    throw new HttpError(404, "This writing template operation was not found.");
  }
  if (area === "journals") {
    if (method === "POST" && !id) {
      const value = await createJournalFromInput(
        owner,
        writingInputs.journalCreate.parse(command.input),
      );
      return result(value.note, value.created ? 201 : 200);
    }
    if (method === "GET" && !id) {
      const input = parseQuery(writingInputs.journalList, query);
      return result(listJournalPage(owner, input));
    }
    if (method === "GET" && id === "review" && !action) {
      const input = parseQuery(writingInputs.journalReview, query);
      const review = journalReview(
        owner,
        input.date,
        input.period,
        input.timezone,
      );
      return result({
        period: review.period,
        periodStart: review.start,
        tasks: review.activity.tasks,
        events: review.activity.events,
        entry: review.entry,
        entries: review.entries,
      });
    }
    if (method === "GET" && id === "on-this-day" && !action) {
      const input = parseQuery(writingInputs.onThisDay, query);
      return result({ items: journalsOnThisDay(owner, input.date) });
    }
    if (method === "GET" && id && action === "navigate") {
      const input = parseQuery(writingInputs.journalNavigate, query);
      return result({ item: navigateJournal(owner, id, input.direction) });
    }
    if (id && !action && ["GET", "PATCH", "DELETE"].includes(method))
      return null;
    throw new HttpError(404, "This journal operation was not found.");
  }
  return null;
}
