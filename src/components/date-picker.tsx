"use client";
import { useState } from "react";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { formatDate, localDate, validDate } from "@/lib/dates";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
export function DatePicker({
  value,
  onChange,
  disabled = false,
  label = "Due date",
  allowClear = true,
}: {
  value: string | null;
  onChange: (date: string | null) => void;
  disabled?: boolean;
  label?: string;
  allowClear?: boolean;
}) {
  const dateAt = (year: number, month: number, day: number) => {
    const date = new Date(0);
    date.setFullYear(year, month, day);
    date.setHours(12, 0, 0, 0);
    return date;
  };
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState(
    () => new Date(`${value || localDate()}T12:00:00`),
  );
  const [draft, setDraft] = useState(value || "");
  const [error, setError] = useState("");
  const first = dateAt(month.getFullYear(), month.getMonth(), 1);
  const count = dateAt(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const choose = (day: string | null) => {
    onChange(day);
    setOpen(false);
    setError("");
  };
  const shift = (direction: number) =>
    setMonth(dateAt(month.getFullYear(), month.getMonth() + direction, 1));
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setDraft(value || "");
          setMonth(new Date(`${value || localDate()}T12:00:00`));
          setError("");
        }
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          disabled={disabled}
          aria-label={label}
          className="date-picker-trigger"
        >
          <CalendarDays size={15} />
          <span className="date-picker-label">
            {value ? formatDate(value) : label}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        collisionPadding={12}
        className="date-picker-popover"
        aria-label={`Choose ${label.toLowerCase()}`}
      >
        <div className="calendar-heading">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Previous month"
            disabled={month.getFullYear() === 1 && month.getMonth() === 0}
            onClick={() => shift(-1)}
          >
            <ChevronLeft />
          </Button>
          <span aria-live="polite">
            {month.toLocaleDateString(undefined, {
              month: "long",
              year: "numeric",
            })}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Next month"
            disabled={month.getFullYear() === 9999 && month.getMonth() === 11}
            onClick={() => shift(1)}
          >
            <ChevronRight />
          </Button>
        </div>
        <div className="calendar-grid" role="group" aria-label="Calendar days">
          {["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"].map((day) => (
            <span key={day} aria-hidden="true">
              {day}
            </span>
          ))}
          {Array.from({ length: first.getDay() }, (_, i) => (
            <span key={`space-${i}`} />
          ))}
          {Array.from({ length: count }, (_, i) => {
            const date = localDate(
              dateAt(month.getFullYear(), month.getMonth(), i + 1),
            );
            return (
              <Button
                type="button"
                variant="ghost"
                key={date}
                aria-label={formatDate(date)}
                aria-pressed={value === date}
                data-today={date === localDate()}
                onClick={() => choose(date)}
              >
                {i + 1}
              </Button>
            );
          })}
        </div>
        <div className="calendar-shortcuts">
          <Button
            type="button"
            variant="ghost"
            onClick={() => choose(localDate())}
          >
            Today
          </Button>
          {allowClear && (
            <Button type="button" variant="ghost" onClick={() => choose(null)}>
              No date
            </Button>
          )}
        </div>
        <div className="calendar-entry">
          <Input
            aria-label={`Enter ${label.toLowerCase()}`}
            placeholder="YYYY-MM-DD"
            value={draft}
            maxLength={10}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                if (validDate(draft)) choose(draft);
                else setError("Use a valid date: YYYY-MM-DD.");
              }
            }}
          />
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              if (validDate(draft)) choose(draft);
              else setError("Use a valid date: YYYY-MM-DD.");
            }}
          >
            Set date
          </Button>
        </div>
        {error && (
          <p role="alert" className="picker-message">
            {error}
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}
