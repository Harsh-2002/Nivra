import { randomUUID } from "node:crypto";
import type { TaskStep } from "../task-planning";
import type { ContentCommand, ContentResult } from "./content-service";
import { sqlite } from "./db";
import { HttpError } from "./http";
import { completionEvent } from "./jobs";
import { getTask } from "./tasks";
import { taskPlanningInputs } from "./task-planning-api";

type StepRow = {
  id: string;
  taskId: string;
  text: string;
  completed: number;
  position: number;
  revision: number;
  createdAt: number;
  updatedAt: number;
};
const result = (data: unknown, status = 200): ContentResult => ({
  data,
  status,
});

function getStepRows(owner: string, taskId: string): TaskStep[] {
  return (
    sqlite()
      .prepare(
        "SELECT id,task_id AS taskId,text,completed,position,revision,created_at AS createdAt,updated_at AS updatedAt FROM task_steps WHERE owner_id=? AND task_id=? ORDER BY position,id",
      )
      .all(owner, taskId) as StepRow[]
  ).map((row) => ({
    ...row,
    completed: row.completed === 1,
  }));
}

function requireTaskRevision(owner: string, taskId: string, revision: number) {
  const task = sqlite()
    .prepare(
      "SELECT revision FROM tasks WHERE id=? AND owner_id=? AND trashed_at IS NULL",
    )
    .get(taskId, owner) as { revision: number } | undefined;
  if (!task) throw new HttpError(404, "This task was not found.");
  if (task.revision !== revision)
    throw new HttpError(
      409,
      "This task changed in another tab. Refresh tasks and try again.",
    );
  return task.revision;
}

function bumpTask(
  owner: string,
  taskId: string,
  revision: number,
  now: number,
) {
  const updated = sqlite()
    .prepare(
      "UPDATE tasks SET revision=revision+1,updated_at=? WHERE id=? AND owner_id=? AND revision=? AND trashed_at IS NULL RETURNING revision",
    )
    .get(now, taskId, owner, revision) as { revision: number } | undefined;
  if (!updated)
    throw new HttpError(
      409,
      "This task changed in another tab. Refresh tasks and try again.",
    );
  completionEvent(owner, "content", taskId, "changed");
  return updated.revision;
}

function rewriteOrder(
  owner: string,
  taskId: string,
  ids: string[],
  now: number,
  skipId?: string,
) {
  const update = sqlite().prepare(
    "UPDATE task_steps SET position=?,revision=revision+1,updated_at=? WHERE id=? AND owner_id=? AND task_id=? AND position<>?",
  );
  ids.forEach((id, position) => {
    if (id === skipId) return;
    update.run(position, now, id, owner, taskId, position);
  });
}

function insertStep(
  owner: string,
  taskId: string,
  revision: number,
  text: string,
  requestedPosition?: number,
) {
  return sqlite()
    .transaction(() => {
      requireTaskRevision(owner, taskId, revision);
      const rows = getStepRows(owner, taskId);
      if (rows.length >= 100)
        throw new HttpError(422, "A task can have at most 100 steps.");
      const position = requestedPosition ?? rows.length;
      if (position > rows.length)
        throw new HttpError(400, "Choose a position within the task steps.");
      const now = Date.now();
      const id = randomUUID();
      const ids = rows.map((row) => row.id);
      ids.splice(position, 0, id);
      sqlite()
        .prepare(
          "INSERT INTO task_steps(id,owner_id,task_id,text,completed,position,revision,created_at,updated_at) VALUES(?,?,?,?,0,?,1,?,?)",
        )
        .run(id, owner, taskId, text, position, now, now);
      rewriteOrder(owner, taskId, ids, now);
      bumpTask(owner, taskId, revision, now);
      return {
        task: getTask(owner, taskId),
        step: getStepRows(owner, taskId).find((step) => step.id === id)!,
      };
    })
    .immediate();
}

