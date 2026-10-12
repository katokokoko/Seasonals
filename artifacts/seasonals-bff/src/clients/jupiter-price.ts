/**
 * jupiter-price — Jupiter Price API v3 の USD 単価 (2026-10、menu TVL 換算用)
 *
 * `GET https://lite-api.jup.ag/price/v3?ids=<mint,...>` は mint キーの object を返す
 * (`{ "<mint>": { usdPrice: 1.495, decimals: 6, ... } }`、2026-10-06 確認)。
 * 用途は eHYUSD (旧 sHYUSD) の menu TVL (供給 × 単価) — **表示専用 Number** (§3 display carve-out)。
 * 金額計算 / tx には使わない。正の有限数以外は捨てる。1 件も取れなければ throw。
 */

import { fetchWithTimeout } from "./http";

const JUP_PRICE_URL = "https://lite-api.jup.ag/price/v3";
const TTL_MS = 5 * 60_000;

let cache: { at: number; key: string; values: Map<string, number> } | null = null;

export async function fetchJupiterUsdPrices(
  mints: string[]
): Promise<Map<string, number>> {
  const key = mints.join(",");
  if (cache && cache.key === key && Date.now() - cache.at < TTL_MS) {
    return cache.values;
  }
  const res = await fetchWithTimeout(
    `${JUP_PRICE_URL}?ids=${mints.map(encodeURIComponent).join(",")}`,
    { headers: { accept: "application/json" } }
  );
  if (!res.ok) throw new Error(`Jupiter price v3 HTTP ${res.status}`);
  const json = (await res.json()) as Record<string, { usdPrice?: unknown } | null>;
  const out = new Map<string, number>();
  for (const mint of mints) {
    const p = json?.[mint]?.usdPrice;
    if (typeof p === "number" && Number.isFinite(p) && p > 0) out.set(mint, p);
  }
  if (out.size === 0) throw new Error("Jupiter price v3: no valid usdPrice");
  cache = { at: Date.now(), key, values: out };
  return out;
}

/** test 用: cache クリア */
export function _clearJupiterPriceCacheForTest(): void {
  cache = null;
}
