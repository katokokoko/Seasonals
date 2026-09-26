/**
 * EventDetailCard — 日付 / event を押した時の前面詳細カード (UI v2 §4, §12)。
 * - portal で最前面、role="dialog" + aria-labelledby、focus trap、Esc / 外側 click / Close
 * - close 時は開いた要素へ focus を戻す。同時に 1 枚だけ
 * - 押した要素の近くに anchor、入らなければ中央
 * - action は event.actions (Seeker と同じく event 側が持つ)。wallet 必須 action は
 *   未接続なら Connect wallet の案内に置き換え、結果を模擬しない
 * - 日付を押した時はその日に自分の予定 (custom plan: 絵文字 + 内容) を追加できる。
 *   custom plan を開いた時だけ編集 / 削除を出す (他の class は読み取り専用)
 */
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router";
import { chainInfo } from "@workspace/lib/config/chains";
import { deriveTimelineStatus, displayStatus, dayKey, isCustomPlan } from "@workspace/lib/derive/timeline";
import type { TimelineAction, TimelineEvent } from "@workspace/lib/types";
import { useActiveAddresses } from "../state/session";
import { ChainIcon } from "../ui/ChainIcon";
import { fmtAmount, fmtEventTime, fmtFullDate, fmtMetric, fmtTime, fmtUsd, parseDayKey } from "../ui/format";
import { IconClose, IconExternal } from "../ui/icons";
import { ProtocolBadge, brandStyle } from "../ui/ProtocolBadge";
import { EventMarker } from "./EventMarker";
import { requestOpenWallet, useDetail } from "./detailStore";
import { CLASS_LABEL, KIND_LABEL, statusText } from "./labels";
import { StatusBadge } from "./StatusBadge";
import { ActionPreview } from "./ActionPreview";
import { ProposalPanel } from "./ProposalPanel";
import { useNow } from "../ui/useNow";
import { CustomEventForm } from "../calendar/CustomEventForm";
import { useCustomEvents } from "../state/customEvents";
import "./timeline.css";

const CARD_W = 400;
const GAP = 12;

