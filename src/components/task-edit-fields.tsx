"use client";
import type { Task } from "@/lib/types";
import type { Recurrence } from "@/lib/dates";
import type { TaskRecurrenceRule, TaskSchedule } from "@/lib/task-planning";
import { CalendarDays } from "lucide-react";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import { DatePicker } from "./date-picker";
import { NotePicker } from "./note-picker";
import { TaskReminders } from "./task-reminders";
import { ScheduleEditor } from "./schedule-editor";
import { Button } from "./ui/button";

const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
function newRule(): TaskRecurrenceRule {
  return {
    frequency: "weekly",
    interval: 1,
    weekdays: [],
    anchor: "scheduled",
    until: null,
  };
}

export function TaskEditFields({
  task,
  title,
  setTitle,
  dueDate,
  setDueDate,
  plannedDate,
  setPlannedDate,
  recurrence,
  setRecurrence,
  recurrenceRule,
  setRecurrenceRule,
  schedule,
  setSchedule,
  note,
  setNote,
  disabled,
  onReminderDirty,
}: {
  task: Task;
  title: string;
  setTitle: (value: string) => void;
  dueDate: string | null;
  setDueDate: (value: string | null) => void;
  plannedDate: string | null;
  setPlannedDate: (value: string | null) => void;
  recurrence: Recurrence | null;
  setRecurrence: (value: Recurrence | null) => void;
  recurrenceRule: TaskRecurrenceRule | null;
  setRecurrenceRule: (value: TaskRecurrenceRule | null) => void;
  schedule: TaskSchedule | null;
  setSchedule: (value: TaskSchedule | null) => void;
  note: { id: string | null; title: string | null };
  setNote: (value: { id: string | null; title: string | null }) => void;
  disabled: boolean;
  onReminderDirty: (value: boolean) => void;
}) {
  const zone =
    schedule?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const repeatValue = recurrenceRule ? "custom" : (recurrence ?? "none");
  function chooseRepeat(value: string) {
    if (value === "none") {
      setRecurrence(null);
      setRecurrenceRule(null);
    } else if (value === "custom") {
      setRecurrence(null);
      setRecurrenceRule(recurrenceRule ?? newRule());
    } else {
      setRecurrence(value as Recurrence);
      setRecurrenceRule(null);
    }
  }
  function changePlannedDate(value: string | null) {
    setPlannedDate(value);
    if (schedule) {
      if (!value) setSchedule(null);
      else
        setSchedule({
          ...schedule,
          start: `${value}T${schedule.start.slice(11)}`,
        });
    }
  }
  return (
    <>
      <Label htmlFor={`edit-task-${task.id}`}>Task</Label>
      <Input
        id={`edit-task-${task.id}`}
        autoFocus
        value={title}
        maxLength={300}
        disabled={disabled}
        onChange={(e) => setTitle(e.target.value)}
      />
      <div className="task-schedule-controls">
        {!schedule && (
          <DatePicker
            label="Planned date"
            value={plannedDate}
            onChange={changePlannedDate}
            disabled={disabled}
          />
        )}
        <DatePicker
          value={dueDate}
          onChange={(value) => {
            setDueDate(value);
            if (!value) {
              setRecurrence(null);
              setRecurrenceRule(null);
            }
          }}
          disabled={disabled}
        />
        <Select
          value={repeatValue}
          onValueChange={chooseRepeat}
          disabled={disabled || !dueDate}
        >
          <SelectTrigger aria-label="Task recurrence">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">Does not repeat</SelectItem>
            <SelectItem value="daily">Every day</SelectItem>
            <SelectItem value="weekly">Every week</SelectItem>
            <SelectItem value="monthly">Every month</SelectItem>
            <SelectItem value="custom">Custom schedule…</SelectItem>
          </SelectContent>
        </Select>
        <NotePicker
          value={note.id}
          title={note.title}
          disabled={disabled}
          onChange={(id, title) => setNote({ id, title })}
        />
      </div>
      {schedule && (
        <ScheduleEditor
          id={`task-${task.id}`}
          schedule={schedule}
          plannedDate={plannedDate}
          timezone={zone}
          disabled={disabled}
          onScheduleChange={setSchedule}
          onPlannedDateChange={setPlannedDate}
        />
      )}
      {!schedule && (
        <ScheduleEditor
          id={`task-${task.id}`}
          schedule={null}
          plannedDate={plannedDate}
          timezone={zone}
          disabled={disabled}
          onScheduleChange={(value) => {
            setSchedule(value);
            if (value) setPlannedDate(value.start.slice(0, 10));
          }}
          onPlannedDateChange={changePlannedDate}
        />
      )}
      {recurrenceRule && (
        <section
          className="planning-recurrence"
          aria-labelledby={`repeat-${task.id}`}
        >
          <div className="planning-section-heading">
            <div>
              <h3 id={`repeat-${task.id}`}>Custom repeat</h3>
              <p>
                {recurrenceRule.anchor === "completion"
                  ? "Repeat after you complete this task."
                  : "Repeat from this task’s due date."}
              </p>
            </div>
          </div>
          <div className="planning-recurrence-grid">
            <label className="planning-schedule-field">
              <span>Repeats</span>
              <Select
                value={recurrenceRule.frequency}
                disabled={disabled}
                onValueChange={(value) =>
                  setRecurrenceRule({
                    ...recurrenceRule,
                    frequency: value as TaskRecurrenceRule["frequency"],
                    weekdays: value === "weekly" ? recurrenceRule.weekdays : [],
                  })
                }
              >
                <SelectTrigger aria-label="Custom repeat frequency">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="daily">Days</SelectItem>
                  <SelectItem value="weekly">Weeks</SelectItem>
                  <SelectItem value="monthly">Months</SelectItem>
                  <SelectItem value="yearly">Years</SelectItem>
                </SelectContent>
              </Select>
            </label>
            <label
              className="planning-schedule-field"
              htmlFor={`repeat-interval-${task.id}`}
            >
              <span>Every</span>
              <Input
                id={`repeat-interval-${task.id}`}
                type="number"
                min={1}
                max={999}
                value={recurrenceRule.interval}
                disabled={disabled}
                onChange={(event) =>
                  setRecurrenceRule({
                    ...recurrenceRule,
                    interval: Number(event.target.value),
                  })
                }
              />
            </label>
            <label className="planning-schedule-field">
              <span>Starts again</span>
              <Select
                value={recurrenceRule.anchor}
                disabled={disabled}
                onValueChange={(value) =>
                  setRecurrenceRule({
                    ...recurrenceRule,
                    anchor: value as TaskRecurrenceRule["anchor"],
                  })
                }
              >
                <SelectTrigger aria-label="Repeat anchor">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="scheduled">
                    From its planned date
                  </SelectItem>
                  <SelectItem value="completion">After completion</SelectItem>
                </SelectContent>
              </Select>
            </label>
            <div className="planning-schedule-field">
              <span>End date</span>
              <DatePicker
                label="Repeat until"
                value={recurrenceRule.until}
                disabled={disabled}
                onChange={(until) =>
                  setRecurrenceRule({ ...recurrenceRule, until })
                }
              />
            </div>
          </div>
          {recurrenceRule.frequency === "weekly" && (
            <div className="planning-weekdays">
              <span>On these days</span>
              <div role="group" aria-label="Repeat weekdays">
                {weekdays.map((day, index) => {
                  const selected = recurrenceRule.weekdays.includes(index);
                  return (
                    <Button
                      key={day}
                      type="button"
                      variant={selected ? "secondary" : "outline"}
                      aria-pressed={selected}
                      disabled={disabled}
                      onClick={() =>
                        setRecurrenceRule({
                          ...recurrenceRule,
                          weekdays: selected
                            ? recurrenceRule.weekdays.filter(
                                (value) => value !== index,
                              )
                            : [...recurrenceRule.weekdays, index].sort(),
                        })
                      }
                    >
                      {day}
                    </Button>
                  );
                })}
              </div>
              <small>
                Leave all days clear to repeat on the original weekday.
              </small>
            </div>
          )}
          {!dueDate && (
            <p className="planning-inline-status">
              Add a deadline to enable recurrence.
            </p>
          )}
          <Button
            type="button"
            variant="ghost"
            disabled={disabled}
            onClick={() => setRecurrenceRule(null)}
          >
            <CalendarDays size={15} />
            Remove custom repeat
          </Button>
        </section>
      )}
      <TaskReminders
        id={task.id}
        revision={task.revision}
        onDirty={onReminderDirty}
      />
    </>
  );
}
