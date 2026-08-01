/**
 * portfolio-history — wallet の tx から過去の評価額を復元する (Phase 8.58)
 *
 * 8.56 の端末スナップショットは「今日から」しか貯まらない。ここでは
 * **現在残高から tx の差分を遡って**各日の残高を復元し、その日の実価格
 * (Pyth Benchmarks) で値付けする。捏造は入れない:
 *   - 残高は Helius enhanced tx の符号付き差分から厳密に復元 (bigint、§4.5)
 *   - 価格は feed がある asset のみ実価格。無い asset は **現在価格で固定**し、
 *     近似であることを応答で明示する (jlToken / LST の過去 rate は取得手段が無い)
 *   - tx window より前は残高を保証できないので、その日より前は返さない
 *
 * 本 module は **純関数** を中心に構成し (I/O は server.ts の route が担当)、
 * 逆算とサンプリングを単体テストできるようにしてある。
 */

import {
  toBigInt,
  toSmallestUnit,
} from "@workspace/lib/utils/numeric";

/** USD の 8-dec fixed point bigint → decimal string (server.ts と同形式) */
function formatUsd8(scaled8: bigint): string {
  const neg = scaled8 < 0n;
  const v = neg ? -scaled8 : scaled8;
  const intPart = v / 100_000_000n;
  const frac = (v % 100_000_000n).toString().padStart(8, "0");
  return `${neg ? "-" : ""}${intPart.toString()}.${frac}`;
}

/** 8-dec decimal string → scaled bigint (×1e8)。不正は null */
function usd8ToScaled(price: string): bigint | null {
  if (!/^[0-9]+(\.[0-9]{1,8})?$/.test(price)) return null;
  try {
    return toBigInt(toSmallestUnit(price, 8));
  } catch {
    return null;
  }
}

/** 1 件の残高変化 (符号付き smallest unit) */
export interface BalanceDelta {
  /** unix seconds */
  timestamp: number;
  /** mint address (native SOL は "SOL" の擬似キー) */
  mint: string;
  /** 符号付き差分 (wallet 増加が正) */
  amount: bigint;
}

/** 値付けに必要な asset のメタ情報 */
export interface HistoryAsset {
  mint: string;
  symbol: string;
  decimals: number;
  /** Pyth feed id (無ければ過去価格を引けない = 現在価格で近似) */
  feedId?: string | undefined;
  /** 現在の USD 単価 (8-dec string)。feed が無い asset の近似に使う */
  currentUsd8?: string | undefined;
}

export interface HistoryPoint {
  /** "YYYY-MM-DD" (UTC) */
  day: string;
  /** その日の評価額 (USD 8-dec string) */
  usd: string;
  /** その日の SOL 建て評価額 (8-dec string)。SOL 価格が無い日は "0" */
  sol: string;
}

const SECONDS_PER_DAY = 86_400;

