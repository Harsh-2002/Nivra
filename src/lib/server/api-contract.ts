import { z } from "zod";
import { formApiOperations } from "./form-api-schemas";
import { captureOperations } from "./capture-service";
import { extraOutputs } from "./api-extra-schemas";
import { taskPlanningApiOperations } from "./task-planning-api";
import { writingInputs } from "./writing-contract";
import {
  apiInputs,
  apiOutputs,
  apiQueries,
  idSchema,
  jobSchema,
  listOutput,
  listQuery,
  revisionInput,
} from "./api-schemas";
export type ApiOperation = {
  path: string;
  method: string;
  summary: string;
  access: "public" | "content" | "owner";
  input?: z.ZodType;
  query?: z.ZodType;
  output: z.ZodType;
  status: number;
  additionalStatuses?: number[];
  binary?: string;
  binaryInput?: string;
  multipart?: boolean;
  optionalBody?: boolean;
  headers?: { name: string; schema: z.ZodType; required: boolean }[];
};
const object = z.record(z.string(), z.unknown());
const empty = z.object({}).strict();
export const apiOperations: ApiOperation[] = [
  ...formApiOperations,
  ...captureOperations,
  ...taskPlanningApiOperations,
];
function add(
  path: string,
  method: string,
  summary: string,
  output: z.ZodType,
  options: Partial<ApiOperation> = {},
) {
  apiOperations.push({
    path: "/api/v1/" + path,
    method,
    summary,
    output,
    status: 200,
    access: "content",
    ...options,
  });
}
for (const area of ["notes", "journals"] as const) {
  add(area, "GET", `List ${area}`, listOutput(apiOutputs.noteSummary), {
    query: area === "notes" ? apiQueries.notes : writingInputs.journalList,
  });
  add(
    `${area}/{id}`,
    "GET",
    `Read a ${area === "notes" ? "note" : "journal"}`,
    apiOutputs.note,
  );
  add(
    area,
    "POST",
    `Create a ${area === "notes" ? "note" : "journal"}`,
    apiOutputs.note,
    {
      input: area === "notes" ? apiInputs.noteCreate : apiInputs.journalCreate,
      status: 201,
      ...(area === "journals" ? { additionalStatuses: [200] } : {}),
    },
  );
  add(
    `${area}/{id}`,
    "PATCH",
    "Update content with its current revision",
    apiOutputs.note,
    { input: apiInputs.noteUpdate },
  );
  add(`${area}/{id}`, "DELETE", "Move an active item to Trash", apiOutputs.ok, {
    input: revisionInput,
  });
}

add(
  "notes/{id}/tasks",
  "POST",
  "Turn a note block into a linked task",
  apiOutputs.linkedTaskConversion,
  {
    input: writingInputs.linkedTaskCreate,
    status: 201,
    additionalStatuses: [200],
  },
);
add(
  "notes/{id}/tasks/{blockId}",
  "DELETE",
  "Unlink a task from a note block",
  z.object({ note: apiOutputs.note }).strict(),
  { input: revisionInput },
);
add(
  "journals/review",
  "GET",
  "Review a journal period with related activity",
  apiOutputs.journalReview,
  {
    query: writingInputs.journalReview,
  },
);
add(
  "journals/on-this-day",
  "GET",
  "Find entries from this day in prior years",
  apiOutputs.journalHistory,
  {
    query: writingInputs.onThisDay,
  },
);
add(
  "journals/{id}/navigate",
  "GET",
  "Navigate to the adjacent journal period",
  apiOutputs.journalNavigation,
  {
    query: writingInputs.journalNavigate,
  },
);
add(
  "templates",
  "GET",
  "List writing templates",
  apiOutputs.writingTemplatePage,
  {
    query: writingInputs.templateList,
  },
);
add(
  "templates/{id}",
  "GET",
  "Read a writing template",
  apiOutputs.writingTemplateDetail,
);
add(
  "templates",
  "POST",
  "Create a writing template",
  apiOutputs.writingTemplateDetail,
  {
    input: writingInputs.templateCreate,
    status: 201,
  },
);
add(
  "templates/{id}",
  "PATCH",
  "Update a writing template",
  apiOutputs.writingTemplateDetail,
  {
    input: writingInputs.templateUpdate,
  },
);
add("templates/{id}", "DELETE", "Delete a writing template", apiOutputs.ok, {
  input: revisionInput,
  access: "owner",
});
add(
  "templates/{id}/apply",
  "POST",
  "Create a note or journal entry from a template",
  z.object({ note: apiOutputs.note, created: z.boolean() }).strict(),
  {
    input: writingInputs.templateApply,
    status: 201,
    additionalStatuses: [200],
  },
);
for (const method of ["GET", "PATCH"] as const)
  add(
    "writing/preferences",
    method,
    "Read or update journal template preferences",
    apiOutputs.writingPreferences,
    {
      access: "owner",
      input: method === "PATCH" ? writingInputs.writingPreferences : undefined,
    },
  );
