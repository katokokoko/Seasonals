/**
 * Ethereum の menu (Explore) 商品。値はすべて公開 API の実データ:
 * - Lido stETH: eth-api.lido.fi 7 日 SMA APR
 * - Ethena sUSDe: ethena.fi 30 日平均 yield
 * - Pendle: v2/markets/all (active、流動性上位 8 market) を PT / YT のペアで出す。
 *   PT = implied APY (満期保有で固定)、YT = ytFloatingApy (Long Yield APY、負もありうる)
 * 取れなかった利率は null (0 や推測で埋めない)。
 */
import type { MenuProduct } from "@workspace/lib/types";
import { getJson } from "./client";
import { usdNumberTo8 } from "./common";
import { fetchPendleMarkets, type PendleMarket } from "./pendle";

async function safe<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch {
    return null;
  }
}

let cache: { at: number; items: MenuProduct[] } | null = null;

export async function getEthMenu(): Promise<MenuProduct[]> {
  if (cache && Date.now() - cache.at < 5 * 60_000) return cache.items;
  const observedAt = new Date().toISOString();
  const [lido, ethena, markets] = await Promise.all([
    safe(getJson<{ data: { smaApr: number } }>("https://eth-api.lido.fi/v1/protocol/steth/apr/sma")),
    safe(getJson<{ avg30dSusdeYield: { value: number } }>("https://ethena.fi/api/yields/protocol-and-staking-yield")),
    safe(fetchPendleMarkets({ active: true })),
  ]);
  const items: MenuProduct[] = [
    {
      id: "ethereum:lido:steth",
      chain: "ethereum",
      protocolId: "lido",
      protocolName: "Lido",
      name: "stETH / wstETH",
      category: "staking",
      rate: lido ? { label: "APR (7-day avg)", value: lido.data.smaApr / 100, source: "eth-api.lido.fi" } : null,
      facts: [{ label: "Exit", kind: "text", value: "Withdrawal queue (typically 1–5 days) or a DEX" }],
      url: "https://stake.lido.fi",
      observedAt,
    },
    {
      id: "ethereum:ethena:susde",
      chain: "ethereum",
      protocolId: "ethena",
      protocolName: "Ethena",
      name: "sUSDe",
      category: "stable",
      rate: ethena ? { label: "30-day avg yield", value: ethena.avg30dSusdeYield.value / 100, source: "ethena.fi" } : null,
      facts: [{ label: "Exit", kind: "text", value: "Cooldown set by Ethena (1–7 days), then claim" }],
      url: "https://app.ethena.fi",
      observedAt,
    },
    ...pendleMenuProducts(markets ?? [], observedAt),
  ];
  cache = { at: Date.now(), items };
  return items;
}

/** Pendle menu に出す market 数 (流動性上位)。PT / YT で 2 倍の商品になる */
const PENDLE_MENU_MARKETS = 8;

/**
 * 流動性上位の market ごとに PT → YT の順で 2 商品を返す (隣り合わせで並ぶ)。
 * YT の率は Pendle の Long Yield APY (`ytFloatingApy`)。負の値もそのまま返し、無ければ null。
 */
export function pendleMenuProducts(markets: PendleMarket[], observedAt: string, limit = PENDLE_MENU_MARKETS): MenuProduct[] {
  return [...markets]
    .sort((a, b) => (b.details?.liquidity ?? 0) - (a.details?.liquidity ?? 0))
    .slice(0, limit)
    .flatMap((m) => {
      const addr = m.address.toLowerCase();
      const liquidity = usdNumberTo8(m.details?.liquidity);
      const facts: MenuProduct["facts"] = [
        ...(liquidity ? [{ label: "Liquidity", kind: "usd" as const, value: liquidity }] : []),
        ...(m.details?.underlyingApy !== undefined ? [{ label: "Underlying APY", kind: "ratio" as const, value: m.details.underlyingApy }] : []),
      ];
      const common = { chain: "ethereum" as const, protocolId: "pendle", protocolName: "Pendle", category: "pt_yt" as const, facts, maturity: m.expiry, observedAt };
      const market = `https://app.pendle.finance/trade/markets/${m.address}/swap`;
      const pt: MenuProduct = {
        ...common,
        id: `ethereum:pendle:pt:${addr}`,
        name: `PT-${m.name}`,
        tokenKind: "pt",
        rate:
          m.details?.impliedApy !== undefined
            ? { label: "Fixed APY", value: m.details.impliedApy, basis: "Fixed if held to maturity", source: "Pendle API" }
            : null,
        url: `${market}?chain=ethereum`,
      };
      const yt: MenuProduct = {
        ...common,
        id: `ethereum:pendle:yt:${addr}`,
        name: `YT-${m.name}`,
        tokenKind: "yt",
        rate:
          m.details?.ytFloatingApy !== undefined
            ? { label: "Long yield APY", value: m.details.ytFloatingApy, basis: "Floating; YT is worth 0 at maturity", source: "Pendle API" }
            : null,
        url: `${market}?view=yt&chain=ethereum`,
      };
      return [pt, yt];
    });
}
