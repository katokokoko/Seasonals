/**
 * ExploreMenu — refined diner menu (UI v2 §10)。
 * データは BFF の実 listing (/menu-listings)。APY は必ず label 付き、
 * sponsored / featured は既存データに無いので出さない (捏造しない)。
 */
import { useMemo, useState } from "react";
import { Link } from "react-router";
import { LEARN } from "../learn/content";
import { SUPPORTED_CHAINS, chainInfo, type ChainId } from "@workspace/lib/config/chains";
import { heldPoolKeys } from "@workspace/lib/derive/earn-positions";
import { canWithdrawEarnPosition, depositAction, resolveSolanaRoute } from "@workspace/lib/derive/solana-action";
import type { EarnPosition, MenuHolding, MenuProduct, PositionCategory, ProtocolMenuEntry, ProtocolPool } from "@workspace/lib/types";
import { useEthMenu, useMenuHoldings, useMenuListings, type MenuHoldingsData } from "../services/queries";
import { requestOpenWallet } from "../timeline/detailStore";
import { ethHoldingText, solHoldingText } from "./holdingText";
import { MenuActionPanel, actionLabel, menuActionable, type MenuAction } from "./MenuActionPanel";
import { useActiveAddresses, useConnectedAddress } from "../state/session";
import { SolanaActionPanel } from "./SolanaActionPanel";
import { fmtDate, fmtMetric } from "../ui/format";
import { ChainIcon } from "../ui/ChainIcon";
import { fmtCompactUsd, fmtRatio } from "../ui/format";
import { ProtocolBadge, brandStyle } from "../ui/ProtocolBadge";
import { TokenKindBadge } from "../ui/TokenKindBadge";
import { Notice } from "../shell/WorkspaceShell";
import "./explore.css";

/** Learn に解説がある protocol (Menu カードから /learn#<id> へ) */
const LEARN_IDS = new Set(LEARN.map((e) => e.id));

const SECTION: Partial<Record<PositionCategory, string>> & Record<string, string> = {
  lending: "Lending",
  lp: "Liquidity",
  vault: "Yield",
  pt_yt: "PT/YT",
  staking: "Staking",
  restaking: "Staking",
  stable: "Yield-bearing stable",
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
  const [chain, setChain] = useState<"all" | ChainId>("all");
  const [query, setQuery] = useState("");
  const [depositedOnly, setDepositedOnly] = useState(false);
  const holdings = useMenuHoldings(q.data);
  const active = useActiveAddresses();
  const ethCtx: EthActionContext = { addresses: active.filter((a) => a.chain === "ethereum").map((a) => a.address), byAddress: holdings.ethByAddress };
  // Solana の withdraw は接続 wallet の position からだけ組む (watch 中の address は読み取りのみ)
  const solConnected = useConnectedAddress("solana");
  const solConnectedEarn = solConnected ? holdings.solByAddress.get(solConnected) : undefined;
  const solMine = useMemo(
    () => (q.data && solConnectedEarn ? heldPoolKeys(q.data, [solConnectedEarn]) : new Map<string, EarnPosition[]>()),
    [q.data, solConnectedEarn]
  );
  const extra = depositedOnly ? holdings.extraProducts : [];

  const rows = useMemo<Row[]>(
    () => [
      ...[...(eth.data ?? []), ...extra].map<Row>((p) => ({
        kind: "eth",
        key: p.id,
        section: SECTION[p.category] ?? "Other",
        text: `${p.protocolName} ${p.name}`,
        product: p,
      })),
      ...(q.data ?? []).flatMap((p) =>
        p.pools.map<Row>((pool) => {
          const item = { protocol: p, pool, section: SECTION[pool.category] ?? "Other" };
          return { kind: "sol", key: `${p.protocol_id}:${pool.pool_id}`, section: item.section, text: `${p.display_name} ${pool.name} ${pool.asset}`, item };
        })
      ),
    ],
    [q.data, eth.data, extra]
  );
  const held = (r: Row) => (r.kind === "eth" ? holdings.eth.has(r.key) : holdings.sol.has(r.key));
  const chainRows = rows.filter((r) => (chain === "all" || chain === rowChain(r)) && (!depositedOnly || held(r)));
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
        {/* chain は config から描く (UI v2 §1: 対応 chain を hard-code しない) */}
        {(["all", ...SUPPORTED_CHAINS.map((c) => c.id)] as const).map((c) => (
          <button key={c} type="button" className="filter-chip" aria-pressed={chain === c} onClick={() => setChain(c)}>
            {c === "all" ? "All chains" : chainInfo(c).name}
          </button>
        ))}
        <DepositedToggle on={depositedOnly} onChange={setDepositedOnly} holdings={holdings} />
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
              .map((r) =>
                r.kind === "eth" ? (
                  <EthMenuCard key={r.key} product={r.product} holding={holdings.eth.get(r.key)} ctx={ethCtx} />
                ) : (
                  <MenuCard key={r.key} item={r.item} held={holdings.sol.get(r.key)} owner={solConnected} mine={solMine.get(r.key) ?? []} />
                )
              )}
          </ul>
        </section>
      ))}
      <p className="menu-foot muted small">
        Rates are current or trailing values reported by each protocol (source shown on each item), not a promise of future returns.
      </p>
    </div>
  );
}

