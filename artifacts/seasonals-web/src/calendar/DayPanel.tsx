/** Calendar workspace 右パネル: 選択日の event 一覧 + 自分の予定の追加 */
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { deriveTimelineStatus, displayStatus } from "@workspace/lib/derive/timeline";
import type { TimelineEvent } from "@workspace/lib/types";
import { EventMarker } from "../timeline/EventMarker";
import { CLASS_LABEL } from "../timeline/labels";
import { StatusBadge } from "../timeline/StatusBadge";
import { requestOpenWallet } from "../timeline/detailStore";
import { fmtEventTime, fmtFullDate, parseDayKey } from "../ui/format";
import { ProtocolBadge, brandStyle } from "../ui/ProtocolBadge";
import { useCustomEvents } from "../state/customEvents";
import { CustomEventForm } from "./CustomEventForm";

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
  const [adding, setAdding] = useState(false);
  const add = useCustomEvents((s) => s.add);
  // 別の日を選んだらフォームを閉じる
  useEffect(() => setAdding(false), [day]);
  return (
    <div className="day-panel">
      <p className="overline">Selected day</p>
      <h2>{fmtFullDate(parseDayKey(day))}</h2>
      {events.length === 0 ? (
        !adding && (
          <div className="day-panel-empty">
            <p className="muted">Nothing scheduled.</p>
          </div>
        )
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
                  <EventMarker event={e} status={st} size={12} />
                  <span className="day-list-text">
                    <strong>{e.title}</strong>
                    <span className="muted small brand-inline">
                      {e.protocol && <ProtocolBadge id={e.protocol} name={e.protocolName} size={16} />}
                      {e.protocolName ?? CLASS_LABEL[e.class]} · {fmtEventTime(e) ?? "time unknown"}
                    </span>
                  </span>
                  <StatusBadge status={st} compact />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {adding ? (
        <CustomEventForm
          key={day}
          day={day}
          onSave={(input) => {
            add(input);
            setAdding(false);
          }}
          onCancel={() => setAdding(false)}
        />
      ) : (
        <div className="day-panel-actions">
          <button type="button" className="btn btn-primary" onClick={() => setAdding(true)}>
            + Add plan
          </button>
          {events.length === 0 && (
            <Link className="btn" to="/menu">
              Browse the menu
            </Link>
          )}
        </div>
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
