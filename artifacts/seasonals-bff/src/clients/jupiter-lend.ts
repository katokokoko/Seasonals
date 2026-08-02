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
 *   - shares / underlyingAssets は underlying / share token の smallest unit integer string
 *   - underlyingBalance は **USD 値を 8-decimal fixed-point integer string** で返す
 *     (例: "3763527416" = $37.63527416)。BFF (server.ts) で §4.5 decimal string に正規化
 *   - supplyRate は basis points string ("303" = 3.03 %)
 *   - 取得時は string で受けて Number 変換しない (mapper 層で boundary 経由)
 */

import { fetchWithTimeout } from "./http"; // Phase 8.38 (B9): 共通 timeout
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
      /** 8.57: 実 API は **decimal string** で返す (型は歴史的に number だった) */
      price?: number | string;
    };
  };
  /** 保有 jlToken (smallest unit integer string、share decimals 基準) */
  shares: string;
  /** underlying token 換算 (smallest unit integer string、underlying decimals 基準) */
  underlyingAssets: string;
  /**
   * USD 換算 — Jupiter は **8-decimal fixed-point integer string** で返す。
   * 例: "3763527416" = $37.63527416 USD。
   * server.ts の mapper で `normalizeJup8DecimalUsd` 経由で §4.5 decimal string に正規化される。
   */
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

// Phase 8.38 (B10): wallet キー cache の上限 — TTL は read 時にしか効かず、
// 多数 wallet で無制限成長していた。挿入順 (Map) で古い方から落とす
const CACHE_MAX_ENTRIES = 200;
function evictOldest(m: Map<string, unknown>): void {
  while (m.size > CACHE_MAX_ENTRIES) {
    const oldest = m.keys().next().value;
    if (oldest === undefined) break;
    m.delete(oldest);
  }
}


/** Phase 8.6: market catalog cache (single global、 wallet 非依存) */
let marketsCache: { data: JupiterLendMarket[]; ts: number } | null = null;

/** test 用 cache クリア */
export function _clearJupiterLendCacheForTest(): void {
  positionsCache.clear();
  marketsCache = null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 8.6: Markets catalog (lite-api.jup.ag/lend/v1/earn/tokens)
// ─────────────────────────────────────────────────────────────────────────────

export interface JupiterLendMarket {
  /** jlToken (vault share) mint */
  jlMint: string;
  jlSymbol: string;
  jlDecimals: number;
  /** Underlying asset mint */
  underlyingMint: string;
  /** Underlying asset symbol (USDC / WSOL / USDT etc.) */
  underlyingSymbol: string;
  underlyingDecimals: number;
  underlyingPriceUsd: number;
  /**
   * 8.70: `asset.price` の **生 decimal string**。評価額計算は float を挟まず
   * これを使う (§4.5)。`underlyingPriceUsd` は menu の TVL 換算が使うので残置。
   */
  underlyingPriceRaw?: string;
  /**
   * 8.70: 1 share あたりの underlying smallest unit (= **償還価値**)。
   * DAS の `price_per_token` は市場推定で、実測で 3.1% ずれることがあった
   * (jlUSDC: DAS 1.08643570 vs 実勢 1.05380615)。protocol 自身のこの値を優先する。
   */
  convertToAssets?: string;
  supplyRateBps: number;
  rewardsRateBps: number;
  totalRateBps: number;
  /** Total assets in underlying smallest unit (TVL の底値) */
  tvlUnderlying: string;
}

interface JupTokenRaw {
  id?: number;
  address: string;
  name?: string;
  symbol?: string;
  decimals?: number;
  assetAddress?: string;
  asset?: {
    address?: string;
    symbol?: string;
    decimals?: number;
    price?: number | string;
  };
  supplyRate?: string;
  rewardsRate?: string;
  totalRate?: string;
  totalAssets?: string;
  /** 8.70: 1 share あたりの underlying smallest unit (償還価値) */
  convertToAssets?: string;
}

export async function fetchEarnMarkets(): Promise<JupiterLendMarket[]> {
  if (marketsCache && Date.now() - marketsCache.ts < CACHE_TTL_MS) {
    return marketsCache.data;
  }
  const res = await fetchWithTimeout(`${JUPITER_LEND_BASE}/earn/tokens`, {
    method: "GET",
    headers: { accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(
      `Jupiter Lend markets HTTP ${res.status}: ${await res.text().catch(() => "")}`
    );
  }
  const json = (await res.json()) as JupTokenRaw[];
  if (!Array.isArray(json)) {
    throw new Error("Jupiter Lend markets unexpected response shape");
  }
  const data: JupiterLendMarket[] = json
    .filter((t) => t.address && t.asset?.address)
    .map((t) => ({
      jlMint: t.address,
      jlSymbol: t.symbol ?? "",
      jlDecimals: t.decimals ?? 0,
      underlyingMint: t.asset!.address!,
      underlyingSymbol: t.asset?.symbol ?? "",
      underlyingDecimals: t.asset?.decimals ?? 0,
      underlyingPriceUsd:
        typeof t.asset?.price === "number"
          ? t.asset.price
          : typeof t.asset?.price === "string"
            ? Number.parseFloat(t.asset.price)
            : 0,
      // 8.70: float 化していない生の値も持ち回る (評価額計算はこちらを使う)
      ...(typeof t.asset?.price === "string"
        ? { underlyingPriceRaw: t.asset.price }
        : {}),
      ...(typeof t.convertToAssets === "string"
        ? { convertToAssets: t.convertToAssets }
        : {}),
      supplyRateBps: Number(t.supplyRate) || 0,
      rewardsRateBps: Number(t.rewardsRate) || 0,
      totalRateBps: Number(t.totalRate) || 0,
      tvlUnderlying: String(t.totalAssets ?? "0"),
    }));
  marketsCache = { data, ts: Date.now() };
  return data;
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
  const res = await fetchWithTimeout(url, {
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
  evictOldest(positionsCache);
  return json;
}