function rowChain(r: Row): ChainId {
  return r.kind === "eth" ? "ethereum" : "solana";
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

/**
 * Solana の pool カード。Deposit / Withdraw は Seeker MenuDrawer と同じ gate:
 * - display_only / deposit_open === false は Deposit を押させない (BFF も 409 で拒否する、fail-closed)
 * - BFF の tx builder に解決できない pool も押させない (Seeker は押した後に止める。web は先に見せる)
 * - Withdraw は接続 wallet がこの pool に withdraw できる position を持つ時だけ
 * 最下段の右下には、Learn に解説がある protocol なら /learn#<protocol_id> への「Learn」(Ethereum カードと同じ位置)。
 */
export function MenuCard({ item, held, owner, mine }: { item: MenuItem; held?: EarnPosition[]; owner: string | null; mine: EarnPosition[] }) {
  const { protocol, pool } = item;
  const [open, setOpen] = useState(false);
  const [panel, setPanel] = useState<MenuAction | null>(null);
  const avail = availability(pool);
  const routable = useMemo(
    () => resolveSolanaRoute(depositAction(protocol.protocol_id, pool.deposit_asset ?? pool.asset, pool.pool_id)) !== null,
    [protocol.protocol_id, pool.deposit_asset, pool.asset, pool.pool_id]
  );
  const depositReason = pool.display_only || pool.deposit_open === false ? avail?.label : !routable ? "Seasonals cannot build deposits for this pool yet" : null;
  const withdrawable = mine.some((p) => canWithdrawEarnPosition(p));
  const withdrawReason = withdrawable ? null : owner ? "Nothing withdrawable at the connected wallet" : "Connect a Solana wallet to withdraw";
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
      <HoldingLine sol={held} />
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
          {pool.display_only ? (
            <p>
              {protocol.display_name} {pool.name} is listed for reference only; Seasonals cannot deposit into or withdraw from it.
            </p>
          ) : (
            <p>
              {protocol.display_name} {pool.name} accepts {pool.deposit_asset ?? pool.asset}. Deposits and withdrawals are signed in your Solana wallet and
              sent to mainnet through the Seasonals server.
            </p>
          )}
          {pool.borrowed_usd !== undefined && <p>Borrowed: {fmtCompactUsd(pool.borrowed_usd)}</p>}
          {/* Seasonals で扱えない操作 (旧 token の引き出し等) は protocol の公式 app へ案内する */}
          {pool.note && <p>{pool.note}</p>}
          {pool.external_url && (
            <p>
              <a className="menu-open-link" href={pool.external_url} target="_blank" rel="noreferrer">
                Open {protocol.display_name} ↗
              </a>
            </p>
          )}
        </div>
      )}
      {panel && (
        <SolanaActionPanel key={panel} protocol={protocol} pool={pool} action={panel} owner={owner} positions={mine} onClose={() => setPanel(null)} />
      )}
      <div className="menu-item-bottom">
        {!panel && (
          <span className="menu-item-cta">
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => setPanel("deposit")}
              disabled={Boolean(depositReason)}
              title={depositReason ?? undefined}
            >
              {actionLabel("deposit")}
            </button>
            <button type="button" className="btn" onClick={() => setPanel("withdraw")} disabled={!withdrawable} title={withdrawReason ?? undefined}>
              {actionLabel("withdraw")}
            </button>
          </span>
        )}
        {LEARN_IDS.has(protocol.protocol_id) && (
          <span className="menu-links">
            <Link className="menu-open-link" to={`/learn#${protocol.protocol_id}`}>
              Learn
            </Link>
          </span>
        )}
      </div>
    </li>
  );
}