function updateStep(
  owner: string,
  taskId: string,
  stepId: string,
  revision: number,
  input: { text?: string; completed?: boolean; position?: number },
) {
  return sqlite()
    .transaction(() => {
      requireTaskRevision(owner, taskId, revision);
      const rows = getStepRows(owner, taskId);
      const index = rows.findIndex((step) => step.id === stepId);
      if (index < 0) throw new HttpError(404, "This task step was not found.");
      const current = rows[index];
      if (input.position !== undefined) {
        if (input.position >= rows.length)
          throw new HttpError(400, "Choose a position within the task steps.");
        const [step] = rows.splice(index, 1);
        rows.splice(input.position, 0, step);
      }
      const now = Date.now();
      rewriteOrder(
        owner,
        taskId,
        rows.map((step) => step.id),
        now,
        stepId,
      );
      sqlite()
        .prepare(
          "UPDATE task_steps SET text=?,completed=?,position=?,revision=revision+1,updated_at=? WHERE id=? AND owner_id=? AND task_id=?",
        )
        .run(
          input.text ?? current.text,
          Number(input.completed ?? current.completed),
          rows.findIndex((step) => step.id === stepId),
          now,
          stepId,
          owner,
          taskId,
        );
      bumpTask(owner, taskId, revision, now);
      return {
        task: getTask(owner, taskId),
        step: getStepRows(owner, taskId).find((step) => step.id === stepId)!,
      };
    })
    .immediate();
}

function deleteStep(
  owner: string,
  taskId: string,
  stepId: string,
  revision: number,
) {
  return sqlite()
    .transaction(() => {
      requireTaskRevision(owner, taskId, revision);
      const rows = getStepRows(owner, taskId);
      if (!rows.some((step) => step.id === stepId))
        throw new HttpError(404, "This task step was not found.");
      const now = Date.now();
      sqlite()
        .prepare(
          "DELETE FROM task_steps WHERE id=? AND owner_id=? AND task_id=?",
        )
        .run(stepId, owner, taskId);
      const remaining = rows.filter((step) => step.id !== stepId);
      rewriteOrder(
        owner,
        taskId,
        remaining.map((step) => step.id),
        now,
      );
      bumpTask(owner, taskId, revision, now);
      return { task: getTask(owner, taskId) };
    })
    .immediate();
}

function reorderSteps(
  owner: string,
  taskId: string,
  revision: number,
  stepIds: string[],
) {
  return sqlite()
    .transaction(() => {
      requireTaskRevision(owner, taskId, revision);
      const rows = getStepRows(owner, taskId);
      if (
        stepIds.length !== rows.length ||
        new Set(stepIds).size !== rows.length ||
        stepIds.some((id) => !rows.some((step) => step.id === id))
      )
        throw new HttpError(
          400,
          "Reordering must include every task step exactly once.",
        );
      const now = Date.now();
      rewriteOrder(owner, taskId, stepIds, now);
      bumpTask(owner, taskId, revision, now);
      return {
        task: getTask(owner, taskId),
        items: getStepRows(owner, taskId),
      };
    })
    .immediate();
}

export async function executeTaskPlanning(
  command: ContentCommand,
): Promise<ContentResult | null> {
  const [area, rawTaskId, action, rawStepId] = command.path;
  if (area !== "tasks" || !rawTaskId || action !== "steps") return null;
  const taskId = rawTaskId;
  const owner = command.ownerId;
  if (command.method === "GET" && !rawStepId) {
    const task = getTask(owner, taskId);
    return result({
      taskRevision: task.revision,
      items: getStepRows(owner, taskId),
    });
  }
  if (command.method === "POST" && !rawStepId) {
    const input = taskPlanningInputs.createStep.parse(command.input);
    return result(
      insertStep(owner, taskId, input.revision, input.text, input.position),
      201,
    );
  }
  if (
    command.method === "POST" &&
    rawStepId === "reorder" &&
    command.path.length === 4
  ) {
    const input = taskPlanningInputs.reorderSteps.parse(command.input);
    return result(reorderSteps(owner, taskId, input.revision, input.stepIds));
  }
  if (rawStepId && command.path.length === 4 && command.method === "PATCH") {
    const stepId = rawStepId;
    const input = taskPlanningInputs.updateStep.parse(command.input);
    return result(updateStep(owner, taskId, stepId, input.revision, input));
  }
  if (rawStepId && command.path.length === 4 && command.method === "DELETE") {
    const stepId = rawStepId;
    const input = taskPlanningInputs.deleteStep.parse(command.input);
    return result(deleteStep(owner, taskId, stepId, input.revision));
  }
  throw new HttpError(404, "This task step operation was not found.");
}
