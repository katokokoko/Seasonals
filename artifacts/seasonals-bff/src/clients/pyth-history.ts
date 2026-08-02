/**
 * pyth-history — 過去の実価格 (Phase 8.58 / 8.59)
 *
 * Pyth Benchmarks の過去価格。oracle.ts (Hermes latest) と同じ提供元なので、
 * 現在と過去で価格の出所が一致する (§4.6 Pyth primary の一貫性)。
 *
 * 実測メモ (2026-08-01):
 *   - 400 日前まで取得できた (SOL: 1d $74.92 / 180d $102.29 / 400d $139.18)
 *   - symbol は `Crypto.<SYMBOL>/USD`。SOL / USDC / USDT / JLP で確認済
 *   - User-Agent 無しだと Cloudflare が 403 を返すことがある (python urllib で再現)。
 *     undici (fetchWithTimeout) + 明示 UA で回避する。
 *     — solend-sdk が global fetch を node-fetch に差し替えて Orca/Meteora が
 *       403 になった 8.38 の件と同種の落とし穴
 *
 * 8.59: **1 点 1 リクエスト**の `/v1/updates/price/<ts>` から、系列を一括で返す
 * TradingView shim (`/v1/shims/tradingview/history`) に切り替えた。点密度を ~90 に
 * 上げたところ、時刻ごとの個別取得では大半が rate limit で落ち、chart が
 * 「現在価格で概算」だらけの平坦線になっていた (実機で確認)。
 * shim なら **1 symbol 1 リクエスト**で範囲全体が取れる。
 *
 * §4.5: 価格は USD 8 decimals string に正規化して返す。
 */

import { fetchWithTimeout } from "./http";

const SHIM_URL = "https://benchmarks.pyth.network/v1/shims/tradingview/history";
const FETCH_TIMEOUT_MS = 15_000;
/** 系列はしばらく変わらない (末尾以外は不変) ので短めの TTL で十分 */
const CACHE_TTL_MS = 5 * 60_000;
const CACHE_MAX_ENTRIES = 200;

/** 時刻昇順の価格系列 (USD 8-dec string) */
export interface PriceSeries {
  t: number[];
  usd8: string[];
}

interface CacheEntry {
  at: number;
  data: PriceSeries;
}

const cache = new Map<string, CacheEntry>();

export function _clearPythHistoryCacheForTest(): void {
  cache.clear();
}

/** symbol → TradingView shim の symbol 名 */
export function tradingViewSymbol(symbol: string): string {
  return `Crypto.${symbol === "WSOL" ? "SOL" : symbol}/USD`;
}

/**
 * 刻み幅 (秒) → shim の resolution。取り得る値は分数 or "D"。
 * 目標刻みより **細かい** 解像度を選び、呼び手が「その時刻以前の直近」を拾う。
 */
export function resolutionForStep(stepSec: number): string {
  if (stepSec <= 3_600) return "60";
  if (stepSec <= 2 * 3_600) return "120";
  if (stepSec <= 4 * 3_600) return "240";
  if (stepSec <= 6 * 3_600) return "360";
  if (stepSec <= 12 * 3_600) return "720";
  return "D";
}

/** float の価格 → USD 8-dec string (§4.5 の文字列表現に揃える) */
export function priceToUsd8(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return value.toFixed(8);
}

/**
 * 指定範囲の価格系列を **1 リクエスト**で取得する。
 * 失敗時は空系列 (呼び手は「その asset は実価格不明」として近似に落ちる)。
 */
export async function fetchPriceSeries(
  symbol: string,
  fromSec: number,
  toSec: number,
  stepSec: number
): Promise<PriceSeries> {
  const resolution = resolutionForStep(stepSec);
  const tvSymbol = tradingViewSymbol(symbol);
  const cacheKey = `${tvSymbol}|${resolution}|${fromSec}|${toSec}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.data;

  const url =
    `${SHIM_URL}?symbol=${encodeURIComponent(tvSymbol)}` +
    `&resolution=${resolution}&from=${fromSec}&to=${toSec}`;
  const out: PriceSeries = { t: [], usd8: [] };
  try {
    const res = await fetchWithTimeout(
      url,
      {
        method: "GET",
        headers: {
          accept: "application/json",
          // Cloudflare 対策 (UA 無しだと 403 になることがある)
          "user-agent": "seasonals-bff/1.0",
        },
      },
      FETCH_TIMEOUT_MS
    );
    if (!res.ok) return out;
    const json = (await res.json()) as {
      s?: string;
      t?: number[];
      c?: number[];
    };
    if (json.s !== "ok" || !Array.isArray(json.t) || !Array.isArray(json.c)) {
      return out;
    }
    for (let i = 0; i < json.t.length; i++) {
      const usd8 = priceToUsd8(json.c[i]);
      const at = json.t[i];
      if (usd8 === null || typeof at !== "number") continue;
      out.t.push(at);
      out.usd8.push(usd8);
    }
  } catch {
    /* noop — 取れない symbol は空系列 (呼び手が近似に落ちる) */
  }
  cache.set(cacheKey, { at: Date.now(), data: out });
  while (cache.size > CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return out;
}

/**
 * 系列から「その時刻以前の直近」の価格を引く (二分探索)。
 * 系列より前の時刻は最初の点で代用しない = undefined (捏造しない)。
 */
export function priceAtOrBefore(
  series: PriceSeries,
  at: number
): string | undefined {
  const { t, usd8 } = series;
  if (t.length === 0 || at < t[0]!) return undefined;
  let lo = 0;
  let hi = t.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (t[mid]! <= at) lo = mid;
    else hi = mid - 1;
  }
  return usd8[lo];
}
