import { z } from "./zod";
import { validDate } from "./dates";
import { dateSchema, zoneSchema } from "./calendar";

export const formDeadlineSchema = z
  .object({
    date: dateSchema,
    timezone: zoneSchema,
  })
  .strict();

export const formFieldTypes = [
  "short_text",
  "long_text",
  "email",
  "phone",
  "url",
  "number",
  "amount",
  "rating",
  "single_choice",
  "multiple_choice",
  "dropdown",
  "yes_no",
  "date",
  "time",
  "file",
  "consent",
  "heading",
  "description",
  "section",
] as const;
export const formChoiceSchema = z
  .object({
    id: z.string().uuid(),
    label: z.string().trim().min(1).max(300),
  })
  .strict();
export const formFieldSchema = z
  .object({
    id: z.string().uuid(),
    type: z.enum(formFieldTypes),
    label: z.string().trim().max(300),
    description: z.string().max(2000).default(""),
    required: z.boolean().default(false),
    choices: z.array(formChoiceSchema).max(100).default([]),
    minimum: z.number().finite().optional(),
    maximum: z.number().finite().optional(),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .default("USD"),
    maxLength: z.number().int().min(1).max(10000).default(2000),
    maxFiles: z.number().int().min(1).max(3).default(3),
    fileTypes: z
      .array(z.enum(["image", "document", "audio", "video"]))
      .max(4)
      .default(["image", "document"]),
  })
  .strict()
  .superRefine((field, ctx) => {
    if (
      field.minimum !== undefined &&
      field.maximum !== undefined &&
      field.minimum > field.maximum
    )
      ctx.addIssue({
        code: "custom",
        path: ["maximum"],
        message: "Maximum must be at least minimum.",
      });
    if (
      new Set(field.choices.map((choice) => choice.id)).size !==
      field.choices.length
    )
      ctx.addIssue({
        code: "custom",
        path: ["choices"],
        message: "Choice identifiers must be unique.",
      });
    if (
      field.type === "rating" &&
      [field.minimum ?? 1, field.maximum ?? 5].some(
        (value) => !Number.isInteger(value) || value < 1 || value > 10,
      )
    )
      ctx.addIssue({
        code: "custom",
        path: ["maximum"],
        message: "Ratings use whole numbers from 1 to 10.",
      });
  });
export const formDefinitionSchema = z
  .object({
    schemaVersion: z.literal(1),
    title: z.string().trim().max(300),
    description: z.string().max(5000).default(""),
    confirmation: z
      .string()
      .min(1)
      .max(2000)
      .describe(
        "Post-submission text. Insert an answer with {{field:QUESTION_UUID}}; references must identify a non-file answer field in this definition.",
      )
      .default("Thank you. Your response has been submitted."),
    fields: z.array(formFieldSchema).max(100),
  })
  .strict()
  .superRefine((definition, ctx) => {
    if (!definition.confirmation.trim())
      ctx.addIssue({
        code: "custom",
        path: ["confirmation"],
        message: "Enter a confirmation message.",
      });
    if (
      new Set(definition.fields.map((field) => field.id)).size !==
      definition.fields.length
    )
      ctx.addIssue({
        code: "custom",
        path: ["fields"],
        message: "Question identifiers must be unique.",
      });
    const eligible = new Set(
      definition.fields.filter(confirmationField).map((field) => field.id),
    );
    for (const match of definition.confirmation.matchAll(
      /\{\{field:([^{}]+)\}\}/g,
    ))
      if (!eligible.has(match[1])) {
        ctx.addIssue({
          code: "custom",
          path: ["confirmation"],
          message:
            "Confirmation answers must reference an existing question that accepts text, numbers or choices.",
        });
        break;
      }
  });
