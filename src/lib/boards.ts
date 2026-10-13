import { z } from "./zod";
export const taskStages = ["todo", "in_progress", "done"] as const;
export type TaskStage = (typeof taskStages)[number];
export const stageLabels: Record<TaskStage, string> = {
  todo: "To do",
  in_progress: "In progress",
  done: "Done",
};
export const boardInput = z
  .object({ name: z.string().trim().min(1).max(80) })
  .strict();
export const boardChanges = boardInput
  .partial()
  .extend({
    revision: z.number().int().positive(),
    archived: z.boolean().optional(),
  })
  .strict()
  .refine(
    (v) => v.name !== undefined || v.archived !== undefined,
    "Provide a field to change.",
  );
export const taskBoardFields = {
  boardId: z.string().uuid().nullable().optional(),
  status: z.enum(taskStages).optional(),
};
export const taskMoveInput = z
  .object({
    revision: z.number().int().positive(),
    boardId: z.string().uuid().nullable(),
    status: z.enum(taskStages),
    beforeId: z
      .string()
      .uuid()
      .nullable()
      .optional()
      .describe(
        "Insert before this task; omit for the top, null for the bottom.",
      ),
  })
  .strict();
