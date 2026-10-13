"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Temporal } from "@js-temporal/polyfill";
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Plus,
  Download,
} from "lucide-react";
import {
  addDays,
  eventPayload,
  localInstant,
  type CalendarEvent,
  type CalendarItem,
  type CalendarRange,
} from "@/lib/calendar";
import { localDate, validDate } from "@/lib/dates";
import { api, downloadRequest } from "@/lib/client";
import type { Task } from "@/lib/types";
import { useCompletion } from "@/lib/completion-client";
import { SectionHeading } from "./section-heading";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { DatePicker } from "./date-picker";
import { CalendarEventEditor, CalendarSelect } from "./calendar-event-editor";
import { useConfirm } from "./confirm-provider";
import { CalendarTimeGrid } from "./calendar-time-grid";
import { CalendarTaskDialog } from "./calendar-task-dialog";
import { TaskDetails } from "./task-details";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "./ui/dialog";

type TaskPage = {
  items: {
    id: string;
    title: string;
    revision: number;
    dueDate: string | null;
    plannedDate: string | null;
  }[];
  nextOffset: number | null;
};
type View = "month" | "week" | "day" | "year";
const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
function initialRoute() {
  const params =
    typeof window === "undefined"
      ? new URLSearchParams()
      : new URL(window.location.href).searchParams;
  return {
    date: validDate(params.get("date") ?? "")
      ? params.get("date")!
      : localDate(),
    view: (["month", "week", "day", "year"].includes(params.get("view") ?? "")
      ? params.get("view")
      : "month") as View,
    mode: params.get("mode") === "activity" ? "activity" : "planning",
  };
}
function monthDays(date: string) {
  const first = Temporal.PlainDate.from(date).with({ day: 1 });
  const start = first.subtract({ days: first.dayOfWeek % 7 });
  return Array.from({ length: 42 }, (_, i) =>
    start.add({ days: i }).toString(),
  );
}
function range(date: string, view: View) {
  const day = Temporal.PlainDate.from(date);
  if (view === "day") return [date, addDays(date, 1)];
  if (view === "week") {
    const start = day.subtract({ days: day.dayOfWeek % 7 }).toString();
    return [start, addDays(start, 7)];
  }
  if (view === "year") {
    const first = day.with({ month: 1, day: 1 });
    return [first.toString(), first.add({ years: 1 }).toString()];
  }
  const days = monthDays(date);
  return [days[0], addDays(days[41], 1)];
}
function dayLabel(
  date: string,
  options: Intl.DateTimeFormatOptions = {
    weekday: "long",
    month: "long",
    day: "numeric",
  },
) {
  return new Date(date + "T12:00").toLocaleDateString(undefined, options);
}
export function CalendarPanel({
  onNavigation,
  onOpenItem,
  registerGuard,
  onWriteJournal,
}: {
  onNavigation: () => void;
  onOpenItem: (item: CalendarItem) => void;
  onWriteJournal: (date: string) => Promise<void>;
  registerGuard?: (guard: () => Promise<boolean>) => (() => void) | void;
}) {
  const [route, setRoute] = useState(initialRoute),
    [data, setData] = useState<CalendarRange | null>(null),
    [agenda, setAgenda] = useState<CalendarRange | null>(null),
    [taskMode, setTaskMode] = useState<"unscheduled" | "overdue" | null>(null),
    [taskPage, setTaskPage] = useState<TaskPage | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [completed, setCompleted] = useState(false),
    [monthPreview, setMonthPreview] = useState(3),
    [editor, setEditor] = useState<{
      event: CalendarEvent | null;
      occurrence?: string;
      move?: { startAt: number; endAt: number };
    } | null>(() =>
      typeof window !== "undefined" &&
      new URL(window.location.href).searchParams.get("new") === "1"
        ? { event: null }
        : null,
    ),
    [taskDialog, setTaskDialog] = useState<{
      date: string;
      time: string;
      task?: Task;
    } | null>(null),
    [detailTask, setDetailTask] = useState<Task | null>(null),
    [busy, setBusy] = useState(false),
    [exportOpen, setExportOpen] = useState(false),
    [exportFrom, setExportFrom] = useState(""),
    [exportThrough, setExportThrough] = useState(""),
    [exportBusy, setExportBusy] = useState(false),
    [exportError, setExportError] = useState(""),
    [refresh, setRefresh] = useState(0);
  const monthGrid = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const grid = monthGrid.current;
    if (!grid) return;
    const observer = new ResizeObserver(([entry]) => {
      const cellHeight = entry.contentRect.height / 6;
      setMonthPreview(
        Math.max(0, Math.min(3, Math.floor((cellHeight - 58) / 24))),
      );
    });
    observer.observe(grid);
    return () => observer.disconnect();
  }, [route.view, loading]);
  const zone = useMemo(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone,
    [],
  );
  const [from, to] = range(route.date, route.view);
  const confirm = useConfirm(),
    dirty = useRef(false),
    cache = useRef(new Map<string, CalendarRange>()),
    taskPageMode = useRef<string | null>(null);
  const setDirty = useCallback((value: boolean) => {
    dirty.current = value;
  }, []);
  const allowed = useCallback(
    async () =>
      !dirty.current ||
      (await confirm({
        title: "Discard calendar changes?",
        description: "Your unsaved changes will be lost.",
        action: "Discard changes",
      })),
    [confirm],
  );
  useEffect(() => registerGuard?.(allowed), [registerGuard, allowed]);
  const navigate = useCallback(
    (next: Partial<typeof route>, replace = false) => {
      const value = { ...route, ...next };
      setRoute(value);
      setTaskMode(null);
      const url = new URL(window.location.href);
      if (url.pathname.replace(/\/$/, "") !== "/calendar") return;
      url.searchParams.set("date", value.date);
      url.searchParams.set("view", value.view);
      url.searchParams.set("mode", value.mode);
      window.history[replace ? "replaceState" : "pushState"](null, "", url);
      window.dispatchEvent(new Event("nivra:route-updated"));
    },
    [route],
  );
  useEffect(() => {
    const abort = new AbortController(),
      key = [from, to, zone, route.mode, completed, route.view].join(":");
    const cached = cache.current.get(key);
    const timer = setTimeout(() => {
      if (cached) setData(cached);
      setLoading(!cached);
      setError("");
      void api<CalendarRange>(
        `calendar/range?${new URLSearchParams({ from, to, timezone: zone, mode: route.mode, limit: route.view === "year" ? "1" : "500", preview: route.view === "year" ? "0" : route.view === "month" ? "3" : "50", includeCompleted: completed ? "1" : "0" })}`,
        { signal: abort.signal },
      )
        .then((value) => {
          cache.current.set(key, value);
          if (cache.current.size > 8)
            cache.current.delete(cache.current.keys().next().value!);
          setData(value);
          setLoading(false);
        })
        .catch((e) => {
          if (!abort.signal.aborted) {
            setError((e as Error).message);
            setLoading(false);
          }
        });
    }, 0);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [from, to, zone, route.mode, refresh, completed, route.view]);
  useEffect(() => {
    const abort = new AbortController();
    void api<CalendarRange>(
      `calendar/range?${new URLSearchParams({ from: route.date, to: addDays(route.date, 1), timezone: zone, mode: route.mode, limit: "50", includeCompleted: completed ? "1" : "0" })}`,
      { signal: abort.signal },
    )
      .then(setAgenda)
      .catch((e) => {
        if (!abort.signal.aborted) setError((e as Error).message);
      });
    return () => abort.abort();
  }, [route.date, route.mode, zone, refresh, completed]);
  useEffect(() => {
    if (!taskMode) return;
    const abort = new AbortController();
    const timer = setTimeout(() => {
      if (taskPageMode.current !== taskMode) {
        taskPageMode.current = taskMode;
        setTaskPage(null);
      }
      void api<TaskPage>(
        `calendar/tasks?mode=${taskMode}&date=${localDate()}`,
        { signal: abort.signal },
      )
        .then(setTaskPage)
        .catch((e) => {
          if (!abort.signal.aborted) setError((e as Error).message);
        });
    }, 0);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [taskMode, refresh]);
  useCompletion(undefined, (change) => {
    setRefresh((value) => value + 1);
    const id = editor?.event?.id;
    if (!id || dirty.current || (change.target && change.target !== id)) return;
    void api<CalendarEvent>(`events/${encodeURIComponent(id)}`)
      .then((event) => {
        if (dirty.current) return;
        setEditor((current) =>
          current?.event?.id === id && event.revision > current.event.revision
            ? { ...current, event }
            : current,
        );
      })
      .catch(() => {});
  });
  useEffect(() => {
    const params = new URL(window.location.href).searchParams;
    const id = params.get("event");
    if (!id) return;
    const abort = new AbortController();
    void api<CalendarEvent>(`events/${encodeURIComponent(id)}`, {
      signal: abort.signal,
    })
      .then((event) =>
        setEditor({ event, occurrence: params.get("occurrence") ?? undefined }),
      )
      .catch((e) => {
        if (!abort.signal.aborted) setError((e as Error).message);
      });
    return () => abort.abort();
  }, []);
  const closeEditor = () => {
    dirty.current = false;
    setEditor(null);
    const url = new URL(window.location.href);
    url.searchParams.delete("event");
    url.searchParams.delete("occurrence");
    for (const key of ["new", "link", "linkType", "linkTitle"])
      url.searchParams.delete(key);
    window.history.replaceState(null, "", url);
    window.dispatchEvent(new Event("nivra:route-updated"));
  };
  async function open(item: CalendarItem) {
    if (item.type === "task") {
      setBusy(true);
      setError("");
      try {
        setDetailTask(
          await api<Task>("tasks/" + encodeURIComponent(item.sourceId)),
        );
      } catch (cause) {
        setError((cause as Error).message);
      } finally {
        setBusy(false);
      }
      return;
    }
    if (item.type !== "event") {
      onOpenItem(item);
      return;
    }
    setBusy(true);
    setError("");
    try {
      const event = await api<CalendarEvent>(`events/${item.sourceId}`);
      setEditor({ event, occurrence: item.occurrence });
      const url = new URL(window.location.href);
      url.searchParams.set("event", event.id);
      if (item.occurrence) url.searchParams.set("occurrence", item.occurrence);
      window.history.pushState(null, "", url);
      window.dispatchEvent(new Event("nivra:route-updated"));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function scheduleTask(item: CalendarItem) {
    setBusy(true);
    setError("");
    try {
      const task = await api<Task>(
        "tasks/" + encodeURIComponent(item.sourceId),
      );
      const start = task.schedule?.start;
      setTaskDialog({
        task,
        date: start?.slice(0, 10) ?? item.date,
        time: start?.slice(11, 16) ?? "09:00",
      });
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function moveItem(
    item: CalendarItem,
    startAt: number,
    endAt: number,
    kind: "move" | "resize",
  ) {
    setError("");
    if (item.type === "task") {
      setBusy(true);
      try {
        const task = await api<Task>(
          "tasks/" + encodeURIComponent(item.sourceId),
        );
        if (task.revision !== item.revision)
          throw new Error(
            "This task changed elsewhere. Refresh the calendar before moving it.",
          );
        const timezone = task.schedule?.timezone ?? zone;
        const start = localInstant(startAt, timezone);
        const schedule = {
          start,
          timezone,
          durationMinutes:
            kind === "resize"
              ? Math.max(5, Math.round((endAt - startAt) / 60_000))
              : (task.schedule?.durationMinutes ??
                Math.max(5, Math.round((endAt - startAt) / 60_000))),
          disambiguation: task.schedule?.disambiguation ?? "reject",
        } as const;
        await api<Task>("tasks/" + encodeURIComponent(task.id), {
          method: "PATCH",
          body: JSON.stringify({
            revision: task.revision,
            plannedDate: start.slice(0, 10),
            schedule,
          }),
        });
        setRefresh((value) => value + 1);
      } catch (cause) {
        setError((cause as Error).message);
      } finally {
        setBusy(false);
      }
      return;
    }
    if (item.type !== "event") return;
    setBusy(true);
    try {
      const event = await api<CalendarEvent>(
        "events/" + encodeURIComponent(item.sourceId),
      );
      if (event.revision !== item.revision)
        throw new Error(
          "This event changed elsewhere. Refresh the calendar before moving it.",
        );
      if (event.recurrence) {
        setEditor({
          event,
          occurrence: item.occurrence,
          move: { startAt, endAt },
        });
        const url = new URL(window.location.href);
        url.searchParams.set("event", event.id);
        if (item.occurrence)
          url.searchParams.set("occurrence", item.occurrence);
        window.history.pushState(null, "", url);
        window.dispatchEvent(new Event("nivra:route-updated"));
        return;
      }
      const input = {
        ...eventPayload(event),
        allDay: false,
        start: localInstant(startAt, event.timezone),
        end: localInstant(endAt, event.timezone),
        timezone: event.timezone,
      };
      await api("events/" + encodeURIComponent(event.id), {
        method: "PATCH",
        body: JSON.stringify({
          input,
          revision: event.revision,
          scope: "series",
        }),
      });
      setRefresh((value) => value + 1);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function openCalendarExport() {
    setExportFrom(from);
    setExportThrough(addDays(to, -1));
    setExportError("");
    setExportOpen(true);
  }
  async function exportCalendar() {
    setExportError("");
    if (!validDate(exportFrom) || !validDate(exportThrough)) {
      setExportError("Choose a valid start and end date.");
      return;
    }
    const toExclusive = addDays(exportThrough, 1);
    const dayCount = Temporal.PlainDate.from(exportFrom).until(
      Temporal.PlainDate.from(toExclusive),
    ).days;
    if (dayCount < 1) {
      setExportError("The end date must be on or after the start date.");
      return;
    }
    if (dayCount > 366) {
      setExportError("Choose a range of 366 days or less.");
      return;
    }
    setExportBusy(true);
    try {
      const query = new URLSearchParams({
        from: exportFrom,
        to: toExclusive,
        timezone: zone,
      });
      await downloadRequest(
        `calendar/export?${query}`,
        `nivra-calendar-${exportFrom}-through-${exportThrough}.ics`,
      );
      setExportOpen(false);
    } catch (cause) {
      setExportError((cause as Error).message);
    } finally {
      setExportBusy(false);
    }
  }
  function shift(direction: number) {
    const day = Temporal.PlainDate.from(route.date);
    navigate({
      date: day
        .add(
          route.view === "year"
            ? { years: direction }
            : route.view === "month"
              ? { months: direction }
              : { days: direction * (route.view === "week" ? 7 : 1) },
        )
        .toString(),
    });
  }
  const visible = (item: CalendarItem) => completed || !item.completed;
  const itemsOn = (date: string, items = data?.items ?? []) =>
    items.filter(
      (item) =>
        visible(item) &&
        item.date <= date &&
        (item.endDate
          ? item.endDate > date ||
            (item.endDate === date &&
              !!item.endAt &&
              new Date(item.endAt).getHours() !== 0)
          : item.date === date),
    );
  const entryButton = (item: CalendarItem) => (
    <Button
      key={item.id}
      variant="ghost"
      className="schedule-agenda-entry"
      onClick={() => void open(item)}
      disabled={busy}
    >
      <span
        className={`schedule-entry-time ${item.id.startsWith("form-responses:") ? "schedule-entry-count" : ""}`}
      >
        {item.startAt && item.label === "Event"
          ? new Date(item.startAt).toLocaleTimeString(undefined, {
              hour: "2-digit",
              minute: "2-digit",
            })
          : item.type === "event"
            ? "All day"
            : item.label}
      </span>
      <span>
        <strong>{item.title}</strong>
        <small>
          {item.type === "event"
            ? "Event"
            : item.id.startsWith("form-responses:")
              ? "Form"
              : item.label}
          {item.completed ? " · Completed" : ""}
        </small>
      </span>
    </Button>
  );
  const entry = (item: CalendarItem) =>
    item.type === "task" && route.mode === "planning" ? (
      <div key={item.id} className="planning-agenda-task">
        {entryButton(item)}
        <Button
          variant="outline"
          className="planning-agenda-schedule"
          disabled={busy}
          onClick={() => void scheduleTask(item)}
        >
          <CalendarDays size={15} />
          {item.startAt ? "Move time" : "Schedule"}
        </Button>
      </div>
    ) : (
      entryButton(item)
    );
  const days =
    route.view === "month"
      ? monthDays(route.date)
      : Array.from({ length: route.view === "week" ? 7 : 1 }, (_, i) =>
          addDays(from, i),
        );
  return (
    <section className="schedule-panel" data-view={route.view}>
      <div className="schedule-scroll">
        <SectionHeading
          title="Calendar"
          description="Your plans, deadlines and daily entries."
          onNavigation={onNavigation}
        />
        <div className="schedule-toolbar">
          <div className="schedule-period">
            <Button
              variant="ghost"
              size="icon"
              aria-label="Previous period"
              onClick={() => shift(-1)}
            >
              <ChevronLeft size={18} />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Next period"
              onClick={() => shift(1)}
            >
              <ChevronRight size={18} />
            </Button>
            <h2>
              {dayLabel(
                route.date,
                route.view === "year"
                  ? { year: "numeric" }
                  : route.view === "day"
                    ? { month: "long", day: "numeric", year: "numeric" }
                    : { month: "long", year: "numeric" },
              )}
            </h2>
          </div>
          <div className="schedule-actions">
            <Button
              variant="outline"
              onClick={() => navigate({ date: localDate() })}
            >
              Today
            </Button>
            <DatePicker
              label="Go to date"
              value={route.date}
              onChange={(date) => date && navigate({ date })}
            />
            <CalendarSelect
              label="Calendar view"
              value={route.view}
              onChange={(view) => navigate({ view: view as View })}
              options={[
                ["month", "Month"],
                ["week", "Week"],
                ["day", "Day"],
                ["year", "Year"],
              ]}
            />
            <Button onClick={() => setEditor({ event: null })}>
              <Plus size={16} />
              New event
            </Button>
            {route.mode === "planning" && (
              <Button
                variant="outline"
                onClick={() =>
                  setTaskDialog({ date: route.date, time: "09:00" })
                }
              >
                <CalendarDays size={16} />
                New task
              </Button>
            )}
            <Button variant="outline" onClick={openCalendarExport}>
              <Download size={16} />
              Export
            </Button>
          </div>
        </div>
        <div className="schedule-filters">
          <CalendarSelect
            label="Calendar content"
            value={route.mode}
            onChange={(mode) => navigate({ mode })}
            options={[
              ["planning", "Planning"],
              ["activity", "Activity"],
            ]}
          />
          <label className="check-row">
            <Checkbox
              checked={completed}
              onCheckedChange={(value) => setCompleted(value === true)}
            />
            Show completed
          </label>
          {loading && data && (
            <span role="status">
              <Loader2 size={14} className="animate-spin" />
              Updating
            </span>
          )}
        </div>
        {error && (
          <div className="schedule-error" role="alert">
            <p>{error}</p>
            <Button
              variant="outline"
              onClick={() => setRefresh((value) => value + 1)}
            >
              Retry
            </Button>
          </div>
        )}
        {loading && !data ? (
          <div
            className={`schedule-skeleton schedule-skeleton-${route.view}`}
            role="status"
            aria-label="Loading calendar"
          >
            {Array.from(
              {
                length:
                  route.view === "year"
                    ? 12
                    : route.view === "week"
                      ? 7
                      : route.view === "day"
                        ? 1
                        : 42,
              },
              (_, i) => (
                <div key={i} />
              ),
            )}
          </div>
        ) : route.view === "year" ? (
          <div className="schedule-year">
            {Array.from({ length: 12 }, (_, i) => {
              const month = Temporal.PlainDate.from(route.date)
                .with({ month: i + 1, day: 1 })
                .toString();
              return (
                <section key={month}>
                  <Button
                    variant="ghost"
                    className="schedule-month-heading"
                    onClick={() => navigate({ date: month, view: "month" })}
                  >
                    {dayLabel(month, { month: "long" })}
                  </Button>
                  <div className="schedule-mini-grid">
                    {weekdays.map((day) => (
                      <span key={day}>{day[0]}</span>
                    ))}
                    {monthDays(month).map((day) => (
                      <Button
                        key={day}
                        variant="ghost"
                        data-outside={day.slice(0, 7) !== month.slice(0, 7)}
                        data-today={day === localDate()}
                        aria-label={`${dayLabel(day)}, ${data?.counts[day] ?? 0} items`}
                        onClick={() => navigate({ date: day, view: "day" })}
                      >
                        <span>{Number(day.slice(-2))}</span>
                        {!!data?.counts[day] && <i aria-hidden="true" />}
                      </Button>
                    ))}
                  </div>
                </section>
              );
            })}
          </div>
        ) : (
          <div
            className={`schedule-layout schedule-${route.view === "month" ? "month-layout" : route.view}`}
          >
            {route.view === "month" && (
              <div className="schedule-month">
                <div className="schedule-week-heading">
                  {weekdays.map((day) => (
                    <span key={day}>{day}</span>
                  ))}
                </div>
                <div
                  className="schedule-month-grid"
                  ref={monthGrid}
                  role="grid"
                  aria-label="Month"
                >
                  {Array.from({ length: days.length / 7 }, (_, week) => (
                    <div
                      className="schedule-week-row"
                      role="row"
                      key={days[week * 7]}
                    >
                      {days.slice(week * 7, week * 7 + 7).map((day) => {
                        const entries = itemsOn(day),
                          count = data?.counts[day] ?? 0;
                        return (
                          <div
                            role="gridcell"
                            aria-selected={day === route.date}
                            key={day}
                            className="schedule-day-cell"
                            data-outside={
                              day.slice(0, 7) !== route.date.slice(0, 7)
                            }
                            data-selected={day === route.date}
                            onClick={(event) => {
                              if (
                                !(event.target as HTMLElement).closest("button")
                              )
                                navigate({ date: day });
                            }}
                          >
                            <Button
                              className="schedule-day-number"
                              variant="ghost"
                              data-today={day === localDate()}
                              aria-label={`${dayLabel(day)}${count ? `, ${count} items` : ""}`}
                              aria-pressed={day === route.date}
                              tabIndex={day === route.date ? 0 : -1}
                              onClick={() => navigate({ date: day })}
                              onKeyDown={(event) => {
                                const delta = (
                                  {
                                    ArrowLeft: -1,
                                    ArrowRight: 1,
                                    ArrowUp: -7,
                                    ArrowDown: 7,
                                  } as Record<string, number>
                                )[event.key];
                                if (delta) {
                                  event.preventDefault();
                                  navigate({ date: addDays(day, delta) });
                                  requestAnimationFrame(() =>
                                    document
                                      .querySelector<HTMLButtonElement>(
                                        `.schedule-day-number[aria-pressed="true"]`,
                                      )
                                      ?.focus(),
                                  );
                                }
                              }}
                            >
                              {Number(day.slice(-2))}
                            </Button>
                            <div
                              className="schedule-cell-events"
                              data-compact={monthPreview === 0}
                            >
                              {entries.slice(0, monthPreview).map((item) => (
                                <Button
                                  key={item.id}
                                  variant="ghost"
                                  className="schedule-cell-event"
                                  onClick={() => void open(item)}
                                >
                                  {item.title}
                                </Button>
                              ))}
                              {monthPreview === 0 && count > 0 ? (
                                <span
                                  className="schedule-more-count"
                                  aria-hidden="true"
                                >
                                  {count}
                                </span>
                              ) : (
                                count >
                                  Math.min(monthPreview, entries.length) && (
                                  <Button
                                    variant="ghost"
                                    className="schedule-more"
                                    aria-label={`${count - Math.min(monthPreview, entries.length)} more items on ${dayLabel(day)}`}
                                    onClick={() => navigate({ date: day })}
                                  >
                                    {`+${count - Math.min(monthPreview, entries.length)}`}
                                  </Button>
                                )
                              )}
                            </div>
                            <span
                              className="schedule-mobile-count"
                              aria-hidden="true"
                            >
                              {count || ""}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  ))}
                </div>
              </div>
            )}
            {["week", "day"].includes(route.view) &&
              route.mode === "planning" && (
                <CalendarTimeGrid
                  days={days}
                  items={(data?.items ?? []).filter(visible)}
                  timezone={zone}
                  onOpen={(item) => void open(item)}
                  onEmptySlot={(date, time) => setTaskDialog({ date, time })}
                  onMove={(item, startAt, endAt, kind) =>
                    void moveItem(item, startAt, endAt, kind)
                  }
                />
              )}
            <section
              className={`schedule-agenda ${["week", "day"].includes(route.view) && route.mode === "planning" ? "schedule-mobile-agenda" : ""}`}
              aria-label="Calendar agenda"
            >
              <h2>
                {taskMode === "unscheduled"
                  ? "Unscheduled tasks"
                  : taskMode === "overdue"
                    ? "Overdue tasks"
                    : route.view === "week"
                      ? "This week"
                      : dayLabel(route.date)}
              </h2>
              {taskMode && (
                <Button variant="ghost" onClick={() => setTaskMode(null)}>
                  Back to selected day
                </Button>
              )}
              {taskMode && !taskPage && <p role="status">Loading tasks…</p>}
              {(route.view === "week" ? days : [route.date]).map((day) => {
                const entries = taskMode
                  ? (taskPage?.items ?? []).map((task) => ({
                      id: task.id,
                      sourceId: task.id,
                      type: "task" as const,
                      title: task.title,
                      date: task.dueDate ?? day,
                      label: taskMode === "unscheduled" ? "Undated" : "Overdue",
                      revision: task.revision,
                    }))
                  : itemsOn(
                      day,
                      route.view === "week" ? data?.items : agenda?.items,
                    );
                return (
                  <div key={day} className="schedule-agenda-day">
                    {route.view === "week" && (
                      <h3>
                        {dayLabel(day, {
                          weekday: "long",
                          month: "short",
                          day: "numeric",
                        })}
                      </h3>
                    )}
                    {entries.map(entry)}
                    {!entries.length && !taskMode && (
                      <div className="schedule-day-empty">
                        <CalendarDays size={24} />
                        <p>
                          No {route.mode === "activity" ? "activity" : "plans"}{" "}
                          for this day.
                        </p>
                        {!taskMode && route.mode === "planning" && (
                          <Button
                            variant="outline"
                            onClick={() => {
                              navigate({ date: day });
                              setEditor({ event: null });
                            }}
                          >
                            Add event
                          </Button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
              {route.mode === "planning" &&
                route.view !== "week" &&
                !agenda?.items.some((item) => item.type === "journal") && (
                  <Button
                    variant="ghost"
                    disabled={busy}
                    onClick={() => {
                      setBusy(true);
                      void onWriteJournal(route.date)
                        .catch((e) => setError((e as Error).message))
                        .finally(() => setBusy(false));
                    }}
                  >
                    Write journal
                  </Button>
                )}
              {!taskMode &&
                agenda?.nextOffset !== null &&
                agenda?.nextOffset !== undefined &&
                route.view !== "week" && (
                  <Button
                    variant="outline"
                    onClick={() => {
                      void api<CalendarRange>(
                        `calendar/range?${new URLSearchParams({
                          from: route.date,
                          to: addDays(route.date, 1),
                          timezone: zone,
                          mode: route.mode,
                          limit: "50",
                          includeCompleted: completed ? "1" : "0",
                          offset: String(agenda.nextOffset),
                        })}`,
                      )
                        .then((value) =>
                          setAgenda((current) =>
                            current
                              ? {
                                  ...value,
                                  items: [...current.items, ...value.items],
                                }
                              : value,
                          ),
                        )
                        .catch((e) => setError((e as Error).message));
                    }}
                  >
                    Load more
                  </Button>
                )}
              {taskMode &&
                taskPage?.nextOffset !== null &&
                taskPage?.nextOffset !== undefined && (
                  <Button
                    variant="outline"
                    onClick={() => {
                      void api<TaskPage>(
                        `calendar/tasks?mode=${taskMode}&date=${localDate()}&offset=${taskPage.nextOffset}`,
                      )
                        .then((value) =>
                          setTaskPage((current) =>
                            current
                              ? {
                                  ...value,
                                  items: [...current.items, ...value.items],
                                }
                              : value,
                          ),
                        )
                        .catch((e) => setError((e as Error).message));
                    }}
                  >
                    Load more tasks
                  </Button>
                )}
            </section>
          </div>
        )}
        {data && route.mode === "planning" && (
          <footer className="schedule-summary">
            <Button
              variant="ghost"
              onClick={() => {
                navigate({ view: "month" });
                setTaskMode("unscheduled");
              }}
            >
              {data.unscheduled} unscheduled tasks
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                navigate({ view: "month" });
                setTaskMode("overdue");
              }}
            >
              {data.overdue} overdue tasks
            </Button>
          </footer>
        )}
      </div>
      {editor && (
        <CalendarEventEditor
          key={
            editor.event ? `${editor.event.id}:${editor.event.revision}` : "new"
          }
          event={editor.event}
          occurrence={editor.occurrence}
          move={editor.move}
          date={route.date}
          zone={zone}
          onDirty={setDirty}
          onClose={closeEditor}
          onSaved={() => {
            closeEditor();
            setRefresh((value) => value + 1);
          }}
        />
      )}
      {taskDialog && (
        <CalendarTaskDialog
          date={taskDialog.date}
          time={taskDialog.time}
          timezone={taskDialog.task?.schedule?.timezone ?? zone}
          task={taskDialog.task}
          onDirty={setDirty}
          onClose={() => setTaskDialog(null)}
          onSaved={() => {
            setTaskDialog(null);
            setRefresh((value) => value + 1);
          }}
        />
      )}
      {detailTask && (
        <TaskDetails
          key={detailTask.id}
          task={detailTask}
          onClose={() => setDetailTask(null)}
          onDirty={setDirty}
          onSaved={(task) => {
            setDetailTask(task);
            setRefresh((value) => value + 1);
          }}
          onOpenNote={async (id) => {
            setDetailTask(null);
            onOpenItem({
              id,
              sourceId: id,
              type: "note",
              title: "Linked note",
              date: route.date,
              label: "Note",
              revision: 1,
            });
            return true;
          }}
        />
      )}
      <Dialog
        open={exportOpen}
        onOpenChange={(open) => {
          if (!exportBusy) setExportOpen(open);
        }}
      >
        <DialogContent className="planning-export-dialog">
          <DialogTitle>Export calendar</DialogTitle>
          <DialogDescription>
            Download an iCalendar snapshot. Reminders are not included.
          </DialogDescription>
          <div className="planning-export-dates">
            <DatePicker
              label="From"
              value={exportFrom}
              disabled={exportBusy}
              onChange={(value) => value && setExportFrom(value)}
            />
            <DatePicker
              label="Through"
              value={exportThrough}
              disabled={exportBusy}
              onChange={(value) => value && setExportThrough(value)}
            />
          </div>
          {exportError && (
            <p className="planning-field-error" role="alert">
              {exportError}
            </p>
          )}
          <div className="planning-export-actions">
            <Button
              type="button"
              variant="outline"
              disabled={exportBusy}
              onClick={() => setExportOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              disabled={exportBusy}
              onClick={() => void exportCalendar()}
            >
              {exportBusy ? "Preparing…" : "Download snapshot"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}
