/**
 * CalendarWorkspace — /calendar (UI v2 §8, §9)。
 * ?view=month | week | list | timeline、&date=YYYY-MM-DD。
 * Timeline は同じ route の別 view (TimelineWorkspace)。view 切替は ?view= を
 * replace で更新し full navigation しない。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { dayKey } from "@workspace/lib/derive/timeline";
import type { TimelineEvent, TimelineEventClass } from "@workspace/lib/types";
import type { ChainId } from "@workspace/lib/config/chains";
import { SUPPORTED_CHAINS } from "@workspace/lib/config/chains";
import { useTimeline } from "../services/queries";
import { WorkspaceShell } from "../shell/WorkspaceShell";
import { useDetail } from "../timeline/detailStore";
import { MonthGrid } from "../timeline/MonthGrid";
import { TimelineList } from "../timeline/TimelineList";
import { SourceStatusLine } from "../timeline/SourceStatusLine";
import { CLASS_LABEL } from "../timeline/labels";
import { fmtFullDate, fmtMonthYear, parseDayKey } from "../ui/format";
import { IconChevronDown, IconChevronLeft, IconChevronRight } from "../ui/icons";
import { TimelineWorkspace } from "./TimelineWorkspace";
import { DayPanel } from "./DayPanel";
import { WeekView } from "./WeekView";
import "./calendar.css";

export type CalView = "month" | "week" | "list" | "timeline";
const VIEWS: CalView[] = ["month", "week", "list", "timeline"];

export interface Filters {
  classes: Set<TimelineEventClass>;
  chains: Set<ChainId>;
}

export function applyFilters(events: TimelineEvent[], f: Filters): TimelineEvent[] {
  return events.filter((e) => f.classes.has(e.class) && f.chains.has(e.chain));
}

export default function CalendarWorkspace() {
  const [params, setParams] = useSearchParams();
  const view = (VIEWS.includes(params.get("view") as CalView) ? params.get("view") : "month") as CalView;
  const dateParam = params.get("date");
  const anchor = dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam) ? parseDayKey(dateParam) : new Date();
  const selectedDay = dateParam ?? dayKey(new Date());
  const [now] = useState(() => new Date());
  const timeline = useTimeline();
  const open = useDetail((s) => s.open);
  const [filters, setFilters] = useState<Filters>({
    classes: new Set(["protocol", "user_plan", "executed"]),
    chains: new Set(SUPPORTED_CHAINS.map((c) => c.id)),
  });
  const events = useMemo(() => applyFilters(timeline.events, filters), [timeline.events, filters]);

  const update = (next: Record<string, string | null>) => {
    const p = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) {
      if (v === null) p.delete(k);
      else p.set(k, v);
    }
    setParams(p, { replace: true });
  };
  const shift = (dir: -1 | 1) => {
    const d =
      view === "week"
        ? new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() + 7 * dir)
        : new Date(anchor.getFullYear(), anchor.getMonth() + dir, 1);
    update({ date: dayKey(d) });
  };

  const isTimeline = view === "timeline";
  const monthStart = new Date(anchor.getFullYear(), anchor.getMonth(), 1);

  const viewSwitch = (
    <div className="segmented" role="group" aria-label="Workspace view">
      <button type="button" aria-pressed={!isTimeline} onClick={() => update({ view: "month" })}>
        Calendar
      </button>
      <button type="button" aria-pressed={isTimeline} onClick={() => update({ view: "timeline" })}>
        Timeline
      </button>
    </div>
  );

  const filterChips = <FilterChips filters={filters} onChange={setFilters} />;

  if (isTimeline) {
    return (
      <TimelineWorkspace
        events={events}
        now={now}
        viewSwitch={viewSwitch}
        filterChips={filterChips}
        sources={timeline.sources}
        isLoading={timeline.isLoading}
        hasWallet={timeline.hasWallet}
      />
    );
  }

  const toolbar = (
    <>
      <div className="toolbar-nav">
        <button type="button" className="icon-button" aria-label={view === "week" ? "Previous week" : "Previous month"} onClick={() => shift(-1)}>
          <IconChevronLeft size={18} />
        </button>
        <span className="toolbar-label" aria-live="polite">
          {view === "week" ? `Week of ${fmtFullDate(startOfWeek(anchor))}` : fmtMonthYear(monthStart)}
        </span>
        <button type="button" className="icon-button" aria-label={view === "week" ? "Next week" : "Next month"} onClick={() => shift(1)}>
          <IconChevronRight size={18} />
        </button>
        <button type="button" className="btn btn-quiet" onClick={() => update({ date: dayKey(new Date()) })}>
          Today
        </button>
      </div>
      <div className="segmented" role="group" aria-label="Calendar range">
        {(["month", "week", "list"] as const).map((v) => (
          <button key={v} type="button" aria-pressed={view === v} onClick={() => update({ view: v })}>
            {v[0]!.toUpperCase() + v.slice(1)}
          </button>
        ))}
      </div>
      {filterChips}
      {viewSwitch}
    </>
  );

  const monthEvents = events.filter((e) => {
    if (!e.at) return false;
    const d = new Date(e.at);
    return d.getFullYear() === monthStart.getFullYear() && d.getMonth() === monthStart.getMonth();
  });

  return (
    <WorkspaceShell
      title="Calendar"
      toolbar={toolbar}
      aside={
        <DayPanel
          day={selectedDay}
          events={events.filter((e) => e.at && dayKey(new Date(e.at)) === selectedDay)}
          now={now}
          hasWallet={timeline.hasWallet}
          onEvent={(id, el) => open({ kind: "event", eventId: id }, el)}
        />
      }
    >
      <div className="calendar-content">
        {view === "month" && (
          <MonthGrid
            month={monthStart}
            events={events}
            now={now}
            density="full"
            selectedDay={selectedDay}
            onDay={(day) => update({ date: day })}
            onEvent={(id, el) => open({ kind: "event", eventId: id }, el)}
          />
        )}
        {view === "week" && (
          <WeekView
            start={startOfWeek(anchor)}
            events={events}
            now={now}
            selectedDay={selectedDay}
            onDay={(day) => update({ date: day })}
            onEvent={(id, el) => open({ kind: "event", eventId: id }, el)}
          />
        )}
        {view === "list" &&
          (monthEvents.length === 0 ? (
            <p className="muted empty-state">No events in {fmtMonthYear(monthStart)}.</p>
          ) : (
            <TimelineList events={monthEvents} now={now} variant="full" onEvent={(id, el) => open({ kind: "event", eventId: id }, el)} />
          ))}
        <SourceStatusLine sources={timeline.sources} />
      </div>
    </WorkspaceShell>
  );
}

function startOfWeek(d: Date): Date {
  const offset = (d.getDay() + 6) % 7; // Monday start (Seeker と同じ)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - offset);
}

function FilterChips({ filters, onChange }: { filters: Filters; onChange: (f: Filters) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const toggle = <T,>(set: Set<T>, v: T) => {
    const n = new Set(set);
    if (n.has(v)) n.delete(v);
    else n.add(v);
    return n;
  };
  const off = 3 - filters.classes.size + (SUPPORTED_CHAINS.length - filters.chains.size);
  return (
    <div className="filter-menu" ref={ref}>
      <button type="button" className="btn" aria-haspopup="true" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        Filters{off > 0 ? ` (${off} hidden)` : ""} <IconChevronDown size={14} />
      </button>
      {open && (
        <div className="popover filter-popover">
          <fieldset>
            <legend>Event type</legend>
            {(["protocol", "user_plan", "executed"] as const).map((c) => (
              <label key={c} className="check">
                <input type="checkbox" checked={filters.classes.has(c)} onChange={() => onChange({ ...filters, classes: toggle(filters.classes, c) })} />
                <span className={`class-tag class-${c}`}>{CLASS_LABEL[c]}</span>
              </label>
            ))}
          </fieldset>
          <fieldset>
            <legend>Chain</legend>
            {SUPPORTED_CHAINS.map((c) => (
              <label key={c.id} className="check">
                <input type="checkbox" checked={filters.chains.has(c.id)} onChange={() => onChange({ ...filters, chains: toggle(filters.chains, c.id) })} />
                {c.name}
              </label>
            ))}
          </fieldset>
        </div>
      )}
    </div>
  );
}