/** unix 秒 → UTC の "YYYY-MM-DD" */
export function utcDayKey(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

/** "YYYY-MM-DD" の **終わり** (23:59:59 UTC) の unix 秒 */
export function endOfUtcDay(day: string): number {
  return Math.floor(Date.parse(`${day}T23:59:59.999Z`) / 1000);
}

/**
 * 描画する日付の並びを作る。
 * 90 日までは日次、それを超えたら**週次サンプリング** (点数を ~52 に抑える)。
 * 過去価格は 1 日 1 リクエストなので、1Y を日次にすると 365 回叩くことになる。
 */
export function sampleDays(days: number, nowSeconds: number): string[] {
  const step = days > 90 ? 7 : 1;
  const out: string[] = [];
  for (let ago = days; ago >= 0; ago -= step) {
    out.push(utcDayKey(nowSeconds - ago * SECONDS_PER_DAY));
  }
  const todayKey = utcDayKey(nowSeconds);
  if (out[out.length - 1] !== todayKey) out.push(todayKey);
  return out;
}

/**
 * 現在残高から差分を遡って、各日の**終値残高**を復元する。
 *
 * balance(D) = current − Σ(D の終わりより後に起きた差分)
 * tx window の外まで遡ると負になり得るため、負は 0 に丸める
 * (「その頃はもっと持っていた」ことは差分から証明できないため)。
 */
export function replayBalances(
  current: Map<string, bigint>,
  deltas: BalanceDelta[],
  days: string[]
): Map<string, Map<string, bigint>> {
  const newestFirst = [...deltas].sort((a, b) => b.timestamp - a.timestamp);
  const running = new Map(current);
  const out = new Map<string, Map<string, bigint>>();
  let cursor = 0;
  for (let i = days.length - 1; i >= 0; i--) {
    const day = days[i]!;
    const dayEnd = endOfUtcDay(day);
    while (cursor < newestFirst.length && newestFirst[cursor]!.timestamp > dayEnd) {
      const d = newestFirst[cursor]!;
      running.set(d.mint, (running.get(d.mint) ?? 0n) - d.amount);
      cursor++;
    }
    const snapshot = new Map<string, bigint>();
    for (const [mint, amount] of running) {
      snapshot.set(mint, amount > 0n ? amount : 0n);
    }
    out.set(day, snapshot);
  }
  return out;
}

/** その asset の、その日の USD 単価 (8-dec string)。引けなければ null */
function priceForAsset(
  asset: HistoryAsset,
  pricesOfDay: Map<string, string> | undefined
): { usd8: string; approximated: boolean } | null {
  if (asset.feedId) {
    const real = pricesOfDay?.get(asset.feedId);
    if (real) return { usd8: real, approximated: false };
  }
  // feed が無い / その日の価格が引けない → 現在価格で近似 (応答で明示する)
  if (asset.currentUsd8 && asset.currentUsd8 !== "0") {
    return { usd8: asset.currentUsd8, approximated: true };
  }
  return null;
}

export interface HistorySeries {
  points: HistoryPoint[];
  /** 現在価格で近似した (= その日の実価格が無い) asset symbol */
  approximatedSymbols: string[];
}

/**
 * 日次残高 × その日の価格 → 評価額の系列。
 * SOL 建ては同じ日の SOL 価格で割る (SOL の線も歴史的に正しくなる)。
 */
export function buildHistorySeries(
  days: string[],
  balancesByDay: Map<string, Map<string, bigint>>,
  assets: HistoryAsset[],
  pricesByDay: Map<string, Map<string, string>>,
  solFeedId: string | undefined
): HistorySeries {
  const points: HistoryPoint[] = [];
  const approximated = new Set<string>();
  for (const day of days) {
    const balances = balancesByDay.get(day);
    if (!balances) continue;
    const pricesOfDay = pricesByDay.get(day);
    let usdTotal = 0n; // 8-dec fixed point
    let priced = false;
    for (const asset of assets) {
      const amount = balances.get(asset.mint) ?? 0n;
      if (amount === 0n) continue;
      const price = priceForAsset(asset, pricesOfDay);
      if (!price) continue;
      // amount(smallest) × price(8-dec) / 10^decimals → USD の 8-dec fixed point
      const scaled = usd8ToScaled(price.usd8);
      if (scaled === null || scaled === 0n) continue;
      if (price.approximated) approximated.add(asset.symbol);
      usdTotal += (amount * scaled) / 10n ** BigInt(asset.decimals);
      priced = true;
    }
    if (!priced) continue;
    const solScaled = solFeedId
      ? usd8ToScaled(pricesOfDay?.get(solFeedId) ?? "")
      : null;
    const sol8 =
      solScaled && solScaled > 0n ? (usdTotal * 100_000_000n) / solScaled : 0n;
    points.push({
      day,
      usd: formatUsd8(usdTotal),
      sol: formatUsd8(sol8),
    });
  }
  return { points, approximatedSymbols: [...approximated].sort() };
}
