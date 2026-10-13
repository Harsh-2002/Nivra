import { sqlite } from "./db";
import { HttpError } from "./http";
import { journalPeriodSql } from "./journal-classification";
export type CountOptions = {
  state: "active" | "trash";
  tagId?: string;
  favoritesOnly: boolean;
};
export function agentCounts(owner: string, options: CountOptions) {
  const database = sqlite();
  return database.transaction(() => {
    if (
      options.tagId &&
      !database.prepare("SELECT 1 FROM tags WHERE id=?").get(options.tagId)
    )
      throw new HttpError(404, "This tag was not found.");
    const counts: Record<string, number> = {};
    let taskStatus = { open: 0, completed: 0 };
    for (const [type, table, tagTable, tagColumn, extra, favorite] of [
      [
        "notes",
        "notes",
        "note_tags",
        "note_id",
        `kind='note' AND ${journalPeriodSql("notes")} IS NULL`,
        true,
      ],
      [
        "journals",
        "notes",
        "note_tags",
        "note_id",
        `kind='note' AND ${journalPeriodSql("notes")} IS NOT NULL`,
        true,
      ],
      ["tasks", "tasks", "task_tags", "task_id", "1=1", false],
      ["bookmarks", "bookmarks", "bookmark_tags", "bookmark_id", "1=1", true],
      ["artifacts", "artifacts", "artifact_tags", "artifact_id", "1=1", false],
      ["events", "calendar_events", "event_tags", "event_id", "1=1", false],
      ["forms", "forms", "form_tags", "form_id", "1=1", true],
    ] as const) {
      const where = [
        "owner_id=?",
        options.state === "trash"
          ? "trashed_at IS NOT NULL"
          : "trashed_at IS NULL",
        extra,
      ];
      const values = [owner];
      if (options.tagId) {
        where.push(
          `id IN(SELECT ${tagColumn} FROM ${tagTable} WHERE tag_id=?)`,
        );
        values.push(options.tagId);
      }
      if (options.favoritesOnly) where.push(favorite ? "favorite=1" : "0=1");
      const row = database
        .prepare(
          `SELECT count(*) AS total${type === "tasks" ? ",coalesce(sum(completed_at IS NULL),0) AS open,coalesce(sum(completed_at IS NOT NULL),0) AS completed" : ""} FROM ${table}${options.state === "active" ? ` INDEXED BY ${table === "calendar_events" ? "events" : table}_active_counts_idx` : ""} WHERE ${where.join(" AND ")}`,
        )
        .get(...values) as { total: number; open?: number; completed?: number };
      counts[type] = row.total;
      if (type === "tasks")
        taskStatus = { open: row.open!, completed: row.completed! };
    }
    return {
      exact: true,
      state: options.state,
      favoritesOnly: options.favoritesOnly,
      tagId: options.tagId ?? null,
      counts,
      total: Object.values(counts).reduce((a, b) => a + b, 0),
      taskStatus,
    };
  })();
}
