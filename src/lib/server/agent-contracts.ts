import { extraOutputs } from "./api-extra-schemas";
import { formApiOperations } from "./form-api-schemas";
import { eventInput, dateSchema, zoneSchema } from "../calendar";
import { z } from "zod";
import { documentInput } from "./validation";
const count = z.number().int().nonnegative();
const tag = z
  .object({ id: z.string().uuid(), name: z.string(), color: z.string() })
  .passthrough();
const summary = z
  .object({
    id: z.string().uuid(),
    title: z.string(),
    revision: z.number().int().positive(),
  })
  .passthrough();
const note = summary
  .extend({
    document: documentInput,
    text: z.string(),
    tags: z.array(tag),
    dailyDate: z.string().nullable(),
  })
  .passthrough();
const task = summary
  .extend({
    completedAt: z.number().nullable(),
    boardId: z.string().uuid().nullable(),
    status: z.enum(["todo", "in_progress", "done"]),
    dueDate: z.string().nullable(),
  })
  .passthrough();
const board = z.object({
  id: z.string().uuid(),
  name: z.string(),
  revision: z.number().int().positive(),
  archivedAt: z.number().nullable(),
  createdAt: count,
  updatedAt: count,
  url: z.string().url(),
});
const bookmark = summary
  .extend({ url: z.string(), description: z.string(), favorite: z.boolean() })
  .passthrough();
const artifact = summary
  .extend({
    kind: z.enum(["text", "image", "file"]),
    name: z.string(),
    mime: z.string(),
    size: count,
    extraction: z.enum(["none", "pending", "done", "failed"]),
  })
  .passthrough();
const item = z
  .object({
    id: z.string().uuid(),
    title: z.string(),
    type: z.enum([
      "note",
      "journal",
      "task",
      "bookmark",
      "artifact",
      "event",
      "form",
      "response",
    ]),
  })
  .passthrough();
const cursorPage = (row: z.ZodType) =>
  z.object({ items: z.array(row), next: z.string().nullable() }).passthrough();
const offsetPage = (row: z.ZodType) =>
  z.object({ items: z.array(row), nextOffset: count.nullable() }).passthrough();
const transfer = z
  .object({ url: z.string().url(), method: z.enum(["GET", "POST"]) })
  .passthrough();
