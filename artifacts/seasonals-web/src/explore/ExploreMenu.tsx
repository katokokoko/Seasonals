/**
 * ExploreMenu — refined diner menu (UI v2 §10)。
 * データは BFF の実 listing (/menu-listings)。APY は必ず label 付き、
 * sponsored / featured は既存データに無いので出さない (捏造しない)。
 */
import { useMemo, useState } from "react";
import type { ChainId } from "@workspace/lib/config/chains";
import type { MenuProduct, PositionCategory, ProtocolMenuEntry, ProtocolPool } from "@workspace/lib/types";
import { useEthMenu, useMenuListings } from "../services/queries";
import { fmtFullDate, fmtMetric } from "../ui/format";
import { UniswapRoutePreview } from "./UniswapRoutePreview";
import { ChainIcon } from "../ui/ChainIcon";
import { fmtCompactUsd, fmtRatio } from "../ui/format";
import { ProtocolBadge, brandStyle } from "../ui/ProtocolBadge";
import { TokenKindBadge } from "../ui/TokenKindBadge";
import { Notice } from "../shell/WorkspaceShell";
import "./explore.css";

const SECTION: Partial<Record<PositionCategory, string>> & Record<string, string> = {
  lending: "Lending",
  lp: "Liquidity",
  vault: "Yield",
  pt_yt: "PT/YT",
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
type Row = { kind: "sol"; key: string; section: string; text: string; item: MenuItem } | { kind: "eth"; key: string; section: string; text: string; product: MenuProduct };

export default function ExploreMenu() {
  const q = useMenuListings();
  const eth = useEthMenu();
  const [tab, setTab] = useState("All");
  const [chain, setChain] = useState<"all" | "solana" | "ethereum">("all");
  const [query, setQuery] = useState("");

  const rows = useMemo<Row[]>(
    () => [
      ...(eth.data ?? []).map<Row>((p) => ({
        kind: "eth",
        key: p.id,
        section: SECTION[p.category] ?? "Other",
        text: `${p.protocolName} ${p.name}`,
        product: p,
      })),
      ...(q.data ?? []).flatMap((p) =>
        p.pools.map<Row>((pool) => {
          const item = { protocol: p, pool, section: SECTION[pool.category] ?? "Other" };
          return { kind: "sol", key: pool.pool_id, section: item.section, text: `${p.display_name} ${pool.name} ${pool.asset}`, item };
        })
      ),
    ],
    [q.data, eth.data]
  );
  const chainRows = rows.filter((r) => chain === "all" || (chain === "ethereum") === (r.kind === "eth"));
  const tabs = ["All", ...Array.from(new Set(chainRows.map((i) => i.section)))];
  const activeTab = tabs.includes(tab) ? tab : "All";
  const filtered = chainRows.filter(
    (r) => (activeTab === "All" || r.section === activeTab) && (query === "" || r.text.toLowerCase().includes(query.toLowerCase()))
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
      <div className="menu-chain" role="group" aria-label="Chain">
        {(["all", "ethereum", "solana"] as const).map((c) => (
          <button key={c} type="button" className="filter-chip" aria-pressed={chain === c} onClick={() => setChain(c)}>
            {c === "all" ? "All chains" : c === "ethereum" ? "Ethereum" : "Solana"}
          </button>
        ))}
      </div>
      <div className="menu-tabs" role="tablist" aria-label="Menu sections">
        {tabs.map((t) => (
          <button key={t} role="tab" type="button" aria-selected={activeTab === t} className="menu-tab" onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </div>

      {(q.isPending || eth.isPending) && <p className="muted">Loading the menu…</p>}
      {q.isError && (
        <Notice tone="warning" title="Solana listings could not be loaded.">
          The Seasonals server did not return them. No data is shown instead of guessing.
        </Notice>
      )}
      {eth.isError && (
        <Notice tone="warning" title="Ethereum listings could not be loaded.">
          The Seasonals server did not return them. No data is shown instead of guessing.
        </Notice>
      )}
      {!q.isPending && !eth.isPending && filtered.length === 0 && <p className="muted">Nothing on the menu matches.</p>}

      {sections.map((section) => (
        <section key={section} className="menu-section" aria-labelledby={`sec-${section}`}>
          <h2 id={`sec-${section}`} className="menu-section-title">
            <span>{section}</span>
          </h2>
          <ul className="menu-items">
            {filtered
              .filter((r) => r.section === section)
              .map((r) => (r.kind === "eth" ? <EthMenuCard key={r.key} product={r.product} /> : <MenuCard key={r.key} item={r.item} />))}
          </ul>
        </section>
      ))}
      <p className="menu-foot muted small">
        Rates are current or trailing values reported by each protocol (source shown on each item), not a promise of future returns.
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

/**
 * カード左の列: 上から chain ロゴ → protocol ロゴ → (Pendle のみ) PT / YT バッジ。
 * chain 名は画面では icon だけなので sr-only で読み上げ用に残す。
 */
function MenuMedia({ chain, chainName, protocolId, protocolName, tokenKind }: {
  chain: ChainId;
  chainName: string;
  protocolId: string;
  protocolName: string;
  tokenKind?: "pt" | "yt";
}) {
  return (
    <div className="menu-media">
      <span className="menu-media-chain" title={chainName}>
        <ChainIcon chain={chain} size={14} />
        <span className="sr-only">{chainName}</span>
      </span>
      <ProtocolBadge id={protocolId} name={protocolName} size={40} />
      {tokenKind && <TokenKindBadge kind={tokenKind} />}
    </div>
  );
}

/** "PT-apyUSD" が「PT-」と「apyUSD」に割れないよう、表示だけハイフンを改行しないハイフン (U+2011) にする */
export function noBreakHyphen(name: string): string {
  return name.replace(/-/g, "\u2011");
}

function MenuCard({ item }: { item: MenuItem }) {
  const { protocol, pool } = item;
  const [open, setOpen] = useState(false);
  const avail = availability(pool);
  return (
    <li className="menu-item" style={brandStyle(protocol.icon_id)}>
      <div className="menu-item-top">
        <MenuMedia chain="solana" chainName="Solana" protocolId={protocol.icon_id} protocolName={protocol.display_name} />
        <div className="menu-item-name">
          <h3>{noBreakHyphen(pool.name)}</h3>
          <p className="menu-item-protocol">{protocol.display_name}</p>
          <p className="muted small">{item.section}</p>
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

export function EthMenuCard({ product }: { product: MenuProduct }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="menu-item" style={brandStyle(product.protocolId)}>
      <div className="menu-item-top">
        <MenuMedia
          chain="ethereum"
          chainName="Ethereum"
          protocolId={product.protocolId}
          protocolName={product.protocolName}
          tokenKind={product.tokenKind}
        />
        <div className="menu-item-name">
          <h3>{noBreakHyphen(product.name)}</h3>
          <p className="menu-item-protocol">{product.protocolName}</p>
          <p className="muted small">{SECTION[product.category] ?? "Other"}</p>
        </div>
        <div className="menu-price">
          <span className="menu-price-label">{product.rate ? product.rate.label : "Rate"}</span>
          {/* 負の利回り (YT の Long Yield APY など) は cherry (CLAUDE.md §6: 負/警告は cherryDark) */}
          <span className={product.rate && product.rate.value < 0 ? "menu-price-value negative" : "menu-price-value"}>
            {product.rate ? fmtRatio(product.rate.value) : "n/a"}
          </span>
        </div>
      </div>
      <div className="menu-rule" aria-hidden="true" />
      <dl className="menu-facts">
        {product.maturity && (
          <div>
            <dt>Maturity</dt>
            <dd>{fmtFullDate(new Date(product.maturity))}</dd>
          </div>
        )}
        {product.facts.map((f) => (
          <div key={f.label}>
            <dt>{f.label}</dt>
            <dd>{fmtMetric(f)}</dd>
          </div>
        ))}
      </dl>
      <div className="menu-item-foot">
        {product.rate ? (
          <span className="muted small">
            {product.rate.basis ? `${product.rate.basis} · ${product.rate.source}` : `Source: ${product.rate.source}`}
          </span>
        ) : (
          <span className="ticket ticket-warn">Rate unavailable</span>
        )}
        <span className="menu-actions">
          {product.url && (
            <a className="btn btn-quiet" href={product.url} target="_blank" rel="noreferrer">
              Open {product.protocolName} ↗
            </a>
          )}
          {product.protocolId === "ethena" && (
            <button type="button" className="btn btn-quiet" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
              {open ? "Hide route" : "Route from USDC"}
            </button>
          )}
        </span>
      </div>
      {open && (
        <div className="menu-details">
          <UniswapRoutePreview />
        </div>
      )}
    </li>
  );
}
