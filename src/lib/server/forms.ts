import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import {
  formDefinitionSchema,
  formDeadlineSchema,
  formAnswersSchema,
  publishableForm,
  validateFormAnswers,
  renderFormConfirmation,
  type FormDefinition,
} from "../forms";
import { db, sqlite } from "./db";
import { forms, formVersions } from "./schema";
import { HttpError } from "./http";
import { completionEvent, enqueueJob, startJobWorker } from "./jobs";
import { installationUrl } from "./installation";
import { ftsQuery } from "./validation";
import { itemTags } from "./item-tags";
import { decodeCursor, encodeCursor } from "./pagination";
import { addDays, zoneDay } from "../calendar";

export const formUpdateSchema = z
  .object({
    revision: z.number().int().positive(),
    definition: formDefinitionSchema.optional(),
    favorite: z.boolean().optional(),
    deadline: formDeadlineSchema.nullable().optional(),
    uploadBudget: z
      .number()
      .int()
      .min(0)
      .max(10 * 1024 * 1024 * 1024)
      .optional(),
  })
  .strict();
const owned = (owner: string, id: string) =>
  and(eq(forms.ownerId, owner), eq(forms.id, id), isNull(forms.trashedAt));
export function getForm(owner: string, id: string) {
  const form = db().select().from(forms).where(owned(owner, id)).get();
  if (!form) throw new HttpError(404, "Form not found.");
  const counts = sqlite()
    .prepare(
      "SELECT count(*) AS total,coalesce(sum(reviewed=0),0) AS newCount,max(created_at) AS lastSubmittedAt FROM form_responses WHERE form_id=? AND trashed_at IS NULL",
    )
    .get(id) as {
    total: number;
    newCount: number;
    lastSubmittedAt: number | null;
  };
  const baseUrl = installationUrl();
  if (form.publicToken && !baseUrl)
    throw new HttpError(
      503,
      "Configure the installation URL before sharing forms.",
    );
  const publication = form.publishedVersionId
    ? db()
        .select()
        .from(formVersions)
        .where(
          and(
            eq(formVersions.id, form.publishedVersionId),
            eq(formVersions.formId, form.id),
          ),
        )
        .get()
    : null;
  return {
    ...form,
    ...counts,
    deadline:
      form.closingDate && form.closingTimezone
        ? {
            date: form.closingDate,
            timezone: form.closingTimezone,
          }
        : null,
    tags: itemTags("form", form.id),
    publishedRevision: publication?.revision ?? null,
    hasUnpublishedChanges:
      !!publication &&
      JSON.stringify(publication.definition) !==
        JSON.stringify(form.definition),
    url: form.publicToken ? `${baseUrl}/form/${form.publicToken}` : null,
  };
}
export function createForm(owner: string, input: unknown = {}) {
  const value = z
    .object({
      definition: formDefinitionSchema.optional(),
      deadline: formDeadlineSchema.nullable().optional(),
    })
    .strict()
    .parse(input);
  const definition =
    value.definition ??
    formDefinitionSchema.parse({
      schemaVersion: 1,
      title: "Untitled form",
      fields: [],
    });
  const id = randomUUID();
  sqlite()
    .transaction(() => {
      db()
        .insert(forms)
        .values({
          id,
          ownerId: owner,
          title: definition.title,
          description: definition.description,
          definition,
          closingDate: value.deadline?.date ?? null,
          closingTimezone: value.deadline?.timezone ?? null,
          closesAt: value.deadline
            ? zoneDay(addDays(value.deadline.date, 1), value.deadline.timezone)
            : null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        })
        .run();
      completionEvent(owner, "content", id, "forms");
    })
    .immediate();
  return getForm(owner, id);
}
export function updateForm(owner: string, id: string, input: unknown) {
  const value = formUpdateSchema.parse(input);
  sqlite()
    .transaction(() => {
      const current = getForm(owner, id);
      if (current.revision !== value.revision)
        throw new HttpError(409, "This form changed. Reload before saving.");
      if (value.definition) {
        const previous = new Map(
          current.definition.fields.map((field) => [field.id, field.type]),
        );
        for (const field of value.definition.fields)
          if (previous.has(field.id) && previous.get(field.id) !== field.type)
            throw new HttpError(
              400,
              "Changing a question type requires a new question identifier.",
            );
      }
      if (value.definition)
        for (const field of value.definition.fields) {
          const incompatible = sqlite()
            .prepare(
              "SELECT 1 FROM form_versions v,json_each(v.definition,'$.fields') question WHERE v.form_id=? AND json_extract(question.value,'$.id')=? AND json_extract(question.value,'$.type')<>? LIMIT 1",
            )
            .get(id, field.id, field.type);
          if (incompatible)
            throw new HttpError(
              400,
              "Changing a published question type requires a new question identifier.",
            );
        }
      const { definition, favorite, uploadBudget, deadline } = value;
      db()
        .update(forms)
        .set({
          ...(definition
            ? {
                definition,
                title: definition.title,
                description: definition.description,
              }
            : {}),
          ...(favorite === undefined ? {} : { favorite }),
          ...(uploadBudget === undefined ? {} : { uploadBudget }),
          ...(deadline === undefined
            ? {}
            : {
                closingDate: deadline?.date ?? null,
                closingTimezone: deadline?.timezone ?? null,
                closesAt: deadline
                  ? zoneDay(addDays(deadline.date, 1), deadline.timezone)
                  : null,
              }),
          revision: current.revision + 1,
          updatedAt: Date.now(),
        })
        .where(owned(owner, id))
        .run();
      completionEvent(owner, "content", id, "forms");
    })
    .immediate();
  return getForm(owner, id);
}
export function publishForm(owner: string, id: string, revision: number) {
  sqlite()
    .transaction(() => {
      const current = getForm(owner, id);
      if (current.revision !== revision)
        throw new HttpError(
          409,
          "This form changed. Reload before publishing.",
        );
      if (!publishableForm(current.definition))
        throw new HttpError(
          400,
          "Add a title and at least one complete question before publishing.",
        );
      let version = db()
        .select()
        .from(formVersions)
        .where(
          and(eq(formVersions.formId, id), eq(formVersions.revision, revision)),
        )
        .get();
      if (!version) {
        const created = {
          id: randomUUID(),
          formId: id,
          revision,
          definition: current.definition,
          createdAt: Date.now(),
        };
        db().insert(formVersions).values(created).run();
        version = created;
      }
      db()
        .update(forms)
        .set({
          publishedVersionId: version.id,
          publicToken:
            current.publicToken ?? randomBytes(24).toString("base64url"),
          status: current.status === "closed" ? "closed" : "published",
          revision: revision + 1,
          updatedAt: Date.now(),
        })
        .where(owned(owner, id))
        .run();
      completionEvent(owner, "content", id, "forms");
    })
    .immediate();
  return getForm(owner, id);
}
export function changeFormStatus(
  owner: string,
  id: string,
  revision: number,
  action: "close" | "reopen" | "unpublish" | "trash",
) {
  sqlite()
    .transaction(() => {
      const current = getForm(owner, id);
      if (current.revision !== revision)
        throw new HttpError(
          409,
          "This form changed. Reload before continuing.",
        );
      if (action === "close" && current.status !== "published")
        throw new HttpError(409, "Only a published form can be closed.");
      if (
        action === "reopen" &&
        current.closesAt !== null &&
        current.closesAt <= Date.now()
      )
        throw new HttpError(
          409,
          "Change or remove the closing date before reopening.",
        );
      if (action === "reopen" && current.status !== "closed")
        throw new HttpError(409, "Only a closed form can be reopened.");
      const revoked = action === "unpublish" || action === "trash";
      db()
        .update(forms)
        .set({
          status: revoked
            ? "draft"
            : action === "close"
              ? "closed"
              : "published",
          ...(revoked ? { publicToken: null, publishedVersionId: null } : {}),
          ...(action === "trash" ? { trashedAt: Date.now() } : {}),
          revision: revision + 1,
          updatedAt: Date.now(),
        })
        .where(owned(owner, id))
        .run();
      completionEvent(owner, "content", id, "forms");
    })
    .immediate();
  return action === "trash" ? { ok: true } : getForm(owner, id);
}
export function publicFormExists(token: string) {
  return (
    /^[A-Za-z0-9_-]{32}$/.test(token) &&
    !!sqlite()
      .prepare(
        "SELECT 1 FROM forms WHERE public_token=? AND trashed_at IS NULL AND status IN ('published','closed')",
      )
      .get(token)
  );
}
export function publicForm(token: string): {
  id: string;
  ownerId: string;
  versionId: string;
  status: "published" | "closed";
  definition: FormDefinition;
} {
  if (!/^[A-Za-z0-9_-]{32}$/.test(token))
    throw new HttpError(404, "Form not available.");
  const row = sqlite()
    .prepare(
      "SELECT f.id,f.owner_id AS ownerId,f.published_version_id AS versionId,f.status,f.closes_at AS closesAt,v.definition FROM forms f JOIN form_versions v ON v.id=f.published_version_id AND v.form_id=f.id WHERE f.public_token=? AND f.trashed_at IS NULL AND f.status IN ('published','closed')",
    )
    .get(token) as
    | {
        id: string;
        ownerId: string;
        versionId: string;
        status: "published" | "closed";
        closesAt: number | null;
        definition: string;
      }
    | undefined;
  if (!row) throw new HttpError(404, "Form not available.");
  return {
    ...row,
    status:
      row.closesAt !== null && row.closesAt <= Date.now()
        ? "closed"
        : row.status,
    definition: formDefinitionSchema.parse(JSON.parse(row.definition)),
  };
}