add(
  "tasks",
  "GET",
  "List tasks, newest first by default",
  z.union([
    listOutput(apiOutputs.task),
    z
      .object({
        open: z.number().int().nonnegative(),
        completed: z.number().int().nonnegative(),
      })
      .strict(),
  ]),
  { query: apiQueries.tasks },
);
add("tasks/{id}", "GET", "Read a task", apiOutputs.task);
add("tasks", "POST", "Create a task", apiOutputs.task, {
  input: apiInputs.taskCreate,
  status: 201,
});
add(
  "tasks/{id}",
  "PATCH",
  "Update a task with its current revision",
  apiOutputs.task,
  { input: apiInputs.taskUpdate },
);
add("tasks/{id}", "DELETE", "Move a task to Trash", apiOutputs.ok, {
  input: revisionInput,
});
add(
  "tasks/{id}/move",
  "POST",
  "Move a task within or between boards",
  apiOutputs.task,
  { input: apiInputs.taskMove },
);
add("boards", "GET", "List boards", listOutput(apiOutputs.board), {
  query: apiQueries.boards,
});
add(
  "boards/{id}",
  "GET",
  "Read a board and its task summaries",
  apiOutputs.board,
  { query: z.object({ q: z.string().max(300).optional() }).strict() },
);
add("boards", "POST", "Create a board", apiOutputs.board, {
  input: apiInputs.boardCreate,
  status: 201,
});
add("boards/{id}", "PATCH", "Update or archive a board", apiOutputs.board, {
  input: apiInputs.boardUpdate,
});
add(
  "bookmarks",
  "GET",
  "List bookmarks",
  z.union([
    listOutput(apiOutputs.bookmark),
    z
      .object({
        total: z.number().int().nonnegative(),
        collections: z.array(z.string()),
      })
      .strict(),
  ]),
  { query: apiQueries.bookmarks },
);
add("bookmarks/{id}", "GET", "Read a bookmark", apiOutputs.bookmark);
add(
  "bookmarks",
  "POST",
  "Save a bookmark and queue metadata processing",
  apiOutputs.bookmark,
  { input: apiInputs.bookmarkCreate, status: 201 },
);
add("bookmarks/{id}", "PATCH", "Update a bookmark", apiOutputs.bookmark, {
  input: apiInputs.bookmarkUpdate,
});
add("bookmarks/{id}", "DELETE", "Move a bookmark to Trash", apiOutputs.ok, {
  input: revisionInput,
});
add(
  "bookmarks/{id}/refresh",
  "POST",
  "Queue bookmark metadata refresh",
  apiOutputs.bookmark,
  { input: revisionInput },
);
add(
  "bookmarks/read-state",
  "POST",
  "Update read state for bookmarks",
  apiOutputs.bookmarkReadState,
  {
    input: apiInputs.bookmarkReadState,
  },
);
for (const action of ["thumbnail", "icon"])
  add(
    `bookmarks/{id}/${action}`,
    "GET",
    `Read a cached bookmark ${action}`,
    object,
    { binary: "image/*" },
  );
add(
  "artifacts",
  "GET",
  "List artifacts",
  z.union([
    listOutput(apiOutputs.artifact),
    z
      .object({
        total: z.number().int().nonnegative(),
        images: z.number().int().nonnegative(),
        texts: z.number().int().nonnegative(),
        files: z.number().int().nonnegative(),
      })
      .strict(),
  ]),
  { query: apiQueries.artifacts },
);
add("artifacts/{id}", "GET", "Read an artifact", apiOutputs.artifact);
add(
  "artifacts",
  "POST",
  "Save text or upload an artifact and queue processing",
  apiOutputs.artifact,
  { input: apiInputs.artifactCreate, status: 201, multipart: true },
);
add("artifacts/{id}", "PATCH", "Update an artifact", apiOutputs.artifact, {
  input: apiInputs.artifactUpdate,
});
add("artifacts/{id}", "DELETE", "Move an artifact to Trash", apiOutputs.ok, {
  input: revisionInput,
});
add(
  "artifacts/{id}/extract",
  "POST",
  "Retry background extraction",
  apiOutputs.artifact,
  { input: empty, optionalBody: true },
);
for (const action of ["file", "thumbnail"])
  add(`artifacts/{id}/${action}`, "GET", `Read an artifact ${action}`, object, {
    binary: "application/octet-stream",
  });