const object = z.record(z.string(), z.unknown());
const publication = z.object({
  token: z.string().regex(/^[a-f0-9]{48}$/),
  revision: z.number().int().positive(),
  publishedAt: z.number(),
  url: z.string().url(),
});
const calendarEventOutput = eventInput.safeExtend({
  id: z.string().uuid(),
  ownerId: z.string(),
  revision: z.number().int().positive(),
  trashedAt: z.number().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
  url: z.string().url().optional(),
  linkedItems: z
    .array(
      z
        .object({
          type: z.string(),
          id: z.string(),
          title: z.string(),
          available: z.boolean(),
        })
        .passthrough(),
    )
    .optional(),
});
const schemas: Record<string, z.ZodType> = {
  list_calendar: extraOutputs.calendarRange,
  get_event: calendarEventOutput,
  create_event: calendarEventOutput,
  update_event: calendarEventOutput,
  trash_event: z.object({ ok: z.literal(true) }),
  dismiss_reminder: z.object({ ok: z.literal(true) }),
  set_task_reminders: z.object({ ok: z.literal(true) }),
  get_task_reminders: z.object({
    reminders: z.array(
      z.object({
        field: z.enum(["planned", "due"]),
        timezone: zoneSchema,
        offsets: z.array(z.number().int().min(0).max(10080)).max(3),
      }),
    ),
  }),
  list_calendar_tasks: offsetPage(
    summary.extend({
      dueDate: dateSchema.nullable(),
      plannedDate: dateSchema.nullable(),
    }),
  ).extend({ total: count }),
  list_reminders: offsetPage(
    z
      .object({
        id: z.string(),
        title: z.string(),
        scheduledAt: z.number(),
        state: z.string(),
      })
      .passthrough(),
  ),
  get_instance: z.object({
    url: z.string().url(),
    mcpUrl: z.string().url(),
    routes: z.object({
      overview: z.literal("/overview"),
      notes: z.literal("/notes"),
      journals: z.literal("/journal"),
      tasks: z.literal("/tasks"),
      calendar: z.literal("/calendar"),
      bookmarks: z.literal("/bookmarks"),
      artifacts: z.literal("/artifacts"),
      favorites: z.literal("/favorites"),
      trash: z.literal("/trash"),
      forms: z.literal("/forms"),
    }),
    publicSharePath: z.literal("/share/{token}"),
    publicFormPath: z.literal("/form/{token}"),
  }),
  get_publication: publication.nullable(),
  publish_note: publication,
  search: z.array(item),
  search_items: offsetPage(item).extend({ total: count }),
  count_items: z.object({
    exact: z.literal(true),
    state: z.enum(["active", "trash"]),
    favoritesOnly: z.boolean(),
    tagId: z.string().uuid().nullable(),
    counts: z.object({
      notes: count,
      journals: count,
      tasks: count,
      bookmarks: count,
      artifacts: count,
      events: count,
      forms: count,
    }),
    total: count,
    taskStatus: z.object({ open: count, completed: count }),
  }),
  list_notes: offsetPage(summary),
  list_journals: offsetPage(summary),
  list_tags: offsetPage(tag),
  list_tasks: cursorPage(task),
  list_boards: cursorPage(board),
  get_board: board.extend({
    counts: z.object({ todo: count, in_progress: count, done: count }),
  }),
  create_board: board,
  update_board: board,
  move_task: task,
  list_bookmarks: cursorPage(bookmark),
  list_artifacts: cursorPage(artifact),
  list_favorites: offsetPage(item),
  tagged_items: offsetPage(item),
  get_note: note,
  get_journal: note,
  create_note: note,
  create_journal: note,
  update_note: note,
  append_note: note,
  replace_note_content: note,
  edit_note_blocks: note,
  duplicate_note: note,
  item_tags: z.object({
    revision: z.number().int().positive(),
    tags: z.array(tag),
  }),
  get_task: task,
  get_bookmark: bookmark,
  create_task: task,
  update_task: task,
  create_bookmark: bookmark,
  update_bookmark: bookmark,
  get_artifact: artifact.extend({ content: z.string() }),
  create_text_artifact: artifact,
  update_artifact: artifact,
  create_tag: tag,
  update_tag: tag,
  list_trash: cursorPage(
    z
      .object({
        id: z.string().uuid(),
        kind: z.enum([
          "note",
          "journal",
          "task",
          "bookmark",
          "artifact",
          "event",
          "form",
          "form_response",
        ]),
        title: z.string(),
        revision: z.number().int().positive(),
        trashedAt: z.number(),
      })
      .passthrough(),
  ),
  file_transfer: transfer,
  upload_transfer: transfer,
};
for (const [name, path, method] of [
  ["list_forms", "forms", "GET"],
  ["get_form", "forms/{id}", "GET"],
  ["create_form", "forms", "POST"],
  ["update_form", "forms/{id}", "PATCH"],
  ["duplicate_form", "forms/{id}/duplicate", "POST"],
  ["publish_form", "forms/{id}/publish", "POST"],
  ["close_form", "forms/{id}/close", "POST"],
  ["reopen_form", "forms/{id}/reopen", "POST"],
  ["unpublish_form", "forms/{id}/unpublish", "POST"],
  ["trash_form", "forms/{id}", "DELETE"],
  ["list_form_responses", "forms/{id}/responses", "GET"],
  ["get_form_response", "forms/{id}/responses/{responseId}", "GET"],
  ["get_form_summary", "forms/{id}/summary", "GET"],
  ["review_form_response", "forms/{id}/responses/{responseId}", "PATCH"],
  ["trash_form_response", "forms/{id}/responses/{responseId}", "DELETE"],
]) {
  const operation = formApiOperations.find(
    (operation) =>
      operation.path === `/api/v1/${path}` && operation.method === method,
  );
  if (!operation) throw new Error(`Missing Forms contract for ${name}`);
  schemas[name] = operation.output;
}
export function agentOutputSchema(name: string) {
  return schemas[name] ?? z.union([object, z.array(object), z.null()]);
}
