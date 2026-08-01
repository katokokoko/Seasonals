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
  /** その点の時刻 (unix 秒)。8.59: 日内サンプリングのため日付文字列から変更 */
  at: number;
  /** その時点の評価額 (USD 8-dec string) */
  usd: string;
  /** その時点の SOL 建て評価額 (8-dec string)。SOL 価格が無い点は "0" */
  sol: string;
}

const SECONDS_PER_DAY = 86_400;
const SECONDS_PER_HOUR = 3_600;

/**
 * 切りのよい刻み幅 (秒)。範囲 ÷ 目標点数 を、この中の最も近い値に丸める。
 * epoch からの倍数に整列させるので、同じ刻みなら毎回同じ時刻を引く
 * (= 過去価格キャッシュがそのまま効く)。
 */
const NICE_STEPS_SEC = [
  1 * SECONDS_PER_HOUR,
  2 * SECONDS_PER_HOUR,
  3 * SECONDS_PER_HOUR,
  4 * SECONDS_PER_HOUR,
  6 * SECONDS_PER_HOUR,
  8 * SECONDS_PER_HOUR,
  12 * SECONDS_PER_HOUR,
  1 * SECONDS_PER_DAY,
  2 * SECONDS_PER_DAY,
  3 * SECONDS_PER_DAY,
  4 * SECONDS_PER_DAY,
  5 * SECONDS_PER_DAY,
  7 * SECONDS_PER_DAY,
  8 * SECONDS_PER_DAY,
  14 * SECONDS_PER_DAY,
];

/** どの range でもこの点数を目指す (3M の日次 ≒ 90 点が「ちょうどいい」基準) */
export const TARGET_POINTS = 90;

/**
 * 末尾の点を「今」から少し戻す秒数。
 * 実測 (8.58): Benchmarks は現在時刻ちょうどだと 404、60s 前なら 200。
 */
export const HISTORY_PRICE_LAG_SEC = 120;