add("tags", "GET", "List tags", listOutput(apiOutputs.tag), {
  query: listQuery.strict(),
});
add("tags/{id}", "GET", "Read a tag", apiOutputs.tag);
add("tags", "POST", "Create a tag", apiOutputs.tag, {
  input: apiInputs.tagCreate,
  status: 201,
});
add("tags/{id}", "PATCH", "Update a tag", apiOutputs.tag, {
  input: apiInputs.tagCreate,
});
add(
  "tags/{id}",
  "DELETE",
  "Remove a tag without deleting its items",
  apiOutputs.ok,
);
add(
  "tags/{id}/items",
  "GET",
  "List items assigned to a tag",
  listOutput(apiOutputs.item),
  { query: listQuery.strict() },
);
for (const method of ["GET", "PATCH"])
  add(
    "item-tags/{kind}/{id}",
    method,
    method === "GET"
      ? "Read assigned tags"
      : "Assign tags with the item's current revision",
    z.object({
      revision: z.number().int().positive(),
      tags: z.array(apiOutputs.tag),
    }),
    { input: method === "PATCH" ? apiInputs.itemTags : undefined },
  );
add("favorites", "GET", "List favorite items", listOutput(apiOutputs.item), {
  query: listQuery.strict(),
});
add(
  "search",
  "GET",
  "Search indexed active content",
  listOutput(
    z
      .object({
        id: z.string(),
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
        dailyDate: z.string().nullable().optional(),
        journalPeriod: z
          .enum(["daily", "weekly", "monthly"])
          .nullable()
          .optional(),
        journalPeriodStart: z.string().nullable().optional(),
      })
      .passthrough(),
  ),
  { query: apiQueries.search },
);
add(
  "counts",
  "GET",
  "Get exact item and task-state counts",
  z
    .object({
      exact: z.literal(true),
      state: z.enum(["active", "trash"]),
      total: z.number().int().nonnegative(),
      counts: z.record(z.string(), z.number().int().nonnegative()),
      taskStatus: z.object({
        open: z.number().int().nonnegative(),
        completed: z.number().int().nonnegative(),
      }),
    })
    .passthrough(),
  { query: apiQueries.counts },
);
add(
  "trash",
  "GET",
  "List deleted items; agents have read access only",
  listOutput(apiOutputs.trashItem),
  { query: apiQueries.trash },
);
add(
  "trash/{kind}/{id}/restore",
  "POST",
  "Restore a deleted item as the owner",
  apiOutputs.ok,
  { input: revisionInput, access: "owner" },
);
add(
  "trash/{kind}/{id}",
  "DELETE",
  "Permanently delete an item as the owner",
  apiOutputs.ok,
  { input: revisionInput, access: "owner" },
);
add(
  "events",
  "GET",
  "List calendar event records",
  listOutput(apiOutputs.event),
  { query: listQuery.strict() },
);
add("events/{id}", "GET", "Read an event and linked items", apiOutputs.event);
add("events", "POST", "Create an event", apiOutputs.event, {
  input: apiInputs.eventCreate,
  status: 201,
});
add(
  "events/{id}",
  "PATCH",
  "Update an event occurrence or series",
  apiOutputs.event,
  { input: apiInputs.eventUpdate },
);
add(
  "events/{id}",
  "DELETE",
  "Move an event occurrence or series to Trash",
  z.union([apiOutputs.event, apiOutputs.ok]),
  { input: apiInputs.eventDelete },
);
add(
  "calendar/range",
  "GET",
  "Read bounded calendar occurrences and activity",
  extraOutputs.calendarRange,
  { query: apiQueries.calendar },
);
add(
  "calendar/export",
  "GET",
  "Download calendar items as an iCalendar file",
  z.object({ exported: z.literal(true) }).strict(),
  {
    query: apiQueries.calendarExport,
    binary: "text/calendar",
    access: "owner",
  },
);
add("jobs/{id}", "GET", "Read background job status", jobSchema);
add(
  "completions",
  "GET",
  "Stream owner content and job completion invalidations",
  object,
  { binary: "text/event-stream", access: "owner" },
);
add("overview", "GET", "Read workspace summaries", extraOutputs.overview, {
  query: z
    .object({
      date: apiInputs.journalCreate.shape.date,
      timezone: apiQueries.calendar.shape.timezone.optional(),
    })
    .strict(),
});
add(
  "notes/{id}/publication",
  "GET",
  "Read a publication and its canonical share URL",
  apiOutputs.publication.nullable(),
);
add(
  "notes/{id}/publication",
  "POST",
  "Prepare and publish a note",
  apiOutputs.publication,
  { input: revisionInput },
);
add("notes/{id}/publication", "DELETE", "Unpublish a note", apiOutputs.ok);
add(
  "notes/{id}/duplicate",
  "POST",
  "Duplicate a note with its attachments",
  apiOutputs.note,
  { input: empty, optionalBody: true, status: 201 },
);
add(
  "notes/{id}/connections",
  "GET",
  "Read linked content",
  extraOutputs.connections,
);
add(
  "notes/{id}/history",
  "GET",
  "List note checkpoints",
  z.array(extraOutputs.checkpoint),
);
add(
  "notes/{id}/history/{versionId}",
  "GET",
  "Read a note checkpoint",
  extraOutputs.checkpoint,
);
add(
  "notes/{id}/history/{versionId}/restore",
  "POST",
  "Restore a checkpoint with the current note revision",
  apiOutputs.note,
  { input: revisionInput },
);
add("files", "GET", "List note attachments", extraOutputs.files, {
  query: z.object({ note: idSchema }).strict(),
});
add("files/{id}", "GET", "Read an authorized attachment", object, {
  binary: "application/octet-stream",
});
add(
  "files",
  "POST",
  "Upload a note attachment",
  z
    .object({
      id: idSchema,
      url: z.string().url(),
      name: z.string(),
      mime: z.string(),
    })
    .passthrough(),
  { multipart: true, status: 201 },
);
for (const kind of ["bundle", "markdown"]) {
  if (kind === "bundle")
    add("export/bundle", "GET", "Export a content bundle", object, {
      binary: "application/zip",
    });
  else
    add(
      "export/markdown/{id}",
      "POST",
      "Export a note as Markdown with attachments",
      object,
      {
        binary: "application/zip",
        input: z.object({ markdown: z.string().max(8 * 1024 * 1024) }).strict(),
      },
    );
}
add(
  "import/bundle",
  "POST",
  "Import a content bundle",
  z
    .object({
      imported: z.number().int().nonnegative(),
      importedTasks: z.number().int().nonnegative(),
      importedBookmarks: z.number().int().nonnegative(),
      dailyConflicts: z.number().int().nonnegative(),
    })
    .passthrough(),
  { binaryInput: "application/zip" },
);
add(
  "status",
  "GET",
  "Read installation and current-session status",
  extraOutputs.status,
  {
    access: "public",
  },
);
add(
  "setup",
  "POST",
  "Create the first owner and choose encryption",
  extraOutputs.recovery,
  {
    input: apiInputs.setup,
    access: "public",
  },
);
add(
  "setup-passkey",
  "POST",
  "Begin first-owner passkey setup",
  extraOutputs.passkeySetup,
  {
    input: apiInputs.passkeySetup,
    access: "public",
  },
);
add(
  "setup-passkey/cancel",
  "POST",
  "Cancel pending passkey setup",
  apiOutputs.ok,
  {
    input: z.object({ context: z.string().length(43) }).strict(),
    access: "public",
  },
);
add("recover", "POST", "Recover the owner account", extraOutputs.recovery, {
  access: "public",
  input: apiInputs.recovery,
});
add(
  "extension/authorize",
  "POST",
  "Approve a browser extension pairing as the owner",
  extraOutputs.extensionCode,
  { access: "owner", input: apiInputs.extensionAuthorize, status: 201 },
);
add(
  "extension/pair",
  "POST",
  "Exchange a one-time pairing code for an extension key",
  extraOutputs.extensionPaired,
  { access: "public", input: apiInputs.extensionPair, status: 201 },
);
add(
  "extension/session",
  "GET",
  "Read the current browser extension connection",
  extraOutputs.extensionSession,
);
add(
  "extension/session",
  "DELETE",
  "Disconnect the current browser extension",
  apiOutputs.ok,
);
for (const method of ["GET", "PATCH"])
  add(
    "settings",
    method,
    "Read or update owner appearance and setup progress",
    extraOutputs.settings,
    {
      access: "owner",
      input: method === "PATCH" ? apiInputs.settingsUpdate : undefined,
    },
  );
