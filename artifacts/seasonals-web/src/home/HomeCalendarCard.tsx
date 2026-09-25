/**
 * HomeCalendarCard — 中央カード (UI v2 §4–§7)。
 * - Calendar | Timeline はカード内でその場切替 (外形・header 高さ不変、150–220ms crossfade)
 * - 右上の expand ボタンだけが Home を離れる (/calendar?view=month | timeline)
 * - 日付 / event を押すと前面の詳細カード (遷移しない)
 * - Timeline は月送り無し、今から 30 日の固定 window
 */
import { useMemo, useState } from "react";
import { Link } from "react-router";
import { HOME_TIMELINE_WINDOW_DAYS, windowTimeline } from "@workspace/lib/derive/timeline";
import { useTimeline } from "../services/queries";
import { useDetail, requestOpenWallet } from "../timeline/detailStore";
import { MonthGrid } from "../timeline/MonthGrid";
import { TimelineList } from "../timeline/TimelineList";
import { fmtMonthYear } from "../ui/format";
import { IconChevronLeft, IconChevronRight, IconExpand } from "../ui/icons";
import { SourceStatusLine } from "../timeline/SourceStatusLine";

type Mode = "calendar" | "timeline";
const PREVIEW_ROWS = 7;

export function HomeCalendarCard() {
  const [mode, setMode] = useState<Mode>("calendar");
  const [month, setMonth] = useState(() => {
    const n = new Date();
    return new Date(n.getFullYear(), n.getMonth(), 1);
  });
  const [now] = useState(() => new Date());
  const timeline = useTimeline();
  const open = useDetail((s) => s.open);

  const upcoming = useMemo(
    () => windowTimeline(timeline.events, now, HOME_TIMELINE_WINDOW_DAYS, { includeOpenPast: true }).filter((e) => e.class !== "executed"),
    [timeline.events, now]
  );
  const visible = upcoming.slice(0, PREVIEW_ROWS);
  const expandTo = mode === "calendar" ? "/calendar?view=month" : "/calendar?view=timeline";
  const expandLabel = mode === "calendar" ? "Open full calendar" : "Open full timeline";

  return (
    <section className="home-card" data-water-quiet="center" aria-label="Calendar and timeline preview">
      <header className="home-card-head">
        <div className="home-card-left">
          {mode === "calendar" ? (
            <>
              <button
                type="button"
                className="icon-button"
                aria-label="Previous month"
                onClick={() => setMonth((m) => new Date(m.getFullYear(), m.getMonth() - 1, 1))}
              >
                <IconChevronLeft size={18} />
              </button>
              <h2 className="home-card-title" aria-live="polite">
                {fmtMonthYear(month)}
              </h2>
              <button
                type="button"
                className="icon-button"
                aria-label="Next month"
                onClick={() => setMonth((m) => new Date(m.getFullYear(), m.getMonth() + 1, 1))}
              >
                <IconChevronRight size={18} />
              </button>
            </>
          ) : (
            <div className="home-card-static">
              <h2 className="home-card-title">Upcoming</h2>
              <span className="muted small">Next {HOME_TIMELINE_WINDOW_DAYS} days</span>
            </div>
          )}
        </div>
        <div className="segmented" role="group" aria-label="Preview mode">
          <button type="button" aria-pressed={mode === "calendar"} onClick={() => setMode("calendar")}>
            Calendar
          </button>
          <button type="button" aria-pressed={mode === "timeline"} onClick={() => setMode("timeline")}>
            Timeline
          </button>
        </div>
        <Link to={expandTo} className="icon-button expand-button tip" aria-label={expandLabel} data-tip={expandLabel}>
          <IconExpand size={18} />
        </Link>
      </header>

      <div className="home-card-body" key={mode}>
        {mode === "calendar" ? (
          <div className="view-enter">
            <MonthGrid
              month={month}
              events={timeline.events}
              now={now}
              density="preview"
              onDay={(day, el) => open({ kind: "day", day }, el)}
              onEvent={(id, el) => open({ kind: "event", eventId: id }, el)}
            />
          </div>
        ) : (
          <div className="view-enter home-timeline">
            {!timeline.hasWallet && (
              <p className="connect-note">
                Connect your wallet to see your own positions here.{" "}
                <button type="button" className="btn-link" onClick={requestOpenWallet}>
                  Connect wallet
                </button>
              </p>
            )}
            {timeline.isLoading && upcoming.length === 0 ? (
              <p className="muted empty-state" aria-busy="true">
                Loading events…
              </p>
            ) : upcoming.length === 0 ? (
              <div className="empty-state">
                <p>No upcoming activity in this period.</p>
                <Link className="btn btn-primary" to="/explore">
                  Explore opportunities
                </Link>
              </div>
            ) : (
              <>
                <TimelineList events={visible} now={now} variant="preview" onEvent={(id, el) => open({ kind: "event", eventId: id }, el)} />
                {upcoming.length > visible.length && (
                  <Link className="view-more" to="/calendar?view=timeline">
                    View more ({upcoming.length - visible.length})
                  </Link>
                )}
              </>
            )}
          </div>
        )}
      </div>
      <footer className="home-card-foot">
        <SourceStatusLine sources={timeline.sources} />
      </footer>
    </section>
  );
}
