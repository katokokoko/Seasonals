/**
 * EventDetailCard — 日付 / event を押した時の前面詳細カード (UI v2 §4, §12)。
 * - portal で最前面、role="dialog" + aria-labelledby、focus trap、Esc / 外側 click / Close
 * - close 時は開いた要素へ focus を戻す。同時に 1 枚だけ
 * - 押した要素の近くに anchor、入らなければ中央
 * - action は event.actions (Seeker と同じく event 側が持つ)。wallet 必須 action は
 *   未接続なら Connect wallet の案内に置き換え、結果を模擬しない
 */
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router";
import { chainInfo } from "@workspace/lib/config/chains";
import { deriveTimelineStatus, displayStatus, dayKey } from "@workspace/lib/derive/timeline";
import type { TimelineAction, TimelineEvent } from "@workspace/lib/types";
import { useActiveAddresses } from "../state/session";
import { ChainIcon } from "../ui/ChainIcon";
import { fmtAmount, fmtFullDate, fmtMetric, fmtTime, fmtUsd, parseDayKey } from "../ui/format";
import { IconClose, IconExternal } from "../ui/icons";
import { ProtocolBadge } from "../ui/ProtocolBadge";
import { STATUS_COLOR } from "../styles/tokens";
import { Droplet } from "./Droplet";
import { requestOpenWallet, useDetail } from "./detailStore";
import { CLASS_LABEL, KIND_LABEL, shapeForKind, statusText } from "./labels";
import { StatusBadge } from "./StatusBadge";
import { ActionPreview } from "./ActionPreview";
import { useNow } from "../ui/useNow";
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
      const f = [...cardRef.current.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input, [tabindex]:not([tabindex="-1"])')];
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
            <EventBody event={event} titleId={titleId} now={now} onDone={close} />
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
  return (
    <div className="detail-body">
      <p className="overline">Day</p>
      <h2 id={titleId}>{fmtFullDate(date)}</h2>
      {events.length === 0 ? (
        <>
          <p className="muted">Nothing scheduled.</p>
          <div className="detail-actions">
            <Link className="btn btn-primary" to="/explore" data-autofocus>
              Explore opportunities
            </Link>
          </div>
        </>
      ) : (
        <ul className="day-list">
          {events.map((e, i) => {
            const st = displayStatus(e, deriveTimelineStatus(e, now));
            return (
              <li key={e.id}>
                <button type="button" className="day-list-item" onClick={() => onPick(e.id)} {...(i === 0 ? { "data-autofocus": true } : {})}>
                  <Droplet shape={shapeForKind(e.kind, e.class)} color={STATUS_COLOR[st]} size={12} />
                  <span className="day-list-text">
                    <strong>{e.title}</strong>
                    <span className="muted small">
                      {e.protocolName ?? "Plan"} · {e.atApprox ? "≈ " : ""}
                      {e.at ? fmtTime(new Date(e.at)) : "time unknown"}
                    </span>
                  </span>
                  <StatusBadge status={st} compact />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <Link className="text-link" to={`/calendar?view=month&date=${day}`}>
        Open this day in calendar
      </Link>
    </div>
  );
}

function EventBody({ event, titleId, now, onDone }: { event: TimelineEvent; titleId: string; now: Date; onDone: () => void }) {
  const active = useActiveAddresses();
  // owner のある event は、その address を閲覧 (watch) または接続している時だけ action を出す
  const hasWalletForChain = active.some(
    (a) => a.chain === event.chain && (!event.owner || a.address.toLowerCase() === event.owner.toLowerCase())
  );
  const status = deriveTimelineStatus(event, now);
  const st = displayStatus(event, status);
  const at = event.at ? new Date(event.at) : null;
  const day = at ? dayKey(at) : null;
  const [preview, setPreview] = useState<TimelineAction | null>(null);
  const needsWallet = event.actions.some((a) => a.requiresWallet) && !hasWalletForChain;

  return (
    <div className="detail-body">
      <div className="detail-head">
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
          {at ? `${event.atApprox ? "≈ " : ""}${fmtTime(at)}` : "—"}
          {event.etaNote && <span className="muted small block">{event.etaNote}</span>}
        </dd>
        <dt>Chain</dt>
        <dd className="inline-icon">
          <ChainIcon chain={event.chain} size={14} /> {chainInfo(event.chain).name}
        </dd>
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

      {preview ? (
        <ActionPreview event={event} action={preview} onBack={() => setPreview(null)} />
      ) : event.actions.length > 0 ? (
        <div className="detail-actions">
          {needsWallet ? (
            <div className="wallet-gate">
              <p className="small muted">Connect or watch a {chainInfo(event.chain).name} wallet to act on this event.</p>
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
