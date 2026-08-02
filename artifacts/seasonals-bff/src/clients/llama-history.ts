/**
 * llama-history — Pyth feed が無い token の過去価格 (Phase 8.64)
 *
 * jlUSDC / LST / vault share のような **利回りで単価が上がる token** は、
 * Pyth に feed が無いため 8.58 の履歴では全点を現在価格で近似していた。
 * その結果 Deposited のグラフが **完全な横一直線** になっていた
 * (単価が定数 × 残高が不変 = 積が定数)。線が本来動く理由そのものを
 * 近似が消していた、という不具合。
 *
 * DeFiLlama の coins API は mint 単位で過去価格を持っている (実測: jlUSDC は
 * 2026-05-11 の 1.04269 → 08-01 の 1.05372 = +1.06%、Jupiter の earnings
 * 107982 と整合)。これを **履歴表示専用** の第 3 経路として使う。
 *
 * **oracle 経路とは隔離する**: §4.6 の primary=Pyth / fallback=Switchboard は
 * simulate / execute の fail-closed 判定であり、本 module はそこに一切入らない。
 * ここは chart の値付け (display only) だけに使う。
 *
 * 実測メモ (2026-08-02):
 *   - GET https://coins.llama.fi/chart/solana:<mint>,solana:<mint>
 *       ?start=&span=&period=&searchWidth=
 *     → { coins: { "solana:<mint>": { symbol, confidence, prices: [{timestamp, price}] } } }
 *   - **複数 mint をカンマ区切りで 1 リクエスト**にまとめられる
 *   - period は "2h" / "1d" / "4d" を受ける
 *   - 返る timestamp は要求の格子に整列しない (05:15 / 07:14 …) ので、
 *     呼び手は pyth-history の `priceAtOrBefore` で「その時刻以前の直近」を引く
 *   - 価格履歴が始まる前を要求すると {"coins":{}} (空)。degrade するだけ
 *   - Save cToken / Exponent PT は **未収録** ({"coins":{}})。従来の近似に落ちる
 *
 * §4.5: 価格は USD 8-dec string。アンカー計算も 8-dec scaled bigint で行い、
 * float 演算を通さない。
 */

import { fetchWithTimeout } from "./http";
import type { PriceSeries } from "./pyth-history";

const CHART_URL = "https://coins.llama.fi/chart";
const FETCH_TIMEOUT_MS = 15_000;
/** 系列は末尾以外変わらないので pyth-history と同じ TTL */
const CACHE_TTL_MS = 5 * 60_000;
const CACHE_MAX_ENTRIES = 200;

/**
 * これ未満の confidence は採用しない。DeFiLlama の confidence は
 * 「その価格をどれだけ信用してよいか」の指標で、低い値をそのまま描くと
 * 実データの顔をした雑音になる (実測: jlUSDC = 0.9)。
 */
export const MIN_CONFIDENCE = 0.7;

/** 上限点数 (API の span 上限に踏み込まないための保険) */
const MAX_SPAN = 400;

interface CacheEntry {
  at: number;
  data: Map<string, PriceSeries>;
}

const cache = new Map<string, CacheEntry>();

export function _clearLlamaHistoryCacheForTest(): void {
  cache.clear();
}

/** mint → coins API のキー (Solana chain 固定) */
export function llamaCoinKey(mint: string): string {
  return `solana:${mint}`;
}

/**
 * 刻み幅 (秒) → coins API の period。
 * 1 日未満は時間表記、それ以上は日表記に丸める (実測でどちらも受け付ける)。
 */
export function periodForStep(stepSec: number): string {
  if (stepSec < 86_400) {
    const hours = Math.max(1, Math.round(stepSec / 3_600));
    return `${hours}h`;
  }
  const days = Math.max(1, Math.round(stepSec / 86_400));
  return `${days}d`;
}

/** float の価格 → USD 8-dec string (pyth-history.priceToUsd8 と同じ規則) */
function toUsd8(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return value.toFixed(8);
}

/** 8-dec string → scaled bigint (×1e8)。不正は null */
function usd8ToScaled(usd8: string): bigint | null {
  const m = /^([0-9]+)(?:\.([0-9]{1,8}))?$/.exec(usd8);
  if (!m) return null;
  const frac = (m[2] ?? "").padEnd(8, "0");
  try {
    return BigInt(m[1]!) * 100_000_000n + BigInt(frac);
  } catch {
    return null;
  }
}