export function EventDetailCard({ events }: { events: TimelineEvent[] }) {
  const { target, trigger, close, swap } = useDetail();
  const cardRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const [pos, setPos] = useState<CSSProperties>({});
  const now = useNow(events);

  // 配置: trigger の右 → 左 → 中央
  useLayoutEffect(() => {
    if (!target) return;
    const card = cardRef.current;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const h = Math.min(card?.offsetHeight ?? 480, vh - 2 * GAP);
    const r = trigger?.isConnected ? trigger.getBoundingClientRect() : null;
    let next: CSSProperties = { left: (vw - CARD_W) / 2, top: Math.max(GAP, (vh - h) / 2) };
    // global nav (上端 ~100px) には被せない。入らない時だけ上へ詰める
    const navBottom = document.querySelector(".global-nav")?.getBoundingClientRect().bottom ?? 0;
    const minTop = vh - h - GAP >= navBottom + GAP ? navBottom + GAP : GAP;
    if (r && vw >= 900) {
      const top = Math.min(Math.max(minTop, r.top + r.height / 2 - h / 2), vh - h - GAP);
      if (r.right + GAP + CARD_W <= vw - GAP) next = { left: r.right + GAP, top };
      else if (r.left - GAP - CARD_W >= GAP) next = { left: r.left - GAP - CARD_W, top };
    }
    setPos(next);
  }, [target, trigger]);

  // focus: open 時に card へ、close 時に trigger へ戻す
  useEffect(() => {
    if (!target) return;
    const prev = trigger;
    const t = window.setTimeout(() => {
      const first = cardRef.current?.querySelector<HTMLElement>("[data-autofocus]") ?? cardRef.current;
      first?.focus();
    }, 0);
    return () => {
      window.clearTimeout(t);
      if (prev?.isConnected) prev.focus();
    };
  }, [target, trigger]);

  useEffect(() => {
    if (!target) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
        return;
      }
      if (e.key !== "Tab" || !cardRef.current) return;
      const f = [...cardRef.current.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input, textarea, [tabindex]:not([tabindex="-1"])')];
      if (f.length === 0) return;
      const first = f[0]!;
      const last = f[f.length - 1]!;
      if (e.shiftKey && (document.activeElement === first || document.activeElement === cardRef.current)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [target, close]);

  if (!target) return null;

  const event = target.kind === "event" ? events.find((e) => e.id === target.eventId) : undefined;
  const dayEvents =
    target.kind === "day" ? events.filter((e) => e.at !== null && dayKey(new Date(e.at)) === target.day) : [];

  return createPortal(
    <div className="detail-layer" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div
        ref={cardRef}
        className="detail-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        style={pos}
        data-water-quiet="detail"
      >
        <button type="button" className="icon-button detail-close" aria-label="Close" onClick={close}>
          <IconClose size={18} />
        </button>
        {target.kind === "event" ? (
          event ? (
            isCustomPlan(event) ? (
              <CustomPlanBody event={event} titleId={titleId} now={now} onDone={close} />
            ) : (
              <EventBody event={event} titleId={titleId} now={now} onDone={close} />
            )
          ) : (
            <div className="detail-body">
              <h2 id={titleId}>Event not found</h2>
              <p className="muted">This event is no longer in the current data.</p>
            </div>
          )
        ) : (
          <DayBody
            day={target.day}
            events={dayEvents}
            titleId={titleId}
            now={now}
            onPick={(id) => swap({ kind: "event", eventId: id })}
          />
        )}
      </div>
    </div>,
    document.body
  );
}

function DayBody({
  day,
  events,
  titleId,
  now,
  onPick,
}: {
  day: string;
  events: TimelineEvent[];
  titleId: string;
  now: Date;
  onPick: (id: string) => void;
}) {
  const date = parseDayKey(day);
  const [adding, setAdding] = useState(false);
  const add = useCustomEvents((s) => s.add);
  return (
    <div className="detail-body">
      <p className="overline">Day</p>
      <h2 id={titleId}>{fmtFullDate(date)}</h2>
      {events.length === 0 ? (
        !adding && <p className="muted">Nothing scheduled.</p>
      ) : (
        <ul className="day-list">
          {events.map((e, i) => {
            const st = displayStatus(e, deriveTimelineStatus(e, now));
            return (
              <li key={e.id}>
                <button type="button" className="day-list-item" onClick={() => onPick(e.id)} {...(i === 0 && !adding ? { "data-autofocus": true } : {})}>
                  <EventMarker event={e} status={st} size={12} />
                  <span className="day-list-text">
                    <strong>{e.title}</strong>
                    <span className="muted small">
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
          day={day}
          onSave={(input) => {
            add(input);
            setAdding(false);
          }}
          onCancel={() => setAdding(false)}
        />
      ) : (
        <div className="detail-actions">
          <button type="button" className="btn btn-primary" onClick={() => setAdding(true)} {...(events.length === 0 ? { "data-autofocus": true } : {})}>
            + Add plan
          </button>
          {events.length === 0 && (
            <Link className="btn" to="/menu">
              Browse the menu
            </Link>
          )}
        </div>
      )}
      <Link className="text-link" to={`/calendar?view=month&date=${day}`}>
        Open this day in calendar
      </Link>
    </div>
  );
}

/** ユーザーが手入力した予定: 内容を見せて、その場で編集 / 削除 */
function CustomPlanBody({ event, titleId, now, onDone }: { event: TimelineEvent; titleId: string; now: Date; onDone: () => void }) {
  const ceId = event.id.replace(/^custom:/, "");
  const ce = useCustomEvents((s) => s.events.find((e) => e.id === ceId));
  const update = useCustomEvents((s) => s.update);
  const remove = useCustomEvents((s) => s.remove);
  const [editing, setEditing] = useState(false);
  const st = displayStatus(event, deriveTimelineStatus(event, now));
  const at = event.at ? new Date(event.at) : null;
  const day = at ? dayKey(at) : null;

  if (editing && ce) {
    return (
      <div className="detail-body">
        <p className="overline">Your plan</p>
        <h2 id={titleId}>Edit plan</h2>
        <CustomEventForm
          day={ce.date}
          initial={{ date: ce.date, title: ce.title, emoji: ce.emoji ?? "📅", note: ce.note ?? "" }}
          onSave={(input) => {
            update(ce.id, input);
            setEditing(false);
          }}
          onCancel={() => setEditing(false)}
          onDelete={() => {
            remove(ce.id);
            onDone();
          }}
        />
      </div>
    );
  }

  return (
    <div className="detail-body">
      <div className="detail-head">
        <span className="plan-emoji-large" aria-hidden="true">
          {event.emoji ?? "📅"}
        </span>
        <div>
          <p className="overline">{CLASS_LABEL[event.class]}</p>
          <h2 id={titleId}>{event.title}</h2>
        </div>
      </div>
      <div className="tag-row">
        <span className={`class-tag class-${event.class}`}>{CLASS_LABEL[event.class]}</span>
        <StatusBadge status={st} label={statusText(event, deriveTimelineStatus(event, now))} />
      </div>
      <dl className="detail-grid">
        <dt>Date</dt>
        <dd>{at ? fmtFullDate(at) : "—"}</dd>
        <dt>Time</dt>
        <dd>{fmtEventTime(event) ?? "—"}</dd>
        {ce?.note && (
          <>
            <dt>Note</dt>
            <dd className="plan-note">{ce.note}</dd>
          </>
        )}
      </dl>
      <div className="detail-actions">
        <button type="button" className="btn btn-primary" data-autofocus onClick={() => setEditing(true)} disabled={!ce}>
          Edit plan
        </button>
      </div>
      <div className="detail-footer">
        {day && (
          <Link className="text-link" to={`/calendar?view=month&date=${day}`}>
            Open in calendar
          </Link>
        )}
      </div>
      <p className="freshness">Saved in this browser only.</p>
    </div>
  );
}

function EventBody({ event, titleId, now, onDone }: { event: TimelineEvent; titleId: string; now: Date; onDone: () => void }) {
  const active = useActiveAddresses();
  // owner のある event は、その address を閲覧 (watch) または接続している時だけ action を出す
  const hasWalletForChain = active.some(
    (a) => event.chain !== null && a.chain === event.chain && (!event.owner || a.address.toLowerCase() === event.owner.toLowerCase())
  );
  const status = deriveTimelineStatus(event, now);
  const st = displayStatus(event, status);
  const at = event.at ? new Date(event.at) : null;
  const day = at ? dayKey(at) : null;
  const [preview, setPreview] = useState<TimelineAction | null>(null);
  const needsWallet = event.actions.some((a) => a.requiresWallet) && !hasWalletForChain;

  return (
    <div className="detail-body">
      <div className="detail-head brand-tint" style={brandStyle(event.protocol)}>
        <ProtocolBadge id={event.protocol} name={event.protocolName} size={36} />
        <div>
          <p className="overline">{event.protocolName ?? CLASS_LABEL[event.class]}</p>
          <h2 id={titleId}>{event.title}</h2>
        </div>
      </div>
      <div className="tag-row">
        <span className={`class-tag class-${event.class}`}>{CLASS_LABEL[event.class]}</span>
        <span className="tag">{KIND_LABEL[event.kind]}</span>
        <StatusBadge status={st} label={statusText(event, status)} />
      </div>
      <dl className="detail-grid">
        <dt>Date</dt>
        <dd>{at ? fmtFullDate(at) : "Not scheduled yet"}</dd>
        <dt>Time</dt>
        <dd>
          {fmtEventTime(event) ?? "—"}
          {event.etaNote && <span className="muted small block">{event.etaNote}</span>}
        </dd>
        {event.chain && (
          <>
            <dt>Chain</dt>
            <dd className="inline-icon">
              <ChainIcon chain={event.chain} size={14} /> {chainInfo(event.chain).name}
            </dd>
          </>
        )}
        {event.asset && (
          <>
            <dt>Position</dt>
            <dd>{event.asset}</dd>
          </>
        )}
        {event.amount && (
          <>
            <dt>Amount</dt>
            <dd>{fmtAmount(event.amount)}</dd>
          </>
        )}
        {event.usd && (
          <>
            <dt>Value (USD)</dt>
            <dd>{fmtUsd(event.usd)}</dd>
          </>
        )}
        {event.metrics.map((m) => (
          <FragmentRow key={m.label} label={m.label} value={fmtMetric(m)} />
        ))}
      </dl>

      {!preview && hasWalletForChain && event.chain === "ethereum" && event.owner && event.class === "protocol" && event.actions.length > 0 && (
        <ProposalPanel event={event} />
      )}
      {preview ? (
        <ActionPreview event={event} action={preview} onBack={() => setPreview(null)} />
      ) : event.actions.length > 0 ? (
        <div className="detail-actions">
          {needsWallet ? (
            <div className="wallet-gate">
              <p className="small muted">Connect or watch a {event.chain ? chainInfo(event.chain).name : ""} wallet to act on this event.</p>
              <button
                type="button"
                className="btn btn-primary"
                data-autofocus
                onClick={() => {
                  onDone();
                  requestOpenWallet();
                }}
              >
                Connect wallet
              </button>
            </div>
          ) : (
            event.actions.map((a, i) => (
              <ActionButton key={a.actionType + i} action={a} first={i === 0} onPreview={() => setPreview(a)} />
            ))
          )}
        </div>
      ) : null}

      <div className="detail-footer">
        {day && (
          <Link className="text-link" to={`/calendar?view=month&date=${day}`}>
            Open in calendar
          </Link>
        )}
        {event.links.map((l) => (
          <a key={l.url} className="text-link" href={l.url} target="_blank" rel="noreferrer">
            {l.label} <IconExternal size={12} />
          </a>
        ))}
      </div>
      <p className="freshness">
        Source: {event.source} · observed {fmtTime(new Date(event.observedAt))}
      </p>
    </div>
  );
}

function FragmentRow({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </>
  );
}

function ActionButton({ action, first, onPreview }: { action: TimelineAction; first: boolean; onPreview: () => void }) {
  if (action.availability === "available") {
    return (
      <button type="button" className="btn btn-primary" onClick={onPreview} {...(first ? { "data-autofocus": true } : {})}>
        {action.label}
      </button>
    );
  }
  return (
    <div className="action-disabled">
      <button type="button" className="btn" disabled aria-describedby={`why-${action.actionType}`}>
        {action.label}
      </button>
      <span id={`why-${action.actionType}`} className="small muted">
        {action.reason ?? (action.availability === "not_yet" ? "Not available yet." : "Not supported on web yet.")}
      </span>
    </div>
  );
}
