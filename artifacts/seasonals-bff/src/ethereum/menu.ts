/**
 * Ethereum の menu (Explore) 商品。値はすべて公開 API の実データ:
 * - Lido stETH: eth-api.lido.fi 7 日 SMA APR
 * - Ethena sUSDe: ethena.fi 30 日平均 yield
 * - Pendle: v2/markets/all (active、流動性上位) の implied APY / 満期 / 流動性
 * 取れなかった利率は null (0 や推測で埋めない)。
 */
import type { MenuProduct } from "@workspace/lib/types";
import { getJson } from "./client";
import { usdNumberTo8 } from "./common";
import { fetchPendleMarkets } from "./pendle";

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
    ...(markets ?? [])
      .sort((a, b) => (b.details?.liquidity ?? 0) - (a.details?.liquidity ?? 0))
      .slice(0, 8)
      .map<MenuProduct>((m) => ({
        id: `ethereum:pendle:${m.address.toLowerCase()}`,
        chain: "ethereum",
        protocolId: "pendle",
        protocolName: "Pendle",
        name: `PT-${m.name}`,
        category: "pt_yt",
        rate: m.details?.impliedApy !== undefined ? { label: "Implied APY (fixed to maturity)", value: m.details.impliedApy, source: "Pendle API" } : null,
        facts: [
          ...(usdNumberTo8(m.details?.liquidity) ? [{ label: "Liquidity", kind: "usd" as const, value: usdNumberTo8(m.details?.liquidity)! }] : []),
          ...(m.details?.underlyingApy !== undefined ? [{ label: "Underlying APY", kind: "ratio" as const, value: m.details.underlyingApy }] : []),
        ],
        maturity: m.expiry,
        url: `https://app.pendle.finance/trade/markets/${m.address}/swap?chain=ethereum`,
        observedAt,
      })),
  ];
  cache = { at: Date.now(), items };
  return items;
}
