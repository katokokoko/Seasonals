/**
 * Learn の詳細 — 一覧カードが拡大して出てくるダイアログ (FLIP)。
 * 開く: 最終位置 (中央) に置いてから、元カードの位置・大きさに合わせた transform → none へ。
 * 閉じる: 逆向きに縮めてから unmount。prefers-reduced-motion では動かさない。
 * role="dialog" + aria-modal、Esc / 背景クリック / Close、Tab は中で循環、閉じたら trigger へ focus を戻す。
 */
import { useCallback, useLayoutEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router";
import { ProtocolBadge, brandStyle } from "../ui/ProtocolBadge";
import { IconClose } from "../ui/icons";
import { useModalFocus } from "../ui/useModalFocus";
import type { LearnEntry } from "./content";

const DURATION = 240;

function prefersReducedMotion(): boolean {
  // matchMedia が無い環境 (jsdom 等) は動かさない側に倒す
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? true;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="learn-section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

function List({ items, ordered }: { items: string[]; ordered?: boolean }) {
  const Tag = ordered ? "ol" : "ul";
  return (
    <Tag className="learn-list">
      {items.map((t) => (
        <li key={t}>{t}</li>
      ))}
    </Tag>
  );
}

export function LearnDetail({
  entry,
  origin,
  trigger,
  onClose,
}: {
  entry: LearnEntry;
  /** 拡大の起点 (一覧カードの位置と大きさ) */
  origin: DOMRect | null;
  /** 閉じた時に focus を戻す要素 (Details ボタン) */
  trigger: HTMLElement | null;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const closing = useRef(false);
  const titleId = `learn-${entry.id}-title`;
  const animate = Boolean(origin) && !prefersReducedMotion();

  const fromOrigin = useCallback(() => {
    const el = ref.current!;
    const to = el.getBoundingClientRect();
    const o = origin!;
    return `translate(${o.left - to.left}px, ${o.top - to.top}px) scale(${o.width / to.width}, ${o.height / to.height})`;
  }, [origin]);

  useLayoutEffect(() => {
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden"; // 背面のスクロールを止める
    const el = ref.current;
    if (animate && el) {
      el.style.transformOrigin = "top left";
      el.style.transform = fromOrigin();
      el.style.opacity = "0.6";
      void el.getBoundingClientRect(); // 初期状態を確定させてから遷移させる
      el.style.transition = `transform ${DURATION}ms ease-out, opacity ${DURATION}ms ease-out`;
      el.style.transform = "none";
      el.style.opacity = "1";
    }
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, [animate, fromOrigin]);

  const requestClose = useCallback(() => {
    if (closing.current) return;
    closing.current = true;
    const el = ref.current;
    if (!animate || !el) {
      onClose();
      return;
    }
    el.style.transform = fromOrigin();
    el.style.opacity = "0";
    window.setTimeout(onClose, DURATION);
  }, [animate, fromOrigin, onClose]);

  useModalFocus(ref, true, requestClose, trigger);

  return createPortal(
    <div className="learn-layer" onMouseDown={(e) => e.target === e.currentTarget && requestClose()}>
      <div
        ref={ref}
        className="learn-detail"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        style={brandStyle(entry.id)}
        data-water-quiet="detail"
      >
        <button type="button" className="icon-button learn-close" aria-label="Close" onClick={requestClose}>
          <IconClose size={18} />
        </button>
        <header className="learn-card-head">
          <ProtocolBadge id={entry.id} name={entry.name} size={72} />
          <div>
            <h2 id={titleId} tabIndex={-1} data-autofocus>
              {entry.name}
            </h2>
            <p className="learn-tagline">{entry.tagline}</p>
          </div>
        </header>
        <div className="learn-detail-body">
          <Section title="What it is">
            <p>{entry.whatItIs}</p>
          </Section>
          <Section title="How it works">
            <List items={entry.howItWorks} ordered />
          </Section>
          <Section title="Strengths">
            <List items={entry.strengths} />
          </Section>
          <Section title="Things to know">
            <List items={entry.risks} />
          </Section>
          <Section title="On your calendar">
            <List items={entry.onYourCalendar} />
          </Section>
          <Section title="In Seasonals">
            <p>{entry.inSeasonals}</p>
          </Section>
        </div>
        <footer className="learn-card-foot">
          <Link className="btn btn-quiet" to="/menu">
            See on Menu
          </Link>
          <span className="learn-links">
            <a href={entry.docs} target="_blank" rel="noreferrer">
              Docs ↗
            </a>
            <a className="btn btn-primary" href={entry.site} target="_blank" rel="noreferrer">
              Open site ↗
            </a>
          </span>
        </footer>
      </div>
    </div>,
    document.body
  );
}