export interface EthActionContext {
  addresses: string[];
  byAddress: MenuHoldingsData["ethByAddress"];
}

export function EthMenuCard({ product, holding, ctx }: { product: MenuProduct; holding?: MenuHolding[]; ctx?: EthActionContext }) {
  const [panel, setPanel] = useState<MenuAction | null>(null);
  const canAct = Boolean(ctx) && menuActionable(product);
  const held = Boolean(holding?.some((h) => h.amounts.length > 0));
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
      <HoldingLine eth={holding} />
      <div className="menu-rule" aria-hidden="true" />
      <dl className="menu-facts">
        {product.maturity && (
          <div>
            <dt>Maturity</dt>
            <dd>{fmtDate(new Date(product.maturity))}</dd>
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
      </div>
      {canAct && panel && ctx && (
        <MenuActionPanel key={panel} product={product} action={panel} addresses={ctx.addresses} byAddress={ctx.byAddress} onClose={() => setPanel(null)} />
      )}
      {/* 最下段: 左に Deposit / Withdraw、右下にプロトコルのサイトへのリンク (小さめ) */}
      <div className="menu-item-bottom">
        {canAct && !panel && (
          <span className="menu-item-cta">
            <button type="button" className="btn btn-primary" onClick={() => setPanel("deposit")}>
              {actionLabel("deposit")}
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => setPanel("withdraw")}
              disabled={!held}
              title={held ? undefined : "Nothing held at the watched addresses"}
            >
              {actionLabel("withdraw")}
            </button>
          </span>
        )}
        <span className="menu-links">
          {LEARN_IDS.has(product.protocolId) && (
            <Link className="menu-open-link" to={`/learn#${product.protocolId}`}>
              Learn
            </Link>
          )}
          {product.url && (
            <a className="menu-open-link" href={product.url} target="_blank" rel="noreferrer">
              Open {product.protocolName} ↗
            </a>
          )}
        </span>
      </div>
    </li>
  );
}

/**
 * 「Deposited only」: 閲覧中 address が今 deposit している商品だけに絞る。
 * address が無ければ無効 + Watch への導線。取得中 / 一部失敗は明示し、失敗分を「保有なし」と見せない。
 */
function DepositedToggle({ on, onChange, holdings }: { on: boolean; onChange: (v: boolean) => void; holdings: MenuHoldingsData }) {
  if (!holdings.hasAddress) {
    return (
      <span className="deposited-toggle muted small">
        <button type="button" className="filter-chip" aria-pressed={false} disabled>
          Deposited only
        </button>{" "}
        <button type="button" className="btn-link" onClick={requestOpenWallet}>
          Watch an address
        </button>{" "}
        to see what you hold.
      </span>
    );
  }
  return (
    <span className="deposited-toggle">
      <button type="button" className="filter-chip" aria-pressed={on} onClick={() => onChange(!on)}>
        Deposited only
      </button>
      {on && holdings.isLoading && <span className="muted small">Checking balances…</span>}
      {on && holdings.failed.length > 0 && (
        <span className="small menu-warning">Could not check: {holdings.failed.join(", ")}. Those may be missing here.</span>
      )}
    </span>
  );
}

function HoldingLine({ eth, sol }: { eth?: MenuHolding[]; sol?: EarnPosition[] }) {
  const h: { text: string; note?: string } | null = eth ? ethHoldingText(eth) : sol ? solHoldingText(sol) : null;
  if (!h) return null;
  return (
    <p className="menu-holding small">
      <strong>{h.text}</strong>
      {h.note && <span className="muted block">{h.note}</span>}
    </p>
  );
}