add(
  "settings/recovery",
  "POST",
  "Replace the owner's recovery code",
  extraOutputs.recovery,
  {
    access: "owner",
    input: z.object({ password: z.string() }),
  },
);
add("account-password", "POST", "Set the owner's password", apiOutputs.ok, {
  access: "owner",
  input: apiInputs.accountPassword,
});
add(
  "ai-consent",
  "GET",
  "Read OAuth client consent information",
  z.object({ name: z.string() }),
  {
    access: "owner",
    query: z.object({ client: z.string().min(1).max(4096) }).strict(),
  },
);
for (const method of ["GET", "POST"])
  add(
    "ai-connections",
    method,
    "Manage MCP credentials as the owner",
    method === "GET"
      ? extraOutputs.credentials
      : extraOutputs.credentialMutation,
    {
      access: "owner",
      input: method === "POST" ? apiInputs.agentManagement : undefined,
      status: method === "POST" ? 201 : 200,
      additionalStatuses: method === "POST" ? [200] : undefined,
    },
  );
for (const method of ["GET", "PATCH"])
  add(
    "system",
    method,
    "Manage instance configuration as the owner",
    extraOutputs.system,
    {
      access: "owner",
      input: method === "GET" ? undefined : apiInputs.systemUpdate,
    },
  );
