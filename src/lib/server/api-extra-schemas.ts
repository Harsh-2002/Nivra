import { z } from "zod";
import { documentInput } from "./validation";
import { apiOutputs, idSchema, listOutput } from "./api-schemas";
const count = z.number().int().nonnegative();
const link = z.object({ id: idSchema, title: z.string() });
const backup = z.object({
  id: z.string(),
  createdAt: count,
  size: count,
  files: count,
});
const settings = z.object({
  theme: z.enum(["light", "dark", "system"]),
  onboardingStep: z.enum(["tags", "install", "complete"]),
  hasPassword: z.boolean(),
  uploadLimit: count,
  twoFactorEnabled: z.boolean(),
});
const checkpoint = z.object({
  id: idSchema,
  title: z.string(),
  revision: z.number().int().positive(),
  createdAt: count,
  document: documentInput.optional(),
});
const recentNote = z.object({
  id: idSchema,
  type: z.literal("note"),
  title: z.string(),
  updatedAt: count,
});
const recentJournal = z.object({
  id: idSchema,
  type: z.literal("journal"),
  title: z.string(),
  date: z.string(),
  updatedAt: count,
});
const recentBookmark = z.object({
  id: idSchema,
  type: z.literal("bookmark"),
  title: z.string(),
  url: z.string(),
  siteName: z.string(),
  updatedAt: count,
});
const recentArtifact = z.object({
  id: idSchema,
  type: z.literal("artifact"),
  title: z.string(),
  updatedAt: count,
});
const recentItems = z.discriminatedUnion("type", [
  recentNote,
  recentJournal,
  recentBookmark,
  recentArtifact,
]);
const recentContent = z.discriminatedUnion("type", [
  recentNote,
  recentJournal,
  recentArtifact,
]);
export const extraOutputs = {
  settings,
  recovery: z.object({ recoveryCode: z.string() }),
  passkeySetup: z.object({ context: z.string(), recoveryCode: z.string() }),
  status: z.object({
    setup: z.boolean(),
    installation: z.object({
      encrypted: z.boolean(),
      locked: z.boolean(),
      publicUrl: z.string().url(),
    }),
    methods: z.object({ password: z.boolean(), passkey: z.boolean() }),
    owner: z
      .object({ id: z.string(), name: z.string(), username: z.string() })
      .nullable(),
    settings: settings.nullable(),
  }),
  checkpoint,
  connections: z.object({
    incoming: z.array(link).max(100),
    outgoing: z.array(link).max(100),
    tasks: z.array(link.extend({ completed: z.boolean() })).max(100),
    bookmarks: z.array(link.extend({ url: z.string() })).max(100),
  }),
  files: z.array(
    z
      .object({
        id: idSchema,
        note_id: idSchema,
        name: z.string(),
        mime: z.string(),
        size: count,
        created_at: count,
      })
      .passthrough(),
  ),
  overview: z.object({
    counts: z.object({ open: count, today: count, overdue: count }),
    tasks: z
      .array(
        link.extend({
          revision: z.number().int().positive(),
          dueDate: z.string().nullable(),
          recurrence: z.string().nullable(),
        }),
      )
      .max(20),
    notes: z.array(link.extend({ updatedAt: count })).max(20),
    bookmarks: z
      .array(
        link.extend({
          url: z.string(),
          description: z.string(),
          siteName: z.string(),
          updatedAt: count,
        }),
      )
      .max(20),
    calendar: z
      .array(
        z.object({
          id: z.string(),
          sourceId: idSchema,
          type: z.literal("event"),
          title: z.string(),
          date: z.string(),
          startAt: z.number().optional(),
          endAt: z.number().optional(),
          label: z.string(),
          revision: z.number().int().positive(),
          occurrence: z.string().optional(),
        }),
      )
      .max(5),
    recentItems: z.array(recentItems).max(8),
    recentContent: z.array(recentContent).max(8),
    recentResponses: z
      .array(
        z.object({
          id: idSchema,
          formId: idSchema,
          formTitle: z.string(),
          createdAt: count,
          reviewed: z.boolean(),
        }),
      )
      .max(5)
      .optional(),
    review: z
      .object({ formResponses: count, tagSuggestions: count })
      .optional(),
    refreshedAt: count,
  }),
  calendarRange: z.object({
    items: z
      .array(
        z.object({
          id: z.string(),
          sourceId: idSchema,
          type: z.enum([
            "event",
            "task",
            "journal",
            "note",
            "bookmark",
            "artifact",
            "form",
          ]),
          title: z.string(),
          date: z.string(),
          endDate: z.string().optional(),
          startAt: z.number().optional(),
          endAt: z.number().optional(),
          label: z.string(),
          revision: z.number().int().positive(),
          completed: z.boolean().optional(),
          occurrence: z.string().optional(),
        }),
      )
      .max(10000),
    counts: z.record(z.string(), count),
    total: count,
    nextOffset: count.nullable(),
    next: z.string().nullable(),
    unscheduled: count,
    overdue: count,
  }),
  calendarTasks: listOutput(
    link.extend({
      revision: z.number().int().positive(),
      dueDate: z.string().nullable(),
      plannedDate: z.string().nullable(),
    }),
  ),
  taskReminders: z
    .array(
      z.object({
        field: z.enum(["planned", "due"]),
        timezone: z.string(),
        offsets: z.array(count).max(3),
      }),
    )
    .max(2),
  subscriptions: z.object({
    publicKey: z.string(),
    hashes: z.array(z.object({ hash: z.string() })),
  }),
  backups: z.object({
    backend: z.enum(["local", "s3"]),
    storage: z.enum(["local", "s3"]),
    intervalHours: count,
    keep: count,
    running: z.boolean(),
    lastSuccess: count.nullable(),
    nextAt: z.number().nonnegative().nullable(),
    error: z.string().nullable(),
    backups: z.array(backup),
  }),
  backup,
  published: z.object({
    token: z.string(),
    title: z.string(),
    document: documentInput,
    excerpt: z.string(),
    revision: z.number().int().positive(),
    publishedAt: count,
  }),
  system: z.object({
    cleanupAvailable: z.boolean(),
    revision: z.number().int().positive(),
    storageBackend: z.enum(["local", "s3"]),
    s3Backups: z.boolean(),
    uploadMiB: count,
    backupHours: count,
    backupKeep: count,
    connection: z
      .object({
        provider: z.string(),
        endpoint: z.string(),
        region: z.string(),
        bucket: z.string(),
        pathStyle: z.boolean(),
        hasCredentials: z.boolean(),
      })
      .nullable(),
    encrypted: z.boolean(),
    publicUrl: z.string().nullable(),
    transfer: z
      .object({
        id: idSchema,
        state: z.enum(["queued", "running", "done", "failed"]),
        copied: count,
        error: z.string().nullable(),
      })
      .nullable(),
  }),
  credentials: z.object({
    endpoint: z.string().url(),
    keys: z.array(
      z.object({
        id: z.string(),
        name: z.string().nullable(),
        start: z.string().nullable(),
        permissions: z.string().nullable(),
        expiresAt: count.nullable(),
        lastUsed: count.nullable(),
        createdAt: count,
      }),
    ),
    connections: z.array(
      z.object({
        clientId: z.string(),
        name: z.string().nullable(),
        lastUsed: count.nullable(),
        redirectUris: z.string(),
      }),
    ),
  }),
  credentialMutation: z.union([
    z.object({ key: z.string(), id: z.string() }),
    apiOutputs.ok,
  ]),
};
