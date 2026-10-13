"use client";

import { useEffect, useState } from "react";
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Clock3,
  ListTodo,
  NotebookPen,
} from "lucide-react";
import { api } from "@/lib/client";
import { journalPeriodEnd } from "@/lib/writing";
import type { JournalPeriod, NoteSummary, SearchResult } from "@/lib/types";
import { Button } from "./ui/button";

type Review = {
  period: JournalPeriod;
  periodStart: string;
  entry: NoteSummary | null;
  entries: NoteSummary[];
  tasks: {
    id: string;
    title: string;
    dueDate: string | null;
    plannedDate: string | null;
    completedAt: number | null;
  }[];
  events: {
    id: string;
    title: string;
    startDate: string;
    endDate: string;
    recurring?: boolean;
  }[];
};

type Props = {
  noteId: string;
  date: string;
  period: JournalPeriod;
  onOpenNote: (id: string) => Promise<boolean>;
  onOpenItem: (item: SearchResult) => Promise<boolean>;
  mobilePane: "writing" | "activity";
  onMobilePaneChange: (pane: "writing" | "activity") => void;
};

function periodLabel(period: JournalPeriod) {
  return period === "daily" ? "Day" : period === "weekly" ? "Week" : "Month";
}

function dateLabel(date: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${date}T12:00:00.000Z`));
}

function rangeLabel(start: string, period: JournalPeriod) {
  const endExclusive = journalPeriodEnd(start, period);
  const endDate = new Date(`${endExclusive}T12:00:00.000Z`);
  endDate.setUTCDate(endDate.getUTCDate() - 1);
  const end = endDate.toISOString().slice(0, 10);
  return start === end
    ? dateLabel(start)
    : `${dateLabel(start)} – ${dateLabel(end)}`;
}

function noteDateLabel(note: NoteSummary) {
  if (note.journalPeriodStart) {
    return note.journalPeriod && note.journalPeriod !== "daily"
      ? rangeLabel(note.journalPeriodStart, note.journalPeriod)
      : dateLabel(note.journalPeriodStart);
  }
  return note.dailyDate ? dateLabel(note.dailyDate) : "";
}

export function JournalReview({
  noteId,
  date,
  period,
  onOpenNote,
  onOpenItem,
  mobilePane,
  onMobilePaneChange,
}: Props) {
  const [loaded, setLoaded] = useState<{
    key: string;
    review: Review | null;
    onThisDay: NoteSummary[];
    error: string;
  } | null>(null);
  const [navigationMessage, setNavigationMessage] = useState("");
  const [navigationError, setNavigationError] = useState("");
  const [busyDirection, setBusyDirection] = useState<
    "previous" | "next" | null
  >(null);
  const requestKey = `${noteId}:${period}:${date}`;
  const current = loaded?.key === requestKey ? loaded : null;
  const review = current?.review ?? null;
  const onThisDay = current?.onThisDay ?? [];
  const error = current?.error ?? "";

  useEffect(() => {
    const controller = new AbortController();
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    void Promise.all([
      api<Review>(
        `journals/review?period=${period}&date=${encodeURIComponent(date)}&timezone=${encodeURIComponent(timezone)}`,
        { signal: controller.signal },
      ),
      api<{ items: NoteSummary[] }>(
        `journals/on-this-day?date=${encodeURIComponent(date)}`,
        { signal: controller.signal },
      ),
    ])
      .then(([nextReview, past]) => {
        if (controller.signal.aborted) return;
        setLoaded({
          key: requestKey,
          review: nextReview,
          onThisDay: past.items,
          error: "",
        });
      })
      .catch((cause) => {
        if (!controller.signal.aborted)
          setLoaded({
            key: requestKey,
            review: null,
            onThisDay: [],
            error: (cause as Error).message,
          });
      });
    return () => controller.abort();
  }, [date, period, noteId, requestKey]);

  async function navigate(direction: "previous" | "next") {
    if (busyDirection) return;
    setBusyDirection(direction);
    setNavigationError("");
    setNavigationMessage("");
    try {
      const result = await api<{ item: NoteSummary | null }>(
        `journals/${noteId}/navigate?direction=${direction}`,
      );
      if (result.item) await onOpenNote(result.item.id);
      else setNavigationMessage(`No ${direction} journal entry.`);
    } catch (cause) {
      setNavigationError((cause as Error).message);
    } finally {
      setBusyDirection(null);
    }
  }

  return (
    <>
      <div
        className="journal-review-switch"
        role="group"
        aria-label="Journal view"
      >
        <Button
          type="button"
          size="sm"
          variant={mobilePane === "writing" ? "secondary" : "ghost"}
          aria-pressed={mobilePane === "writing"}
          onClick={() => onMobilePaneChange("writing")}
        >
          Writing
        </Button>
        <Button
          type="button"
          size="sm"
          variant={mobilePane === "activity" ? "secondary" : "ghost"}
          aria-pressed={mobilePane === "activity"}
          onClick={() => onMobilePaneChange("activity")}
        >
          Activity
        </Button>
      </div>
      <aside className="journal-review" aria-labelledby="journal-review-title">
        <header className="journal-review-header">
          <div>
            <h2 id="journal-review-title">Journal review</h2>
            <p>
              {periodLabel(period)} · {dateLabel(date)}
            </p>
          </div>
          <div className="journal-review-navigation">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Open previous journal entry"
              disabled={busyDirection !== null}
              onClick={() => void navigate("previous")}
            >
              <ChevronLeft size={16} />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Open next journal entry"
              disabled={busyDirection !== null}
              onClick={() => void navigate("next")}
            >
              <ChevronRight size={16} />
            </Button>
          </div>
        </header>
        {navigationMessage && (
          <p className="journal-review-muted" role="status">
            {navigationMessage}
          </p>
        )}
        {navigationError && (
          <p className="journal-review-error" role="alert">
            {navigationError}
          </p>
        )}
        {error && (
          <p className="journal-review-error" role="alert">
            {error}
          </p>
        )}
        {!review && !error ? (
          <p className="journal-review-muted" role="status">
            Loading this period…
          </p>
        ) : review ? (
          <>
            <section className="journal-review-section">
              <h3>
                <NotebookPen size={14} />{" "}
                {rangeLabel(review.periodStart, review.period)}
              </h3>
              {review.entries.length ? (
                <ul>
                  {review.entries.map((entry) => (
                    <li key={entry.id}>
                      <button
                        type="button"
                        className="journal-review-row"
                        aria-current={entry.id === noteId ? "page" : undefined}
                        onClick={() => void onOpenNote(entry.id)}
                      >
                        <span>{entry.title || "Untitled entry"}</span>
                        <small>{noteDateLabel(entry)}</small>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="journal-review-muted">
                  No other entries in this period.
                </p>
              )}
            </section>
            <section className="journal-review-section">
              <h3>
                <ListTodo size={14} /> Tasks
              </h3>
              {review.tasks.length ? (
                <ul>
                  {review.tasks.map((task) => {
                    const dateForTask = task.plannedDate || task.dueDate;
                    return (
                      <li key={task.id}>
                        <button
                          type="button"
                          className="journal-review-row"
                          onClick={() =>
                            void onOpenItem({
                              id: task.id,
                              type: "task",
                              title: task.title,
                              excerpt: "",
                              updatedAt: task.completedAt || 0,
                              completed: task.completedAt !== null,
                            })
                          }
                        >
                          <span>{task.title}</span>
                          <small>
                            {task.completedAt
                              ? "Completed"
                              : dateForTask
                                ? dateLabel(dateForTask)
                                : "Open"}
                          </small>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="journal-review-muted">No planned tasks.</p>
              )}
            </section>
            <section className="journal-review-section">
              <h3>
                <CalendarDays size={14} /> Events
              </h3>
              {review.events.length ? (
                <ul>
                  {review.events.map((event) => (
                    <li key={event.id}>
                      <button
                        type="button"
                        className="journal-review-row"
                        onClick={() =>
                          void onOpenItem({
                            id: event.id,
                            type: "event",
                            title: event.title,
                            excerpt: "",
                            updatedAt: 0,
                          })
                        }
                      >
                        <span>{event.title}</span>
                        <small>
                          {dateLabel(event.startDate)}
                          {event.endDate !== event.startDate
                            ? ` – ${dateLabel(event.endDate)}`
                            : ""}
                        </small>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="journal-review-muted">No events this period.</p>
              )}
            </section>
          </>
        ) : null}
        {!error && (
          <section className="journal-review-section">
            <h3>
              <Clock3 size={14} /> On this day
            </h3>
            {!review ? (
              <p className="journal-review-muted" role="status">
                Checking past entries…
              </p>
            ) : onThisDay.length ? (
              <ul>
                {onThisDay.map((entry) => (
                  <li key={entry.id}>
                    <button
                      type="button"
                      className="journal-review-row"
                      onClick={() => void onOpenNote(entry.id)}
                    >
                      <span>{entry.title || "Untitled entry"}</span>
                      <small>{noteDateLabel(entry)}</small>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="journal-review-muted">
                No entries from this date in earlier years.
              </p>
            )}
          </section>
        )}
        {review?.entry && review.entry.id !== noteId && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="journal-review-open-current"
            onClick={() => void onOpenNote(review.entry!.id)}
          >
            <CalendarDays size={14} />
            Open this period’s entry
          </Button>
        )}
      </aside>
    </>
  );
}