for (const action of ["verify", "retry", "cleanup"])
  add(
    `system/${action}`,
    "POST",
    `Run owner storage ${action}`,
    action === "verify"
      ? z.object({ verificationToken: z.string() })
      : extraOutputs.system,
    {
      access: "owner",
      input: action === "verify" ? apiInputs.systemVerify : empty,
      optionalBody: action !== "verify",
    },
  );
add(
  "backups",
  "GET",
  "Read full-instance backup status",
  extraOutputs.backups,
  {
    access: "owner",
  },
);
add(
  "backups",
  "POST",
  "Queue an owner-only full-instance backup",
  z.object({ accepted: z.literal(true) }),
  { access: "owner", status: 202 },
);
add(
  "backups/{id}/verify",
  "POST",
  "Verify a recovery backup",
  extraOutputs.backup,
  {
    access: "owner",
  },
);
for (const method of ["GET", "POST", "DELETE"])
  add(
    "calendar/subscriptions",
    method,
    "Manage device push notifications as the owner",
    method === "GET" ? extraOutputs.subscriptions : apiOutputs.ok,
    {
      access: "owner",
      input:
        method === "POST"
          ? apiInputs.subscription
          : method === "DELETE"
            ? apiInputs.unsubscribe
            : undefined,
    },
  );
add(
  "calendar/subscriptions/test",
  "POST",
  "Send a device test reminder",
  apiOutputs.ok,
  { access: "owner", optionalBody: true },
);
add(
  "calendar/reminders",
  "GET",
  "List reminder delivery records",
  listOutput(
    z
      .object({
        id: z.string().regex(/^[a-f0-9]{64}$/),
        title: z.string(),
        scheduledAt: z.number(),
        state: z.string(),
        sourceType: z.string(),
        sourceId: z.string(),
        occurrence: z.string(),
      })
      .strict(),
  ),
  { query: listQuery.omit({ q: true }).strict() },
);
add(
  "calendar/reminders/{id}",
  "PATCH",
  "Dismiss a reminder record",
  apiOutputs.ok,
  { optionalBody: true },
);
for (const method of ["GET", "PUT"])
  add(
    "calendar/task-reminders/{id}",
    method,
    "Read or configure task reminders",
    z.union([extraOutputs.taskReminders, apiOutputs.ok]),
    { input: method === "PUT" ? apiInputs.taskReminders : undefined },
  );
