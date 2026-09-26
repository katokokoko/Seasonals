/**
 * Learn — 初学者向けのプロトコル解説 (大きめのカード + 大きいロゴ + 公式サイトへのリンク)。
 * 文章は learn/content.ts (公式 docs で裏取りした静的データ)。変わる数値 (APY / TVL) は書かず Menu へ誘導する。
 * /learn#<id> でそのカードへスクロールし、見出しへ focus を移す (Menu カードの「Learn」から来た時)。
 */
import { useEffect } from "react";
import { Link, useLocation } from "react-router";
import { ProtocolBadge, brandStyle } from "../ui/ProtocolBadge";
import { LEARN, type LearnEntry } from "./content";
import "./learn.css";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
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

export function LearnCard({ entry }: { entry: LearnEntry }) {
  const headingId = `learn-${entry.id}-title`;
  return (
    <article id={entry.id} className="learn-card" style={brandStyle(entry.id)} aria-labelledby={headingId}>
      <header className="learn-card-head">
        <ProtocolBadge id={entry.id} name={entry.name} size={72} />
        <div>
          <h2 id={headingId} tabIndex={-1}>
            {entry.name}
          </h2>
          <p className="learn-tagline">{entry.tagline}</p>
        </div>
      </header>
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
      <footer className="learn-card-foot">
        <Link className="btn btn-quiet" to="/explore">
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
    </article>
  );
}

export default function LearnPage() {
  const { hash } = useLocation();
  useEffect(() => {
    const id = hash.replace(/^#/, "");
    if (!id) return;
    const card = document.getElementById(id);
    if (!card) return;
    card.scrollIntoView({ block: "start" });
    document.getElementById(`learn-${id}-title`)?.focus({ preventScroll: true });
  }, [hash]);

  return (
    <div className="learn-page" data-water-quiet="work">
      <header className="learn-header">
        <p className="learn-kicker">Seasonals</p>
        <h1 className="learn-title">Learn</h1>
        <p className="learn-sub">Plain-language guides to the protocols Seasonals reads. Live rates are on the Menu.</p>
      </header>
      <div className="learn-grid">
        {LEARN.map((e) => (
          <LearnCard key={e.id} entry={e} />
        ))}
      </div>
      <p className="learn-disclaimer muted small">
        These guides explain how each protocol works; they are not financial advice. Details can change, so check each protocol's own docs before
        using it.
      </p>
    </div>
  );
}
