/** Calendar workspace 右パネル: 選択日の event 一覧 */
import { Link } from "react-router";
import { deriveTimelineStatus, displayStatus } from "@workspace/lib/derive/timeline";
import type { TimelineEvent } from "@workspace/lib/types";
import { STATUS_COLOR } from "../styles/tokens";
import { Droplet } from "../timeline/Droplet";
import { shapeForKind } from "../timeline/labels";
import { StatusBadge } from "../timeline/StatusBadge";
import { requestOpenWallet } from "../timeline/detailStore";
import { fmtFullDate, fmtTime, parseDayKey } from "../ui/format";
import { ProtocolBadge, brandStyle } from "../ui/ProtocolBadge";

export function DayPanel({
  day,
  events,
  now,
  hasWallet,
  onEvent,
}: {
  day: string;
  events: TimelineEvent[];
  now: Date;
  hasWallet: boolean;
  onEvent: (id: string, el: HTMLElement) => void;
}) {
  return (
    <div className="day-panel">
      <p className="overline">Selected day</p>
      <h2>{fmtFullDate(parseDayKey(day))}</h2>
      {events.length === 0 ? (
        <div className="day-panel-empty">
          <p className="muted">Nothing scheduled.</p>
          <Link className="btn" to="/explore">
            Explore opportunities
          </Link>
        </div>
      ) : (
        <ul className="day-list">
          {events.map((e) => {
            const st = displayStatus(e, deriveTimelineStatus(e, now));
            return (
              <li key={e.id}>
                <button
                  type="button"
                  className="day-list-item brand-accent"
                  style={brandStyle(e.protocol)}
                  onClick={(ev) => onEvent(e.id, ev.currentTarget)}>
                  <Droplet shape={shapeForKind(e.kind, e.class)} color={STATUS_COLOR[st]} size={12} />
                  <span className="day-list-text">
                    <strong>{e.title}</strong>
                    <span className="muted small brand-inline">
                      <ProtocolBadge id={e.protocol} name={e.protocolName} size={16} />
                      {e.protocolName ?? "Plan"} · {e.at ? `${e.atApprox ? "≈ " : ""}${fmtTime(new Date(e.at))}` : "time unknown"}
                    </span>
                  </span>
                  <StatusBadge status={st} compact />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {!hasWallet && (
        <p className="connect-note small">
          Showing public events only.{" "}
          <button type="button" className="btn-link" onClick={requestOpenWallet}>
            Connect wallet
          </button>
        </p>
      )}
    </div>
  );
}