/** unix 秒 → UTC の "YYYY-MM-DD" (ログ / 表示補助用) */
export function utcDayKey(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

/**
 * 描画する時刻の並びを作る。
 *
 * 8.59: range によって点密度が違った (1W は 8 点、3M は 91 点) のを、
 * **目標点数から刻みを決める**方式に変更。1W なら 2 時間刻み、1Y なら 4 日刻みで
 * どれも ~90 点になる。Pyth Benchmarks は任意時刻に対応するので日内も引ける。
 */
export function sampleTimestamps(
  days: number,
  nowSeconds: number,
  targetPoints: number = TARGET_POINTS
): number[] {
  const rangeSec = days * SECONDS_PER_DAY;
  const ideal = rangeSec / Math.max(1, targetPoints);
  // 理想の刻みに **最も近い** 値を選ぶ。切り上げだと 1Y (理想 4.05 日) が
  // 7 日刻みに飛んで 53 点しか出ず、range 間で密度が揃わない
  const step = NICE_STEPS_SEC.reduce((best, s) =>
    Math.abs(s - ideal) < Math.abs(best - ideal) ? s : best
  );
  // 末尾は「今」ではなく少し過去 (Benchmarks は現在時刻ちょうどで 404)
  const end = nowSeconds - HISTORY_PRICE_LAG_SEC;
  // epoch 倍数に整列 (同じ引数なら毎回同一の配列 = キャッシュが効く)
  const lastAligned = Math.floor(end / step) * step;
  // 8.60: **末尾から step の倍数だけ遡る**。以前は `lastAligned - rangeSec` を
  // 起点にしていたため、days が端数 (描ける期間から算出するので端数になる) だと
  // 全点が整列から外れ、range ごとに別の時刻列 = 価格キャッシュが効かなかった
  const count = Math.floor(rangeSec / step);
  const out: number[] = [];
  for (let i = count; i >= 0; i--) out.push(lastAligned - i * step);
  return out;
}

/**
 * 現在残高から差分を遡って、**各時点の残高**を復元する。
 *
 * balance(t) = current − Σ(t より後に起きた差分)
 * tx window の外まで遡ると負になり得るため、負は 0 に丸める
 * (「その頃はもっと持っていた」ことは差分から証明できないため)。
 *
 * 8.59: 日単位から unix 秒単位に一般化 (1W を日内 2 時間刻みで描くため)。
 */
export function replayBalances(
  current: Map<string, bigint>,
  deltas: BalanceDelta[],
  timestamps: number[]
): Map<number, Map<string, bigint>> {
  const newestFirst = [...deltas].sort((a, b) => b.timestamp - a.timestamp);
  const running = new Map(current);
  const out = new Map<number, Map<string, bigint>>();
  let cursor = 0;
  for (let i = timestamps.length - 1; i >= 0; i--) {
    const at = timestamps[i]!;
    while (cursor < newestFirst.length && newestFirst[cursor]!.timestamp > at) {
      const d = newestFirst[cursor]!;
      running.set(d.mint, (running.get(d.mint) ?? 0n) - d.amount);
      cursor++;
    }
    const snapshot = new Map<string, bigint>();
    for (const [mint, amount] of running) {
      snapshot.set(mint, amount > 0n ? amount : 0n);
    }
    out.set(at, snapshot);
  }
  return out;
}

/**
 * 「wallet が **最初に** 資産を持った時刻」を差分から求める (8.60)。
 *
 * 8.59 は「遡って最初に全部ゼロになった時点」を返していたが、
 * 入金 → 全額引き出し → 再入金 という wallet で **最後の保有期間しか出ない**
 * 欠陥があった (実測: 2025-10-26 に 5 SOL 保有 → ゼロ → 2026-05-10 再入金、の
 * 10 月分が丸ごと消えていた)。
 *
 * そこで **要求 window の中で最初に** 残高が正になった時刻を返す。
 * これを描画の下限にすることで:
 *   - window 開始より後に入金した場合 → 入金時点から描く (入金前のゼロは描かない)
 *   - window の中で一度ゼロに戻った場合 → **途中のゼロ期間は事実として描く**
 *
 * window 先頭で既に保有していた場合は null (= それ以前は差分から証明できないので、
 * 呼び手は window 端を下限にする)。
 */
export function firstFundedTime(
  current: Map<string, bigint>,
  deltas: BalanceDelta[],
  windowStart: number
): number | null {
  // window 先頭の残高 = 現在 − (それ以降に起きた差分)
  const atWindowStart = new Map(current);
  const inWindow: BalanceDelta[] = [];
  for (const d of deltas) {
    if (d.timestamp <= windowStart) continue;
    inWindow.push(d);
    atWindowStart.set(d.mint, (atWindowStart.get(d.mint) ?? 0n) - d.amount);
  }
  for (const amount of atWindowStart.values()) {
    // 先頭時点で既に保有 = それ以前は差分から証明できない
    if (amount > 0n) return null;
  }
  inWindow.sort((a, b) => a.timestamp - b.timestamp);
  const running = new Map<string, bigint>();
  for (const d of inWindow) {
    running.set(d.mint, (running.get(d.mint) ?? 0n) + d.amount);
    for (const amount of running.values()) {
      if (amount > 0n) return d.timestamp;
    }
  }
  return null;
}

/** その asset の、その時点の USD 単価 (8-dec string)。引けなければ null */
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
 * 各時点の残高 × その時点の価格 → 評価額の系列。
 * SOL 建ては同じ時点の SOL 価格で割る (SOL の線も歴史的に正しくなる)。
 */
export function buildHistorySeries(
  timestamps: number[],
  balancesByTime: Map<number, Map<string, bigint>>,
  assets: HistoryAsset[],
  pricesByTime: Map<number, Map<string, string>>,
  solFeedId: string | undefined
): HistorySeries {
  const points: HistoryPoint[] = [];
  const approximated = new Set<string>();
  for (const at of timestamps) {
    const balances = balancesByTime.get(at);
    if (!balances) continue;
    const pricesOfPoint = pricesByTime.get(at);
    let usdTotal = 0n; // 8-dec fixed point
    let priced = false;
    let heldAnything = false;
    for (const asset of assets) {
      const amount = balances.get(asset.mint) ?? 0n;
      if (amount === 0n) continue;
      heldAnything = true;
      const price = priceForAsset(asset, pricesOfPoint);
      if (!price) continue;
      // amount(smallest) × price(8-dec) / 10^decimals → USD の 8-dec fixed point
      const scaled = usd8ToScaled(price.usd8);
      if (scaled === null || scaled === 0n) continue;
      if (price.approximated) approximated.add(asset.symbol);
      usdTotal += (amount * scaled) / 10n ** BigInt(asset.decimals);
      priced = true;
    }
    // 8.60: 全資産ゼロは **事実** なので 0 の点を描く (入金前 / 全額引き出し後)。
    // 「保有しているが価格が引けない」場合とは区別し、後者は点を作らない
    if (!priced) {
      if (heldAnything) continue;
      points.push({ at, usd: "0.00000000", sol: "0.00000000" });
      continue;
    }
    const solScaled = solFeedId
      ? usd8ToScaled(pricesOfPoint?.get(solFeedId) ?? "")
      : null;
    const sol8 =
      solScaled && solScaled > 0n ? (usdTotal * 100_000_000n) / solScaled : 0n;
    points.push({ at, usd: formatUsd8(usdTotal), sol: formatUsd8(sol8) });
  }
  return { points, approximatedSymbols: [...approximated].sort() };
}
