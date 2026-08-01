/**
 * oracle client — Pyth (primary) → Switchboard (fallback) fail-closed 判定 (Phase 8.14、§4.6)
 *
 * 実 oracle:
 *   - Pyth Hermes REST: GET hermes.pyth.network/v2/updates/price/latest?ids[]=<feedId>
 *       → parsed[0].price.{price, expo, publish_time}。staleness = now − publish_time。
 *   - Switchboard Crossbar REST: GET crossbar.switchboard.xyz/simulate/<feedHash>
 *       → [{ results: ["71.85000000"] }]。simulate は job をライブ実行するため fetch=fresh
 *         (age≈0)。fallback / divergence の独立第2 source として使う。
 *
 * 数値規約 (§4.5):
 *   - price_usd は 8 decimals string で出力 (transport / 表示用)。oracle 価格は元来
 *     float 由来なので chosen 価格を toFixed(8) で文字列化する境界とする (台帳 amount
 *     ではない)。token amount 演算は別途 bigint。
 *   - divergence_pct / age_seconds は percentage / 計数なので Number (§4.5 carve-out)。
 *
 * fail-closed (§4.6):
 *   - 両 unavailable → oracle_unavailable
 *   - Pyth stale かつ Switchboard fallback 不可 → oracle_both_stale
 *   - Pyth ↔ Switchboard 乖離 >5% (両 fresh 時) → oracle_divergence_too_large
 *   - 2-5% → oracle_divergence_warning / Pyth stale→SB → oracle_pyth_stale
 *   - feed 未設定 asset は gate せず通す (not_configured、silent fail にしない)
 */

import type {
  OracleResult,
  OracleSourceStatus,
  OracleWarning,
} from "@workspace/lib/types";

const HERMES_URL = "https://hermes.pyth.network/v2/updates/price/latest";
const CROSSBAR_URL = "https://crossbar.switchboard.xyz/simulate";

/** §4.6 staleness 閾値 (秒) */
export const STALENESS_THRESHOLD_S = 60;
/** §4.6 divergence warning 閾値 (%) */
export const DIVERGENCE_WARN_PCT = 2;
/** §4.6 divergence block 閾値 (%、execute 拒否) */
export const DIVERGENCE_BLOCK_PCT = 5;

const CACHE_TTL_MS = 12_000;
const FETCH_TIMEOUT_MS = 8_000;

interface FeedConfig {
  symbol: string;
  /** Pyth Hermes price feed id (0x...)。無ければ Pyth 未設定 */
  pythFeedId?: string;
  /** Switchboard Crossbar feed hash (0x...)。無ければ Switchboard 未設定 */
  switchboardFeedHash?: string;
}

/**
 * underlying mint → oracle feed 設定。実地検証済 (2026-06、Hermes / Crossbar)。
 *   - SOL: Pyth + Switchboard 両方 (実 divergence の showcase)
 *   - USDC / USDT: Pyth のみ (staleness 保護)。stablecoin は乖離が出にくい
 *   - EURC / USDG / USDS / JupUSD: 未設定 = 非 gate (feed 確証が取れるまで)
 */
const ASSET_ORACLE_FEEDS: Record<string, FeedConfig> = {
  So11111111111111111111111111111111111111112: {
    symbol: "SOL",
    pythFeedId:
      "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
    switchboardFeedHash:
      "0x822512ee9add93518eca1c105a38422841a76c590db079eebb283deb2c14caa9",
  },
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: {
    symbol: "USDC",
    pythFeedId:
      "0xeaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a",
  },
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: {
    symbol: "USDT",
    pythFeedId:
      "0x2b89b9dc8fdf9f34709a5b106b472f0f39bb6ca9ce04b0fd7f2e971688e2e53b",
  },
  // JLP (Phase 8.27 — Kamino JLP reserve 用。Hermes query で実在確認 2026-07-11)
  "27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4": {
    symbol: "JLP",
    pythFeedId:
      "0xc811abc82b4bad1f9bd711a2773ccaa935b03ecef974236942cec5e0eb845a3a",
  },
};

