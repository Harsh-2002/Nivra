import { recordTagDeletion } from "./ai/tagging";
import { remapDocument } from "@/lib/document";
import {
  artifactFile,
  artifactSummary,
  createFileArtifact,
  createTextArtifact,
  deleteArtifact,
  getArtifact,
  listArtifactPage,
  retryExtraction,
  updateArtifact,
} from "@/lib/server/artifacts";
import {
  bookmarkImage,
  bookmarkSummary,
  createBookmark,
  deleteBookmark,
  getBookmark,
  listBookmarkPage,
  refreshBookmark,
  updateBookmark,
} from "@/lib/server/bookmarks";
import { connectionsFor, syncNoteLinks } from "@/lib/server/connections";
import { sqlite } from "@/lib/server/db";
import { HttpError, throttle } from "@/lib/server/http";
import {
  assignItemTags,
  favoriteItems,
  itemTagState,
  recordExplicitNoteTagSet,
  taggedItems,
  taggedTypes,
} from "@/lib/server/item-tags";
import { dailyNote } from "@/lib/server/journal";
import {
  checkpoint,
  getVersion,
  listVersions,
  restoreVersion,
} from "@/lib/server/note-history";
import { createNote, getNote, listNotes } from "@/lib/server/notes";
import { workspaceOverview } from "@/lib/server/overview";
import { pageLimit } from "@/lib/server/pagination";
import {
  publicationFor,
  publishNote,
  revokePublication,
} from "@/lib/server/publications";
import { storage, storedFileResponse } from "@/lib/server/storage";
import {
  createTask,
  deleteTask,
  listTaskPage,
  taskCounts,
  updateTask,
} from "@/lib/server/tasks";
import { deleteTrash, listTrash, restoreTrash } from "@/lib/server/trash";
import { searchWorkspace } from "@/lib/server/unified-search";
import { calendarDate, plainText } from "@/lib/server/validation";
import { strFromU8 } from "fflate";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { taskStages } from "../boards";
import { authorizeContentPath, type AgentPrincipal } from "./agent-access";
import { agentCounts } from "./agent-counts";
import { agentSearch } from "./agent-search";
import { relatedSearch } from "./ai/search";
import { operationFor } from "./api-contract";
import { offsetPagination } from "./api-pagination";
import { retryable } from "./api-retries";
import { apiInputs, apiQueries, idSchema, revisionInput } from "./api-schemas";
import { validateBody, validateQuery } from "./api-validation";
import { createBoard, getBoard, listBoards, updateBoard } from "./boards";
import { getEvent } from "./calendar";
import { uploadLimit } from "./config";
import { completionEvent } from "./jobs";
import { getTask, moveTask } from "./tasks";
import { executeTransfer } from "./transfer-service";
import { ftsQuery } from "./validation";
import { zoneSchema } from "../calendar";

import { executeCalendar } from "./calendar-service";
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
function collectionOptions(url: URL) {
  const page = offsetPagination(url.searchParams, url.pathname);
  return {
    query: z
      .string()
      .max(300)
      .parse(url.searchParams.get("q") ?? ""),
    limit: page.limit,
    offset: page.offset,
  };
}
function notePage(query: URLSearchParams, owner: string, area: string) {
  const page = offsetPagination(query, area);
  const params = new URLSearchParams(query);
  params.set("limit", String(page.limit + 1));
  params.set("offset", String(page.offset));
  if (area === "notes" && !params.has("view")) params.set("view", "all");
  return page.page(listNotes(params, undefined, owner));
}
function needNote(id: string) {
  const note = getNote(id);
  if (!note) throw new HttpError(404, "This note was not found.");
  return note;
}
export type ContentCommand = {
  ownerId: string;
  principal?: AgentPrincipal;
  sessionId?: string | null;
  origin: string;
  path: string[];
  method: string;
  query?: URLSearchParams;
  input?: unknown;
  transport?: Request;
  idempotencyKey?: string;
};
export type ContentResult =
  { data: unknown; status: number } | { response: Response };