add(
  "calendar/tasks",
  "GET",
  "List overdue or undated task summaries",
  extraOutputs.calendarTasks,
  {
    query: listQuery
      .omit({ q: true })
      .extend({
        mode: z.enum(["unscheduled", "overdue"]),
        date: apiInputs.journalCreate.shape.date,
      })
      .strict(),
  },
);
add("media", "GET", "Read authorized remote media", object, {
  access: "owner",
  binary: "application/octet-stream",
  query: z.object({ url: z.string().max(4096) }),
});
add(
  "published/{token}",
  "GET",
  "Read published note data",
  extraOutputs.published,
  {
    access: "public",
  },
);
add(
  "published/{token}/files/{id}",
  "GET",
  "Read an attachment included in a public share",
  object,
  { access: "public", binary: "application/octet-stream" },
);
add(
  "published/{token}/media",
  "GET",
  "Read media included in a public share",
  object,
  {
    access: "public",
    binary: "application/octet-stream",
    query: z.object({ url: z.string().max(4096) }),
  },
);
export function operationFor(path: string, method: string) {
  return apiOperations
    .filter(
      (operation) =>
        operation.method === method && matches(operation.path, path),
    )
    .sort((a, b) => specificity(b.path) - specificity(a.path))[0];
}
function specificity(path: string) {
  return path
    .split("/")
    .reduce((score, part) => score + (/^\{[^}]+\}$/.test(part) ? 0 : 1), 0);
}
export function matches(template: string, path: string) {
  const parts = template.split("/");
  const actual = path.split("/");
  return (
    parts.length === actual.length &&
    parts.every((part, index) =>
      /^\{[^}]+\}$/.test(part)
        ? Boolean(actual[index])
        : part === actual[index],
    )
  );
}
function rawSchema(value: z.ZodType, io: "input" | "output" = "output") {
  const converted = z.toJSONSchema(value, { target: "draft-2020-12", io });
  delete converted.$schema;
  return converted;
}
export function openApiDocument() {
  const definitions: Record<string, unknown> = {};
  const known = new Map<string, string>();
  function schema(
    value: z.ZodType,
    io: "input" | "output" = "output",
    label = "Schema",
  ) {
    const converted = rawSchema(value, io);
    const key = JSON.stringify(converted);
    let name = known.get(key);
    if (!name) {
      name = label.replace(/[^a-zA-Z0-9_]/g, "_");
      if (name in definitions) name += "_" + (known.size + 1);
      known.set(key, name);
      const localDefinitions = (
        converted as { $defs?: Record<string, unknown> }
      ).$defs;
      if (localDefinitions) {
        delete (converted as { $defs?: Record<string, unknown> }).$defs;
        const qualified = new Map(
          Object.keys(localDefinitions).map((localName) => [
            localName,
            `${name}_${localName}`,
          ]),
        );
        const rewrite = (value: unknown): unknown => {
          if (Array.isArray(value)) return value.map(rewrite);
          if (!value || typeof value !== "object") return value;
          const entry = value as Record<string, unknown>;
          if (typeof entry.$ref === "string") {
            const prefix = "#/$defs/";
            const localName = entry.$ref.startsWith(prefix)
              ? entry.$ref.slice(prefix.length)
              : "";
            if (qualified.has(localName))
              entry.$ref = `#/components/schemas/${qualified.get(localName)}`;
          }
          for (const [key, child] of Object.entries(entry))
            entry[key] = rewrite(child);
          return entry;
        };
        rewrite(converted);
        for (const [localName, localSchema] of Object.entries(
          localDefinitions,
        )) {
          const promoted = rewrite(localSchema);
          const promotedName = qualified.get(localName)!;
          if (promotedName in definitions)
            throw new Error(`Duplicate generated schema ${promotedName}.`);
          definitions[promotedName] = promoted;
        }
      }
      definitions[name] = converted;
    }
    return { $ref: "#/components/schemas/" + name };
  }
  for (const [name, value] of Object.entries(apiOutputs))
    schema(value, "output", name[0].toUpperCase() + name.slice(1));
  schema(jobSchema, "output", "Job");
  for (const [name, value] of Object.entries(apiInputs))
    schema(value, "input", name[0].toUpperCase() + name.slice(1) + "Request");
  const errorResponses = Object.fromEntries(
    [400, 401, 403, 404, 405, 409, 413, 415, 422, 429, 500, 503].map((code) => [
      code,
      {
        description: (
          {
            400: "Invalid input",
            401: "Authentication required",
            403: "Insufficient permission or disallowed origin",
            404: "Resource not found",
            405: "Unsupported method",
            409: "Revision or retry conflict",
            413: "Request too large",
            415: "Unsupported media type",
            422: "Operation cannot be applied to the selected data",
            429: "Rate limited; retry after the Retry-After interval",
            500: "Internal failure",
            503: "Temporarily unavailable",
          } as Record<number, string>
        )[code],
        content: { "application/json": { schema: schema(apiOutputs.error) } },
        ...([429, 503].includes(code)
          ? {
              headers: {
                "Retry-After": {
                  schema: { type: "integer" },
                  description: "Seconds until retry",
                },
              },
            }
          : {}),
      },
    ]),
  );
  const paths: Record<string, Record<string, unknown>> = {};
  for (const operation of apiOperations) {
    const { path, method, input, query, output, status, access, binary } =
      operation;
    const parameters: unknown[] = [...path.matchAll(/\{([^}]+)\}/g)].map(
      (match) => ({
        name: match[1],
        in: "path",
        required: true,
        schema: path.startsWith("/api/v1/backups/")
          ? { type: "string", minLength: 1, maxLength: 300 }
          : path.startsWith("/api/v1/calendar/reminders/")
            ? { type: "string", pattern: "^[a-f0-9]{64}$" }
            : ["id", "versionId", "responseId", "fileId"].includes(match[1])
              ? schema(idSchema)
              : match[1] === "token"
                ? {
                    type: "string",
                    pattern: path.startsWith("/api/v1/published/")
                      ? "^[a-f0-9]{48}$"
                      : "^[A-Za-z0-9_-]{32}$",
                  }
                : match[1] === "format"
                  ? { type: "string", enum: ["csv", "json"] }
                  : { type: "string" },
      }),
    );
    for (const header of operation.headers ?? [])
      parameters.push({
        name: header.name,
        in: "header",
        required: header.required,
        schema: schema(header.schema, "input"),
      });
    if (query) {
      const value = rawSchema(query, "input") as {
        properties?: Record<string, unknown>;
        required?: string[];
      };
      for (const [name, property] of Object.entries(value.properties ?? {}))
        parameters.push({
          name,
          in: "query",
          required: value.required?.includes(name) ?? false,
          schema: property,
        });
    }
    if (
      (method === "POST" ||
        (path.startsWith("/api/v1/forms/") &&
          ["PATCH", "DELETE"].includes(method))) &&
      access === "content" &&
      !operation.binary &&
      !operation.binaryInput
    )
      parameters.push({
        name: "Idempotency-Key",
        in: "header",
        required: false,
        description:
          "8–128 characters. JSON requests only. Repeating identical input returns the original result for 24 hours; conflicting or in-progress input returns 409.",
        schema: { type: "string", minLength: 8, maxLength: 128 },
      });
    const errors = Object.fromEntries(
      Object.keys(errorResponses).map((code) => [
        code,
        { $ref: "#/components/responses/Error" + code },
      ]),
    );
    const content: Record<string, unknown> = {
      [binary ?? "application/json"]: {
        schema: binary
          ? { type: "string" }
          : schema(
              output,
              "output",
              method.toLowerCase() +
                path.replace(/[^a-zA-Z0-9]+/g, "_") +
                "Response",
            ),
      },
    };
    const requestContent: Record<string, unknown> = input
      ? {
          "application/json": {
            schema: schema(
              input,
              "input",
              method.toLowerCase() +
                path.replace(/[^a-zA-Z0-9]+/g, "_") +
                "Request",
            ),
          },
        }
      : {};
    if (operation.binaryInput)
      requestContent[operation.binaryInput] = {
        schema: { type: "string", format: "binary" },
      };
    if (operation.multipart)
      requestContent["multipart/form-data"] = {
        schema: {
          type: "object",
          properties: {
            file: { type: "string", format: "binary" },
            ...(path.endsWith("/files")
              ? { note: { type: "string", format: "uuid" } }
              : { thumb: { type: "string", format: "binary" } }),
          },
          required: path.endsWith("/files") ? ["file", "note"] : ["file"],
        },
      };
    const entry = {
      operationId: method.toLowerCase() + path.replace(/[^a-zA-Z0-9]+/g, "_"),
      summary: operation.summary,
      security:
        access === "public"
          ? []
          : access === "owner"
            ? [{ ownerSession: [] }]
            : [{ ownerSession: [] }, { apiKey: [] }],
      "x-nivra-access": access,
      parameters,
      responses: {
        [status]: { description: "Success", content },
        ...Object.fromEntries(
          (operation.additionalStatuses ?? []).map((code) => [
            code,
            { description: "Success", content },
          ]),
        ),
        ...(binary && binary !== "text/event-stream"
          ? {
              206: { description: "Partial content", content },
              416: { description: "Range not satisfiable" },
            }
          : {}),
        ...errors,
      },
      ...(Object.keys(requestContent).length
        ? {
            requestBody: {
              required: !operation.optionalBody,
              content: requestContent,
            },
          }
        : {}),
    };
    (paths[path] ??= {})[method.toLowerCase()] = entry;
  }
  paths["/health"] = {
    get: {
      operationId: "health",
      summary: "Check installation and database readiness",
      security: [],
      responses: {
        200: {
          description: "Ready or installation pending",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  status: { const: "ok" },
                  installation: { const: "pending" },
                },
                required: ["status"],
              },
            },
          },
        },
        503: { description: "Unavailable" },
      },
    },
  };
  return {
    openapi: "3.1.1",
    info: {
      title: "Nivra HTTP API",
      version: "1.0.0",
      description:
        "Session-authenticated web operations and scoped bearer API-key content access. Write includes read. Agents can move active items to Trash and list deleted items, but cannot restore, change trashed items, or permanently delete content. OAuth remains an MCP interface. Lists return a bounded items array and an explicit next cursor. BlockNote JSON is canonical. Custom calendar/document validation applies in addition to JSON Schema constraints.",
    },
    servers: [{ url: "/" }],
    paths,
    components: {
      schemas: definitions,
      responses: Object.fromEntries(
        Object.entries(errorResponses).map(([code, value]) => [
          "Error" + code,
          value,
        ]),
      ),
      securitySchemes: {
        ownerSession: {
          type: "apiKey",
          in: "cookie",
          name: "better-auth.session_token",
          description:
            "Owner browser session; secure deployments use the __Secure- cookie prefix. Writes enforce same-origin protection.",
        },
        apiKey: {
          type: "http",
          scheme: "bearer",
          description:
            "A Nivra API key with Read or Read & write access. OAuth tokens are not accepted.",
        },
      },
    },
  };
}