export type FormDefinition = z.infer<typeof formDefinitionSchema>;
export type FormField = z.infer<typeof formFieldSchema>;
export function confirmationField(field: { type: string }) {
  return !["file", "heading", "description", "section"].includes(field.type);
}
export function confirmationVariables(definition: FormDefinition) {
  return definition.fields.flatMap((field, index) =>
    confirmationField(field)
      ? [
          {
            id: field.id,
            name: `${index + 1}. ${field.label.trim().replace(/[{}\r\n]/g, " ") || "Untitled question"}`,
          },
        ]
      : [],
  );
}
export function editableConfirmation(definition: FormDefinition) {
  const names = new Map(
    confirmationVariables(definition).map((item) => [item.id, item.name]),
  );
  return definition.confirmation.replace(
    /\{\{field:([^{}]+)\}\}/g,
    (token, id: string) => (names.has(id) ? `{{${names.get(id)}}}` : token),
  );
}
export function encodeConfirmation(definition: FormDefinition, text: string) {
  const ids = new Map(
    confirmationVariables(definition).map((item) => [item.name, item.id]),
  );
  return text.replace(/\{\{([^{}\r\n]+)\}\}/g, (token, name: string) =>
    ids.has(name) ? `{{field:${ids.get(name)}}}` : token,
  );
}
export function retargetConfirmation(
  text: string,
  previousId: string,
  nextId?: string,
) {
  const next = text.replaceAll(
    `{{field:${previousId}}}`,
    nextId ? `{{field:${nextId}}}` : "",
  );
  return next.trim() ? next : "Thank you. Your response has been submitted.";
}
export function renderFormConfirmation(
  definition: FormDefinition,
  answers: FormAnswers,
) {
  const fields = new Map(definition.fields.map((field) => [field.id, field]));
  const rendered = definition.confirmation.replace(
    /\{\{field:([^{}]+)\}\}/g,
    (_, id: string) => {
      const field = fields.get(id);
      const answer = answers[id];
      if (!field || !confirmationField(field) || answer === undefined)
        return "";
      if (
        ["single_choice", "multiple_choice", "dropdown"].includes(field.type)
      ) {
        const selected = Array.isArray(answer) ? answer : [String(answer)];
        return selected
          .map(
            (value) =>
              field.choices.find((choice) => choice.id === value)?.label ?? "",
          )
          .filter(Boolean)
          .join(", ");
      }
      if (typeof answer === "boolean") return answer ? "Yes" : "No";
      if (field.type === "amount" && answer !== "")
        return `${answer} ${field.currency}`;
      return String(answer);
    },
  );
  const message =
    rendered.trim() || "Thank you. Your response has been submitted.";
  return message.length > 20000 ? `${message.slice(0, 19999)}…` : message;
}
export function changeFormFieldType(
  field: FormField,
  type: FormField["type"],
): FormField {
  if (field.type === type) return field;
  const ratingLimitsReset =
    type === "rating" &&
    [field.minimum ?? 1, field.maximum ?? 5].some(
      (limit) => !Number.isInteger(limit) || limit < 1 || limit > 10,
    );
  const invalidLimits =
    field.minimum !== undefined &&
    field.maximum !== undefined &&
    field.minimum > field.maximum;
  return {
    ...field,
    id: crypto.randomUUID(),
    type,
    ...(["single_choice", "multiple_choice", "dropdown"].includes(type) &&
    !field.choices.length
      ? {
          choices: [1, 2].map((number) => ({
            id: crypto.randomUUID(),
            label: `Option ${number}`,
          })),
        }
      : {}),
    ...(ratingLimitsReset || invalidLimits
      ? { minimum: undefined, maximum: undefined }
      : {}),
  };
}
export type FormSummary = {
  id: string;
  title: string;
  description: string;
  status: "draft" | "published" | "closed";
  revision: number;
  favorite: boolean;
  createdAt: number;
  updatedAt: number;
  total: number;
  newCount: number;
  lastSubmittedAt: number | null;
  closesAt: number | null;
};
export type FormRecord = FormSummary & {
  definition: FormDefinition;
  tags: import("./types").Tag[];
  publicToken: string | null;
  publishedVersionId: string | null;
  publishedRevision: number | null;
  hasUnpublishedChanges: boolean;
  uploadBudget: number;
  deadline: z.infer<typeof formDeadlineSchema> | null;
  url: string | null;
};
export type FormAnswer = string | number | boolean | string[];
export type FormAnswers = Record<string, FormAnswer>;
export const formAnswersSchema = z.record(
  z.string().uuid(),
  z.union([
    z.string().max(10000),
    z.number().finite(),
    z.boolean(),
    z.array(z.string().max(300)).max(100),
  ]),
);
export const displayField = (field: FormField) =>
  ["heading", "description", "section"].includes(field.type);
