import { z } from "zod";
import { connectionInput } from "./system-configuration";
import {
  boardInput,
  boardChanges,
  taskBoardFields,
  taskMoveInput,
  taskStages,
} from "../boards";
import { eventInput, dateSchema, zoneSchema } from "../calendar";
import { tagColors } from "../tags";
import {
  taskRecurrenceRuleSchema,
  taskScheduleIssueSchema,
  taskScheduleSchema,
  taskStepSchema,
} from "../task-planning";
import {
  articleActionSchema,
  articleContentSchema,
  bookmarkHighlightCreateSchema,
  bookmarkHighlightDeleteSchema,
  bookmarkHighlightUpdateSchema,
  bookmarkReadStateBatchSchema,
} from "../bookmark-reading";
import { writingInputs } from "./writing-contract";
import {
  calendarDate,
  canonicalDocumentInput,
  documentInput,
  noteInput,
  taskSchedule,
  setupInput,
  credentials,
} from "./validation";
export const idSchema = z.string().uuid();
export const revisionInput = z
  .object({ revision: z.number().int().positive() })
  .strict();
const changes = <T extends z.ZodRawShape>(shape: T) =>
  z
    .object(shape)
    .strict()
    .refine(
      (v) => Object.keys(v).length > 1,
      "Provide at least one field to change.",
    );
