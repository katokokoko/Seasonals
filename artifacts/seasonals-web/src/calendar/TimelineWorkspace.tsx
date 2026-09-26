/**
 * TimelineWorkspace — /calendar?view=timeline (UI v2 §9)。
 * 過去も含む chronological list + Today divider。range は tier-2 toolbar で選ぶ
 * (Home には range 操作が無い)。Ladder 表示は既存実装が無いため今回は入れない。
 */
import { useMemo, useState, type ReactNode } from "react";
import { deriveTimelineStatus } from "@workspace/lib/derive/timeline";
import type { TimelineEvent } from "@workspace/lib/types";
import type { SourceState } from "../services/queries";
import { WorkspaceShell } from "../shell/WorkspaceShell";
import { useDetail, requestOpenWallet } from "../timeline/detailStore";
import { TimelineList } from "../timeline/TimelineList";
import { SourceStatusLine } from "../timeline/SourceStatusLine";

const RANGES = [
  { id: "next7", label: "Next 7 days", past: 0, future: 7 },
  { id: "next30", label: "Next 30 days", past: 0, future: 30 },
  { id: "pm30", label: "±30 days", past: 30, future: 30 },
  { id: "next90", label: "Next 90 days", past: 0, future: 90 },
  { id: "all", label: "All", past: Infinity, future: Infinity },
] as const;
type RangeId = (typeof RANGES)[number]["id"];
const DAY = 86_400_000;

export function TimelineWorkspace({
  events,
  now,
  viewSwitch,
  filterChips,
  sources,
  isLoading,
  hasWallet,
}: {
  events: TimelineEvent[];
  now: Date;
  viewSwitch: ReactNode;
  filterChips: ReactNode;
  sources: SourceState[];
  isLoading: boolean;
  hasWallet: boolean;
}) {
  const [range, setRange] = useState<RangeId>("pm30");
  const [openFirst, setOpenFirst] = useState(true);
  const open = useDetail((s) => s.open);
  const r = RANGES.find((x) => x.id === range)!;

  const { attention, rest } = useMemo(() => {
    const lo = now.getTime() - r.past * DAY;
    const hi = now.getTime() + r.future * DAY;
    const isOpen = (e: TimelineEvent) => {
      const s = deriveTimelineStatus(e, now);
      return s === "overdue" || s === "due";
    };
    const inRange = events.filter((e) => {
      if (e.at === null) return true;
      const t = Date.parse(e.at);
      // 期日を過ぎた未処理 (overdue / due) は range 外でも出す (v3 §4)
      return (t >= lo && t <= hi) || isOpen(e);
    });
    if (!openFirst) return { attention: [] as TimelineEvent[], rest: inRange };
    return { attention: inRange.filter(isOpen), rest: inRange.filter((e) => !isOpen(e)) };
  }, [events, now, r, openFirst]);
  const total = attention.length + rest.length;

  const toolbar = (
    <>
      <label className="select-wrap">
        <span className="sr-only">Date range</span>
        <select className="select" value={range} onChange={(e) => setRange(e.target.value as RangeId)}>
          {RANGES.map((x) => (
            <option key={x.id} value={x.id}>
              {x.label}
            </option>
          ))}
        </select>
      </label>
      <label className="check">
        <input type="checkbox" checked={openFirst} onChange={(e) => setOpenFirst(e.target.checked)} /> Needs attention first
      </label>
      {filterChips}
      {viewSwitch}
    </>
  );

  return (
    <WorkspaceShell title="Timeline" subtitle="Calendar workspace" toolbar={toolbar}>
      {!hasWallet && (
        <p className="connect-note">
          Showing public events only. Connect your wallet to see your own positions here.{" "}
          <button type="button" className="btn-link" onClick={requestOpenWallet}>
            Connect wallet
          </button>
        </p>
      )}
      <div className="tl-table-head" aria-hidden="true">
        <span>Date</span>
        <span>Protocol</span>
        <span>Asset / Position</span>
        <span>Event</span>
        <span className="cell-num">Amount / Value</span>
        <span>Network</span>
        <span>Type</span>
        <span>Status</span>
      </div>
      {isLoading && total === 0 ? (
        <p className="muted empty-state" aria-busy="true">
          Loading events…
        </p>
      ) : total === 0 ? (
        <p className="muted empty-state">No activity in this range.</p>
      ) : (
        <>
          {attention.length > 0 && (
            <section className="attention-section" aria-label="Needs attention">
              <h2 className="section-title">Needs attention</h2>
              <TimelineList events={attention} now={now} variant="full" showToday={false} onEvent={(id, el) => open({ kind: "event", eventId: id }, el)} />
            </section>
          )}
          <TimelineList events={rest} now={now} variant="full" onEvent={(id, el) => open({ kind: "event", eventId: id }, el)} />
        </>
      )}
      <SourceStatusLine sources={sources} />
    </WorkspaceShell>
  );
}