/**
 * Phase 8.57: symbol → underlying mint (registry の逆引き)。
 * `/prices` が symbol 指定で oracle 価格を引くために使う。
 * WSOL は SOL の別名として扱う (mobile 側は SOL に正規化して持つ)。
 */
export function oracleMintForSymbol(symbol: string): string | undefined {
  const wanted = symbol === "WSOL" ? "SOL" : symbol;
  for (const [mint, feed] of Object.entries(ASSET_ORACLE_FEEDS)) {
    if (feed.symbol === wanted) return mint;
  }
  return undefined;
}

/**
 * Phase 8.58: symbol → Pyth feed id。過去価格 (Benchmarks) を引くのに使う。
 * latest (Hermes) と同じ feed を使うことで現在と過去の出所を揃える。
 */
export function pythFeedIdForSymbol(symbol: string): string | undefined {
  const mint = oracleMintForSymbol(symbol);
  if (!mint) return undefined;
  return ASSET_ORACLE_FEEDS[mint]?.pythFeedId;
}

const UNAVAILABLE: OracleSourceStatus = {
  available: false,
  price_usd: null,
  age_seconds: null,
};

/** Number 価格 → 8 decimals string (transport 用、§4.5 注記参照) */
function toPriceString(price: number): string {
  return price.toFixed(8);
}

async function fetchJson(url: string): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Pyth Hermes から price + age を取得。失敗/未設定なら available:false。 */
export async function fetchPyth(
  feedId: string | undefined
): Promise<OracleSourceStatus> {
  if (!feedId) return UNAVAILABLE;
  try {
    const json = (await fetchJson(
      `${HERMES_URL}?ids[]=${encodeURIComponent(feedId)}`
    )) as {
      parsed?: Array<{
        price?: { price: string; expo: number; publish_time: number };
      }>;
    };
    const p = json.parsed?.[0]?.price;
    if (!p || !/^[0-9]+$/.test(p.price)) return UNAVAILABLE;
    const price = Number(p.price) * Math.pow(10, p.expo);
    if (!Number.isFinite(price) || price <= 0) return UNAVAILABLE;
    const age = Math.floor(Date.now() / 1000) - p.publish_time;
    return {
      available: true,
      price_usd: toPriceString(price),
      age_seconds: age >= 0 ? age : 0,
    };
  } catch {
    return UNAVAILABLE;
  }
}

/** Switchboard Crossbar simulate から price を取得 (live = fresh, age 0)。失敗/未設定なら available:false。 */
export async function fetchSwitchboard(
  feedHash: string | undefined
): Promise<OracleSourceStatus> {
  if (!feedHash) return UNAVAILABLE;
  try {
    const json = (await fetchJson(
      `${CROSSBAR_URL}/${encodeURIComponent(feedHash)}`
    )) as Array<{ results?: string[] }>;
    const results = json?.[0]?.results ?? [];
    const valid = results
      .map((r) => Number(r))
      .filter((n) => Number.isFinite(n) && n > 0);
    if (valid.length === 0) return UNAVAILABLE;
    // 複数 job の場合は中央値
    valid.sort((a, b) => a - b);
    const mid = Math.floor(valid.length / 2);
    const price =
      valid.length % 2 === 0 ? (valid[mid - 1]! + valid[mid]!) / 2 : valid[mid]!;
    return { available: true, price_usd: toPriceString(price), age_seconds: 0 };
  } catch {
    return UNAVAILABLE;
  }
}

/**
 * §4.6 decision table を実装する pure 関数。fetch 結果から最終判定を生成。
 * これが fail-closed の核 (jest 全分岐対象)。
 */
