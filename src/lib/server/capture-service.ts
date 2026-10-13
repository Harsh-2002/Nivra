import { randomUUID } from "node:crypto";
import { z } from "zod";
import { captureInput } from "../capture";
import type { Document } from "../types";
import type { ApiOperation } from "./api-contract";
import type { ContentCommand, ContentResult } from "./content-service";
import { sqlite } from "./db";
import { createNote, getNote } from "./notes";
import { createTask } from "./tasks";
import { getBookmark } from "./bookmarks";
import { bookmarkUrl } from "./link-metadata";
import { completionEvent, enqueueJob, startJobWorker } from "./jobs";
import { HttpError } from "./http";

export const captureOperations: ApiOperation[] = [
  {
    path: "/api/v1/capture",
    method: "POST",
    summary: "Save a reviewed capture",
    access: "content",
    input: captureInput,
    output: z
      .object({
        type: z.enum(["note", "task", "bookmark"]),
        id: z.string().uuid(),
        noteId: z.string().uuid().nullable(),
        alreadySaved: z.boolean(),
      })
      .strict(),
    status: 201,
  },
];

function document(text: string, url = ""): Document {
  const blocks = text.split(/\r?\n/).map((line) => ({
    type: "paragraph",
    content: [{ type: "text", text: line, styles: {} }],
  }));
  if (url)
    blocks.push({
      type: "paragraph",
      content: [{ type: "text", text: `Source: ${url}`, styles: {} }],
    });
  return {
    schemaVersion: 1,
    blocks: blocks.length ? blocks : [{ type: "paragraph", content: [] }],
  };
}

export async function executeCapture(
  command: ContentCommand,
): Promise<ContentResult | null> {
  if (
    command.path.length !== 1 ||
    command.path[0] !== "capture" ||
    command.method !== "POST"
  )
    return null;
  const value = captureInput.parse(command.input);
  const owner = command.ownerId;
  const result = sqlite()
    .transaction(() => {
      if (value.type === "task") {
        const task = createTask(owner, (value.title || value.text).trim());
        return {
          type: value.type,
          id: task.id,
          noteId: null,
          alreadySaved: false,
        };
      }
      if (value.type === "note") {
        const note = createNote(owner, value.title, document(value.text));
        completionEvent(owner, "content", note.id, "created");
        return {
          type: value.type,
          id: note.id,
          noteId: note.id,
          alreadySaved: false,
        };
      }
      const url = bookmarkUrl(value.url);
      const existing = sqlite()
        .prepare(
          "SELECT id,trashed_at AS trashedAt,note_id AS noteId,revision FROM bookmarks WHERE owner_id=? AND url=?",
        )
        .get(owner, url) as
        | {
            id: string;
            trashedAt: number | null;
            noteId: string | null;
            revision: number;
          }
        | undefined;
      if (existing?.trashedAt)
        throw new HttpError(
          409,
          "This link is in Trash. Restore it before saving it again.",
        );
      const id = existing?.id ?? randomUUID();
      if (!existing) {
        const now = Date.now();
        sqlite()
          .prepare(
            "INSERT INTO bookmarks(id,owner_id,url,title,collection,title_edited,metadata_status,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,'pending',1,?,?)",
          )
          .run(
            id,
            owner,
            url,
            value.title || new URL(url).hostname,
            value.collection,
            Number(!!value.title),
            now,
            now,
          );
        enqueueJob(owner, "bookmark", id);
      }
      const note = value.text.trim()
        ? createNote(
            owner,
            value.title || "Saved passage",
            document(value.text, url),
          )
        : null;
      if (note && !existing?.noteId)
        sqlite()
          .prepare(
            "UPDATE bookmarks SET note_id=?,revision=revision+1,updated_at=? WHERE id=? AND owner_id=?",
          )
          .run(note.id, Date.now(), id, owner);
      if (note) {
        if (!getNote(note.id))
          throw new HttpError(500, "The captured passage could not be saved.");
        completionEvent(owner, "content", note.id, "created");
      }
      getBookmark(owner, id);
      completionEvent(owner, "bookmark", id, "captured");
      return {
        type: value.type,
        id,
        noteId: note?.id ?? null,
        alreadySaved: !!existing,
      };
    })
    .immediate();
  startJobWorker();
  return { data: result, status: 201 };
}
