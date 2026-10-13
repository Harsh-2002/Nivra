import { Temporal } from "@js-temporal/polyfill";
import { RRule } from "rrule";
import { z } from "./zod";
import { validDate } from "./dates";
export const dateSchema = z.string().refine(validDate, "Choose a valid date.");
export const zoneSchema = z
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
export const contentKinds = [
  "note",
  "journal",
  "task",
  "bookmark",
  "artifact",
] as const;
export const recurrenceSchema = z
  .object({
    frequency: z.enum(["daily", "weekly", "monthly", "yearly"]),
    interval: z.number().int().min(1).max(999).default(1),
    weekdays: z.array(z.number().int().min(0).max(6)).max(7).default([]),
    ordinal: z.number().int().min(-1).max(5).nullable().default(null),
    monthDay: z.number().int().min(1).max(31).nullable().default(null),
    until: dateSchema.nullable().default(null),
    count: z.number().int().min(1).max(10000).nullable().default(null),
  })
  .strict()
  .refine((v) => !(v.until && v.count), "Choose an end date or a count.")
  .refine((v) => v.ordinal !== 0, "Choose a valid week.")
  .refine(
    (v) =>
      !v.ordinal ||
      (v.weekdays.length > 0 && ["monthly", "yearly"].includes(v.frequency)),
    "Choose weekdays for a monthly or yearly ordinal repeat.",
  );
export const eventInput = z
  .object({
    title: z.string().trim().min(1).max(300),
    description: z.string().max(10000).default(""),
    location: z.string().max(500).default(""),
    allDay: z.boolean().default(true),
    start: z.string().max(40),
    end: z.string().max(40),
    timezone: zoneSchema,
    disambiguation: z.enum(["earlier", "later", "reject"]).default("reject"),
    recurrence: recurrenceSchema.nullable().default(null),
    links: z
      .array(
        z
          .object({ type: z.enum(contentKinds), id: z.string().uuid() })
          .strict(),
      )
      .max(100)
      .default([]),
    reminders: z.array(z.number().int().min(0).max(10080)).max(3).default([]),
  })
  .strict()
  .superRefine((v, ctx) => {
    try {
      if (v.allDay) {
        if (!validDate(v.start) || !validDate(v.end) || v.end <= v.start)
          throw Error();
      } else {
        const a = Temporal.PlainDateTime.from(v.start).toZonedDateTime(
            v.timezone,
            { disambiguation: v.disambiguation },
          ),
          b = Temporal.PlainDateTime.from(v.end).toZonedDateTime(v.timezone, {
            disambiguation: v.disambiguation,
          });
        if (
          a.toPlainDateTime().toString() !==
            Temporal.PlainDateTime.from(v.start).toString() ||
          b.toPlainDateTime().toString() !==
            Temporal.PlainDateTime.from(v.end).toString() ||
          Temporal.ZonedDateTime.compare(a, b) >= 0
        )
          throw Error();
      }
    } catch {
      ctx.addIssue({
        code: "custom",
        message:
          "Choose a valid start and later end. For a repeated clock time, select its earlier or later offset.",
      });
    }
  });
