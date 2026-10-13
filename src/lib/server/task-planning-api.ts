import { z } from "zod";
import type { ApiOperation } from "./api-contract";
import { apiOutputs } from "./api-schemas";
import { taskStepSchema } from "../task-planning";

const revision = z.number().int().positive();
const stepId = z.string().uuid();
const stepText = z.string().trim().min(1).max(300);
const taskSchema = apiOutputs.task;
const taskAndStep = z
  .object({ task: taskSchema, step: taskStepSchema })
  .strict();
const taskAndSteps = z
  .object({ task: taskSchema, items: z.array(taskStepSchema).max(100) })
  .strict();

export const taskPlanningInputs = {
  createStep: z
    .object({
      revision,
      text: stepText,
      position: z.number().int().min(0).max(99).optional(),
    })
    .strict(),
  updateStep: z
    .object({
      revision,
      text: stepText.optional(),
      completed: z.boolean().optional(),
      position: z.number().int().min(0).max(99).optional(),
    })
    .strict()
    .refine(
      (input) =>
        input.text !== undefined ||
        input.completed !== undefined ||
        input.position !== undefined,
      "Change at least one step field.",
    ),
  deleteStep: z.object({ revision }).strict(),
  reorderSteps: z
    .object({
      revision,
      stepIds: z.array(stepId).max(100),
    })
    .strict()
    .refine((input) => new Set(input.stepIds).size === input.stepIds.length, {
      path: ["stepIds"],
      message: "Choose each task step only once.",
    }),
};

const operations: ApiOperation[] = [
  {
    path: "/api/v1/tasks/{id}/steps",
    method: "GET",
    summary: "List checklist steps for a task",
    access: "content",
    output: z
      .object({
        taskRevision: revision,
        items: z.array(taskStepSchema).max(100),
      })
      .strict(),
    status: 200,
  },
  {
    path: "/api/v1/tasks/{id}/steps",
    method: "POST",
    summary: "Add a checklist step to a task",
    access: "content",
    input: taskPlanningInputs.createStep,
    output: taskAndStep,
    status: 201,
  },
  {
    path: "/api/v1/tasks/{id}/steps/reorder",
    method: "POST",
    summary: "Reorder all checklist steps on a task",
    access: "content",
    input: taskPlanningInputs.reorderSteps,
    output: taskAndSteps,
    status: 200,
  },
  {
    path: "/api/v1/tasks/{id}/steps/{stepId}",
    method: "PATCH",
    summary: "Update a checklist step",
    access: "content",
    input: taskPlanningInputs.updateStep,
    output: taskAndStep,
    status: 200,
  },
  {
    path: "/api/v1/tasks/{id}/steps/{stepId}",
    method: "DELETE",
    summary: "Delete a checklist step",
    access: "content",
    input: taskPlanningInputs.deleteStep,
    output: z.object({ task: taskSchema }).strict(),
    status: 200,
  },
];

export const taskPlanningApiOperations = operations;
