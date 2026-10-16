"use client";
import { LoadingState } from "./loading-state";
import { useCompletion } from "@/lib/completion-client";
import type { ReactNode } from "react";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  Bookmark,
  CalendarDays,
  ClipboardCheck,
  ExternalLink,
  FileText,
  Layers,
  ListTodo,
  Loader2,
  Plus,
  Repeat2,
  Tag,
} from "lucide-react";
import { api } from "@/lib/client";
import { formatDate, formatTime, localDate } from "@/lib/dates";
import type { Overview } from "@/lib/types";
import { notify } from "@/lib/feedback";
import { Button } from "./ui/button";
import { SectionHeading } from "./section-heading";
import { NotificationSetup } from "./notification-setup";
import { Checkbox } from "./ui/checkbox";
import { sectionCache } from "@/lib/section-cache";

const snapshotKey = "overview:snapshot";
const browserTimezone = () =>
  Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
const freshSnapshot = () => {
  const cached = sectionCache.get<{
    date: string;
    timezone: string;
    data: Overview;
  }>(snapshotKey);
  return cached?.date === localDate() && cached.timezone === browserTimezone()
    ? cached.data
    : null;
};
type OverviewDestination =
  | "all"
  | "tasks"
  | "bookmarks"
  | "calendar"
  | "artifacts"
  | "forms"
  | "tag-suggestions";
