import { Temporal } from "@js-temporal/polyfill";
import { z } from "./zod";
import { validDate } from "./dates";
import { zoneSchema } from "./calendar";

const localMinuteSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
const taskScheduleFieldsSchema = z
  .object({
    start: localMinuteSchema,
    timezone: zoneSchema,
    durationMinutes: z.number().int().min(5).max(1440),
    disambiguation: z.enum(["earlier", "later", "reject"]),
  })
  .strict();

export const storedTaskScheduleSchema = taskScheduleFieldsSchema.superRefine(
  (schedule, ctx) => {
    try {
      const local = Temporal.PlainDateTime.from(schedule.start);
      if (
        !validDate(schedule.start.slice(0, 10)) ||
        local.toString({ smallestUnit: "minute" }) !== schedule.start
      )
        throw new Error("invalid local time");
    } catch {
      ctx.addIssue({
        code: "custom",
        path: ["start"],
        message:
          "Choose a valid local time. During a clock change, select a time that exists in this timezone.",
      });
    }
  },
);

export const taskScheduleSchema = storedTaskScheduleSchema.superRefine(
  (schedule, ctx) => {
    try {
      const zoned = Temporal.PlainDateTime.from(schedule.start).toZonedDateTime(
        schedule.timezone,
        { disambiguation: schedule.disambiguation },
      );
      if (
        zoned.toPlainDateTime().toString({ smallestUnit: "minute" }) !==
        schedule.start
      )
        throw new Error("nonexistent local time");
    } catch {
      ctx.addIssue({
        code: "custom",
        path: ["start"],
        message:
          "Choose a valid local time. During a clock change, select a time that exists in this timezone.",
      });
    }
  },
);

export const taskRecurrenceRuleSchema = z
  .object({
    frequency: z.enum(["daily", "weekly", "monthly", "yearly"]),
    interval: z.number().int().min(1).max(999).default(1),
    weekdays: z.array(z.number().int().min(0).max(6)).max(7).default([]),
    anchor: z.enum(["scheduled", "completion"]),
    until: z
      .string()
      .nullable()
      .refine((value) => value === null || validDate(value), {
        message: "Choose a valid recurrence end date.",
      })
      .default(null),
  })
  .strict()
  .superRefine((rule, ctx) => {
    if (new Set(rule.weekdays).size !== rule.weekdays.length)
      ctx.addIssue({
        code: "custom",
        path: ["weekdays"],
        message: "Choose each weekday only once.",
      });
    if (rule.frequency !== "weekly" && rule.weekdays.length)
      ctx.addIssue({
        code: "custom",
        path: ["weekdays"],
        message: "Selected weekdays apply to weekly recurrence only.",
      });
  });

export const taskScheduleIssueSchema = z.enum(["needs-scheduling"]).nullable();

export const taskStepSchema = z
  .object({
    id: z.string().uuid(),
    taskId: z.string().uuid(),
    text: z.string().min(1).max(300),
    completed: z.boolean(),
    position: z.number().int().min(0).max(99),
    revision: z.number().int().positive(),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
  })
  .strict();

export type TaskSchedule = z.infer<typeof taskScheduleSchema>;
export type TaskRecurrenceRule = z.infer<typeof taskRecurrenceRuleSchema>;
export type TaskScheduleIssue = z.infer<typeof taskScheduleIssueSchema>;
export type TaskStep = z.infer<typeof taskStepSchema>;

export type ResolvedTaskSchedule = {
  startAt: number;
  endAt: number;
};

export function resolveTaskSchedule(
  schedule: TaskSchedule,
): ResolvedTaskSchedule {
  const value = taskScheduleSchema.parse(schedule);
  const start = Temporal.PlainDateTime.from(value.start).toZonedDateTime(
    value.timezone,
    { disambiguation: value.disambiguation },
  );
  return {
    startAt: Number(start.epochMilliseconds),
    endAt: Number(
      start.add({ minutes: value.durationMinutes }).epochMilliseconds,
    ),
  };
}

export function shiftTaskScheduleDate(
  schedule: TaskSchedule,
  date: string,
): TaskSchedule {
  if (!validDate(date)) throw new Error("Invalid task schedule date.");
  const shifted = {
    ...schedule,
    start: `${date}T${schedule.start.slice(11)}`,
  };
  return taskScheduleSchema.parse(shifted);
}

export function nextRuleDate(
  anchorDate: string,
  afterDate: string,
  rule: TaskRecurrenceRule,
): string | null {
  if (!validDate(anchorDate) || !validDate(afterDate)) return null;
  try {
    const anchor = Temporal.PlainDate.from(anchorDate);
    const after = Temporal.PlainDate.from(afterDate);
    const interval = rule.interval;
    let candidate: Temporal.PlainDate;
    if (rule.frequency === "daily") {
      const elapsed = anchor.until(after).days;
      const n = Math.max(1, Math.floor(elapsed / interval) + 1);
      candidate = anchor.add({ days: n * interval });
    } else if (rule.frequency === "weekly" && !rule.weekdays.length) {
      const elapsed = anchor.until(after).days;
      const span = interval * 7;
      const n = Math.max(1, Math.floor(elapsed / span) + 1);
      candidate = anchor.add({ days: n * span });
    } else if (rule.frequency === "weekly") {
      const weekStart = anchor.subtract({ days: anchor.dayOfWeek - 1 });
      const firstDate = after.add({ days: 1 });
      const elapsedWeeks = Math.max(
        0,
        Math.floor(weekStart.until(firstDate).days / 7),
      );
      let weekIndex = Math.floor(elapsedWeeks / interval) * interval;
      candidate = firstDate;
      for (let checked = 0; checked < 1000; checked += 1) {
        const week = weekStart.add({ weeks: weekIndex });
        const choices = rule.weekdays
          .map((weekday) => week.add({ days: (weekday + 6) % 7 }))
          .filter((date) => Temporal.PlainDate.compare(date, firstDate) >= 0)
          .sort(Temporal.PlainDate.compare);
        if (choices.length) {
          candidate = choices[0];
          break;
        }
        weekIndex += interval;
        if (checked === 999) return null;
      }
    } else if (rule.frequency === "monthly") {
      const elapsedMonths =
        (after.year - anchor.year) * 12 + after.month - anchor.month;
      let n = Math.max(1, Math.floor(elapsedMonths / interval) + 1);
      candidate = anchor.add({ months: n * interval });
      while (Temporal.PlainDate.compare(candidate, after) <= 0) {
        n += 1;
        candidate = anchor.add({ months: n * interval });
      }
    } else {
      let n = Math.max(
        1,
        Math.floor((after.year - anchor.year) / interval) + 1,
      );
      candidate = anchor.add({ years: n * interval });
      while (Temporal.PlainDate.compare(candidate, after) <= 0) {
        n += 1;
        candidate = anchor.add({ years: n * interval });
      }
    }
    if (
      rule.until &&
      Temporal.PlainDate.compare(
        candidate,
        Temporal.PlainDate.from(rule.until),
      ) > 0
    )
      return null;
    const result = candidate.toString();
    return validDate(result) ? result : null;
  } catch {
    return null;
  }
}