const aiStatus = z
  .object({
    enabled: z.boolean(),
    taggingMode: z.enum(["manual", "automatic"]),
    revision: z.number().int().positive(),
    total: z.number().int().nonnegative(),
    indexed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    capacity: z.number().int().nonnegative(),
    vocabularyPending: z.number().int().nonnegative(),
    chunkLimit: z.number().int().positive(),
  })
  .strict();
add(
  "ai",
  "GET",
  "Read private local AI settings and indexing coverage",
  aiStatus,
  { access: "owner" },
);
add("ai", "PATCH", "Enable or disable local AI", aiStatus, {
  access: "owner",
  input: z
    .object({
      enabled: z.boolean(),
      revision: z.number().int().positive(),
      taggingMode: z.enum(["manual", "automatic"]).optional(),
    })
    .strict(),
});
add(
  "ai/suggestions",
  "GET",
  "Read up to 30 private existing-tag suggestions",
  z
    .object({
      items: z.array(
        z
          .object({
            id: idSchema,
            itemId: idSchema,
            type: z.enum([
              "note",
              "task",
              "bookmark",
              "artifact",
              "event",
              "form",
              "response",
            ]),
            title: z.string(),
            excerpt: z.string().max(240),
            formId: idSchema.optional(),
            tag: apiOutputs.tag,
            createdAt: z.number().int().nonnegative(),
          })
          .strict(),
      ),
    })
    .strict(),
  { access: "owner" },
);
for (const action of ["accept", "reject"])
  add(
    `ai/suggestions/{id}/${action}`,
    "POST",
    action === "accept"
      ? "Merge an approved tag into current assignments"
      : "Dismiss a private tag suggestion",
    apiOutputs.ok,
    { access: "owner", input: empty },
  );

add(
  "ai/tag-proposals",
  "GET",
  "Read private proposals for reusable new tags",
  z
    .object({
      items: z
        .array(
          z
            .object({
              id: idSchema,
              name: z.string().min(1).max(60),
              color: z.literal("gray"),
              itemCount: z.number().int().min(3),
              items: z
                .array(
                  z
                    .object({
                      itemId: idSchema,
                      type: z.enum([
                        "note",
                        "task",
                        "bookmark",
                        "artifact",
                        "event",
                        "form",
                        "response",
                      ]),
                      title: z.string(),
                      formId: idSchema.optional(),
                    })
                    .strict(),
                )
                .max(3),
              createdAt: z.number().int().nonnegative(),
            })
            .strict(),
        )
        .max(30),
    })
    .strict(),
  { access: "owner" },
);
for (const action of ["accept", "reject"])
  add(
    `ai/tag-proposals/{id}/${action}`,
    "POST",
    action === "accept"
      ? "Create or reuse an approved tag and merge its assignments"
      : "Dismiss a reusable tag proposal",
    apiOutputs.ok,
    { access: "owner", input: empty },
  );