export const apiInputs = {
  agentManagement: z.discriminatedUnion("action", [
    z.object({
      action: z.literal("create-key"),
      name: z.string().trim().min(1).max(80),
      access: z.enum(["read", "full"]),
      expiresIn: z.number().int().min(60).max(31536000).optional(),
    }),
    z.object({
      action: z.literal("revoke-key"),
      id: z.string().min(1).max(200),
    }),
    z.object({
      action: z.literal("revoke-oauth"),
      clientId: z.string().min(1).max(4096),
    }),
  ]),
  systemUpdate: z
    .object({
      revision: z.number().int().positive(),
      storageBackend: z.enum(["local", "s3"]),
      s3Backups: z.boolean(),
      uploadMiB: z.number().int().min(1).max(100),
      backupHours: z.number().int().min(1).max(8760),
      backupKeep: z.number().int().min(1).max(365),
      verificationToken: z.string().min(43).max(43).optional(),
    })
    .strict(),
  systemVerify: z
    .object({ connection: connectionInput, s3Backups: z.boolean() })
    .strict(),
  noteCreate: z
    .object({
      title: z.string().max(300).default(""),
      document: canonicalDocumentInput.optional(),
    })
    .strict(),
  noteUpdate: noteInput,
  journalCreate: writingInputs.journalCreate,
  taskCreate: z
    .object({
      title: z.string().trim().min(1).max(300),
      ...taskSchedule,
      schedule: taskScheduleSchema.nullable().optional(),
      recurrenceRule: taskRecurrenceRuleSchema.nullable().optional(),
      ...taskBoardFields,
      status: z.enum(["todo", "in_progress"]).optional(),
    })
    .strict(),
  taskUpdate: changes({
    revision: revisionInput.shape.revision,
    title: z.string().trim().min(1).max(300).optional(),
    completed: z.boolean().optional(),
    ...taskSchedule,
    schedule: taskScheduleSchema.nullable().optional(),
    recurrenceRule: taskRecurrenceRuleSchema.nullable().optional(),
    ...taskBoardFields,
  }),
  taskMove: taskMoveInput,
  bookmarkCreate: z
    .object({
      url: z.string().trim().min(1).max(4096),
      collection: z.string().trim().max(80).default(""),
    })
    .strict(),
  bookmarkUpdate: changes({
    revision: revisionInput.shape.revision,
    title: z.string().trim().min(1).max(300).optional(),
    description: z.string().max(2000).optional(),
    collection: z.string().trim().max(80).optional(),
    favorite: z.boolean().optional(),
    noteId: idSchema.nullable().optional(),
  }),
  bookmarkReadState: bookmarkReadStateBatchSchema,
  bookmarkArticleAction: articleActionSchema,
  bookmarkHighlightCreate: bookmarkHighlightCreateSchema,
  bookmarkHighlightUpdate: bookmarkHighlightUpdateSchema,
  bookmarkHighlightDelete: bookmarkHighlightDeleteSchema,
  artifactCreate: z.object({ text: z.string().max(400000) }).strict(),
  artifactUpdate: changes({
    revision: revisionInput.shape.revision,
    title: z.string().max(300).optional(),
    content: z.string().max(400000).optional(),
  }),
  boardCreate: boardInput,
  boardUpdate: boardChanges,
  tagCreate: z
    .object({
      name: z.string().trim().min(1).max(50),
      aliases: z.array(z.string().trim().min(1).max(80)).max(10).optional(),
      color: z.enum(tagColors).default("gray"),
    })
    .strict(),
  itemTags: z
    .object({
      revision: revisionInput.shape.revision,
      tags: z.array(idSchema).max(100),
    })
    .strict(),
  eventCreate: eventInput,
  eventUpdate: z
    .object({
      input: eventInput,
      revision: revisionInput.shape.revision,
      scope: z.enum(["series", "occurrence", "following"]).default("series"),
      occurrence: z.string().max(40).optional(),
    })
    .strict(),
  eventDelete: z
    .object({
      revision: revisionInput.shape.revision,
      scope: z.enum(["series", "occurrence", "following"]).default("series"),
      occurrence: z.string().max(40).optional(),
    })
    .strict(),
  setup: setupInput.extend({ encrypted: z.boolean().default(true) }),
  passkeySetup: setupInput
    .omit({ password: true })
    .extend({ encrypted: z.boolean().default(true) }),
  taskReminders: z
    .object({
      revision: revisionInput.shape.revision,
      timezone: zoneSchema,
      field: z.enum(["schedule", "planned", "due"]),
      offsets: z.array(z.number().int().min(0).max(10080)).max(3),
    })
    .strict(),
  subscription: z
    .object({
      endpoint: z.string().url().max(4096),
      expirationTime: z.number().finite().nonnegative().nullable().optional(),
      keys: z
        .object({
          p256dh: z.string().min(80).max(100),
          auth: z.string().min(20).max(30),
        })
        .strict(),
    })
    .strict(),
  unsubscribe: z.object({ endpoint: z.string().url().max(4096) }).strict(),
  settingsUpdate: z
    .object({
      theme: z.enum(["light", "dark", "system"]).optional(),
      onboardingStep: z.enum(["tags", "install", "complete"]).optional(),
    })
    .strict()
    .refine((value) => Object.keys(value).length > 0, {
      message: "Provide at least one setting to change.",
    }),
  accountPassword: credentials.omit({ username: true }),
  recovery: credentials
    .omit({ username: true })
    .extend({ code: z.string().min(30).max(100) }),
};
export const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(60),
  after: z.string().max(400).optional(),
  offset: z.coerce.number().int().min(0).max(1000000).optional(),
  q: z.string().max(300).default(""),
});
export const apiQueries = {
  notes: listQuery
    .extend({
      view: z.enum(["all", "journal", "favorites", "trash"]).optional(),
      sort: z.enum(["updated", "created", "title"]).optional(),
      preview: z.enum(["0", "1"]).optional(),
      tag: idSchema.optional(),
    })
    .strict(),
  journals: writingInputs.journalList,
  tasks: listQuery
    .omit({ offset: true })
    .extend({
      filter: z.enum(["open", "completed"]).default("open"),
      boardId: z.union([idSchema, z.literal("unassigned")]).optional(),
      status: z.enum(taskStages).optional(),
      order: z.enum(["recent", "board"]).default("recent"),
      summary: z.enum(["0", "1"]).optional(),
    })
    .strict(),
  bookmarks: listQuery
    .omit({ offset: true })
    .extend({
      favorite: z.enum(["0", "1"]).optional(),
      unfiled: z.enum(["0", "1"]).optional(),
      collection: z.string().max(80).optional(),
      readingState: z.enum(["all", "unread", "read"]).default("all"),
      summary: z.enum(["0", "1"]).optional(),
    })
    .strict(),
  artifacts: listQuery
    .omit({ offset: true })
    .extend({
      context: z.enum(["0", "1"]).optional(),
      kind: z.enum(["text", "image", "file"]).optional(),
      summary: z.enum(["0", "1"]).optional(),
    })
    .strict(),
  boards: listQuery
    .omit({ offset: true })
    .extend({ archived: z.enum(["0", "1"]).default("0") })
    .strict(),
  trash: listQuery
    .omit({ offset: true })
    .extend({
      kind: z
        .enum([
          "note",
          "journal",
          "task",
          "bookmark",
          "artifact",
          "event",
          "form",
          "form_response",
        ])
        .optional(),
    })
    .strict(),
  counts: z
    .object({
      state: z.enum(["active", "trash"]).default("active"),
      tagId: idSchema.optional(),
      favoritesOnly: z.enum(["0", "1"]).default("0"),
    })
    .strict(),
  search: listQuery
    .extend({
      purpose: z.enum(["workspace", "link"]).default("workspace"),
      mode: z.enum(["full", "suggest"]).default("full"),
      strategy: z.enum(["keyword", "semantic"]).default("keyword"),
    })
    .strict(),
  calendar: z
    .object({
      from: dateSchema,
      to: dateSchema,
      timezone: zoneSchema,
      mode: z.enum(["planning", "activity"]).default("planning"),
      includeCompleted: z.enum(["0", "1"]).default("1"),
      preview: z.coerce.number().int().min(0).max(50).default(0),
      after: z.string().max(2048).optional(),
      offset: z.coerce.number().int().min(0).max(100000).default(0),
      limit: z.coerce.number().int().min(1).max(10000).default(500),
      tag: idSchema.optional(),
      query: z.string().max(300).optional(),
    })
    .strict(),
  bookmarkArticle: z
    .object({ version: z.coerce.number().int().positive().optional() })
    .strict(),
  bookmarkArticleVersions: z
    .object({
      limit: z.coerce.number().int().min(1).max(50).default(20),
      after: z.string().max(2048).optional(),
    })
    .strict(),
  bookmarkHighlights: z
    .object({
      version: z.coerce.number().int().positive().optional(),
      limit: z.coerce.number().int().min(1).max(100).default(60),
      after: z.string().max(2048).optional(),
    })
    .strict(),
  calendarExport: z
    .object({ from: dateSchema, to: dateSchema, timezone: zoneSchema })
    .strict(),
};
const time = z.number().int().nonnegative();
export const jobSchema = z
  .object({
    id: idSchema,
    kind: z.enum(["artifact", "bookmark", "thumbnail", "article"]),
    targetId: idSchema,
    status: z.enum(["queued", "running", "done", "failed"]),
    attempts: time,
    createdAt: time,
    url: z.string().url().optional(),
  })
  .strict();