export const formSubmissionSchema = z
  .object({
    versionId: z.string().uuid(),
    retryKey: z.string().uuid(),
    answers: formAnswersSchema,
    uploadSecret: z
      .string()
      .regex(/^[A-Za-z0-9_-]{43}$/)
      .optional(),
  })
  .strict();
export function submitForm(token: string, input: unknown) {
  const payload = formSubmissionSchema.parse(input);
  return sqlite()
    .transaction(() => {
      const form = publicForm(token);
      const version = db()
        .select()
        .from(formVersions)
        .where(
          and(
            eq(formVersions.id, payload.versionId),
            eq(formVersions.formId, form.id),
          ),
        )
        .get();
      if (!version)
        throw new HttpError(
          409,
          "This form changed. Reload before submitting.",
        );
      const validated = validateFormAnswers(
        version.definition,
        payload.answers,
      );
      if (Object.keys(validated.errors).length)
        throw new HttpError(400, Object.values(validated.errors)[0]);
      const canonical = Object.fromEntries(
        Object.entries(validated.answers).sort(([a], [b]) =>
          a.localeCompare(b),
        ),
      );
      const hash = createHash("sha256")
        .update(
          JSON.stringify({ versionId: payload.versionId, answers: canonical }),
        )
        .digest("hex");
      const previous = sqlite()
        .prepare(
          "SELECT id,request_hash AS hash FROM form_responses WHERE form_id=? AND retry_key=?",
        )
        .get(form.id, payload.retryKey) as
        { id: string; hash: string } | undefined;
      if (previous) {
        if (previous.hash !== hash)
          throw new HttpError(
            409,
            "This submission retry contains different answers.",
          );
        return {
          id: previous.id,
          confirmation: renderFormConfirmation(
            version.definition,
            validated.answers,
          ),
        };
      }
      if (form.status !== "published")
        throw new HttpError(409, "This form is closed to submissions.");
      if (form.versionId !== payload.versionId)
        throw new HttpError(
          409,
          "This form changed. Reload before submitting.",
        );
      const files = version.definition.fields
        .filter((field) => field.type === "file")
        .flatMap((field) => {
          const values = validated.answers[field.id];
          return Array.isArray(values)
            ? values.map((id) => ({ id, fieldId: field.id }))
            : [];
        });
      let session: { id: string } | undefined;
      if (files.length) {
        if (!payload.uploadSecret)
          throw new HttpError(
            400,
            "Upload the selected files before submitting.",
          );
        session = sqlite()
          .prepare(
            "SELECT id FROM form_upload_sessions WHERE form_id=? AND version_id=? AND secret_hash=? AND expires_at>?",
          )
          .get(
            form.id,
            version.id,
            createHash("sha256").update(payload.uploadSecret).digest("hex"),
            Date.now(),
          ) as { id: string } | undefined;
        if (!session)
          throw new HttpError(
            400,
            "This upload session expired. Upload your files again.",
          );
        let bytes = 0;
        const unique = new Set<string>();
        for (const file of files) {
          if (unique.has(file.id))
            throw new HttpError(400, "A file can only answer one question.");
          unique.add(file.id);
          const ready = sqlite()
            .prepare(
              "SELECT size FROM form_files WHERE id=? AND form_id=? AND field_id=? AND session_id=? AND state='ready' AND response_id IS NULL",
            )
            .get(file.id, form.id, file.fieldId, session.id) as
            { size: number } | undefined;
          if (!ready)
            throw new HttpError(
              400,
              "An uploaded file is not available for this response.",
            );
          bytes += ready.size;
        }
        if (bytes > 25 * 1024 * 1024)
          throw new HttpError(413, "Response attachments exceed 25 MiB.");
      }
      const id = randomUUID();
      const searchText = version.definition.fields
        .filter((field) => field.type !== "file")
        .map((field) => {
          const answer = canonical[field.id];
          if (Array.isArray(answer))
            return answer
              .map(
                (value) =>
                  field.choices.find((choice) => choice.id === value)?.label ??
                  value,
              )
              .join(" ");
          return (
            field.choices.find((choice) => choice.id === answer)?.label ??
            String(answer ?? "")
          );
        })
        .join("\n");
      sqlite()
        .prepare(
          "INSERT INTO form_responses(id,form_id,version_id,answers,search_text,retry_key,request_hash,created_at) VALUES(?,?,?,?,?,?,?,?)",
        )
        .run(
          id,
          form.id,
          version.id,
          JSON.stringify(canonical),
          searchText,
          payload.retryKey,
          hash,
          Date.now(),
        );
      for (const file of files)
        sqlite()
          .prepare(
            "UPDATE form_files SET response_id=?,state='attached' WHERE id=? AND session_id=? AND state='ready'",
          )
          .run(id, file.id, session!.id);
      let queued = false;
      for (const file of files)
        if (
          sqlite()
            .prepare(
              "SELECT 1 FROM form_files WHERE id=? AND thumbnail_status='pending'",
            )
            .get(file.id)
        ) {
          enqueueJob(form.ownerId, "thumbnail", file.id);
          queued = true;
        }
      if (queued) startJobWorker();
      completionEvent(form.ownerId, "content", form.id, "forms");
      return {
        id,
        confirmation: renderFormConfirmation(
          version.definition,
          validated.answers,
        ),
      };
    })
    .immediate();
}