export function publishableForm(definition: FormDefinition) {
  if (
    !definition.title ||
    !definition.fields.some((field) => !displayField(field))
  )
    return false;
  return definition.fields.every(
    (field) =>
      field.label &&
      (!["single_choice", "multiple_choice", "dropdown"].includes(field.type) ||
        field.choices.length > 0),
  );
}
export function validateFormAnswers(
  definition: FormDefinition,
  input: unknown,
): { answers: FormAnswers; errors: Record<string, string> } {
  const parsed = formAnswersSchema.safeParse(input);
  if (!parsed.success)
    return { answers: {}, errors: { form: "Invalid response data." } };
  const answers = parsed.data;
  const errors: Record<string, string> = {};
  const known = new Set(
    definition.fields
      .filter((field) => !displayField(field))
      .map((field) => field.id),
  );
  if (Object.keys(answers).some((id) => !known.has(id)))
    errors.form = "This response contains an unknown question.";
  for (const field of definition.fields) {
    if (displayField(field)) continue;
    const value = answers[field.id];
    const empty =
      value === undefined ||
      (typeof value === "string" && !value.trim()) ||
      (Array.isArray(value) && !value.length);
    if (empty) {
      if (field.required) errors[field.id] = "This field is required.";
      continue;
    }
    let valid = true;
    switch (field.type) {
      case "number":
      case "rating":
        valid =
          typeof value === "number" &&
          (field.minimum === undefined || value >= field.minimum) &&
          (field.maximum === undefined || value <= field.maximum) &&
          (field.type !== "rating" ||
            (Number.isInteger(value) &&
              value >= (field.minimum ?? 1) &&
              value <= (field.maximum ?? 5)));
        break;
      case "amount":
        valid =
          typeof value === "string" &&
          /^-?\d{1,12}(\.\d{1,2})?$/.test(value) &&
          (field.minimum === undefined || Number(value) >= field.minimum) &&
          (field.maximum === undefined || Number(value) <= field.maximum);
        break;
      case "yes_no":
      case "consent":
        valid =
          typeof value === "boolean" &&
          (field.type !== "consent" || !field.required || value);
        break;
      case "single_choice":
      case "dropdown":
        valid =
          typeof value === "string" &&
          field.choices.some((choice) => choice.id === value);
        break;
      case "multiple_choice":
        valid =
          Array.isArray(value) &&
          new Set(value).size === value.length &&
          value.every((id) => field.choices.some((choice) => choice.id === id));
        break;
      case "file":
        valid =
          Array.isArray(value) &&
          value.length <= field.maxFiles &&
          new Set(value).size === value.length &&
          value.every((id) => z.string().uuid().safeParse(id).success);
        break;
      case "phone":
        valid =
          typeof value === "string" &&
          value.length <= 40 &&
          /^[+()0-9 .-]+$/.test(value) &&
          value.replace(/\D/g, "").length >= 3;
        break;
      case "email":
        valid = z.email().max(254).safeParse(value).success;
        break;
      case "url":
        valid =
          typeof value === "string" &&
          z.url({ protocol: /^https?$/ }).safeParse(value).success;
        break;
      case "date":
        valid = typeof value === "string" && validDate(value);
        break;
      case "time":
        valid =
          typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
        break;
      default:
        valid = typeof value === "string" && value.length <= field.maxLength;
    }
    if (!valid)
      errors[field.id] =
        field.type === "consent"
          ? "Consent is required."
          : "Enter a valid answer.";
  }
  return { answers, errors };
}
