/**
 * ExploreMenu — refined diner menu (UI v2 §10)。
 * データは BFF の実 listing (/menu-listings)。APY は必ず label 付き、
 * sponsored / featured は既存データに無いので出さない (捏造しない)。
 */
import { useMemo, useState } from "react";
import type { PositionCategory, ProtocolMenuEntry, ProtocolPool } from "@workspace/lib/types";
import { useMenuListings } from "../services/queries";
import { ChainIcon } from "../ui/ChainIcon";
import { fmtCompactUsd, fmtRatio } from "../ui/format";
import { ProtocolBadge } from "../ui/ProtocolBadge";
import { Notice } from "../shell/WorkspaceShell";
import "./explore.css";

const SECTION: Partial<Record<PositionCategory, string>> & Record<string, string> = {
  lending: "Lending",
  lp: "Liquidity",
  vault: "Yield",
  pt_yt: "Fixed yield",
  staking: "Staking",
  restaking: "Staking",
  stable: "Stable yield",
  vesting: "Vesting",
  governance: "Governance",
  other: "Other",
};

interface MenuItem {
  protocol: ProtocolMenuEntry;
  pool: ProtocolPool;
  section: string;
}

export default function ExploreMenu() {
  const q = useMenuListings();
  const [tab, setTab] = useState("All");
  const [query, setQuery] = useState("");

  const items = useMemo<MenuItem[]>(
    () =>
      (q.data ?? []).flatMap((p) =>
        p.pools.map((pool) => ({ protocol: p, pool, section: SECTION[pool.category] ?? "Other" }))
      ),
    [q.data]
  );
  const tabs = useMemo(() => ["All", ...Array.from(new Set(items.map((i) => i.section)))], [items]);
  const filtered = items.filter(
    (i) =>
      (tab === "All" || i.section === tab) &&
      (query === "" || `${i.protocol.display_name} ${i.pool.name} ${i.pool.asset}`.toLowerCase().includes(query.toLowerCase()))
  );
  const sections = Array.from(new Set(filtered.map((i) => i.section)));

  return (
    <div className="menu-page" data-water-quiet="work">
      <header className="menu-header">
        <div>
          <p className="menu-kicker">Seasonals</p>
          <h1 className="menu-title">Menu</h1>
          <p className="menu-sub">Explore Seasonals · Pick what goes on your calendar.</p>
        </div>
        <label className="menu-search">
          <span className="sr-only">Search the menu</span>
          <input className="input" placeholder="Search protocols or assets" value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
      </header>
      <div className="menu-tabs" role="tablist" aria-label="Menu sections">
        {tabs.map((t) => (
          <button key={t} role="tab" type="button" aria-selected={tab === t} className="menu-tab" onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </div>

      {q.isPending && <p className="muted">Loading the menu…</p>}
      {q.isError && (
        <Notice tone="warning" title="The menu could not be loaded.">
          The Seasonals server did not return protocol listings. No data is shown instead of guessing.
        </Notice>
      )}
      {q.isSuccess && filtered.length === 0 && <p className="muted">Nothing on the menu matches.</p>}

      {sections.map((section) => (
        <section key={section} className="menu-section" aria-labelledby={`sec-${section}`}>
          <h2 id={`sec-${section}`} className="menu-section-title">
            <span>{section}</span>
          </h2>
          <ul className="menu-items">
            {filtered
              .filter((i) => i.section === section)
              .map((i) => (
                <MenuCard key={i.pool.pool_id} item={i} />
              ))}
          </ul>
        </section>
      ))}
      <p className="menu-foot muted small">
        Rates are current values reported by each protocol, not a promise of future returns. Listings come from the Seasonals server.
      </p>
    </div>
  );
}

function availability(pool: ProtocolPool): { label: string; tone: "ok" | "warn" } | null {
  if (pool.display_only) return { label: "View only", tone: "warn" };
  if (pool.deposit_open === false) {
    const why = pool.deposit_closed_reason === "full" ? "Deposit cap reached" : pool.deposit_closed_reason === "suspended" ? "Suspended" : "Deposits paused";
    return { label: why, tone: "warn" };
  }
  if (pool.deposit_open === true) return { label: "Open", tone: "ok" };
  return null;
}

function MenuCard({ item }: { item: MenuItem }) {
  const { protocol, pool } = item;
  const [open, setOpen] = useState(false);
  const avail = availability(pool);
  return (
    <li className="menu-item">
      <div className="menu-item-top">
        <ProtocolBadge id={protocol.icon_id} name={protocol.display_name} size={40} />
        <div className="menu-item-name">
          <h3>{pool.name}</h3>
          <p className="menu-item-protocol">{protocol.display_name}</p>
          <p className="muted small inline-icon-left">
            {item.section} · <ChainIcon chain="solana" size={12} /> Solana
          </p>
        </div>
        <div className="menu-price">
          <span className="menu-price-label">APY</span>
          <span className="menu-price-value">{fmtRatio(pool.apy)}</span>
        </div>
      </div>
      <div className="menu-rule" aria-hidden="true" />
      <dl className="menu-facts">
        <div>
          <dt>Asset</dt>
          <dd>{pool.asset}</dd>
        </div>
        <div>
          <dt>TVL</dt>
          <dd>{fmtCompactUsd(pool.tvl_usd)}</dd>
        </div>
        {pool.utilization !== undefined && (
          <div>
            <dt>Utilization</dt>
            <dd>{fmtRatio(pool.utilization)}</dd>
          </div>
        )}
      </dl>
      <div className="menu-item-foot">
        {avail && <span className={`ticket ticket-${avail.tone}`}>{avail.label}</span>}
        <button type="button" className="btn btn-quiet" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {open ? "Hide details" : "View details"}
        </button>
      </div>
      {open && (
        <div className="menu-details small">
          <p>
            {protocol.display_name} {pool.name} accepts {pool.deposit_asset ?? pool.asset}. Depositing and withdrawing run on the Seeker app today; the web
            version shows this listing read-only.
          </p>
          {pool.borrowed_usd !== undefined && <p>Borrowed: {fmtCompactUsd(pool.borrowed_usd)}</p>}
        </div>
      )}
    </li>
  );
}