const result = (data: unknown, status = 200): ContentResult => ({
  data,
  status,
});
export const contentAreas = new Set([
  "forms",
  "overview",
  "search",
  "trash",
  "bookmarks",
  "artifacts",
  "boards",
  "tasks",
  "item-tags",
  "favorites",
  "tags",
  "notes",
  "files",
  "export",
  "import",
  "journals",
  "counts",
  "jobs",
  "calendar",
  "events",
]);
export async function executeContent(
  command: ContentCommand,
): Promise<ContentResult> {
  try {
    return await executeContentOperation(command);
  } catch (error) {
    if (error instanceof SyntaxError)
      throw new HttpError(400, "This file contains invalid document data.");
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      String(error.code).startsWith("SQLITE_CONSTRAINT")
    )
      throw new HttpError(
        409,
        "That name is already in use, or a referenced item no longer exists.",
      );
    throw error;
  }
}
async function executeContentOperation(
  command: ContentCommand,
): Promise<ContentResult> {
  if (command.idempotencyKey && ["export", "import"].includes(command.path[0]))
    throw new HttpError(
      400,
      "Idempotency keys are supported for JSON content operations only.",
    );
  if (command.idempotencyKey && command.input instanceof FormData)
    throw new HttpError(
      400,
      "Idempotency keys are supported for JSON requests only.",
    );
  if (command.principal)
    authorizeContentPath(command.principal, command.path, command.method);
  const response = await retryable(
    `http:${command.principal?.connectionId ?? "owner:" + command.ownerId}`,
    command.method === "POST" ||
      (command.path[0] === "forms" && command.method !== "GET")
      ? command.idempotencyKey
      : undefined,
    {
      method: command.method,
      path: command.path,
      query: command.query?.toString(),
      input: command.input,
    },
    () => executeContentInternal(command),
  );
  if (
    !("data" in response) ||
    !response.data ||
    typeof response.data !== "object" ||
    Array.isArray(response.data)
  )
    return response;
  const data = { ...(response.data as Record<string, unknown>) };
  const pageMaximum =
    command.path[0] === "calendar" && command.path[1] === "range" ? 10000 : 100;
  if (Array.isArray(data.items) && typeof data.next === "number") {
    data.nextOffset = data.next;
    data.next = offsetPagination(
      command.query ?? new URLSearchParams(),
      "/" + command.path.join("/"),
      pageMaximum,
    ).cursor(data.next);
  }
  if (Array.isArray(data.items) && !("next" in data)) {
    const page = offsetPagination(
      command.query ?? new URLSearchParams(),
      "/" + command.path.join("/"),
      pageMaximum,
    );
    data.next =
      typeof data.nextOffset === "number" ? page.cursor(data.nextOffset) : null;
  }
  if (
    ["POST", "PATCH"].includes(command.method) &&
    typeof data.id === "string" &&
    ["artifacts", "bookmarks"].includes(command.path[0])
  ) {
    data.jobs = sqlite()
      .prepare(
        "SELECT id,kind,target_id AS targetId,state AS status,attempts,created_at AS createdAt FROM background_jobs WHERE owner_id=? AND target_id=? ORDER BY kind",
      )
      .all(command.ownerId, data.id)
      .map((job) => ({
        ...(job as Record<string, unknown>),
        url: `${command.origin}/api/v1/jobs/${(job as { id: string }).id}`,
      }));
  }
  return { ...response, data };
}
async function executeContentInternal(
  command: ContentCommand,
): Promise<ContentResult> {
  const {
    ownerId,
    principal,
    origin,
    method,
    input: payload,
    transport,
  } = command;
  const owner = { id: ownerId };
  const query = command.query ?? new URLSearchParams();
  const path = command.path;
  const [area, id, action] = path;
  if (principal) authorizeContentPath(principal, path, method);
  const operation = operationFor("/api/v1/" + path.join("/"), method);
  if (!operation)
    throw new HttpError(404, "This content operation was not found.");
  validateQuery(operation, query);
  validateBody(operation, payload);
  const database = sqlite();
  if (area === "forms")
    return (await import("./form-service")).executeForms(command);
  if (["export", "import"].includes(area)) return executeTransfer(command);
  if (area === "journals") {
    if (method === "POST" && !id) {
      const value = apiInputs.journalCreate.parse(payload);
      return result(await dailyNote(ownerId, value.date, value.document), 201);
    }
    if (method === "GET" && !id) {
      query.set("view", "journal");
      return result(notePage(query, ownerId, "journals"));
    }
    if (id) {
      const note = needNote(id);
      if (!note.dailyDate)
        throw new HttpError(404, "This journal was not found.");
      return executeContent({ ...command, path: ["notes", ...path.slice(1)] });
    }
  }
  if (area === "counts" && method === "GET" && !id) {
    const value = apiQueries.counts.parse(Object.fromEntries(query));
    return result(
      agentCounts(ownerId, {
        ...value,
        favoritesOnly: value.favoritesOnly === "1",
      }),
    );
  }
  if (area === "jobs" && method === "GET" && id) {
    const job = database
      .prepare(
        "SELECT id,kind,target_id AS targetId,state AS status,attempts,created_at AS createdAt FROM background_jobs WHERE id=? AND owner_id=? AND kind<>'semantic'",
      )
      .get(z.string().uuid().parse(id), ownerId);
    if (!job) throw new HttpError(404, "This job was not found.");
    return result(job);
  }
  if (area === "calendar") return executeCalendar(command);
  if (area === "events" && method === "GET" && !id) {
    const page = offsetPagination(query, "events");
    const text = query.get("q") ?? "";
    const match = ftsQuery(text);
    if (text.trim() && !match) return result(page.page([]));
    const ids = database
      .prepare(
        "SELECT id FROM calendar_events WHERE owner_id=? AND trashed_at IS NULL" +
          (match
            ? " AND rowid IN (SELECT rowid FROM events_fts WHERE events_fts MATCH ?)"
            : "") +
          " ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?",
      )
      .all(ownerId, ...(match ? [match] : []), page.limit + 1, page.offset) as {
      id: string;
    }[];
    return result(page.page(ids.map((row) => getEvent(ownerId, row.id))));
  }
  if (area === "events")
    return executeCalendar({
      ...command,
      path: ["calendar", "events", ...path.slice(1)],
    });
  if (area === "overview" && method === "GET" && !id) {
    const today = calendarDate.parse(query.get("date"));
    const timezone = zoneSchema.parse(query.get("timezone") ?? "UTC");
    return result(workspaceOverview(owner.id, today, timezone, !principal));
  }
  if (area === "search" && method === "GET" && !id) {
    const page = offsetPagination(query, "search");
    const text = z
      .string()
      .max(300)
      .parse(query.get("q") ?? "");
    const purpose = z
      .enum(["workspace", "link"])
      .parse(query.get("purpose") ?? "workspace");
    if (query.get("strategy") === "semantic" && purpose === "workspace") {
      const found = await relatedSearch(ownerId, text);
      if (found.strategyUsed === "semantic" || query.get("mode") === "suggest")
        return result({
          ...page.page(found.items.slice(page.offset), found.items.length),
          strategyUsed: found.strategyUsed,
        });
    }
    if (query.get("mode") === "suggest")
      return result(page.page(searchWorkspace(ownerId, text, purpose)));
    const found = agentSearch(ownerId, {
      query: text,
      limit: page.limit,
      offset: page.offset,
    });
    return result({
      ...page.page(found.items, found.total),
      ...(query.get("strategy") === "semantic"
        ? { strategyUsed: "keyword" }
        : {}),
    });
  }
  if (area === "trash") {
    const kinds = z.enum([
      "note",
      "journal",
      "task",
      "bookmark",
      "artifact",
      "event",
      "form",
      "form_response",
    ]);
    if (method === "GET" && !id) {
      const kind = query.get("kind");
      return result(
        listTrash(
          owner.id,
          query.get("q") || "",
          kind ? kinds.parse(kind) : undefined,
          query.get("after"),
          Number(query.get("limit")) || 60,
        ),
      );
    }
    if (
      ((method === "POST" && path[3] === "restore") ||
        (method === "DELETE" && path.length === 3)) &&
      id &&
      action
    ) {
      const kind = kinds.parse(id);
      const itemId = z.string().uuid().parse(action);
      const input = z
        .object({ revision: z.number().int().positive() })
        .parse(payload);
      if (method === "POST")
        restoreTrash(owner.id, kind, itemId, input.revision);
      else await deleteTrash(owner.id, kind, itemId, input.revision);
      return result({ ok: true });
    }
    throw new HttpError(404, "This Trash action was not found.");
  }
  if (area === "bookmarks") {
    if (method === "GET" && !id) {
      const params = query;
      const filters = {
        query: params.get("q") || "",
        favorite: params.get("favorite") === "1",
        unfiled: params.get("unfiled") === "1",
        collection: params.has("collection")
          ? params.get("collection")!.slice(0, 80)
          : undefined,
      };
      if (params.get("summary") === "1")
        return result(bookmarkSummary(owner.id, filters));
      return result(
        listBookmarkPage(owner.id, {
          ...filters,
          limit: pageLimit(params.get("limit")),
          after: params.get("after"),
        }),
      );
    }
    if (method === "GET" && id && (action === "thumbnail" || action === "icon"))
      return { response: await bookmarkImage(owner.id, id, action) };
    if (method === "GET" && id && !action)
      return result(getBookmark(ownerId, idSchema.parse(id)));
    if (method === "POST" && !id) {
      throttle(`bookmark:${owner.id}`);
      const input = apiInputs.bookmarkCreate.parse(payload);
      return result(await createBookmark(owner.id, input), 201);
    }
    if (method === "PATCH" && id) {
      const input = apiInputs.bookmarkUpdate.parse(payload);
      return result(updateBookmark(owner.id, id, input));
    }
    if (method === "POST" && id && action === "refresh") {
      throttle(`bookmark:${owner.id}`);
      const input = revisionInput.parse(payload);
      return result(await refreshBookmark(owner.id, id, input.revision));
    }
    if (method === "DELETE" && id) {
      const input = revisionInput.parse(payload);
      await deleteBookmark(owner.id, id, input.revision);
      return result({ ok: true });
    }
  }
  if (area === "artifacts") {
    if (method === "GET" && !id) {
      const params = query;
      if (params.get("summary") === "1")
        return result(artifactSummary(owner.id));
      return result(
        listArtifactPage(owner.id, {
          query: params.get("q") || "",
          context: params.get("context") !== "0",
          kind: z
            .enum(["text", "image", "file"])
            .optional()
            .parse(params.get("kind") ?? undefined),
          limit: pageLimit(params.get("limit")),
          after: params.get("after"),
        }),
      );
    }
    if (method === "GET" && id && (action === "file" || action === "thumbnail"))
      return { response: await artifactFile(transport!, owner.id, id, action) };
    if (method === "GET" && id) return result(getArtifact(owner.id, id));
    if (method === "POST" && !id) {
      if (!(payload instanceof FormData)) {
        const input = apiInputs.artifactCreate.parse(payload);
        return result(createTextArtifact(owner.id, input.text), 201);
      }
      const limit = uploadLimit();
      const form = payload;
      if (!(form instanceof FormData))
        throw new HttpError(400, "Choose a file to save.");
      const file = form.get("file");
      const thumb = form.get("thumb");
      if (!(file instanceof File))
        throw new HttpError(400, "Choose a file to save.");
      if (file.size > limit)
        throw new HttpError(413, "This file exceeds your attachment limit.");
      return result(
        await createFileArtifact(
          owner.id,
          {
            name: file.name,
            mime: file.type,
            bytes: new Uint8Array(await file.arrayBuffer()),
          },
          thumb instanceof File
            ? new Uint8Array(await thumb.arrayBuffer())
            : undefined,
        ),
        201,
      );
    }
    if (method === "POST" && id && action === "extract")
      return result(retryExtraction(owner.id, id));
    if (method === "PATCH" && id) {
      const input = apiInputs.artifactUpdate.parse(payload);
      return result(updateArtifact(owner.id, id, input));
    }
    if (method === "DELETE" && id) {
      const input = revisionInput.parse(payload);
      await deleteArtifact(owner.id, id, input.revision);
      return result({ ok: true });
    }
  }
  if (area === "boards") {
    const boardUrl = (board: import("../types").Board) => ({
      ...board,
      url: `${origin}/tasks?view=board&board=${board.id}`,
    });
    if (id) z.string().uuid().parse(id);
    if (method === "GET" && !id) {
      const archived =
        z
          .enum(["0", "1"])
          .default("0")
          .parse(query.get("archived") ?? undefined) === "1";
      const page = listBoards(
        owner.id,
        archived,
        pageLimit(query.get("limit")),
        query.get("after"),
        query.get("q") ?? "",
      );
      return result({ ...page, items: page.items.map(boardUrl) });
    }
    if (method === "GET" && id)
      return result({
        ...getBoard(owner.id, id, query.get("q") ?? ""),
        url: `${origin}/tasks?view=board&board=${id}`,
      });
    if (method === "POST" && !id) {
      const board = createBoard(
        owner.id,
        apiInputs.boardCreate.parse(payload).name,
      );
      completionEvent(owner.id, "content", board.id, "changed");
      return result(boardUrl(board), 201);
    }
    if (method === "PATCH" && id) {
      const board = updateBoard(
        owner.id,
        id,
        apiInputs.boardUpdate.parse(payload),
      );
      completionEvent(owner.id, "content", board.id, "changed");
      return result(boardUrl(board));
    }
  }
  if (area === "tasks") {
    if (method === "GET" && id)
      return result(getTask(owner.id, z.string().uuid().parse(id)));
    if (method === "POST" && id && action === "move") {
      const task = moveTask(
        owner.id,
        z.string().uuid().parse(id),
        apiInputs.taskMove.parse(payload),
      );
      completionEvent(owner.id, "content", task.id, "changed");
      return result(task);
    }
    if (method === "GET" && !id) {
      const params = query;
      const boardValue = params.get("boardId");
      const boardId =
        boardValue === "unassigned"
          ? null
          : boardValue === null
            ? undefined
            : z.string().uuid().parse(boardValue);
      const status = z
        .enum(taskStages)
        .optional()
        .parse(params.get("status") ?? undefined);
      const order = z
        .enum(["recent", "board"])
        .default("recent")
        .parse(params.get("order") ?? undefined);
      if (params.get("summary") === "1")
        return result(taskCounts(owner.id, boardId));
      const filter = z
        .enum(["open", "completed"])
        .default("open")
        .parse(params.get("filter") ?? undefined);
      return result(
        listTaskPage(owner.id, {
          filter,
          boardId,
          status,
          order,
          query: params.get("q") || "",
          limit: pageLimit(params.get("limit")),
          after: params.get("after"),
        }),
      );
    }
    if (method === "POST" && !id) {
      const input = apiInputs.taskCreate.parse(payload);
      const task = createTask(owner.id, input.title, input);
      completionEvent(owner.id, "content", task.id, "changed");
      return result(task, 201);
    }
    if (method === "PATCH" && id) {
      const input = apiInputs.taskUpdate.parse(payload);
      const task = updateTask(owner.id, id, input);
      completionEvent(owner.id, "content", task.id, "changed");
      return result(task);
    }
    if (method === "DELETE" && id) {
      const input = revisionInput.parse(payload);
      deleteTask(owner.id, id, input.revision);
      if (!principal) completionEvent(owner.id, "content", id, "trashed");
      return result({ ok: true });
    }
  }
  if (area === "item-tags" && id && action) {
    const type = z.enum([...taggedTypes, "response"]).parse(id);
    const itemId = z.string().uuid().parse(action);
    if (method === "GET") return result(itemTagState(owner.id, type, itemId));
    if (method === "PATCH") {
      const input = apiInputs.itemTags.parse(payload);
      return result(
        assignItemTags(owner.id, type, itemId, input.revision, input.tags),
      );
    }
  }
  if (area === "favorites" && method === "GET" && !id) {
    const options = collectionOptions(
      new URL("/" + path.join("/") + "?" + query, origin),
    );
    return result(
      favoriteItems(owner.id, options.query, options.limit, options.offset),
    );
  }
  if (area === "tags") {
    if (method === "GET" && id && action === "items") {
      const tagId = z.string().uuid().parse(id);
      const options = collectionOptions(
        new URL("/" + path.join("/") + "?" + query, origin),
      );
      return result(
        taggedItems(
          owner.id,
          tagId,
          options.query,
          options.limit,
          options.offset,
        ),
      );
    }
    if (method === "GET" && !id) {
      const page = offsetPagination(query, "tags");
      const rows = database
        .prepare(
          "SELECT id,name,color,aliases FROM tags ORDER BY name COLLATE NOCASE,id LIMIT ? OFFSET ?",
        )
        .all(page.limit + 1, page.offset);
      return result(
        page.page(
          (rows as { aliases: string }[]).map((row) => ({
            ...row,
            aliases: JSON.parse(row.aliases),
          })),
        ),
      );
    }
    if (method === "GET" && id) {
      const tag = database
        .prepare("SELECT id,name,color,aliases FROM tags WHERE id=?")
        .get(z.string().uuid().parse(id)) as { aliases: string } | undefined;
      if (!tag) throw new HttpError(404, "This tag was not found.");
      return result({ ...tag, aliases: JSON.parse(tag.aliases) });
    }
    if (method === "POST" || method === "PATCH") {
      if (
        method === "PATCH" &&
        !database.prepare("SELECT 1 FROM tags WHERE id=?").get(id)
      )
        throw new HttpError(404, "This tag was not found.");
      const {
        name,
        color,
        aliases: inputAliases,
      } = apiInputs.tagCreate.parse(payload);
      const aliases =
        inputAliases === undefined && method === "PATCH"
          ? (JSON.parse(
              (
                database
                  .prepare("SELECT aliases FROM tags WHERE id=?")
                  .get(id) as { aliases: string }
              ).aliases,
            ) as string[])
          : [
              ...new Map(
                (inputAliases ?? []).map((word) => [
                  word.normalize("NFKC").toLowerCase(),
                  word.normalize("NFKC"),
                ]),
              ).values(),
            ];
      if (method === "POST") {
        const tagId = randomUUID();
        database
          .prepare("INSERT INTO tags(id,name,color,aliases) VALUES(?,?,?,?)")
          .run(tagId, name, color, JSON.stringify(aliases));
        return result({ id: tagId, name, color, aliases }, 201);
      }
      database
        .prepare("UPDATE tags SET name=?,color=?,aliases=? WHERE id=?")
        .run(name, color, JSON.stringify(aliases), id);
      return result({ id, name, color, aliases });
    }
    if (method === "DELETE" && id) {
      return database
        .transaction(() => {
          recordTagDeletion(owner.id, id);
          database.prepare("DELETE FROM tags WHERE id=?").run(id);
          return result({ ok: true });
        })
        .immediate();
    }
  }
  if (area === "notes") {
    if (id && action === "connections" && method === "GET") {
      needNote(id);
      return result(connectionsFor(id));
    }
    if (id && action === "history") {
      needNote(id);
      if (method === "GET")
        return result(path[3] ? getVersion(id, path[3]) : listVersions(id));
      if (method === "POST" && path[3] && path[4] === "restore") {
        const input = revisionInput.parse(payload);
        return result(restoreVersion(id, path[3], input.revision));
      }
    }
    if (id && action === "publication") {
      const note = needNote(id);
      const withUrl = (publication: ReturnType<typeof publicationFor>) =>
        publication
          ? {
              ...publication,
              url: new URL(
                `/share/${encodeURIComponent(publication.token)}`,
                origin,
              ).href,
            }
          : null;
      if (method === "GET") return result(withUrl(publicationFor(id)));
      if (method === "POST") {
        const input = z
          .object({ revision: z.number().int().positive() })
          .parse(payload);
        return result(withUrl(await publishNote(note, input.revision)));
      }
      if (method === "DELETE") {
        await revokePublication(id);
        return result({ ok: true });
      }
    }
    if (method === "GET")
      return result(id ? needNote(id) : notePage(query, owner.id, "notes"));
    if (method === "POST" && !id) {
      const input = apiInputs.noteCreate.parse(payload);
      return result(createNote(owner.id, input.title, input.document), 201);
    }
    if (method === "PATCH" && id) {
      const input = apiInputs.noteUpdate.parse(payload);
      const note = database
        .transaction(() => {
          const previous = needNote(id);
          if (previous.revision !== input.revision)
            throw new HttpError(
              409,
              "This note changed in another tab. Save your edits as a new note or reload it.",
            );
          const document = input.document || previous.document;
          if (
            (input.title !== undefined && input.title !== previous.title) ||
            (input.document !== undefined &&
              JSON.stringify(input.document) !==
                JSON.stringify(previous.document))
          )
            checkpoint(previous);
          const addedTags = input.tags
            ? recordExplicitNoteTagSet(owner.id, id, input.tags)
            : [];
          database
            .prepare(
              "UPDATE notes SET title=?,document=?,text=?,favorite=?,editor_width=?,trashed_at=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?",
            )
            .run(
              input.title ?? previous.title,
              JSON.stringify(document),
              plainText(document.blocks),
              Number(input.favorite ?? previous.favorite),
              input.editorWidth ?? previous.editorWidth,
              input.trashed === undefined
                ? previous.trashedAt
                : input.trashed
                  ? Date.now()
                  : null,
              Date.now(),
              id,
              input.revision,
            );
          if (input.tags) {
            const currentTags = new Set(
              (
                database
                  .prepare("SELECT tag_id FROM note_tags WHERE note_id=?")
                  .all(id) as { tag_id: string }[]
              ).map((row) => row.tag_id),
            );
            const desiredTags = new Set(input.tags);
            const finalTags = new Set([
              ...[...currentTags].filter((tag) => desiredTags.has(tag)),
              ...addedTags,
            ]);
            const remove = database.prepare(
              "DELETE FROM note_tags WHERE note_id=? AND tag_id=?",
            );
            for (const tag of currentTags)
              if (!finalTags.has(tag)) remove.run(id, tag);
            const insert = database.prepare(
              "INSERT INTO note_tags(note_id,tag_id) VALUES(?,?)",
            );
            for (const tag of finalTags)
              if (!currentTags.has(tag)) insert.run(id, tag);
          }
          syncNoteLinks(id, document);
          return needNote(id);
        })
        .immediate();
      if (note.trashedAt) await revokePublication(id);
      return result(note);
    }
    if (method === "POST" && action === "duplicate") {
      const original = needNote(id);
      const copy = createNote(
        owner.id,
        `${original.title || "Untitled"} (copy)`,
        original.document,
      );
      const attachmentMap = new Map<string, string>();
      const created: string[] = [];
      try {
        for (const file of filesFor(id)) {
          const newId = randomUUID();
          await storage.write(newId, await storage.read(file.storage_key));
          created.push(newId);
          database
            .prepare("INSERT INTO attachments VALUES(?,?,?,?,?,?,?)")
            .run(
              newId,
              copy.id,
              file.name,
              file.mime,
              file.size,
              newId,
              Date.now(),
            );
          attachmentMap.set(file.id, newId);
        }
        database.transaction(() => {
          database
            .prepare("UPDATE notes SET document=?,editor_width=? WHERE id=?")
            .run(
              JSON.stringify(remapDocument(original.document, attachmentMap)),
              original.editorWidth,
              copy.id,
            );
          for (const tag of original.tags)
            database
              .prepare("INSERT INTO note_tags VALUES(?,?)")
              .run(copy.id, tag.id);
        })();
        return result(
          {
            ...needNote(copy.id),
            attachmentMap: Object.fromEntries(attachmentMap),
          },
          201,
        );
      } catch (error) {
        database.prepare("DELETE FROM notes WHERE id=?").run(copy.id);
        await Promise.all(created.map((key) => storage.delete(key)));
        throw error;
      }
    }
    if (method === "DELETE" && id) {
      const value = revisionInput.parse(payload);
      const note = needNote(id);
      if (note.trashedAt)
        throw new HttpError(409, "This item is already in Trash.");
      if (note.revision !== value.revision)
        throw new HttpError(
          409,
          "This note changed. Reload it before deleting.",
        );
      database
        .prepare(
          "UPDATE notes SET trashed_at=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?",
        )
        .run(Date.now(), Date.now(), id, value.revision);
      await revokePublication(id);
      return result({ ok: true });
    }
  }
  if (area === "files") {
    if (method === "GET" && id) {
      const file = database
        .prepare("SELECT * FROM attachments WHERE id=?")
        .get(id) as Attachment | undefined;
      if (!file) throw new HttpError(404, "This file was not found.");
      return {
        response: await storedFileResponse(transport!, file.storage_key, file),
      };
    }
    if (method === "GET") {
      needNote(query.get("note") || "");
      return result(filesFor(query.get("note")!));
    }
    if (method === "POST") {
      const limit = uploadLimit();
      const form = payload;
      if (!(form instanceof FormData))
        throw new HttpError(400, "Choose a file to save.");
      const file = form.get("file");
      const noteId = form.get("note");
      if (!(file instanceof File) || typeof noteId !== "string")
        throw new HttpError(400, "Choose a file and note.");
      needNote(noteId);
      if (principal) authorizeContentPath(principal, ["notes", noteId], "POST");
      if (file.size > limit)
        throw new HttpError(413, "This file exceeds your attachment limit.");
      const fileId = randomUUID();
      const bytes = new Uint8Array(await file.arrayBuffer());
      let mime = "application/octet-stream";
      if (
        bytes[0] === 0x89 &&
        bytes[1] === 0x50 &&
        bytes[2] === 0x4e &&
        bytes[3] === 0x47
      )
        mime = "image/png";
      else if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
        mime = "image/jpeg";
      else if (strFromU8(bytes.slice(0, 6)).startsWith("GIF8"))
        mime = "image/gif";
      else if (
        strFromU8(bytes.slice(0, 4)) === "RIFF" &&
        strFromU8(bytes.slice(8, 12)) === "WEBP"
      )
        mime = "image/webp";
      await storage.write(fileId, bytes);
      try {
        database
          .prepare("INSERT INTO attachments VALUES(?,?,?,?,?,?,?)")
          .run(
            fileId,
            noteId,
            file.name.slice(0, 200),
            mime,
            file.size,
            fileId,
            Date.now(),
          );
      } catch (error) {
        await storage.delete(fileId);
        throw error;
      }
      return result(
        {
          id: fileId,
          url: `${origin}/api/v1/files/${fileId}`,
          name: file.name,
          mime,
        },
        201,
      );
    }
  }
  throw new HttpError(404, "This content operation was not found.");
}
