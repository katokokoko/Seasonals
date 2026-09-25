/** Week view: 7 列、各日の event を時刻順に縦積み */
import { dayKey, deriveTimelineStatus, displayStatus, sortTimeline } from "@workspace/lib/derive/timeline";
import type { TimelineEvent } from "@workspace/lib/types";
import { STATUS_COLOR } from "../styles/tokens";
import { Droplet } from "../timeline/Droplet";
import { shapeForKind } from "../timeline/labels";
import { fmtTime } from "../ui/format";

export function WeekView({
  start,
  events,
  now,
  selectedDay,
  onDay,
  onEvent,
}: {
  start: Date;
  events: TimelineEvent[];
  now: Date;
  selectedDay: string;
  onDay: (day: string) => void;
  onEvent: (id: string, el: HTMLElement) => void;
}) {
  const days = Array.from({ length: 7 }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
  const sorted = sortTimeline(events);
  const today = dayKey(now);
  return (
    <div className="week-view">
      {days.map((d) => {
        const key = dayKey(d);
        const list = sorted.filter((e) => e.at && dayKey(new Date(e.at)) === key);
        return (
          <section key={key} className={`week-col${key === today ? " is-today" : ""}${key === selectedDay ? " is-selected" : ""}`}>
            <button type="button" className="week-col-head" onClick={() => onDay(key)}>
              <span className="muted small">{d.toLocaleDateString("en-US", { weekday: "short" })}</span>
              <strong>{d.getDate()}</strong>
            </button>
            <div className="week-col-events">
              {list.length === 0 && <span className="muted small">—</span>}
              {list.map((e) => {
                const st = displayStatus(e, deriveTimelineStatus(e, now));
                return (
                  <button key={e.id} type="button" className={`week-event class-${e.class}`} onClick={(ev) => onEvent(e.id, ev.currentTarget)}>
                    <span className="week-event-time">
                      <Droplet shape={shapeForKind(e.kind, e.class)} color={STATUS_COLOR[st]} size={10} />
                      {e.at ? `${e.atApprox ? "≈" : ""}${fmtTime(new Date(e.at))}` : ""}
                    </span>
                    <span className="week-event-title">{e.title}</span>
                    <span className="muted small">{e.protocolName}</span>
                  </button>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}
