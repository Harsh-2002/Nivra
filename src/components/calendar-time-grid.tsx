"use client";
import { useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { Temporal } from "@js-temporal/polyfill";
import { useCspNonce } from "@/lib/csp";
import type { CalendarItem } from "@/lib/calendar";
import { Button } from "./ui/button";

type DragState = {
  item: CalendarItem;
  startX: number;
  startY: number;
  startAt: number;
  endAt: number;
};

function nearestAvailableSlot(
  occupiedSlots: Set<number> | undefined,
  requestedSlot: number,
  timeDirection: number,
) {
  const occupied = occupiedSlots ?? new Set<number>();
  if (timeDirection !== 0) {
    for (
      let slot = requestedSlot;
      slot >= 0 && slot < 48;
      slot += timeDirection
    ) {
      if (!occupied.has(slot)) return slot;
    }
    return undefined;
  }

  if (!occupied.has(requestedSlot)) return requestedSlot;
  for (let distance = 1; distance < 48; distance += 1) {
    const later = requestedSlot + distance;
    if (later < 48 && !occupied.has(later)) return later;
    const earlier = requestedSlot - distance;
    if (earlier >= 0 && !occupied.has(earlier)) return earlier;
  }
  return undefined;
}

function getOccupiedSlots(
  items: CalendarItem[],
  dayStart: number,
  dayStop: number,
  timezone: string,
) {
  const occupiedSlots = new Set<number>();
  for (const item of items) {
    if (
      item.startAt === undefined ||
      item.endAt === undefined ||
      item.startAt >= dayStop ||
      item.endAt <= dayStart
    ) {
      continue;
    }
    const start = Temporal.Instant.fromEpochMilliseconds(
      Math.max(dayStart, item.startAt),
    ).toZonedDateTimeISO(timezone);
    const startMinute =
      start.hour * 60 +
      start.minute +
      start.second / 60 +
      start.millisecond / 60_000;
    let endMinute = 1440;
    if (item.endAt < dayStop) {
      const end = Temporal.Instant.fromEpochMilliseconds(
        item.endAt,
      ).toZonedDateTimeISO(timezone);
      endMinute =
        end.hour * 60 + end.minute + end.second / 60 + end.millisecond / 60_000;
    }
    const visualEndMinute = Math.max(endMinute, startMinute + 30);
    const firstSlot = Math.max(0, Math.floor(startMinute / 30));
    const lastSlot = Math.min(47, Math.ceil(visualEndMinute / 30) - 1);
    for (let slot = firstSlot; slot <= lastSlot; slot += 1) {
      occupiedSlots.add(slot);
    }
  }
  return occupiedSlots;
}

export function CalendarTimeGrid({
  days,
  items,
  timezone,
  onOpen,
  onEmptySlot,
  onMove,
}: {
  days: string[];
  items: CalendarItem[];
  timezone: string;
  onOpen: (item: CalendarItem) => void;
  onEmptySlot: (date: string, time: string) => void;
  onMove: (
    item: CalendarItem,
    startAt: number,
    endAt: number,
    kind: "move" | "resize",
  ) => void;
}) {
  const nonce = useCspNonce();
  const drag = useRef<DragState | null>(null);
  const suppressClick = useRef(false);
  const [dragError, setDragError] = useState("");
  const minimumHeight = 24;
  const minimumDuration = (minimumHeight / 48) * 60 * 60_000;
  const positions: string[] = [];
  let index = 0;

  function finishDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    const current = drag.current;
    if (!current) return;
    drag.current = null;
    const deltaX = event.clientX - current.startX;
    const deltaY = event.clientY - current.startY;
    if (Math.abs(deltaX) < 6 && Math.abs(deltaY) < 6) return;
    suppressClick.current = true;
    const hours = event.currentTarget.closest(".schedule-time-hours");
    const dayWidth = hours?.getBoundingClientRect().width ?? 1;
    const dayDelta = Math.round(deltaX / dayWidth);
    const minuteDelta = Math.round(((deltaY / 48) * 60) / 15) * 15;
    try {
      const original = Temporal.Instant.fromEpochMilliseconds(
        current.startAt,
      ).toZonedDateTimeISO(timezone);
      const moved = original
        .toPlainDateTime()
        .add({ days: dayDelta, minutes: minuteDelta })
        .toZonedDateTime(timezone, { disambiguation: "reject" });
      const startAt = Number(moved.epochMilliseconds);
      const endAt = startAt + (current.endAt - current.startAt);
      setDragError("");
      onMove(current.item, startAt, endAt, "move");
    } catch {
      setDragError(
        "That local time does not exist or occurs twice. Choose a time in the task or event details.",
      );
    }
  }

  const occupiedSlotsByDay = days.map((day) => {
    const start = Number(
      Temporal.PlainDate.from(day).toZonedDateTime(timezone).epochMilliseconds,
    );
    const nextDay = Temporal.PlainDate.from(day).add({ days: 1 }).toString();
    const stop = Number(
      Temporal.PlainDate.from(nextDay).toZonedDateTime(timezone)
        .epochMilliseconds,
    );
    return getOccupiedSlots(items, start, stop, timezone);
  });
  const firstKeyboardEntryDay = occupiedSlotsByDay.findIndex(
    (occupiedSlots) => occupiedSlots.size < 48,
  );

  return (
    <div
      className={"schedule-time-grid schedule-time-" + days.length}
      role="region"
      aria-label={days.length === 1 ? "Day schedule" : "Week schedule"}
    >
      {dragError && (
        <p className="schedule-error planning-grid-error" role="alert">
          {dragError}
        </p>
      )}
      <div className="schedule-time-labels" aria-hidden="true">
        <span>All day</span>
        {Array.from({ length: 24 }, (_, hour) => (
          <span key={hour}>{String(hour).padStart(2, "0")}:00</span>
        ))}
      </div>
      {days.map((day, dayIndex) => {
        const dayStart = Number(
          Temporal.PlainDate.from(day).toZonedDateTime(timezone)
            .epochMilliseconds,
        );
        const nextDay = Temporal.PlainDate.from(day)
          .add({ days: 1 })
          .toString();
        const dayStop = Number(
          Temporal.PlainDate.from(nextDay).toZonedDateTime(timezone)
            .epochMilliseconds,
        );
        const timed = items
          .filter(
            (item) =>
              item.startAt !== undefined &&
              item.endAt !== undefined &&
              item.startAt < dayStop &&
              item.endAt > dayStart,
          )
          .sort((a, b) => a.startAt! - b.startAt!);
        const lanes: number[] = [];
        const placed = timed.map((item) => {
          const visibleStart = Math.max(dayStart, item.startAt!);
          let lane = lanes.findIndex((value) => value <= visibleStart);
          if (lane < 0) lane = lanes.length;
          lanes[lane] = Math.max(
            Math.min(dayStop, item.endAt!),
            visibleStart + minimumDuration,
          );
          return { item, lane };
        });
        const occupiedSlots = occupiedSlotsByDay[dayIndex];
        const firstAvailableSlot = Array.from(
          { length: 48 },
          (_, slot) => slot,
        ).find((slot) => !occupiedSlots.has(slot));
        return (
          <section key={day} className="schedule-time-day">
            <h3>
              {Temporal.PlainDate.from(day)
                .toZonedDateTime(timezone)
                .toLocaleString(undefined, {
                  weekday: "short",
                  day: "numeric",
                })}
            </h3>
            <div className="schedule-time-all-day">
              {items
                .filter(
                  (item) =>
                    !item.startAt &&
                    item.date <= day &&
                    (item.endDate ? item.endDate > day : item.date === day),
                )
                .map((item) => (
                  <Button
                    key={item.id}
                    variant="ghost"
                    onClick={() => onOpen(item)}
                  >
                    {item.title}
                  </Button>
                ))}
            </div>
            <div className="schedule-time-hours">
              {Array.from({ length: 24 }, (_, hour) => (
                <div className="schedule-time-hour" key={hour} />
              ))}
              <div className="schedule-time-slots">
                {Array.from({ length: 48 }, (_, slot) => {
                  if (occupiedSlots.has(slot)) return null;
                  const hour = Math.floor(slot / 2);
                  const minute = slot % 2 ? 30 : 0;
                  const time =
                    String(hour).padStart(2, "0") +
                    ":" +
                    String(minute).padStart(2, "0");
                  const className =
                    "schedule-time-slot-" + dayIndex + "-" + slot;
                  positions.push("." + className + "{top:" + slot * 24 + "px}");
                  return (
                    <button
                      type="button"
                      className={"schedule-time-slot " + className}
                      key={time}
                      data-date={day}
                      data-slot-index={slot}
                      tabIndex={
                        dayIndex === firstKeyboardEntryDay &&
                        slot === firstAvailableSlot
                          ? 0
                          : -1
                      }
                      aria-label={"Plan a task on " + day + " at " + time}
                      onClick={() => onEmptySlot(day, time)}
                      onKeyDown={(event) => {
                        const movement: Record<string, [number, number]> = {
                          ArrowUp: [0, -1],
                          ArrowDown: [0, 1],
                          ArrowLeft: [-1, 0],
                          ArrowRight: [1, 0],
                        };
                        const direction = movement[event.key];
                        if (!direction) return;
                        const nextDayIndex = dayIndex + direction[0];
                        const nextDay = days[nextDayIndex];
                        if (!nextDay) return;
                        const requestedSlot = slot + direction[1];
                        if (requestedSlot < 0 || requestedSlot >= 48) return;
                        const nextSlot = nearestAvailableSlot(
                          occupiedSlotsByDay[nextDayIndex],
                          requestedSlot,
                          direction[1],
                        );
                        if (nextSlot === undefined) return;
                        event.preventDefault();
                        document
                          .querySelector<HTMLButtonElement>(
                            '.schedule-time-slot[data-date="' +
                              nextDay +
                              '"][data-slot-index="' +
                              nextSlot +
                              '"]',
                          )
                          ?.focus();
                      }}
                    />
                  );
                })}
              </div>
              {placed.map(({ item, lane }) => {
                const id = index++;
                const compact = item.endAt! - item.startAt! < 60 * 60_000;
                const visibleStart = Math.max(dayStart, item.startAt!);
                const visibleEnd = Math.min(dayStop, item.endAt!);
                const start =
                  Temporal.Instant.fromEpochMilliseconds(
                    visibleStart,
                  ).toZonedDateTimeISO(timezone);
                const end =
                  Temporal.Instant.fromEpochMilliseconds(
                    visibleEnd,
                  ).toZonedDateTimeISO(timezone);
                const top = ((start.hour * 60 + start.minute) / 1440) * 100;
                const bottom =
                  item.endAt! >= dayStop
                    ? 100
                    : ((end.hour * 60 + end.minute) / 1440) * 100;
                positions.push(
                  ".schedule-time-entry-" +
                    id +
                    "{top:" +
                    top +
                    "%;height:max(" +
                    minimumHeight +
                    "px," +
                    Math.max(0, bottom - top) +
                    "%);left:calc(" +
                    (lane / lanes.length) * 100 +
                    "% + 2px);width:calc(" +
                    100 / lanes.length +
                    "% - 4px)}",
                );
                const startTime = start.toLocaleString(undefined, {
                  hour: "2-digit",
                  minute: "2-digit",
                });
                const endTime = end.toLocaleString(undefined, {
                  hour: "2-digit",
                  minute: "2-digit",
                });
                return (
                  <div
                    key={item.id}
                    className={
                      "schedule-time-entry schedule-time-entry-" +
                      id +
                      (compact ? " is-compact" : "")
                    }
                  >
                    <Button
                      type="button"
                      variant="ghost"
                      className={
                        "schedule-time-entry-open" +
                        (compact ? " is-compact" : "")
                      }
                      title={item.title}
                      aria-label={
                        item.title + ", " + startTime + " to " + endTime
                      }
                      onPointerDown={(event) => {
                        if (event.pointerType === "touch") return;
                        drag.current = {
                          item,
                          startX: event.clientX,
                          startY: event.clientY,
                          startAt: item.startAt!,
                          endAt: item.endAt!,
                        };
                        event.currentTarget.setPointerCapture(event.pointerId);
                      }}
                      onPointerUp={finishDrag}
                      onPointerCancel={() => {
                        drag.current = null;
                      }}
                      onClick={() => {
                        if (suppressClick.current) {
                          suppressClick.current = false;
                          return;
                        }
                        onOpen(item);
                      }}
                    >
                      <span>{startTime}</span>
                      <strong>{item.title}</strong>
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      className="schedule-time-extend"
                      aria-label={"Extend " + item.title + " by 15 minutes"}
                      title="Extend by 15 minutes"
                      onClick={() =>
                        onMove(
                          item,
                          item.startAt!,
                          item.endAt! + 15 * 60_000,
                          "resize",
                        )
                      }
                    >
                      +
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      className="schedule-time-shorten"
                      aria-label={"Shorten " + item.title + " by 15 minutes"}
                      title="Shorten by 15 minutes"
                      disabled={item.endAt! - item.startAt! <= 5 * 60_000}
                      onClick={() =>
                        onMove(
                          item,
                          item.startAt!,
                          item.endAt! - 15 * 60_000,
                          "resize",
                        )
                      }
                    >
                      −
                    </Button>
                  </div>
                );
              })}
            </div>
          </section>
        );
      })}
      <style nonce={nonce}>{positions.join("\n")}</style>
    </div>
  );
}
