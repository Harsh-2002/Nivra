import { randomUUID } from "node:crypto";
import { z } from "zod";
import { eventInput, zoneSchema } from "../calendar";
import { tagColors } from "../tags";
import { sqlite } from "./db";
import { storage } from "./storage";
import { getEvent } from "./calendar";
import { itemTags, importItemTags } from "./item-tags";
import { HttpError } from "./http";
import { enqueueJob } from "./jobs";
const tags = z
  .array(
    z.object({
      name: z.string().trim().min(1).max(50),
      color: z.enum(tagColors),
      aliases: z.array(z.string().trim().min(1).max(80)).max(10).optional(),
    }),
  )
  .max(100)
  .default([]);
export const portableCalendar = z.object({
  events: z
    .array(
      z.object({
        id: z.string().uuid(),
        input: eventInput,
        revision: z.number().int().positive(),
        trashedAt: z.number().nonnegative().nullable(),
        createdAt: z.number().nonnegative(),
        updatedAt: z.number().nonnegative(),
        tags,
      }),
    )
    .max(50000),
  exceptions: z
    .array(
      z.object({
        eventId: z.string().uuid(),
        occurrence: z.string().max(40),
        overrideId: z.string().uuid().nullable(),
      }),
    )
    .max(100000),
  taskReminders: z
    .array(
      z.object({
        taskId: z.string().uuid(),
        timezone: zoneSchema,
        field: z.enum(["planned", "due"]),
        offsets: z.array(z.number().int().min(0).max(10080)).max(3),
      }),
    )
    .max(100000),
  artifacts: z
    .array(
      z.object({
        id: z.string().uuid(),
        kind: z.enum(["text", "image", "file"]),
        title: z.string().max(300),
        content: z.string().max(8388608),
        name: z.string().max(500),
        mime: z.string().max(200),
        size: z.number().int().nonnegative(),
        width: z.number().int().nonnegative(),
        height: z.number().int().nonnegative(),
        storageKey: z.string().uuid().nullable(),
        trashedAt: z.number().nonnegative().nullable(),
        createdAt: z.number().nonnegative(),
        updatedAt: z.number().nonnegative(),
        tags,
      }),
    )
    .max(50000),
});
type Portable = z.infer<typeof portableCalendar>;
export async function exportCalendarBundle(owner: string) {
  const d = sqlite(),
    files: Record<string, Uint8Array> = {};
  const events = (
    d.prepare("SELECT id FROM calendar_events WHERE owner_id=?").all(owner) as {
      id: string;
    }[]
  ).map((row) => {
    const { id, revision, trashedAt, createdAt, updatedAt, ownerId, ...input } =
      getEvent(owner, row.id);
    void ownerId;
    return {
      id,
      input,
      revision,
      trashedAt,
      createdAt,
      updatedAt,
      tags: itemTags("event", id),
    };
  });
  const artifacts = d
    .prepare(
      "SELECT id,kind,title,content,name,mime,size,width,height,storage_key AS storageKey,trashed_at AS trashedAt,created_at AS createdAt,updated_at AS updatedAt FROM artifacts WHERE owner_id=?",
    )
    .all(owner) as Portable["artifacts"];
  for (const artifact of artifacts) {
    if (artifact.storageKey)
      files[`files/${artifact.storageKey}`] = await storage.read(
        artifact.storageKey,
      );
    artifact.tags = itemTags("artifact", artifact.id);
  }
  const exceptions = d
    .prepare(
      "SELECT x.event_id AS eventId,x.occurrence,x.override_id AS overrideId FROM calendar_exceptions x JOIN calendar_events e ON e.id=x.event_id WHERE e.owner_id=?",
    )
    .all(owner);
  const taskReminders = (
    d
      .prepare(
        "SELECT r.task_id AS taskId,r.timezone,r.field,r.offsets FROM calendar_task_reminders r JOIN tasks t ON t.id=r.task_id WHERE t.owner_id=?",
      )
      .all(owner) as {
      taskId: string;
      timezone: string;
      field: string;
      offsets: string;
    }[]
  ).map((row) => ({ ...row, offsets: JSON.parse(row.offsets) }));
  return { data: { events, artifacts, exceptions, taskReminders }, files };
}
export async function stageCalendarFiles(
  value: Portable,
  entries: Record<string, Uint8Array>,
  created: string[],
) {
  const keys = new Map<string, string>();
  for (const artifact of value.artifacts) {
    if (!artifact.storageKey) continue;
    const bytes = entries[`files/${artifact.storageKey}`];
    if (!bytes || bytes.length !== artifact.size)
      throw new HttpError(400, "The bundle is missing an artifact file.");
    const key = randomUUID();
    await storage.write(key, bytes);
    created.push(key);
    keys.set(artifact.storageKey, key);
  }
  return keys;
}
export function importCalendarBundle(
  owner: string,
  value: Portable,
  maps: {
    notes: Map<string, string>;
    tasks: Map<string, string>;
    bookmarks: Map<string, string>;
  },
  keys: Map<string, string>,
) {
  const d = sqlite(),
    artifacts = new Map(value.artifacts.map((row) => [row.id, randomUUID()])),
    events = new Map(value.events.map((row) => [row.id, randomUUID()]));
  if (
    artifacts.size !== value.artifacts.length ||
    events.size !== value.events.length
  )
    throw new HttpError(
      400,
      "The bundle contains duplicate calendar identifiers.",
    );
  for (const row of value.artifacts) {
    const id = artifacts.get(row.id)!;
    d.prepare(
      "INSERT INTO artifacts(id,owner_id,kind,title,content,name,mime,size,width,height,storage_key,extraction,trashed_at,created_at,updated_at,thumbnail_status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    ).run(
      id,
      owner,
      row.kind,
      row.title,
      row.content,
      row.name,
      row.mime,
      row.size,
      row.width,
      row.height,
      row.storageKey ? keys.get(row.storageKey) : null,
      "done",
      row.trashedAt,
      row.createdAt,
      row.updatedAt,
      row.kind === "text" ? "none" : "pending",
    );
    importItemTags("artifact", id, row.tags);
    if (row.kind !== "text" && !row.trashedAt)
      enqueueJob(owner, "thumbnail", id);
  }
  for (const row of value.events) {
    const id = events.get(row.id)!,
      input = {
        ...row.input,
        links: row.input.links.map((link) => ({
          ...link,
          id:
            (link.type === "note" || link.type === "journal"
              ? maps.notes
              : link.type === "task"
                ? maps.tasks
                : link.type === "bookmark"
                  ? maps.bookmarks
                  : artifacts
            ).get(link.id) ?? link.id,
        })),
      };
    d.prepare(
      "INSERT INTO calendar_events(id,owner_id,title,description,start_date,end_date,recurring,data,revision,trashed_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
    ).run(
      id,
      owner,
      input.title,
      input.description,
      input.start.slice(0, 10),
      input.end.slice(0, 10),
      +!!input.recurrence,
      JSON.stringify(input),
      row.revision,
      row.trashedAt,
      row.createdAt,
      row.updatedAt,
    );
    for (const link of input.links)
      d.prepare("INSERT OR IGNORE INTO calendar_links VALUES(?,?,?)").run(
        id,
        link.type,
        link.id,
      );
    importItemTags("event", id, row.tags);
  }
  for (const row of value.exceptions) {
    if (
      !events.has(row.eventId) ||
      (row.overrideId && !events.has(row.overrideId))
    )
      throw new HttpError(
        400,
        "The bundle has an unavailable event occurrence.",
      );
    d.prepare("INSERT INTO calendar_exceptions VALUES(?,?,?)").run(
      events.get(row.eventId),
      row.occurrence,
      row.overrideId ? events.get(row.overrideId) : null,
    );
  }
  for (const row of value.taskReminders) {
    if (!maps.tasks.has(row.taskId))
      throw new HttpError(400, "The bundle has an unavailable reminder task.");
    d.prepare("INSERT INTO calendar_task_reminders VALUES(?,?,?,?)").run(
      maps.tasks.get(row.taskId),
      row.timezone,
      row.field,
      JSON.stringify(row.offsets),
    );
  }
  if (value.events.length || value.taskReminders.length)
    d.prepare("DELETE FROM push_subscriptions WHERE owner_id=?").run(owner);
}
