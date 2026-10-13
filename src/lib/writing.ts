import { z } from "./zod";
import { validDate } from "./dates";
import { plainText } from "./document-text";
import type { Document } from "./types";

export const journalPeriodSchema = z.enum(["daily", "weekly", "monthly"]);
export type JournalPeriod = z.infer<typeof journalPeriodSchema>;

export const journalDateSchema = z
  .string()
  .refine(validDate, "Choose a valid calendar date (YYYY-MM-DD).");

export const writingTemplateKindSchema = z.enum(["note", "journal"]);
export type WritingTemplateKind = z.infer<typeof writingTemplateKindSchema>;

export function journalPeriodStart(date: string, period: JournalPeriod) {
  if (!validDate(date)) throw new Error("Invalid journal date.");
  const value = new Date(`${date}T12:00:00.000Z`);
  if (period === "monthly") return `${date.slice(0, 7)}-01`;
  if (period === "weekly") {
    const day = value.getUTCDay() || 7;
    value.setUTCDate(value.getUTCDate() - day + 1);
    return value.toISOString().slice(0, 10);
  }
  return date;
}

export function journalPeriodEnd(start: string, period: JournalPeriod) {
  const value = new Date(`${start}T12:00:00.000Z`);
  value.setUTCDate(
    value.getUTCDate() + (period === "daily" ? 1 : period === "weekly" ? 7 : 0),
  );
  if (period === "monthly") {
    value.setUTCMonth(value.getUTCMonth() + 1);
    value.setUTCDate(1);
  }
  return value.toISOString().slice(0, 10);
}

export function journalPeriodStartForQuery(
  value: string,
  period: JournalPeriod,
) {
  return journalPeriodStart(value, period);
}

export const taskLinkBlockPropsSchema = z
  .object({
    taskId: z.string().uuid().nullable(),
    fallbackTitle: z.string().max(300),
    fallbackChecked: z.boolean(),
    taskAvailable: z.boolean().optional(),
    taskTitle: z.string().max(300).optional(),
    taskCompleted: z.boolean().optional(),
    taskRevision: z.number().int().positive().optional(),
  })
  .strict();

export type TaskLinkBlockProps = z.infer<typeof taskLinkBlockPropsSchema>;

export function canonicalizeTaskLinks<T>(value: T): T {
  const visit = (item: unknown, taskLinkProps = false): unknown => {
    if (Array.isArray(item)) return item.map((child) => visit(child));
    if (!item || typeof item !== "object") return item;
    const source = item as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(source)) {
      if (
        taskLinkProps &&
        [
          "taskAvailable",
          "taskTitle",
          "taskCompleted",
          "taskRevision",
        ].includes(key)
      )
        continue;
      result[key] = visit(child, source.type === "taskLink" && key === "props");
    }
    return result;
  };
  return visit(value) as T;
}

export function writingPlainText(document: Document): string {
  const linkedTasks: string[] = [];
  const visit = (blocks: unknown) => {
    if (!Array.isArray(blocks)) return;
    for (const value of blocks) {
      if (!value || typeof value !== "object") continue;
      const block = value as Record<string, unknown>;
      if (
        block.type === "taskLink" &&
        block.props &&
        typeof block.props === "object"
      ) {
        const title = (block.props as Record<string, unknown>).fallbackTitle;
        if (typeof title === "string" && title.trim())
          linkedTasks.push(title.trim());
      }
      visit(block.children);
    }
  };
  visit(document.blocks);
  return [plainText(document.blocks), ...linkedTasks]
    .filter(Boolean)
    .join("\n");
}