const summary = z
  .object({
    id: idSchema,
    title: z.string(),
    revision: z.number().int().positive(),
    jobs: z.array(jobSchema).optional(),
  })
  .passthrough();
const tag = z.object({
  aliases: z.array(z.string()).optional(),
  id: idSchema,
  name: z.string(),
  color: z.enum(tagColors),
});
const bookmarkArticleOutput = z
  .object({
    bookmarkId: idSchema,
    version: z.number().int().positive(),
    url: z.string().url(),
    capturedAt: time,
    title: z.string(),
    byline: z.string().nullable(),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    content: articleContentSchema,
    text: z.string(),
  })
  .strict();
const bookmarkHighlightOutput = z
  .object({
    id: idSchema,
    bookmarkId: idSchema,
    articleVersion: z.number().int().positive(),
    quote: z.string(),
    prefix: z.string(),
    suffix: z.string(),
    startOffset: time,
    endOffset: time,
    annotation: z.string(),
    revision: z.number().int().positive(),
    createdAt: time,
    updatedAt: time,
  })
  .strict();
const writingTemplateOutput = z
  .object({
    id: idSchema,
    name: z.string(),
    description: z.string(),
    kind: z.enum(["note", "journal"]),
    revision: z.number().int().positive(),
    createdAt: time,
    updatedAt: time,
  })
  .passthrough();
