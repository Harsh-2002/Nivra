import { z } from "zod";
import {
  journalDateSchema,
  journalPeriodSchema,
  writingTemplateKindSchema,
} from "../writing";
import { documentInput } from "./validation";

const revision = z.number().int().positive();
const idempotencyKey = z
  .string()
  .trim()
  .min(8)
  .max(128)
  .regex(/^[a-zA-Z0-9_-]+$/);
const timeZone = z
  .string()
  .max(100)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat("en", { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }, "Choose a valid timezone.");

export const writingInputs = {
  linkedTaskCreate: z
    .object({
      revision,
      blockId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
      title: z.string().trim().min(1).max(300).optional(),
      selectedText: z.string().min(1).max(300).optional(),
      idempotencyKey,
    })
    .strict(),
  unlinkTask: z.object({ revision }).strict(),
  templateCreate: z
    .object({
      name: z.string().trim().min(1).max(80),
      description: z.string().trim().max(500).default(""),
      kind: writingTemplateKindSchema,
      document: documentInput.optional(),
      sourceNoteId: z.string().uuid().optional(),
      sourceRevision: revision.optional(),
    })
    .strict()
    .refine(
      (value) =>
        (value.document !== undefined) !==
        (value.sourceNoteId !== undefined &&
          value.sourceRevision !== undefined),
      "Provide a document or a source note with its revision.",
    )
    .refine(
      (value) =>
        value.sourceNoteId === undefined || value.sourceRevision !== undefined,
      "Provide the source note revision.",
    )
    .refine(
      (value) =>
        value.sourceNoteId !== undefined || value.sourceRevision === undefined,
      "A source revision requires a source note.",
    ),
  templateUpdate: z
    .object({
      revision,
      name: z.string().trim().min(1).max(80).optional(),
      description: z.string().trim().max(500).optional(),
      document: documentInput.optional(),
    })
    .strict()
    .refine(
      (value) =>
        value.name !== undefined ||
        value.description !== undefined ||
        value.document !== undefined,
      "Provide a template change.",
    ),
  templateApply: z
    .object({
      revision,
      idempotencyKey,
      title: z.string().trim().max(300).optional(),
      date: journalDateSchema.optional(),
      period: journalPeriodSchema.optional(),
      timezone: timeZone.default("UTC"),
    })
    .strict(),
  templateList: z
    .object({
      kind: writingTemplateKindSchema.optional(),
      limit: z.coerce.number().int().min(1).max(100).default(30),
      after: z.string().max(512).optional(),
    })
    .strict(),
  journalCreate: z
    .object({
      date: journalDateSchema,
      period: journalPeriodSchema.default("daily"),
      document: documentInput.optional(),
      templateId: z.string().uuid().nullable().optional(),
      templateRevision: revision.optional(),
      timezone: timeZone.default("UTC"),
    })
    .strict()
    .refine(
      (value) => value.templateId === undefined || value.document === undefined,
      "Provide journal content or a template, not both.",
    )
    .refine(
      (value) =>
        value.templateId != null || value.templateRevision === undefined,
      "A template revision requires a template.",
    ),
  journalList: z
    .object({
      period: journalPeriodSchema.default("daily"),
      from: journalDateSchema.optional(),
      to: journalDateSchema.optional(),
      q: z.string().max(300).default(""),
      limit: z.coerce.number().int().min(1).max(100).default(30),
      after: z.string().max(512).optional(),
    })
    .strict()
    .refine(
      (value) => !value.from || !value.to || value.from <= value.to,
      "The journal date range is reversed.",
    ),
  journalReview: z
    .object({
      period: journalPeriodSchema,
      date: journalDateSchema,
      timezone: timeZone.default("UTC"),
    })
    .strict(),
  onThisDay: z.object({ date: journalDateSchema }).strict(),
  journalNavigate: z
    .object({ direction: z.enum(["previous", "next"]) })
    .strict(),
  writingPreferences: z
    .object({
      revision: z.number().int().min(0),
      defaultJournalTemplateId: z.string().uuid().nullable(),
    })
    .strict(),
} as const;

export type LinkedTaskCreateInput = z.infer<
  typeof writingInputs.linkedTaskCreate
>;
export type UnlinkTaskInput = z.infer<typeof writingInputs.unlinkTask>;
export type WritingTemplateCreateInput = z.infer<
  typeof writingInputs.templateCreate
>;
export type WritingTemplateUpdateInput = z.infer<
  typeof writingInputs.templateUpdate
>;
export type WritingTemplateApplyInput = z.infer<
  typeof writingInputs.templateApply
>;
export type JournalCreateInput = z.infer<typeof writingInputs.journalCreate>;
export type JournalListInput = z.infer<typeof writingInputs.journalList>;
export type JournalReviewInput = z.infer<typeof writingInputs.journalReview>;
