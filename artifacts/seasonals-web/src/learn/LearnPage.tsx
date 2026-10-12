/**
 * Learn — 初学者向けのプロトコル解説。
 * 一覧は横 3 枚のコンパクトなカード (ロゴ / tagline / 要点 3 行 / Details / Open site)。
 * Details で詳細 (LearnDetail) がカードから拡大して開く。文章は learn/content.ts (公式 docs で裏取り済み)。
 * /learn#<id> で開くとその詳細を開いた状態にする (Menu カードの「Learn」から)。閉じたら hash を消す。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { ProtocolBadge, brandStyle } from "../ui/ProtocolBadge";
import { LEARN, type LearnEntry } from "./content";
import { LearnDetail } from "./LearnDetail";
import "./learn.css";

interface Open {
  id: string;
  origin: DOMRect | null;
  trigger: HTMLElement | null;
}

export function LearnCard({ entry, onDetails }: { entry: LearnEntry; onDetails: (card: HTMLElement, button: HTMLElement) => void }) {
  const cardRef = useRef<HTMLElement>(null);
  return (
    <article ref={cardRef} id={entry.id} className="learn-card" style={brandStyle(entry.id)} aria-labelledby={`learn-${entry.id}-name`}>
      <header className="learn-card-head">
        <ProtocolBadge id={entry.id} name={entry.name} size={56} />
        <div>
          <h2 id={`learn-${entry.id}-name`}>{entry.name}</h2>
          <p className="learn-tagline">{entry.tagline}</p>
        </div>
      </header>
      <ul className="learn-points">
        {entry.keyPoints.map((p) => (
          <li key={p}>{p}</li>
        ))}
      </ul>
      <footer className="learn-card-bottom">
        <button
          type="button"
          className="btn btn-primary"
          aria-haspopup="dialog"
          data-learn-details={entry.id}
          onClick={(e) => cardRef.current && onDetails(cardRef.current, e.currentTarget)}
        >
          Details
        </button>
        <a className="learn-open-link" href={entry.site} target="_blank" rel="noreferrer">
          Open site ↗
        </a>
      </footer>
    </article>
  );
}

export default function LearnPage() {
  const { hash, pathname } = useLocation();
  const navigate = useNavigate();
  const [open, setOpen] = useState<Open | null>(null);

  // /learn#<id>: そのカードの詳細を開く (起点はカード、focus の戻り先は Details)
  useEffect(() => {
    const id = hash.replace(/^#/, "");
    if (!id || !LEARN.some((e) => e.id === id)) return;
    const card = document.getElementById(id);
    card?.scrollIntoView({ block: "center" });
    setOpen({
      id,
      origin: card?.getBoundingClientRect() ?? null,
      trigger: document.querySelector<HTMLElement>(`[data-learn-details="${id}"]`),
    });
  }, [hash]);

  const onDetails = useCallback(
    (card: HTMLElement, button: HTMLElement) => setOpen({ id: card.id, origin: card.getBoundingClientRect(), trigger: button }),
    []
  );
  const onClose = useCallback(() => {
    setOpen(null);
    if (hash) navigate(pathname, { replace: true });
  }, [hash, navigate, pathname]);

  const entry = open ? LEARN.find((e) => e.id === open.id) : undefined;

  return (
    <div className="learn-page" data-water-quiet="work">
      <header className="learn-header">
        <p className="learn-kicker">Seasonals</p>
        <h1 className="learn-title">Learn</h1>
        <p className="learn-sub">Plain-language guides to the protocols Seasonals reads. Live rates are on the Menu.</p>
      </header>
      <div className="learn-grid">
        {LEARN.map((e) => (
          <LearnCard key={e.id} entry={e} onDetails={onDetails} />
        ))}
      </div>
      <p className="learn-disclaimer muted small">
        These guides explain how each protocol works; they are not financial advice. Details can change, so check each protocol's own docs before
        using it.
      </p>
      {open && entry && <LearnDetail key={entry.id} entry={entry} origin={open.origin} trigger={open.trigger} onClose={onClose} />}
    </div>
  );
}