type OverviewSection = {
  id: string;
  visible: boolean;
  density: "compact" | "fill";
  content: ReactNode;
};
type OverviewColumn = {
  id: string;
  density: "compact" | "fill";
  sections: OverviewSection[];
};
function packOverviewSections(sections: OverviewSection[]): OverviewColumn[] {
  const columns: OverviewColumn[] = [];
  for (const section of sections) {
    if (!section.visible) continue;
    const previous = columns.at(-1);
    if (section.density === "compact" && previous?.density === "compact") {
      previous.sections.push(section);
    } else {
      columns.push({
        id: `${section.density}-${section.id}`,
        density: section.density,
        sections: [section],
      });
    }
  }
  return columns;
}
export function OverviewPanel({
  onNavigation,
  onOpenNote,
  onNavigate,
  onCreate,
}: {
  onNavigation: () => void;
  onOpenNote: (id: string) => Promise<boolean>;
  onNavigate: (
    destination: OverviewDestination,
    options?: {
      query?: string;
      date?: string;
      openId?: string;
      occurrence?: string;
      formId?: string;
    },
  ) => void;
  onCreate: (kind: "note" | "task" | "bookmark" | "daily") => void;
}) {
  const [data, setData] = useState<Overview | null>(freshSnapshot);
  const [now, setNow] = useState<Date | null>(null);
  const [loading, setLoading] = useState(() => !freshSnapshot());
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  const completionRefresh = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refresh = useCallback(async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    try {
      const date = localDate();
      const timezone = browserTimezone();
      const query = new URLSearchParams({ date, timezone });
      const snapshot = await api<Overview>(`overview?${query}`, {
        signal: controller.signal,
      });
      if (!controller.signal.aborted) {
        sectionCache.set(snapshotKey, { date, timezone, data: snapshot });
        setData(snapshot);
        setError("");
      }
    } catch (e) {
      if (!controller.signal.aborted) setError((e as Error).message);
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, []);
  const scheduleRefresh = useCallback(() => {
    if (completionRefresh.current) clearTimeout(completionRefresh.current);
    completionRefresh.current = setTimeout(() => {
      completionRefresh.current = null;
      void refresh();
    }, 150);
  }, [refresh]);
  useCompletion(undefined, scheduleRefresh);
  useEffect(() => {
    const changed = () => scheduleRefresh();
    window.addEventListener("nivra:ai-completion", changed);
    return () => {
      window.removeEventListener("nivra:ai-completion", changed);
      if (completionRefresh.current) clearTimeout(completionRefresh.current);
    };
  }, [scheduleRefresh]);
  useEffect(() => {
    const captured = () => scheduleRefresh();
    window.addEventListener("nivra:captured", captured);
    return () => window.removeEventListener("nivra:captured", captured);
  }, [scheduleRefresh]);
  useEffect(() => {
    let clock: ReturnType<typeof setTimeout>;
    let date = localDate();
    const tick = () => {
      setNow(new Date());
      const current = localDate();
      if (current !== date) {
        date = current;
        void refresh();
      }
      clock = setTimeout(tick, 60000 - (Date.now() % 60000));
    };
    const resume = () => {
      clearTimeout(clock);
      if (document.visibilityState === "hidden") {
        request.current?.abort();
        return;
      }
      tick();
      void refresh();
    };
    const start = setTimeout(resume, 0);
    document.addEventListener("visibilitychange", resume);
    return () => {
      clearTimeout(start);
      clearTimeout(clock);
      request.current?.abort();
      document.removeEventListener("visibilitychange", resume);
    };
  }, [refresh]);
  async function complete(task: Overview["tasks"][number]) {
    setBusy(task.id);
    try {
      await api(`tasks/${task.id}`, {
        method: "PATCH",
        body: JSON.stringify({ revision: task.revision, completed: true }),
      });
      sectionCache.clear("tasks:");
      await refresh();
      notify.success(
        task.recurrence
          ? "Task completed. Next occurrence created."
          : "Task completed.",
      );
    } catch (e) {
      notify.error((e as Error).message);
      await refresh();
    } finally {
      setBusy(null);
    }
  }
  const today = now ? localDate(now) : "";
  const recentItems =
    data?.recentContent ??
    data?.recentItems.filter((item) => item.type !== "bookmark") ??
    [];
  const recentBookmarks = data?.bookmarks.slice(0, 5) ?? [];
  const recentResponses = data?.recentResponses ?? [];
  const hasReview =
    (data?.review?.formResponses ?? 0) > 0 ||
    (data?.review?.tagSuggestions ?? 0) > 0;
  const overviewSections: OverviewSection[] = data
    ? [
        {
          id: "tasks",
          visible: data.counts.open > 0,
          density: "compact",
          content: (
            <section
              className="overview-widget overview-tasks"
              aria-labelledby="overview-tasks-title"
            >
              <header>
                <h2 id="overview-tasks-title">Open tasks</h2>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onNavigate("tasks")}
                  aria-label="View all tasks"
                >
                  View all
                  <ArrowRight size={14} />
                </Button>
              </header>
              <p className="overview-task-summary">
                {data.counts.open} open
                {data.counts.overdue > 0
                  ? ` · ${data.counts.overdue} overdue`
                  : ""}
                {" · "}
                {data.counts.today} due today
              </p>
              {data.tasks.length ? (
                <ul aria-label="Open tasks">
                  {data.tasks.slice(0, 5).map((task) => (
                    <li key={task.id} className="overview-task-row">
                      <div className="overview-check">
                        <Checkbox
                          checked={false}
                          disabled={!!busy}
                          aria-label={`Complete ${task.title}`}
                          onCheckedChange={() => void complete(task)}
                        />
                        {busy === task.id && (
                          <Loader2
                            size={12}
                            className="animate-spin"
                            aria-label="Completing task"
                          />
                        )}
                      </div>
                      <button
                        className="overview-task-link"
                        onClick={() =>
                          onNavigate("tasks", { query: task.title })
                        }
                      >
                        <strong>{task.title}</strong>
                        <span>
                          {task.dueDate
                            ? task.dueDate < today
                              ? `Overdue · ${formatDate(task.dueDate)}`
                              : task.dueDate === today
                                ? "Due today"
                                : formatDate(task.dueDate)
                            : "No due date"}
                          {task.recurrence && (
                            <>
                              <Repeat2 size={12} />
                              {task.recurrence}
                            </>
                          )}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="overview-empty">
                  Nothing left open. Make room for your next task.
                </p>
              )}
              {data.counts.open > 5 && (
                <p className="overview-more">
                  Showing {Math.min(5, data.tasks.length)} of {data.counts.open}{" "}
                  open tasks, newest first.
                </p>
              )}
            </section>
          ),
        },
        {
          id: "calendar",
          visible: data.calendar.length > 0,
          density: "compact",
          content: (
            <section
              className="overview-widget overview-calendar"
              aria-labelledby="overview-calendar-title"
            >
              <header>
                <h2 id="overview-calendar-title">Upcoming calendar</h2>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onNavigate("calendar")}
                  aria-label="Open Calendar"
                >
                  Calendar
                  <ArrowRight size={14} />
                </Button>
              </header>
              {data.calendar.length ? (
                <ul aria-label="Upcoming calendar events">
                  {data.calendar.map((event) => (
                    <li key={event.id}>
                      <button
                        className="overview-note-link"
                        onClick={() =>
                          onNavigate("calendar", {
                            date: event.date,
                            openId: event.sourceId,
                            occurrence: event.occurrence,
                          })
                        }
                      >
                        <CalendarDays size={16} />
                        <span>
                          <strong>{event.title}</strong>
                          <small>
                            {formatDate(event.date)}
                            {event.startAt !== undefined &&
                              ` · ${formatTime(event.startAt)}`}
                            {event.startAt === undefined &&
                              event.label !== "Event" &&
                              ` · ${event.label}`}
                          </small>
                        </span>
                        <ArrowRight size={14} />
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="overview-calendar-empty">
                  Nothing scheduled in the next week.
                </p>
              )}
            </section>
          ),
        },
        {
          id: "recent",
          visible: recentItems.length > 0,
          density: "fill",
          content: (
            <section
              className="overview-widget overview-recent"
              aria-labelledby="overview-recent-title"
            >
              <header>
                <h2 id="overview-recent-title">Recent notes and files</h2>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onNavigate("all")}
                  aria-label="View all notes"
                >
                  Notes
                  <ArrowRight size={14} />
                </Button>
              </header>
              {recentItems.length ? (
                <ul aria-label="Recent notes and files">
                  {recentItems.map((item) => (
                    <li key={`${item.type}:${item.id}`}>
                      {item.type === "note" || item.type === "journal" ? (
                        <button
                          className="overview-note-link"
                          onClick={() => void onOpenNote(item.id)}
                        >
                          <FileText size={16} />
                          <span>
                            <strong>
                              {item.title ||
                                (item.type === "journal"
                                  ? "Journal"
                                  : "Untitled")}
                            </strong>
                            <small>
                              {item.type === "journal"
                                ? `Journal · ${formatDate(item.date)}`
                                : `Note · ${new Date(item.updatedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`}
                            </small>
                          </span>
                          <ArrowRight size={14} />
                        </button>
                      ) : (
                        <button
                          className="overview-note-link"
                          onClick={() =>
                            onNavigate("artifacts", { openId: item.id })
                          }
                        >
                          <Layers size={16} />
                          <span>
                            <strong>{item.title || "Untitled artifact"}</strong>
                            <small>
                              Artifact ·{" "}
                              {new Date(item.updatedAt).toLocaleDateString(
                                undefined,
                                { month: "short", day: "numeric" },
                              )}
                            </small>
                          </span>
                          <ArrowRight size={14} />
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="overview-empty">Nothing saved recently.</p>
              )}
            </section>
          ),
        },
        {
          id: "bookmarks",
          visible: recentBookmarks.length > 0,
          density: "fill",
          content: (
            <section
              className="overview-widget overview-bookmarks"
              aria-labelledby="overview-bookmarks-title"
            >
              <header>
                <h2 id="overview-bookmarks-title">Recent bookmarks</h2>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onNavigate("bookmarks")}
                  aria-label="View all bookmarks"
                >
                  View all
                  <ArrowRight size={14} />
                </Button>
              </header>
              <ul aria-label="Recent bookmarks">
                {recentBookmarks.map((item) => (
                  <li key={item.id}>
                    <a
                      className="overview-bookmark-link"
                      href={item.url}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <Bookmark size={16} />
                      <span>
                        <strong>{item.title || item.url}</strong>
                        <small>
                          {item.siteName && item.siteName !== item.title
                            ? item.siteName
                            : new Date(item.updatedAt).toLocaleDateString(
                                undefined,
                                { month: "short", day: "numeric" },
                              )}
                        </small>
                      </span>
                      <ExternalLink size={14} aria-label="Opens in a new tab" />
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          ),
        },
        {
          id: "responses",
          visible: recentResponses.length > 0,
          density: "fill",
          content: (
            <section
              className="overview-widget overview-responses"
              aria-labelledby="overview-responses-title"
            >
              <header>
                <h2 id="overview-responses-title">Recent form submissions</h2>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onNavigate("forms")}
                  aria-label="View all forms"
                >
                  Forms
                  <ArrowRight size={14} />
                </Button>
              </header>
              <ul aria-label="Recent form submissions">
                {recentResponses.map((item) => (
                  <li key={item.id}>
                    <button
                      className="overview-note-link"
                      onClick={() =>
                        onNavigate("forms", {
                          formId: item.formId,
                          openId: item.id,
                        })
                      }
                    >
                      <ClipboardCheck size={16} />
                      <span>
                        <strong>{item.formTitle || "Untitled form"}</strong>
                        <small>
                          {new Date(item.createdAt).toLocaleString(undefined, {
                            month: "short",
                            day: "numeric",
                            hour: "numeric",
                            minute: "2-digit",
                          })}{" "}
                          · {item.reviewed ? "Reviewed" : "New"}
                        </small>
                      </span>
                      <ArrowRight size={14} />
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ),
        },
        {
          id: "review",
          visible: hasReview,
          density: "fill",
          content: (
            <section
              className="overview-widget overview-review"
              aria-labelledby="overview-review-title"
            >
              <header>
                <h2 id="overview-review-title">Needs review</h2>
              </header>
              <ul aria-label="Items that need review">
                {data.review?.formResponses ? (
                  <li>
                    <button
                      className="overview-note-link"
                      onClick={() => onNavigate("forms")}
                    >
                      <ClipboardCheck size={16} />
                      <span>
                        <strong>
                          {data.review.formResponses} unreviewed form{" "}
                          {data.review.formResponses === 1
                            ? "response"
                            : "responses"}
                        </strong>
                        <small>Forms</small>
                      </span>
                      <ArrowRight size={14} />
                    </button>
                  </li>
                ) : null}
                {data.review?.tagSuggestions ? (
                  <li>
                    <button
                      className="overview-note-link"
                      onClick={() => onNavigate("tag-suggestions")}
                    >
                      <Tag size={16} />
                      <span>
                        <strong>
                          {data.review.tagSuggestions}{" "}
                          {data.review.tagSuggestions === 1
                            ? "tag suggestion"
                            : "tag suggestions"}{" "}
                          to review
                        </strong>
                        <small>Tags</small>
                      </span>
                      <ArrowRight size={14} />
                    </button>
                  </li>
                ) : null}
              </ul>
            </section>
          ),
        },
      ]
    : [];
  const firstUse =
    !!data && !overviewSections.some((section) => section.visible);
  const visibleSectionCount = overviewSections.filter(
    (section) => section.visible,
  ).length;
  const overviewColumns = packOverviewSections(overviewSections);
  return (
    <section className="overview-panel" aria-label="Overview">
      <div
        className="overview-scroll"
        tabIndex={0}
        role="region"
        aria-label="Your overview"
      >
        <div className="overview-content section-content">
          <div className="overview-header">
            <SectionHeading
              title="Overview"
              description="Your workspace at a glance."
              onNavigation={onNavigation}
            />
            <div className="overview-intro">
              <div className="overview-clock">
                {now ? (
                  <>
                    <time dateTime={today || undefined}>
                      {now.toLocaleDateString(undefined, {
                        weekday: "long",
                        month: "long",
                        day: "numeric",
                        year: "numeric",
                      })}
                    </time>
                    <time dateTime={now?.toISOString()}>
                      {now.toLocaleTimeString(undefined, {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </time>
                    <span>Local time</span>
                  </>
                ) : (
                  <LoadingState kind="clock" label="Loading local time" />
                )}
              </div>
            </div>
          </div>
          <NotificationSetup />
          <div
            className="overview-actions"
            role="group"
            aria-label="Quick actions"
          >
            <Button onClick={() => onCreate("note")}>
              <Plus size={16} />
              New note
            </Button>
            <Button variant="outline" onClick={() => onCreate("task")}>
              <ListTodo size={16} />
              Add task
            </Button>
            <Button variant="outline" onClick={() => onCreate("bookmark")}>
              <Bookmark size={16} />
              Save link
            </Button>
            <Button variant="ghost" onClick={() => onCreate("daily")}>
              <CalendarDays size={16} />
              Journal
            </Button>
          </div>
          {error && (
            <div className="overview-error" role="alert">
              <p>
                {data
                  ? "Overview could not update. Showing the last loaded items. "
                  : "Overview could not load. "}
                {error}
              </p>
              <Button
                variant="outline"
                disabled={loading}
                onClick={() => void refresh()}
              >
                Try again
              </Button>
            </div>
          )}
          {!data && loading ? (
            <LoadingState kind="overview" label="Loading your overview" />
          ) : data && firstUse ? (
            <div
              className="overview-grid"
              data-section-count="1"
              data-column-count="1"
            >
              <section
                className="overview-widget overview-welcome"
                aria-labelledby="overview-welcome-title"
              >
                <h2 id="overview-welcome-title">Your workspace is ready</h2>
                <p>
                  Your recent work and upcoming plans will appear here as you
                  add them.
                </p>
              </section>
            </div>
          ) : (
            data && (
              <div
                className="overview-grid"
                data-section-count={visibleSectionCount}
                data-column-count={overviewColumns.length}
                data-many-columns={
                  overviewColumns.length > 3 ? "true" : undefined
                }
              >
                {overviewColumns.map((column) => (
                  <div
                    key={column.id}
                    className="overview-column"
                    data-density={column.density}
                  >
                    {column.sections.map((section) => (
                      <Fragment key={section.id}>{section.content}</Fragment>
                    ))}
                  </div>
                ))}
              </div>
            )
          )}
        </div>
      </div>
    </section>
  );
}
