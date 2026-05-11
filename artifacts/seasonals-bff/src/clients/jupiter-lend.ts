/**
 * jupiter-lend — Jupiter Lend public API client (Phase 8.2)
 *
 * Public REST API (no auth):
 *   GET https://lite-api.jup.ag/lend/v1/earn/tokens
 *     → 7 markets catalog (jlToken mint / underlying mint / supplyRate)
 *   GET https://lite-api.jup.ag/lend/v1/earn/positions?users=<wallet>
 *     → user positions for all markets (zero balance も含めて返る)
 *
 * Cache: in-memory Map で 30 秒 TTL (rate limit 不明、conservative)。
 *
 * 規約 (CLAUDE.md §4.5):
 *   - shares / underlyingAssets / underlyingBalance は smallest unit string で来る
 *   - supplyRate は basis points string ("303" = 3.03 %)
 *   - 取得時は string で受けて Number 変換しない
 */

const JUPITER_LEND_BASE = "https://lite-api.jup.ag/lend/v1";
const CACHE_TTL_MS = 30_000;

/** Jupiter Lend positions API レスポンスの 1 エントリ */
export interface JupiterLendPositionRaw {
  token: {
    address: string;
    name: string;
    symbol: string;
    decimals: number;
    assetAddress: string;
    asset: {
      address: string;
      symbol: string;
      decimals: number;
      price?: number;
    };
  };
  /** 保有 jlToken (smallest unit string) */
  shares: string;
  /** underlying token 換算 (smallest unit string) */
  underlyingAssets: string;
  /** USD 換算 (string、Jupiter は USD price で算出済) */
  underlyingBalance: string;
  supplyRate: string;
  rewardsRate: string;
  totalRate: string;
  ownerAddress: string;
}

interface CacheEntry {
  data: JupiterLendPositionRaw[];
  ts: number;
}

const positionsCache = new Map<string, CacheEntry>();

/** test 用 cache クリア */
export function _clearJupiterLendCacheForTest(): void {
  positionsCache.clear();
}

/**
 * 指定 wallet の Jupiter Lend positions を取得。
 * zero balance エントリも含まれるので、呼び出し側で `shares > "0"` filter する。
 */
export async function fetchEarnPositions(
  walletAddress: string
): Promise<JupiterLendPositionRaw[]> {
  const cached = positionsCache.get(walletAddress);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.data;
  }

  const url = `${JUPITER_LEND_BASE}/earn/positions?users=${encodeURIComponent(walletAddress)}`;
  const res = await fetch(url, {
    method: "GET",
    headers: { accept: "application/json" },
  });

  if (!res.ok) {
    throw new Error(
      `Jupiter Lend HTTP ${res.status} ${res.statusText}: ${await res.text().catch(() => "")}`
    );
  }

  const json = (await res.json()) as JupiterLendPositionRaw[];
  if (!Array.isArray(json)) {
    throw new Error(`Jupiter Lend unexpected response shape (not array)`);
  }

  positionsCache.set(walletAddress, { data: json, ts: Date.now() });
  return json;
}