export type EventInput = z.infer<typeof eventInput>;
export type CalendarEvent = EventInput & {
  id: string;
  ownerId: string;
  revision: number;
  trashedAt: number | null;
  createdAt: number;
  updatedAt: number;
};
export type CalendarItem = {
  id: string;
  sourceId: string;
  type:
    "event" | "task" | "journal" | "note" | "bookmark" | "artifact" | "form";
  title: string;
  date: string;
  endDate?: string;
  startAt?: number;
  endAt?: number;
  label: string;
  revision: number;
  completed?: boolean;
  scheduleIssue?: "needs-scheduling";
  occurrence?: string;
};
export type CalendarRange = {
  items: CalendarItem[];
  counts: Record<string, number>;
  total: number;
  nextOffset: number | null;
  unscheduled: number;
  overdue: number;
};
export function zoneDay(date: string, zone: string) {
  return Number(
    Temporal.PlainDate.from(date).toZonedDateTime(zone).epochMilliseconds,
  );
}
export function addDays(date: string, days: number) {
  return Temporal.PlainDate.from(date).add({ days }).toString();
}
export function eventInstant(event: EventInput, value = event.start) {
  return event.allDay
    ? zoneDay(value, event.timezone)
    : Number(
        Temporal.PlainDateTime.from(value).toZonedDateTime(event.timezone, {
          disambiguation: event.disambiguation,
        }).epochMilliseconds,
      );
}
export function localInstant(value: number, zone: string) {
  return Temporal.Instant.fromEpochMilliseconds(value)
    .toZonedDateTimeISO(zone)
    .toPlainDateTime()
    .toString({ smallestUnit: "minute" });
}
export function occurrenceRule(event: EventInput) {
  const r = event.recurrence;
  if (!r) return null;
  const start = Temporal.PlainDateTime.from(
    event.allDay ? event.start + "T00:00" : event.start,
  );
  return new RRule(
    {
      freq: {
        daily: RRule.DAILY,
        weekly: RRule.WEEKLY,
        monthly: RRule.MONTHLY,
        yearly: RRule.YEARLY,
      }[r.frequency],
      interval: r.interval,
      dtstart: new Date(start.toString() + "Z"),
      ...(r.weekdays.length
        ? {
            byweekday: r.weekdays.map(
              (day) =>
                [
                  RRule.SU,
                  RRule.MO,
                  RRule.TU,
                  RRule.WE,
                  RRule.TH,
                  RRule.FR,
                  RRule.SA,
                ][day],
            ),
          }
        : {}),
      ...(r.ordinal ? { bysetpos: r.ordinal } : {}),
      ...(r.monthDay ? { bymonthday: r.monthDay } : {}),
      ...(r.until ? { until: new Date(r.until + "T23:59:59Z") } : {}),
      ...(r.count ? { count: r.count } : {}),
    },
    false,
  );
}
export function eventOccurrences(
  event: CalendarEvent,
  from: string,
  to: string,
  zone: string,
): CalendarItem[] {
  const first = zoneDay(from, zone),
    last = zoneDay(to, zone),
    rule = occurrenceRule(event);
  const days = Temporal.PlainDate.from(event.end.slice(0, 10)).since(
    Temporal.PlainDate.from(event.start.slice(0, 10)),
  ).days;
  const wallDuration = event.allDay
    ? null
    : Temporal.PlainDateTime.from(event.end).since(
        Temporal.PlainDateTime.from(event.start),
      );
  let validCount = 0;
  const countedRule =
    rule && event.recurrence?.count && !event.allDay
      ? new RRule({ ...rule.origOptions, count: null }, false)
      : null;
  const dates = countedRule
    ? countedRule.all((date) => {
        if (
          date > new Date(addDays(to, 2) + "T00:00:00Z") ||
          validCount >= event.recurrence!.count!
        )
          return false;
        const start =
          date.toISOString().slice(0, 10) + "T" + event.start.slice(11);
        const end = Temporal.PlainDateTime.from(start)
          .add(wallDuration!)
          .toString({ smallestUnit: "minute" });
        const value = {
          ...event,
          disambiguation:
            event.disambiguation === "reject"
              ? ("earlier" as const)
              : event.disambiguation,
        };
        if (
          localInstant(eventInstant(value, start), event.timezone) ===
            Temporal.PlainDateTime.from(start).toString({
              smallestUnit: "minute",
            }) &&
          localInstant(eventInstant(value, end), event.timezone) === end
        )
          validCount++;
        return true;
      })
    : rule
      ? rule.between(
          new Date(addDays(from, -Math.max(days + 2, 2)) + "T00:00:00Z"),
          new Date(addDays(to, 2) + "T00:00:00Z"),
          true,
          (date, i) => i < 10000,
        )
      : [new Date(event.start.slice(0, 10) + "T00:00:00Z")];
  return dates.flatMap((date) => {
    const day = date.toISOString().slice(0, 10),
      start = rule
        ? event.allDay
          ? day
          : day + "T" + event.start.slice(11)
        : event.start;
    let end = event.end;
    if (rule)
      end = event.allDay
        ? addDays(day, days)
        : Temporal.PlainDateTime.from(start)
            .add(wallDuration!)
            .toString({ smallestUnit: "minute" });
    try {
      const a = eventInstant(
          {
            ...event,
            disambiguation:
              event.disambiguation === "reject"
                ? "earlier"
                : event.disambiguation,
          },
          start,
        ),
        b = eventInstant(
          {
            ...event,
            disambiguation:
              event.disambiguation === "reject"
                ? "earlier"
                : event.disambiguation,
          },
          end,
        );
      if (
        !event.allDay &&
        (localInstant(a, event.timezone) !==
          Temporal.PlainDateTime.from(start).toString({
            smallestUnit: "minute",
          }) ||
          localInstant(b, event.timezone) !==
            Temporal.PlainDateTime.from(end).toString({
              smallestUnit: "minute",
            }))
      )
        return [];
      if (event.allDay ? start >= to || end <= from : a >= last || b <= first)
        return [];
      return [
        {
          id: event.id + ":" + start,
          sourceId: event.id,
          type: "event" as const,
          title: event.title,
          date: event.allDay ? start : localInstant(a, zone).slice(0, 10),
          endDate: event.allDay ? end : localInstant(b, zone).slice(0, 10),
          ...(event.allDay ? {} : { startAt: a, endAt: b }),
          label: "Event",
          revision: event.revision,
          occurrence: start,
        },
      ];
    } catch {
      return [];
    }
  });
}

export function eventPayload(value: EventInput): EventInput {
  const {
    title,
    description,
    location,
    allDay,
    start,
    end,
    timezone,
    disambiguation,
    recurrence,
    links,
    reminders,
  } = value;
  return eventInput.parse({
    title,
    description,
    location,
    allDay,
    start,
    end,
    timezone,
    disambiguation,
    recurrence,
    links,
    reminders,
  });
}
