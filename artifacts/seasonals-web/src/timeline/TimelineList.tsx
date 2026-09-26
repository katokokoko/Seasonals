/**
 * TimelineList — date-first の chronological list (UI v2 §7 / §9)。
 * 同日の event は日付を 1 回だけ出して行を積む。行を押すと詳細カード。
 * variant = "preview" (Home、軽量) / "full" (workspace、network / amount / source 列 + Today divider)
 */
import { Fragment } from "react";
import { chainInfo } from "@workspace/lib/config/chains";
import { dayKey, deriveTimelineStatus, displayStatus, groupTimelineByDay } from "@workspace/lib/derive/timeline";
import type { TimelineEvent } from "@workspace/lib/types";
import { fmtAmount, fmtEventTime, fmtMonthDay, fmtUsd, parseDayKey } from "../ui/format";
import { ProtocolBadge, brandStyle } from "../ui/ProtocolBadge";
import { EventMarker } from "./EventMarker";
import { CLASS_LABEL, KIND_LABEL, statusText } from "./labels";
import { StatusBadge } from "./StatusBadge";

export function TimelineList({
  events,
  now,
  variant,
  onEvent,
  showToday = variant === "full",
}: {
  events: TimelineEvent[];
  now: Date;
  variant: "preview" | "full";
  onEvent: (id: string, el: HTMLElement) => void;
  /** Today divider を入れるか (workspace の chronological list のみ) */
  showToday?: boolean;
}) {
  const groups = groupTimelineByDay(events);
  const todayKey = dayKey(now);
  let todayShown = !showToday;
  return (
    <ol className={`tl-groups tl-${variant}`}>
      {groups.map((g) => {
        const showToday = !todayShown && (g.day === "unscheduled" || g.day >= todayKey);
        if (showToday) todayShown = true;
        const first = g.events[0]!;
        const date = g.day === "unscheduled" ? null : parseDayKey(g.day);
        return (
          <Fragment key={g.day}>
            {showToday && (
              <li className="today-divider" aria-label="Today">
                Today
              </li>
            )}
            <li className="tl-group">
              <div className="tl-date">
                {date ? (
                  <>
                    <strong>{fmtMonthDay(date)}</strong>
                    <span>{fmtEventTime(first) ?? ""}</span>
                  </>
                ) : (
                  <>
                    <strong>TBD</strong>
                    <span>ETA unknown</span>
                  </>
                )}
              </div>
              <ul className="tl-rows">
                {g.events.map((e) => {
                  const status = deriveTimelineStatus(e, now);
                  const st = displayStatus(e, status);
                  return (
                    <li key={e.id} className="tl-row">
                      <span className="tl-dot" aria-hidden="true">
                        <EventMarker event={e} status={st} size={10} />
                      </span>
                      <button
                        type="button"
                        className="tl-row-button brand-accent"
                        style={brandStyle(e.protocol)}
                        onClick={(ev) => onEvent(e.id, ev.currentTarget)}>
                        <span className="cell-protocol">
                          {e.protocol || !e.emoji ? <ProtocolBadge id={e.protocol} name={e.protocolName} size={22} /> : null}
                          <span className="cell-ellipsis">{e.protocolName ?? CLASS_LABEL[e.class]}</span>
                        </span>
                        <span className="cell-ellipsis cell-asset">{e.asset ?? "—"}</span>
                        <span className="cell-ellipsis cell-event">
                          {e.title}
                          <span className="sr-only">, {KIND_LABEL[e.kind]}</span>
                        </span>
                        <span className="cell-num cell-ellipsis cell-amount">
                          {e.usd ? fmtUsd(e.usd) : e.amount ? fmtAmount(e.amount, 4) : ""}
                        </span>
                        {variant === "full" && (
                          <>
                            <span className="cell-ellipsis cell-network">{e.chain ? chainInfo(e.chain).name : "—"}</span>
                            <span className="cell-ellipsis cell-class">
                              <span className={`class-tag class-${e.class}`}>{CLASS_LABEL[e.class]}</span>
                            </span>
                          </>
                        )}
                        <span className="cell-status">
                          <StatusBadge status={st} label={statusText(e, status)} />
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </li>
          </Fragment>
        );
      })}
    </ol>
  );
}