/** scaled bigint (×1e8) → 8-dec string */
function scaledToUsd8(scaled: bigint): string {
  const v = scaled < 0n ? -scaled : scaled;
  const int = v / 100_000_000n;
  const frac = (v % 100_000_000n).toString().padStart(8, "0");
  return `${scaled < 0n ? "-" : ""}${int}.${frac}`;
}

interface LlamaChartCoin {
  symbol?: string;
  confidence?: number;
  prices?: { timestamp?: number; price?: number }[];
}

/**
 * 複数 mint の過去価格系列を **1 リクエスト**で取得する。
 *
 * 取れなかった mint は Map に入らない (呼び手は従来どおり現在価格の近似に落ちる)。
 * 例外 / 非 ok / 空 / 低 confidence はすべて「無い」として扱い、0 で埋めない。
 */
export async function fetchLlamaPriceSeries(
  mints: string[],
  fromSec: number,
  toSec: number,
  stepSec: number
): Promise<Map<string, PriceSeries>> {
  const unique = [...new Set(mints)].sort();
  const out = new Map<string, PriceSeries>();
  if (unique.length === 0) return out;

  const period = periodForStep(stepSec);
  const span = Math.min(
    MAX_SPAN,
    Math.max(1, Math.ceil((toSec - fromSec) / Math.max(1, stepSec)) + 1)
  );
  const cacheKey = `${unique.join(",")}|${period}|${span}|${fromSec}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.data;

  const coins = unique.map(llamaCoinKey).join(",");
  const url =
    `${CHART_URL}/${coins}?start=${fromSec}&span=${span}` +
    `&period=${period}&searchWidth=${period}`;
  try {
    const res = await fetchWithTimeout(
      url,
      {
        method: "GET",
        headers: {
          accept: "application/json",
          "user-agent": "seasonals-bff/1.0",
        },
      },
      FETCH_TIMEOUT_MS
    );
    if (res.ok) {
      const json = (await res.json()) as {
        coins?: Record<string, LlamaChartCoin>;
      };
      for (const mint of unique) {
        const coin = json.coins?.[llamaCoinKey(mint)];
        if (!coin || !Array.isArray(coin.prices)) continue;
        // confidence は「この価格をどれだけ信用してよいか」。低い値は採用しない
        if (
          typeof coin.confidence === "number" &&
          coin.confidence < MIN_CONFIDENCE
        ) {
          continue;
        }
        const series: PriceSeries = { t: [], usd8: [] };
        for (const p of coin.prices) {
          const usd8 = toUsd8(p?.price);
          if (usd8 === null || typeof p?.timestamp !== "number") continue;
          series.t.push(p.timestamp);
          series.usd8.push(usd8);
        }
        // 返る順は昇順のはずだが保証されていないので明示的に整列する
        if (series.t.length > 1) {
          const order = series.t
            .map((t, i) => [t, i] as const)
            .sort((a, b) => a[0] - b[0]);
          series.t = order.map(([t]) => t);
          series.usd8 = order.map(([, i]) => series.usd8[i]!);
        }
        if (series.t.length > 0) out.set(mint, series);
      }
    }
  } catch {
    /* noop — 取れない mint は Map に入れない (呼び手が近似に落ちる) */
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
 * 系列の末尾を `currentUsd8` に合わせて全体を比例調整する。
 *
 * 見出しの現在値は Helius DAS の価格を使うので、そのままだと chart の右端と
 * 微妙に食い違う (実測 jlUSDC: llama 1.05372 vs DAS 1.05312 = 0.06%)。
 * Deposited の軸は幅が狭い (10.10〜10.21) ため、この差が目視できてしまう。
 *
 * **形 (利回りの推移) は観測値のまま、水準だけ現在の権威ある価格に合わせる**。
 * currentUsd8 が無い / 系列が空 / 末尾が 0 のときは素通し。
 */
export function anchorSeries(
  series: PriceSeries,
  currentUsd8: string | undefined
): PriceSeries {
  if (!currentUsd8 || series.t.length === 0) return series;
  const target = usd8ToScaled(currentUsd8);
  const last = usd8ToScaled(series.usd8[series.usd8.length - 1]!);
  if (target === null || last === null || last === 0n || target === 0n) {
    return series;
  }
  if (target === last) return series;
  return {
    t: [...series.t],
    usd8: series.usd8.map((v) => {
      const scaled = usd8ToScaled(v);
      if (scaled === null) return v;
      return scaledToUsd8((scaled * target) / last);
    }),
  };
}
