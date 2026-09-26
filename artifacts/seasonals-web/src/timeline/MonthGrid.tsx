/**
 * MonthGrid — 月 grid (Home preview と Calendar workspace で共有)。
 * 日付 cell (全面の button) と event chip (個別 button) は兄弟要素にして、
 * interactive 要素を入れ子にしない。
 */
import { useMemo } from "react";
import { dayKey, deriveTimelineStatus, displayStatus, indexTimelineByDay, monthGridDays } from "@workspace/lib/derive/timeline";
import type { TimelineEvent } from "@workspace/lib/types";
import { STATUS_COLOR } from "../styles/tokens";
import { fmtFullDate } from "../ui/format";
import { Droplet } from "./Droplet";
import { shapeForKind } from "./labels";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function MonthGrid({
  month,
  events,
  now,
  density,
  selectedDay,
  onDay,
  onEvent,
}: {
  month: Date;
  events: TimelineEvent[];
  now: Date;
  density: "preview" | "full";
  selectedDay?: string | null;
  onDay: (day: string, el: HTMLElement) => void;
  onEvent: (id: string, el: HTMLElement) => void;
}) {
  const days = useMemo(() => monthGridDays(month, 1), [month]);
  const byDay = useMemo(() => indexTimelineByDay(events), [events]);
  const todayKey = dayKey(now);
  const maxChips = 2; // 1100–1439px でもセル高さに収まる数 (超過は "+n more")

  return (
    <div className={`month-grid density-${density}`} role="grid" aria-label="Month">
      <div className="month-grid-head" role="row">
        {WEEKDAYS.map((w) => (
          <div key={w} role="columnheader" className="month-grid-weekday">
            {w}
          </div>
        ))}
      </div>
      <div className="month-grid-body">
        {Array.from({ length: 6 }, (_, week) => (
          <div className="month-grid-row" role="row" key={week}>
            {days.slice(week * 7, week * 7 + 7).map((d) => {
              const key = dayKey(d);
              const list = byDay.get(key) ?? [];
              const outside = d.getMonth() !== month.getMonth();
              return (
                <div
                  key={key}
                  role="gridcell"
                  className={`month-cell${outside ? " is-outside" : ""}${key === todayKey ? " is-today" : ""}${
                    key === selectedDay ? " is-selected" : ""
                  }`}
                >
                  <button
                    type="button"
                    className="month-cell-hit"
                    aria-label={`${fmtFullDate(d)}${list.length ? `, ${list.length} event${list.length > 1 ? "s" : ""}` : ""}`}
                    onClick={(e) => onDay(key, e.currentTarget)}
                  >
                    <span className="month-cell-date">{d.getDate()}</span>
                  </button>
                  <div className="month-cell-events">
                    {list.slice(0, maxChips).map((ev) => {
                      const st = displayStatus(ev, deriveTimelineStatus(ev, now));
                      return (
                        <button
                          type="button"
                          key={ev.id}
                          className={`event-chip class-${ev.class}${st === "warning" ? " is-warning" : ""}`}
                          onClick={(e) => onEvent(ev.id, e.currentTarget)}
                          title={ev.title}
                        >
                          <Droplet shape={shapeForKind(ev.kind, ev.class)} color={STATUS_COLOR[st]} size={10} />
                          <span>{ev.title}</span>
                        </button>
                      );
                    })}
                    {list.length > maxChips && (
                      <button type="button" className="more-chip" onClick={(e) => onDay(key, e.currentTarget)}>
                        +{list.length - maxChips} more
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
