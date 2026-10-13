"use client";
import { useEffect, useState } from "react";
import { ArrowLeft, Loader2, Pencil, Plus, Trash2, X } from "lucide-react";
import { Temporal } from "@js-temporal/polyfill";
import { api, apiItems } from "@/lib/client";
import {
  addDays,
  eventInput,
  eventPayload,
  localInstant,
  type CalendarEvent,
  type EventInput,
} from "@/lib/calendar";
import type { SearchResult } from "@/lib/types";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Checkbox } from "./ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "./ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import { DatePicker } from "./date-picker";
import { ItemTagPicker } from "./item-tag-picker";
import { useConfirm } from "./confirm-provider";

export function CalendarSelect({
  label,
  value,
  onChange,
  options,
  open,
  onOpenChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: [string, string][];
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  return (
    <Select
      value={value}
      onValueChange={onChange}
      open={open}
      onOpenChange={onOpenChange}
    >
      <SelectTrigger aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map(([id, text]) => (
          <SelectItem key={id} value={id}>
            {text}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
export function CalendarEventEditor({
  event,
  date,
  zone,
  occurrence,
  move,
  onClose,
  onSaved,
  onDirty,
}: {
  event: CalendarEvent | null;
  date: string;
  zone: string;
  occurrence?: string;
  move?: { startAt: number; endAt: number };
  onClose: () => void;
  onSaved: () => void;
  onDirty: (dirty: boolean) => void;
}) {
  const confirm = useConfirm();
  const [editing, setEditing] = useState(!event || !!move);
  const [openSelect, setOpenSelect] = useState<string | null>(null);
  const [revision, setRevision] = useState(event?.revision ?? 1);
  const [linkNames, setLinkNames] = useState<Record<string, string>>(() => {
    const names = Object.fromEntries(
      (
        (
          event as CalendarEvent & {
            linkedItems?: { id: string; title: string }[];
          }
        )?.linkedItems ?? []
      ).map((item) => [item.id, item.title]),
    );
    if (typeof window !== "undefined") {
      const p = new URL(window.location.href).searchParams;
      if (p.get("link"))
        names[p.get("link")!] = p.get("linkTitle") ?? "Linked item";
    }
    return names;
  });
  const [draft, setDraft] = useState<EventInput>(() =>
    event
      ? move
        ? {
            ...eventPayload(event),
            allDay: false,
            start: localInstant(move.startAt, event.timezone),
            end: localInstant(move.endAt, event.timezone),
            timezone: event.timezone,
          }
        : eventPayload(event)
      : {
          title: "",
          description: "",
          location: "",
          allDay: true,
          start: date,
          end: addDays(date, 1),
          timezone: zone,
          disambiguation: "reject",
          recurrence: null,
          links: (() => {
            const p = new URL(window.location.href).searchParams,
              type = p.get("linkType"),
              id = p.get("link");
            return id &&
              ["note", "journal", "task", "bookmark", "artifact"].includes(
                type ?? "",
              )
              ? [{ type: type as EventInput["links"][number]["type"], id }]
              : [];
          })(),
          reminders: [],
        },
  );
  const [initial] = useState(() => JSON.stringify(draft));
  const [initialOffsets] = useState(draft.reminders.join(", "));
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [scope, setScope] = useState(move && occurrence ? "occurrence" : "series"),
    [query, setQuery] = useState(""),
    [results, setResults] = useState<SearchResult[]>([]),
    [searchState, setSearchState] = useState("idle"),
    [offsets, setOffsets] = useState(draft.reminders.join(", "));
  const dirty = JSON.stringify(draft) !== initial || offsets !== initialOffsets;
  useEffect(() => {
    onDirty(dirty || busy);
    return () => onDirty(false);
  }, [dirty, busy, onDirty]);
  useEffect(() => {
    if (!query.trim()) return;
    const abort = new AbortController();
    const timer = setTimeout(() => {
      void apiItems<SearchResult>(
        `search?mode=suggest&purpose=link&q=${encodeURIComponent(query)}`,
        {
          signal: abort.signal,
        },
      )
        .then((items) => {
          if (abort.signal.aborted) return;
          setResults(items);
          setSearchState("ready");
        })
        .catch(() => {
          if (!abort.signal.aborted) setSearchState("error");
        });
    }, 150);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [query]);
  const change = (value: Partial<EventInput>) =>
    setDraft((current) => ({ ...current, ...value }));
  const selectControl = (id: string) => ({
    open: openSelect === id,
    onOpenChange: (open: boolean) =>
      setOpenSelect((current) => (open ? id : current === id ? null : current)),
  });
  async function close() {
    if (
      !busy &&
      (!dirty ||
        (await confirm({
          title: "Discard event changes?",
          description: "Your unsaved changes will be lost.",
          action: "Discard changes",
        })))
    )
      onClose();
  }
  async function cancelEdit() {
    if (!event) return close();
    if (
      busy ||
      (dirty &&
        !(await confirm({
          title: "Discard event changes?",
          description: "Your unsaved changes will be lost.",
          action: "Discard changes",
        })))
    )
      return;
    setDraft(eventPayload(event));
    setOffsets(initialOffsets);
    setScope("series");
    setQuery("");
    setError("");
    setEditing(false);
  }
  async function save() {
    setError("");
    const reminders = offsets.trim()
      ? offsets.split(",").map((value) => Number(value.trim()))
      : [];
    const parsed = eventInput.safeParse({ ...draft, reminders });
    if (!parsed.success) {
      setError(parsed.error.issues[0].message);
      return;
    }
    setBusy(true);
    try {
      await api(event ? `events/${event.id}` : "events", {
        method: event ? "PATCH" : "POST",
        body: JSON.stringify(
          event
            ? {
                input: parsed.data,
                revision,
                scope,
                occurrence,
              }
            : parsed.data,
        ),
      });
      onSaved();
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "The event could not be saved. Try again.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function trash() {
    if (
      !event ||
      !(await confirm({
        title: "Move event to Trash?",
        description: "You can restore it from Trash.",
        action: "Move to Trash",
      }))
    )
      return;
    setBusy(true);
    try {
      await api(`events/${event.id}`, {
        method: "DELETE",
        body: JSON.stringify({ revision, scope, occurrence }),
      });
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function chooseScope(value: string) {
    setScope(value);
    if (event && occurrence && value !== "series") {
      const duration = event.allDay
        ? Temporal.PlainDate.from(event.end).since(
            Temporal.PlainDate.from(event.start),
          )
        : Temporal.PlainDateTime.from(event.end).since(
            Temporal.PlainDateTime.from(event.start),
          );
      change({
        start: occurrence,
        end: event.allDay
          ? Temporal.PlainDate.from(occurrence).add(duration).toString()
          : Temporal.PlainDateTime.from(occurrence)
              .add(duration)
              .toString({ smallestUnit: "minute" }),
      });
    } else if (event) change({ start: event.start, end: event.end });
  }
  const repeat = draft.recurrence;
  const recurrence = (value: Partial<NonNullable<EventInput["recurrence"]>>) =>
    change({
      recurrence: {
        frequency: "weekly",
        interval: 1,
        weekdays: [],
        ordinal: null,
        monthDay: null,
        until: null,
        count: null,
        ...repeat,
        ...value,
      },
    });
  const dateField = (which: "start" | "end", label: string) => (
    <label className="schedule-field">
      <span>{label}</span>
      <DatePicker
        label={label}
        value={
          draft.allDay && which === "end"
            ? addDays(draft.end, -1)
            : draft[which].slice(0, 10)
        }
        onChange={(value) => {
          if (!value) return;
          change({
            [which]: draft.allDay
              ? which === "end"
                ? addDays(value, 1)
                : value
              : value + "T" + draft[which].slice(11),
          });
        }}
      />
      {!draft.allDay && (
        <Input
          type="time"
          aria-label={`${label} time`}
          value={draft[which].slice(11, 16)}
          onChange={(e) =>
            change({
              [which]: draft[which].slice(0, 10) + "T" + e.target.value,
            })
          }
        />
      )}
    </label>
  );
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) void close();
      }}
    >
      <DialogContent
        className="schedule-editor"
        showCloseButton={false}
        overlayClassName="schedule-editor-overlay"
        onEscapeKeyDown={(e) => {
          e.preventDefault();
          if (openSelect) {
            setOpenSelect(null);
            return;
          }
          void close();
        }}
        onInteractOutside={(e) => e.preventDefault()}
      >
        <header className="schedule-editor-heading">
          <Button
            variant="ghost"
            size="icon"
            aria-label="Back to calendar"
            onClick={() => void close()}
            disabled={busy}
          >
            <ArrowLeft size={18} />
          </Button>
          <div>
            <DialogTitle>
              {editing ? (event ? "Edit event" : "New event") : event?.title}
            </DialogTitle>
            <DialogDescription>
              {editing
                ? "Schedule time and link your content."
                : "Event details"}
            </DialogDescription>
          </div>
        </header>
        <div className="schedule-editor-body">
          {!editing && event ? (
            <CalendarEventDetails
              event={event}
              occurrence={occurrence}
              linkNames={linkNames}
            />
          ) : (
            <>
              {event?.recurrence && occurrence && (
                <label className="schedule-field">
                  <span>Apply changes to</span>
                  <CalendarSelect
                    {...selectControl("scope")}
                    label="Apply changes to"
                    value={scope}
                    onChange={chooseScope}
                    options={[
                      ["occurrence", "This occurrence"],
                      ["following", "This and following"],
                      ["series", "Entire series"],
                    ]}
                  />
                </label>
              )}
              <label className="schedule-field">
                <span>Title</span>
                <Input
                  autoFocus
                  value={draft.title}
                  maxLength={300}
                  onChange={(e) => change({ title: e.target.value })}
                  placeholder="What’s happening?"
                />
              </label>
              <label className="check-row">
                <Checkbox
                  checked={draft.allDay}
                  onCheckedChange={(value) => {
                    const allDay = value === true;
                    change({
                      allDay,
                      start: allDay
                        ? draft.start.slice(0, 10)
                        : draft.start.slice(0, 10) + "T09:00",
                      end: allDay
                        ? addDays(draft.end.slice(0, 10), 1)
                        : draft.start.slice(0, 10) + "T10:00",
                    });
                  }}
                />
                All day
              </label>
              <div className="schedule-field-pair">
                {dateField("start", "Starts")}
                {dateField("end", "Ends")}
              </div>
              {!draft.allDay && (
                <label className="schedule-field">
                  <span>Timezone</span>
                  <Input
                    value={draft.timezone}
                    maxLength={100}
                    onChange={(e) => change({ timezone: e.target.value })}
                  />
                </label>
              )}
              <label className="schedule-field">
                <span>
                  Location <small>optional</small>
                </span>
                <Input
                  value={draft.location}
                  maxLength={500}
                  onChange={(e) => change({ location: e.target.value })}
                />
              </label>
              <label className="schedule-field">
                <span>
                  Description <small>optional</small>
                </span>
                <textarea
                  value={draft.description}
                  maxLength={10000}
                  onChange={(e) => change({ description: e.target.value })}
                />
              </label>
              <details className="schedule-details">
                <summary>Repeat and reminders</summary>
                <label className="schedule-field">
                  <span>Repeat</span>
                  <CalendarSelect
                    {...selectControl("repeat")}
                    label="Repeat"
                    value={repeat?.frequency ?? "none"}
                    onChange={(value) =>
                      value === "none"
                        ? change({ recurrence: null })
                        : recurrence({
                            frequency: value as NonNullable<
                              EventInput["recurrence"]
                            >["frequency"],
                          })
                    }
                    options={[
                      ["none", "Does not repeat"],
                      ["daily", "Daily"],
                      ["weekly", "Weekly"],
                      ["monthly", "Monthly"],
                      ["yearly", "Yearly"],
                    ]}
                  />
                </label>
                {repeat && (
                  <>
                    <label className="schedule-field">
                      <span>Every</span>
                      <Input
                        aria-label="Repeat interval"
                        type="number"
                        min={1}
                        max={999}
                        value={repeat.interval}
                        onChange={(e) =>
                          recurrence({ interval: Number(e.target.value) })
                        }
                      />
                    </label>
                    <div
                      className="schedule-weekdays"
                      role="group"
                      aria-label="Repeat weekdays"
                    >
                      {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map(
                        (day, i) => (
                          <Button
                            key={day}
                            type="button"
                            variant="ghost"
                            aria-pressed={repeat.weekdays.includes(i)}
                            onClick={() =>
                              recurrence({
                                weekdays: repeat.weekdays.includes(i)
                                  ? repeat.weekdays.filter((v) => v !== i)
                                  : [...repeat.weekdays, i],
                              })
                            }
                          >
                            {day}
                          </Button>
                        ),
                      )}
                    </div>
                    {["monthly", "yearly"].includes(repeat.frequency) && (
                      <div className="schedule-field-pair">
                        <label className="schedule-field">
                          <span>Week</span>
                          <CalendarSelect
                            {...selectControl("week-of-month")}
                            label="Week of month"
                            value={String(repeat.ordinal ?? "any")}
                            onChange={(v) =>
                              recurrence({
                                ordinal: v === "any" ? null : Number(v),
                                monthDay: null,
                              })
                            }
                            options={[
                              ["any", "Any week"],
                              ["1", "First"],
                              ["2", "Second"],
                              ["3", "Third"],
                              ["4", "Fourth"],
                              ["5", "Fifth"],
                              ["-1", "Last"],
                            ]}
                          />
                        </label>
                        <label className="schedule-field">
                          <span>Day of month</span>
                          <Input
                            type="number"
                            min={1}
                            max={31}
                            value={repeat.monthDay ?? ""}
                            onChange={(e) =>
                              recurrence({
                                monthDay: e.target.value
                                  ? Number(e.target.value)
                                  : null,
                                ordinal: null,
                              })
                            }
                          />
                        </label>
                      </div>
                    )}
                    <div className="schedule-field-pair">
                      <label className="schedule-field">
                        <span>
                          Until <small>optional</small>
                        </span>
                        <DatePicker
                          label="Repeat until"
                          value={repeat.until}
                          onChange={(until) =>
                            recurrence({ until, count: null })
                          }
                        />
                      </label>
                      <label className="schedule-field">
                        <span>
                          Occurrences <small>optional</small>
                        </span>
                        <Input
                          type="number"
                          min={1}
                          max={10000}
                          value={repeat.count ?? ""}
                          onChange={(e) =>
                            recurrence({
                              count: e.target.value
                                ? Number(e.target.value)
                                : null,
                              until: null,
                            })
                          }
                        />
                      </label>
                    </div>
                  </>
                )}
                <label className="schedule-field">
                  <span>
                    Remind me before <small>minutes</small>
                  </span>
                  <Input
                    value={offsets}
                    maxLength={60}
                    onChange={(e) => {
                      setOffsets(e.target.value);
                      onDirty(true);
                    }}
                    placeholder="e.g. 0, 15, 60"
                  />
                  <small>
                    Up to three reminders. All-day reminders use 09:00 in{" "}
                    {draft.timezone}.
                  </small>
                </label>
                {!draft.allDay && (
                  <label className="schedule-field">
                    <span>Repeated clock time</span>
                    <CalendarSelect
                      {...selectControl("clock-disambiguation")}
                      label="Repeated clock time"
                      value={draft.disambiguation}
                      onChange={(v) =>
                        change({
                          disambiguation: v as EventInput["disambiguation"],
                        })
                      }
                      options={[
                        ["reject", "Ask me to choose"],
                        ["earlier", "Earlier offset"],
                        ["later", "Later offset"],
                      ]}
                    />
                  </label>
                )}
              </details>
              <details className="schedule-details">
                <summary>Linked items ({draft.links.length})</summary>
                <Input
                  aria-label="Find items to link"
                  placeholder="Search saved items…"
                  maxLength={300}
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setResults([]);
                    setSearchState(e.target.value.trim() ? "loading" : "idle");
                  }}
                />
                {query.trim() && (
                  <p className="muted" role="status">
                    {searchState === "loading"
                      ? "Searching…"
                      : searchState === "error"
                        ? "Search could not load. Try searching again."
                        : searchState === "ready" && !results.length
                          ? "No matching items."
                          : ""}
                  </p>
                )}
                {draft.links.map((link) => (
                  <div className="schedule-link" key={link.type + link.id}>
                    <span>{linkNames[link.id] ?? `Linked ${link.type}`}</span>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Remove ${linkNames[link.id] ?? `linked ${link.type}`}`}
                      onClick={() =>
                        change({
                          links: draft.links.filter(
                            (v) => v.id !== link.id || v.type !== link.type,
                          ),
                        })
                      }
                    >
                      <X size={16} />
                    </Button>
                  </div>
                ))}
                {query &&
                  results
                    .filter((item) =>
                      [
                        "note",
                        "journal",
                        "task",
                        "bookmark",
                        "artifact",
                      ].includes(item.type),
                    )
                    .slice(0, 10)
                    .map((item) => (
                      <Button
                        key={item.id}
                        className="schedule-link-result"
                        variant="ghost"
                        disabled={draft.links.some(
                          (link) => link.id === item.id,
                        )}
                        onClick={() => {
                          change({
                            links: [
                              ...draft.links,
                              {
                                type: (item.type === "note" &&
                                (item.journalPeriod || item.dailyDate)
                                  ? "journal"
                                  : item.type) as EventInput["links"][number]["type"],
                                id: item.id,
                              },
                            ],
                          });
                          setLinkNames((names) => ({
                            ...names,
                            [item.id]: item.title,
                          }));
                          setQuery("");
                        }}
                      >
                        <Plus size={16} />
                        <span>{item.title}</span>
                      </Button>
                    ))}
              </details>
              {event && (
                <ItemTagPicker
                  type="event"
                  id={event.id}
                  title={event.title}
                  compact={false}
                  disabled={busy || dirty}
                  onChanged={async () => {
                    const state = await api<{ revision: number }>(
                      `item-tags/event/${event.id}`,
                    );
                    setRevision(state.revision);
                  }}
                />
              )}
              {error && (
                <p className="form-error" role="alert">
                  {error}
                </p>
              )}
            </>
          )}
        </div>
        <footer className="schedule-editor-footer">
          {!editing ? (
            <>
              <Button variant="outline" onClick={() => void close()}>
                Close
              </Button>
              <Button onClick={() => setEditing(true)}>
                <Pencil size={16} />
                Edit event
              </Button>
            </>
          ) : (
            <>
              {event && (
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => void trash()}
                >
                  <Trash2 size={16} />
                  Trash
                </Button>
              )}
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => void cancelEdit()}
              >
                Cancel
              </Button>
              <Button
                disabled={busy || !draft.title.trim()}
                onClick={() => void save()}
              >
                {busy && <Loader2 className="animate-spin" size={16} />}Save
                event
              </Button>
            </>
          )}
        </footer>
      </DialogContent>
    </Dialog>
  );
}

function CalendarEventDetails({
  event,
  occurrence,
  linkNames,
}: {
  event: CalendarEvent;
  occurrence?: string;
  linkNames: Record<string, string>;
}) {
  let start = event.start;
  let end = event.end;
  if (event.recurrence && occurrence) {
    try {
      start = event.allDay
        ? Temporal.PlainDate.from(occurrence).toString()
        : Temporal.PlainDateTime.from(occurrence).toString();
      end = event.allDay
        ? Temporal.PlainDate.from(start)
            .add(
              Temporal.PlainDate.from(event.end).since(
                Temporal.PlainDate.from(event.start),
              ),
            )
            .toString()
        : Temporal.PlainDateTime.from(start)
            .add(
              Temporal.PlainDateTime.from(event.end).since(
                Temporal.PlainDateTime.from(event.start),
              ),
            )
            .toString();
    } catch {
      start = event.start;
      end = event.end;
    }
  }
  const format = (value: string) =>
    new Date(value.slice(0, 10) + "T12:00").toLocaleDateString(undefined, {
      weekday: "short",
      year: "numeric",
      month: "short",
      day: "numeric",
    }) +
    (event.allDay || !value.includes("T") ? "" : ` · ${value.slice(11, 16)}`);
  const repeat = event.recurrence;
  const units = {
    daily: "day",
    weekly: "week",
    monthly: "month",
    yearly: "year",
  };
  return (
    <dl className="schedule-event-details">
      <div>
        <dt>Starts</dt>
        <dd>{format(start)}</dd>
      </div>
      <div>
        <dt>Ends</dt>
        <dd>{format(event.allDay ? addDays(end, -1) : end)}</dd>
      </div>
      <div>
        <dt>{event.allDay ? "Time" : "Timezone"}</dt>
        <dd>{event.allDay ? "All day" : event.timezone}</dd>
      </div>
      {event.location && (
        <div>
          <dt>Location</dt>
          <dd>{event.location}</dd>
        </div>
      )}
      {event.description && (
        <div>
          <dt>Description</dt>
          <dd className="schedule-event-description">{event.description}</dd>
        </div>
      )}
      {repeat && (
        <div>
          <dt>Repeats</dt>
          <dd>
            Every {repeat.interval === 1 ? "" : `${repeat.interval} `}
            {units[repeat.frequency]}
            {repeat.interval === 1 ? "" : "s"}
            {repeat.weekdays.length > 0 && (
              <p>
                {repeat.ordinal &&
                  `${({ 1: "First", 2: "Second", 3: "Third", 4: "Fourth", 5: "Fifth", [-1]: "Last" } as Record<number, string>)[repeat.ordinal]} `}
                {repeat.weekdays
                  .map(
                    (day) =>
                      ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][day],
                  )
                  .join(", ")}
              </p>
            )}
            {repeat.monthDay && <p>Day {repeat.monthDay} of the month</p>}
            {repeat.until && <p>Until {format(repeat.until)}</p>}
            {repeat.count && <p>{repeat.count} occurrences</p>}
          </dd>
        </div>
      )}
      {event.reminders.length > 0 && (
        <div>
          <dt>Reminders</dt>
          <dd>
            {event.reminders.map((offset, index) => (
              <p key={`${offset}:${index}`}>
                {offset === 0 ? "At start" : `${offset} minutes before`}
              </p>
            ))}
          </dd>
        </div>
      )}
      {event.links.length > 0 && (
        <div>
          <dt>Linked items</dt>
          <dd>
            <ul>
              {event.links.map((link) => (
                <li key={`${link.type}:${link.id}`}>
                  {linkNames[link.id] || "Linked item"}
                  <span className="schedule-event-kind">{link.type}</span>
                </li>
              ))}
            </ul>
          </dd>
        </div>
      )}
    </dl>
  );
}
