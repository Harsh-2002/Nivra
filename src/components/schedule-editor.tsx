"use client";
import { useMemo } from "react";
import { Temporal } from "@js-temporal/polyfill";
import { CalendarClock, Clock3, X } from "lucide-react";
import type { TaskSchedule } from "@/lib/task-planning";
import { taskScheduleSchema } from "@/lib/task-planning";
import { localDate } from "@/lib/dates";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { DatePicker } from "./date-picker";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";

function scheduleMessage(value: TaskSchedule | null) {
  if (!value) return "";
  const parsed = taskScheduleSchema.safeParse(value);
  if (parsed.success) return "";
  const issue = parsed.error.issues[0];
  if (!issue?.path.includes("start"))
    return issue?.message ?? "Choose a valid schedule.";
  try {
    const local = Temporal.PlainDateTime.from(value.start);
    const earlier = local.toZonedDateTime(value.timezone, {
      disambiguation: "earlier",
    });
    const later = local.toZonedDateTime(value.timezone, {
      disambiguation: "later",
    });
    const preservesWallTime = (date: Temporal.ZonedDateTime) =>
      date.toPlainDateTime().toString({ smallestUnit: "minute" }) ===
      value.start;
    if (
      preservesWallTime(earlier) &&
      preservesWallTime(later) &&
      earlier.epochMilliseconds !== later.epochMilliseconds
    )
      return "This clock time occurs twice. Choose the earlier or later time.";
  } catch {
    return "Choose a valid date and time.";
  }
  return "This local time does not exist because the clocks change. Choose another time.";
}

export function validateTaskSchedule(value: TaskSchedule | null) {
  return scheduleMessage(value);
}

export function ScheduleEditor({
  id,
  schedule,
  plannedDate,
  timezone,
  disabled,
  onScheduleChange,
  onPlannedDateChange,
}: {
  id: string;
  schedule: TaskSchedule | null;
  plannedDate: string | null;
  timezone: string;
  disabled: boolean;
  onScheduleChange: (value: TaskSchedule | null) => void;
  onPlannedDateChange: (value: string | null) => void;
}) {
  const message = useMemo(() => scheduleMessage(schedule), [schedule]);
  function reserve() {
    const date = plannedDate ?? localDate();
    const start = date + "T09:00";
    onPlannedDateChange(date);
    onScheduleChange({
      start,
      timezone,
      durationMinutes: 30,
      disambiguation: "reject",
    });
  }
  if (!schedule)
    return (
      <div className="planning-schedule-empty">
        <div>
          <strong>Reserved time</strong>
          <span>Choose a time to work on this task.</span>
        </div>
        <Button
          type="button"
          variant="outline"
          className="planning-action"
          onClick={reserve}
          disabled={disabled}
        >
          <CalendarClock size={16} />
          Reserve time
        </Button>
      </div>
    );
  const date = schedule.start.slice(0, 10);
  const time = schedule.start.slice(11, 16);
  const timezoneId = `schedule-timezone-${id}`;
  const disambiguationId = `schedule-disambiguation-${id}`;
  return (
    <section
      className="planning-schedule-editor"
      aria-labelledby={`${id}-heading`}
    >
      <div className="planning-section-heading">
        <div>
          <h3 id={`${id}-heading`}>Reserved time</h3>
          <p>One block for this task. Its deadline stays separate.</p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Remove reserved time"
          disabled={disabled}
          onClick={() => onScheduleChange(null)}
        >
          <X size={16} />
        </Button>
      </div>
      <div className="planning-schedule-grid">
        <div className="planning-schedule-field">
          <span id={`${id}-date-label`}>Work date</span>
          <DatePicker
            label="Work date"
            value={date}
            disabled={disabled}
            onChange={(value) => {
              if (!value) {
                onScheduleChange(null);
                onPlannedDateChange(null);
                return;
              }
              onScheduleChange({ ...schedule, start: `${value}T${time}` });
              onPlannedDateChange(value);
            }}
          />
        </div>
        <label className="planning-schedule-field" htmlFor={`${id}-time`}>
          <span>Start time</span>
          <Input
            id={`${id}-time`}
            type="time"
            step={300}
            value={time}
            disabled={disabled}
            aria-describedby={timezoneId}
            onChange={(event) =>
              onScheduleChange({
                ...schedule,
                start: `${date}T${event.target.value}`,
              })
            }
          />
        </label>
        <label className="planning-schedule-field" htmlFor={`${id}-duration`}>
          <span>Duration</span>
          <div className="planning-duration-control">
            <Input
              id={`${id}-duration`}
              type="number"
              min={5}
              max={1440}
              step={5}
              value={schedule.durationMinutes}
              disabled={disabled}
              aria-describedby={`${id}-duration-help`}
              onChange={(event) =>
                onScheduleChange({
                  ...schedule,
                  durationMinutes: Number(event.target.value),
                })
              }
            />
            <span>minutes</span>
          </div>
          <small id={`${id}-duration-help`}>5 minutes to 24 hours</small>
        </label>
      </div>
      <div className="planning-timezone-note">
        <Clock3 size={14} aria-hidden="true" />
        <span id={timezoneId}>Times are shown in {schedule.timezone}.</span>
      </div>
      {message && (
        <div className="planning-field-error">
          <p role="alert">{message}</p>
          {message.startsWith("This clock time occurs twice") && (
            <Select
              value={schedule.disambiguation}
              onValueChange={(value) =>
                onScheduleChange({
                  ...schedule,
                  disambiguation: value as TaskSchedule["disambiguation"],
                })
              }
              disabled={disabled}
            >
              <SelectTrigger
                id={disambiguationId}
                aria-label="Choose which occurrence of this time"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="earlier">Earlier time</SelectItem>
                <SelectItem value="later">Later time</SelectItem>
              </SelectContent>
            </Select>
          )}
        </div>
      )}
    </section>
  );
}