export const formListQuery = z
  .object({
    q: z.string().max(300).default(""),
    status: z.enum(["all", "draft", "published", "closed"]).default("all"),
    tag: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(60),
    after: z.string().max(400).optional(),
  })
  .strict();
export function listForms(owner: string, query = new URLSearchParams()) {
  const input = formListQuery.parse(Object.fromEntries(query));
  const currentStatus = `CASE WHEN f.status='published' AND f.closes_at<=${Date.now()} THEN 'closed' ELSE f.status END`;
  const where = ["f.owner_id=?", "f.trashed_at IS NULL"],
    values: (string | number)[] = [owner];
  if (input.status !== "all") {
    where.push(`${currentStatus}=?`);
    values.push(input.status);
  }
  if (input.tag) {
    where.push(
      "EXISTS(SELECT 1 FROM form_tags WHERE form_id=f.id AND tag_id=?)",
    );
    values.push(input.tag);
  }
  const search = ftsQuery(input.q);
  if (search) {
    where.push("forms_fts MATCH ?");
    values.push(search);
  }
  const source = search
    ? "forms f JOIN forms_fts ON forms_fts.rowid=f.rowid"
    : "forms f";
  const { after, ...filters } = input;
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ owner, ...filters }))
    .digest("hex")
    .slice(0, 24);
  const cursor = decodeCursor(after ?? null, ["number", "string", "string"]);
  if (cursor && cursor[2] !== fingerprint)
    throw new HttpError(400, "This cursor belongs to a different query.");
  if (cursor) {
    z.number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER)
      .parse(cursor[0]);
    z.string().uuid().parse(cursor[1]);
  }
  const total = (
    sqlite()
      .prepare(
        `SELECT count(*) AS total FROM ${source} WHERE ${where.join(" AND ")}`,
      )
      .get(...values) as { total: number }
  ).total;
  const rows = sqlite()
    .prepare(
      `SELECT f.id,f.title,f.description,${currentStatus} AS status,f.closes_at AS closesAt,f.revision,f.favorite,f.created_at AS createdAt,f.updated_at AS updatedAt,(SELECT count(*) FROM form_responses WHERE form_id=f.id AND trashed_at IS NULL) AS total,(SELECT count(*) FROM form_responses WHERE form_id=f.id AND trashed_at IS NULL AND reviewed=0) AS newCount,(SELECT max(created_at) FROM form_responses WHERE form_id=f.id AND trashed_at IS NULL) AS lastSubmittedAt FROM ${source} WHERE ${where.join(" AND ")} ${cursor ? " AND (f.created_at,f.id)<(?,?)" : ""} ORDER BY f.created_at DESC,f.id DESC LIMIT ?`,
    )
    .all(
      ...values,
      ...(cursor ? [cursor[0], cursor[1]] : []),
      input.limit + 1,
    ) as {
    id: string;
    title: string;
    description: string;
    status: "draft" | "published" | "closed";
    revision: number;
    favorite: number;
    createdAt: number;
    updatedAt: number;
    total: number;
    newCount: number;
    lastSubmittedAt: number | null;
    closesAt: number | null;
  }[];
  const selected = rows.slice(0, input.limit),
    last = selected.at(-1);
  return {
    items: selected.map((row) => ({ ...row, favorite: !!row.favorite })),
    total,
    next:
      rows.length > input.limit && last
        ? encodeCursor([last.createdAt, last.id, fingerprint])
        : null,
    nextOffset: null,
  };
}
export function duplicateForm(owner: string, id: string) {
  const source = getForm(owner, id);
  return createForm(owner, {
    definition: {
      ...source.definition,
      title: `${source.title || "Untitled form"} (copy)`.slice(0, 300),
    },
  });
}
