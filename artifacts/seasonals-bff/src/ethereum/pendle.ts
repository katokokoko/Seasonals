/**
 * Pendle adapter — PT maturity (Ethereum v3 §3 Pendle)
 *
 * - 公開イベント: active market の満期 (v2/markets/all?chainId=1&isActive=true)
 * - address 別: v1/dashboard/positions/database/{user} の chainId=1 openPositions の PT 残高
 *   → maturity event。満期後は "Redeem PT" (Hosted SDK Convert で unsigned plan)
 */
import type { TimelineEvent } from "@workspace/lib/types";
import { getEthClient, getJson } from "./client";
import { erc20Abi } from "./abis";
import { MAINNET_CHAIN_ID, PENDLE_API } from "./config";
import { baseEvent, etherscanAddress, usdNumberTo8 } from "./common";

export interface PendleMarket {
  name: string;
  protocol?: string;
  address: string;
  expiry: string;
  pt: string; // "1-0x…"
  yt: string;
  sy: string;
  underlyingAsset: string;
  chainId?: number;
  details?: {
    liquidity?: number;
    totalTvl?: number;
    impliedApy?: number;
    underlyingApy?: number;
    aggregatedApy?: number;
    /** YT の Long Yield APY (Pendle UI と同じ値)。負もありうる */
    ytFloatingApy?: number;
  };
}

export interface PendlePosition {
  marketId: string; // "1-0x…"
  pt: { balance: string; valuation: number };
  yt: { balance: string; valuation: number };
  lp: { balance: string; valuation: number };
}

const strip = (id: string) => (id.includes("-") ? id.split("-")[1]! : id);

/** 公開: 流動性上位の active market の満期 (表示を絞る、全件は Explore 側) */
export function derivePendleMarketEvents(markets: PendleMarket[], observedAt: string, limit = 12): TimelineEvent[] {
  return [...markets]
    .filter((m) => (m.chainId ?? MAINNET_CHAIN_ID) === MAINNET_CHAIN_ID && Date.parse(m.expiry) > Date.parse(observedAt))
    .sort((a, b) => (b.details?.liquidity ?? 0) - (a.details?.liquidity ?? 0))
    .slice(0, limit)
    .map((m) =>
      baseEvent({
        id: `ethereum:pendle:pt_maturity:market:${m.address.toLowerCase()}`,
        kind: "pt_maturity",
        protocol: "pendle",
        protocolName: "Pendle",
        title: `PT-${m.name} market matures`,
        asset: `PT-${m.name}`,
        at: m.expiry,
        requiresWallet: false,
        metrics: [
          ...(m.details?.impliedApy !== undefined ? [{ label: "Implied APY (fixed)", kind: "ratio" as const, value: m.details.impliedApy }] : []),
          ...(m.details?.underlyingApy !== undefined ? [{ label: "Underlying APY", kind: "ratio" as const, value: m.details.underlyingApy }] : []),
          ...(usdNumberTo8(m.details?.liquidity) ? [{ label: "Liquidity (USD)", kind: "usd" as const, value: usdNumberTo8(m.details?.liquidity)! }] : []),
        ],
        links: [{ label: "Open on Pendle", url: `https://app.pendle.finance/trade/markets/${m.address}/swap?chain=ethereum` }],
        source: "pendle-api:markets",
        observedAt,
      })
    );
}