export function evaluateOracle(
  symbol: string,
  pyth: OracleSourceStatus,
  switchboard: OracleSourceStatus
): OracleResult {
  const base = {
    asset_symbol: symbol,
    pyth,
    switchboard,
  };

  // 両 unavailable → fail-closed
  if (!pyth.available && !switchboard.available) {
    return {
      ...base,
      status: "blocked",
      primary: null,
      price_usd: null,
      divergence_pct: null,
      warnings: [],
      block_reason: "oracle_unavailable",
    };
  }

  const pythFresh =
    pyth.available &&
    pyth.age_seconds !== null &&
    pyth.age_seconds <= STALENESS_THRESHOLD_S;
  const pythStale = pyth.available && !pythFresh;
  const sbFresh = switchboard.available; // Crossbar simulate = fresh by construction

  const warnings: OracleWarning[] = [];
  let primary: OracleResult["primary"];
  let price_usd: string | null;

  if (pythFresh) {
    primary = "pyth";
    price_usd = pyth.price_usd;
  } else if (sbFresh) {
    // Pyth stale / 未取得 だが Switchboard fresh → fallback + warning
    primary = "switchboard";
    price_usd = switchboard.price_usd;
    warnings.push({
      kind: "oracle_pyth_stale",
      pythAgeSeconds: pyth.age_seconds ?? undefined,
    });
  } else {
    // Pyth stale かつ Switchboard fallback 不可 → fail-closed
    return {
      ...base,
      status: "blocked",
      primary: null,
      price_usd: null,
      divergence_pct: null,
      warnings: [],
      block_reason: "oracle_both_stale",
    };
  }

  // divergence は両 fresh の時のみ評価 (stale price 比較は無意味)
  let divergence_pct: number | null = null;
  if (
    pythFresh &&
    switchboard.available &&
    pyth.price_usd &&
    switchboard.price_usd
  ) {
    const a = Number(pyth.price_usd);
    const b = Number(switchboard.price_usd);
    if (a > 0 && b > 0) {
      divergence_pct = (Math.abs(a - b) / ((a + b) / 2)) * 100;
      if (divergence_pct > DIVERGENCE_BLOCK_PCT) {
        return {
          ...base,
          status: "blocked",
          primary: null,
          price_usd: null,
          divergence_pct,
          warnings: [],
          block_reason: "oracle_divergence_too_large",
        };
      }
      if (divergence_pct >= DIVERGENCE_WARN_PCT) {
        warnings.push({ kind: "oracle_divergence_warning", divergencePct: divergence_pct });
      }
    }
  }

  return {
    ...base,
    status: warnings.length > 0 ? "warning" : "ok",
    primary,
    price_usd,
    divergence_pct,
    warnings,
    block_reason: null,
  };
}

interface CacheEntry {
  data: OracleResult;
  ts: number;
}
const cache = new Map<string, CacheEntry>();

export function _clearOracleCacheForTest(): void {
  cache.clear();
}

/**
 * underlying mint の oracle 判定を返す。feed 未設定 asset は not_configured で通す
 * (oracle gate 対象外)。設定済 asset は Pyth/Switchboard を並列 fetch して評価。
 */
export async function getOracleResult(mint: string): Promise<OracleResult> {
  const config = ASSET_ORACLE_FEEDS[mint];

  // feed 未設定 → 非 gate (正当な asset を silent fail させない)
  if (!config || (!config.pythFeedId && !config.switchboardFeedHash)) {
    return {
      asset_symbol: config?.symbol ?? "UNKNOWN",
      status: "ok",
      primary: null,
      price_usd: null,
      pyth: UNAVAILABLE,
      switchboard: UNAVAILABLE,
      divergence_pct: null,
      warnings: [],
      block_reason: null,
      not_configured: true,
    };
  }

  const cached = cache.get(mint);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.data;

  const [pyth, switchboard] = await Promise.all([
    fetchPyth(config.pythFeedId),
    fetchSwitchboard(config.switchboardFeedHash),
  ]);
  const result = evaluateOracle(config.symbol, pyth, switchboard);
  cache.set(mint, { data: result, ts: Date.now() });
  return result;
}