export const apiOutputs: Record<string, z.ZodType> = {
  note: summary
    .extend({
      document: documentInput,
      text: z.string(),
      tags: z.array(tag),
      dailyDate: z.string().nullable(),
      journalPeriod: z.enum(["daily", "weekly", "monthly"]).nullable(),
      journalPeriodStart: z.string().nullable(),
      favorite: z.boolean(),
      editorWidth: z.enum(["standard", "wide"]),
      trashedAt: z.number().nullable(),
      createdAt: time,
      updatedAt: time,
    })
    .passthrough(),
  noteSummary: summary
    .extend({
      tags: z.array(tag),
      dailyDate: z.string().nullable(),
      journalPeriod: z.enum(["daily", "weekly", "monthly"]).nullable(),
      journalPeriodStart: z.string().nullable(),
      favorite: z.boolean(),
      createdAt: time,
      updatedAt: time,
    })
    .passthrough(),
  task: summary
    .extend({
      status: z.enum(taskStages),
      dueDate: z.string().nullable(),
      plannedDate: z.string().nullable(),
      recurrence: z.enum(["daily", "weekly", "monthly"]).nullable(),
      recurrenceRule: taskRecurrenceRuleSchema.nullable(),
      schedule: taskScheduleSchema.nullable(),
      scheduleIssue: taskScheduleIssueSchema,
      stepProgress: z.object({ completed: time, total: time }).strict(),
      boardId: idSchema.nullable(),
      completedAt: z.number().nullable(),
    })
    .passthrough(),
  bookmark: summary
    .extend({
      url: z.string(),
      description: z.string(),
      favorite: z.boolean(),
      readAt: z.number().nullable(),
      articleStatus: z.enum(["pending", "ready", "unavailable"]),
      articleVersion: time,
      articleGeneration: time,
    })
    .passthrough(),
  bookmarkArticle: bookmarkArticleOutput,
  bookmarkArticleResult: z
    .object({
      status: z.enum(["pending", "ready", "unavailable"]),
      currentVersion: time,
      article: bookmarkArticleOutput.nullable(),
      jobId: idSchema.nullable(),
    })
    .strict(),
  bookmarkArticleVersionPage: z
    .object({
      items: z
        .array(
          z
            .object({
              version: time,
              capturedAt: time,
              title: z.string().max(300),
            })
            .strict(),
        )
        .max(50),
      next: z.string().nullable(),
    })
    .strict(),
  bookmarkHighlight: bookmarkHighlightOutput,
  bookmarkHighlightPage: z
    .object({
      items: z.array(bookmarkHighlightOutput).max(100),
      next: z.string().nullable(),
    })
    .strict(),
  bookmarkReadState: z
    .object({
      items: z.array(
        z
          .object({
            id: idSchema,
            status: z.enum(["updated", "unchanged", "conflict", "not_found"]),
            bookmark: z.lazy(() => apiOutputs.bookmark).optional(),
          })
          .strict(),
      ),
    })
    .strict(),
  taskStep: taskStepSchema,
  taskStepList: z
    .object({
      taskRevision: z.number().int().positive(),
      items: z.array(taskStepSchema).max(100),
    })
    .strict(),
  taskStepChange: z
    .object({ task: z.lazy(() => apiOutputs.task), step: taskStepSchema })
    .strict(),
  taskStepsChange: z
    .object({
      task: z.lazy(() => apiOutputs.task),
      items: z.array(taskStepSchema).max(100),
    })
    .strict(),
  taskChange: z.object({ task: z.lazy(() => apiOutputs.task) }).strict(),
  writingTemplate: writingTemplateOutput,
  writingTemplateDetail: writingTemplateOutput.extend({
    document: documentInput,
    attachments: z.array(
      z
        .object({
          id: idSchema,
          name: z.string(),
          mime: z.string(),
          size: time,
        })
        .strict(),
    ),
  }),
  writingTemplatePage: z
    .object({
      items: z.array(writingTemplateOutput).max(100),
      next: z.string().nullable(),
      total: time.optional(),
    })
    .strict(),
  templateApply: z
    .object({ note: z.lazy(() => apiOutputs.note), created: z.boolean() })
    .strict(),
  writingPreferences: z
    .object({
      revision: z.number().int().nonnegative(),
      defaultJournalTemplateId: idSchema.nullable(),
    })
    .strict(),
  linkedTaskConversion: z
    .object({
      note: z.lazy(() => apiOutputs.note),
      task: z.lazy(() => apiOutputs.task),
      created: z.boolean(),
    })
    .strict(),
  journalReview: z
    .object({
      period: z.enum(["daily", "weekly", "monthly"]),
      periodStart: calendarDate,
      entry: z.lazy(() => apiOutputs.noteSummary).nullable(),
      entries: z.array(z.lazy(() => apiOutputs.noteSummary)).max(100),
      tasks: z
        .array(
          z
            .object({
              id: idSchema,
              title: z.string(),
              dueDate: calendarDate.nullable(),
              plannedDate: calendarDate.nullable(),
              completedAt: time.nullable(),
            })
            .strict(),
        )
        .max(1000),
      events: z
        .array(
          z
            .object({
              id: idSchema,
              title: z.string(),
              startDate: calendarDate,
              endDate: calendarDate,
              data: eventInput,
            })
            .strict(),
        )
        .max(1000),
    })
    .strict(),
  journalHistory: z
    .object({ items: z.array(z.lazy(() => apiOutputs.noteSummary)).max(100) })
    .strict(),
  journalNavigation: z
    .object({ item: z.lazy(() => apiOutputs.noteSummary).nullable() })
    .strict(),
  article: z
    .object({
      bookmarkId: idSchema,
      version: z.number().int().positive(),
      url: z.string().url(),
      capturedAt: time,
      title: z.string(),
      byline: z.string().nullable(),
      fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
      content: articleContentSchema,
      text: z.string(),
    })
    .strict(),
  artifact: summary
    .extend({
      kind: z.enum(["text", "image", "file"]),
      name: z.string(),
      mime: z.string(),
      size: time,
      extraction: z.enum(["none", "pending", "done", "failed"]),
    })
    .passthrough(),
  board: z
    .object({
      id: idSchema,
      name: z.string(),
      revision: z.number().int().positive(),
      archivedAt: z.number().nullable(),
      createdAt: time,
      updatedAt: time,
      url: z.string().url(),
    })
    .passthrough(),
  event: eventInput
    .safeExtend({
      id: idSchema,
      ownerId: z.string(),
      revision: z.number().int().positive(),
      trashedAt: z.number().nullable(),
      createdAt: time,
      updatedAt: time,
    })
    .passthrough(),
  tag,
  item: z
    .object({
      id: idSchema,
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
      journalPeriod: z
        .enum(["daily", "weekly", "monthly"])
        .nullable()
        .optional(),
      journalPeriodStart: z.string().nullable().optional(),
    })
    .passthrough(),
  trashItem: z
    .object({
      id: idSchema,
      title: z.string(),
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
      excerpt: z.string(),
      revision: z.number().int().positive(),
      trashedAt: time,
    })
    .strict(),
  publication: z.object({
    token: z.string().regex(/^[a-f0-9]{48}$/),
    revision: z.number().int().positive(),
    publishedAt: z.number(),
    url: z.string().url(),
  }),
  ok: z.object({ ok: z.literal(true) }),
  error: z
    .object({ code: z.string().min(1), error: z.string().min(1) })
    .passthrough(),
};
export const listOutput = (item: z.ZodType) =>
  z
    .object({
      items: z.array(item).max(100),
      next: z.string().nullable(),
      nextOffset: z.number().int().nonnegative().nullable().optional(),
      total: time.optional(),
    })
    .passthrough();