/** address 別: PT 残高 → maturity event (満期後は overdue になり Redeem action が出る) */
export function derivePendlePositionEvents(
  owner: string,
  positions: PendlePosition[],
  markets: Map<string, PendleMarket>,
  ptDecimals: Map<string, number>,
  observedAt: string
): TimelineEvent[] {
  const now = Date.parse(observedAt);
  const out: TimelineEvent[] = [];
  for (const p of positions) {
    if (!p.pt || !/^[0-9]+$/.test(p.pt.balance) || BigInt(p.pt.balance) === 0n) continue;
    const marketAddr = strip(p.marketId).toLowerCase();
    const m = markets.get(marketAddr);
    if (!m) continue;
    const pt = strip(m.pt).toLowerCase();
    const decimals = ptDecimals.get(pt);
    const matured = Date.parse(m.expiry) <= now;
    out.push(
      baseEvent({
        id: `ethereum:pendle:pt_maturity:${owner.toLowerCase()}:${marketAddr}`,
        kind: "pt_maturity",
        protocol: "pendle",
        protocolName: "Pendle",
        title: matured ? `PT-${m.name} matured` : `PT-${m.name} matures`,
        asset: `PT-${m.name}`,
        at: m.expiry,
        owner,
        ...(decimals !== undefined ? { amount: { value: p.pt.balance, decimals, symbol: `PT-${m.name}` } } : {}),
        ...(usdNumberTo8(p.pt.valuation) ? { usd: usdNumberTo8(p.pt.valuation)! } : {}),
        metrics: [
          ...(m.details?.impliedApy !== undefined ? [{ label: "Market implied APY (now)", kind: "ratio" as const, value: m.details.impliedApy }] : []),
          { label: "Value source", kind: "text" as const, value: "Pendle API valuation (indicative)" },
        ],
        actions: [
          {
            actionType: "pendle_redeem",
            label: "Redeem PT",
            requiresWallet: true,
            availability: matured ? "available" : "not_yet",
            ...(matured ? {} : { reason: "PT can be redeemed 1:1 after maturity." }),
            params: { market: marketAddr, pt, amount: p.pt.balance },
          },
        ],
        links: [etherscanAddress(pt), { label: "Open on Pendle", url: `https://app.pendle.finance/trade/markets/${marketAddr}/swap?chain=ethereum` }],
        source: "pendle-api:dashboard",
        observedAt,
      })
    );
  }
  return out;
}

export async function fetchPendleMarkets(opts: { active?: boolean } = {}): Promise<PendleMarket[]> {
  const out: PendleMarket[] = [];
  for (let skip = 0; skip < 1000; skip += 100) {
    const q = `chainId=${MAINNET_CHAIN_ID}&limit=100&skip=${skip}${opts.active === undefined ? "" : `&isActive=${opts.active}`}`;
    const page = await getJson<{ total: number; results: PendleMarket[] }>(`${PENDLE_API}/v2/markets/all?${q}`);
    out.push(...page.results);
    if (out.length >= page.total || page.results.length === 0) break;
  }
  return out;
}

export async function fetchPendlePublicEvents(observedAt: string): Promise<TimelineEvent[]> {
  return derivePendleMarketEvents(await fetchPendleMarkets({ active: true }), observedAt);
}

export async function fetchPendleUserEvents(owner: string, observedAt: string): Promise<TimelineEvent[]> {
  const res = await getJson<{ positions: Array<{ chainId: number; openPositions: PendlePosition[] }> }>(
    `${PENDLE_API}/v1/dashboard/positions/database/${owner}`
  );
  const open = res.positions.filter((p) => p.chainId === MAINNET_CHAIN_ID).flatMap((p) => p.openPositions);
  if (open.length === 0) return [];
  // 満期済み (inactive) の market も含めて引く — overdue PT を出すため
  const all = await fetchPendleMarkets();
  const byAddr = new Map(all.map((m) => [m.address.toLowerCase(), m]));
  const client = getEthClient();
  const pts = [...new Set(open.map((p) => byAddr.get(strip(p.marketId).toLowerCase())).filter(Boolean).map((m) => strip(m!.pt).toLowerCase()))];
  const decimals = new Map<string, number>();
  if (client && pts.length) {
    const res2 = await client.multicall({
      contracts: pts.map((a) => ({ address: a as `0x${string}`, abi: erc20Abi, functionName: "decimals" as const })),
      allowFailure: true,
    });
    res2.forEach((r, i) => {
      if (r.status === "success") decimals.set(pts[i]!, Number(r.result));
    });
  }
  return derivePendlePositionEvents(owner, open, byAddr, decimals, observedAt);
}
