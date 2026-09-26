/**
 * portfolio — 資産推移グラフ / Allocation donut の chain 非依存 helper
 *
 * Seeker の `components/portfolio/*` (8.55〜8.76) から chain に依存しない部分を
 * 移設したもの。mobile は re-export で同じ実装を使い、web Dashboard も同じ関数で
 * 描く (same source of truth)。設計: docs/portfolio-history-design.md
 *
 * 数値表現 (CLAUDE.md §3): 合算は USD 8-dec の bigint で行い、Number 化は
 * **chart / donut に渡す直前**だけ (display only、execute / settle 経路に届かない)。
 */

import { COLOR } from "../design-system";
import { PositionCategory } from "../types/enums";
import type {
  PortfolioHistoryResponse,
  PortfolioHolding,
} from "../types/portfolio";
import {
  bigIntToUsd8,
  signedUsd8ToBigInt,
  usd8ToBigInt,
} from "../utils/numeric";

// ── range / 系列 ─────────────────────────────────────────────────────────────

export type RangeKey = "1W" | "1M" | "3M" | "1Y" | "ALL";

export const RANGE_KEYS: readonly RangeKey[] = ["1W", "1M", "3M", "1Y", "ALL"];

export interface PortfolioPoint {
  date: Date;
  /** 選択通貨建ての評価額 (8.55: 旧 `sol` を一般化) */
  value: number;
  /** today より未来か (chart の dashed forecast 区間) */
  isFuture: boolean;
  /**
   * 8.65: 直前の点からの間に起きた **元本の増減** (預入 / 引出、選択通貨建て、符号付き)。
   * 価格変動 / 利回りの分は含まない。段差の理由をマーカーで示すために使う。
   */
  flow?: number;
}

/** 8.62: 集計の対象。total = 全資産 / deposited = protocol への預入のみ */
export type PortfolioScope = "total" | "deposited";

/** range key → 過去日数 */
export function rangeToDays(range: RangeKey): number {
  switch (range) {
    case "1W":
      return 7;
    case "1M":
      return 30;
    case "3M":
      return 90;
    case "1Y":
      return 365;
    case "ALL":
      return 365 * 2;
  }
}

/**
 * chart として意味のある履歴があるか。
 * 2 点未満、または全点が同値 (= 変動を観測していない) なら false。
 * false の間は線を描かず現在値カードを出す (中身のない目盛りを作らない)。
 */
export function hasHistory(points: PortfolioPoint[]): boolean {
  if (points.length < 2) return false;
  const first = points[0]!.value;
  return points.some((p) => p.value !== first);
}

/**
 * chart の y 軸範囲 = **実際の変動幅 (span) の ±10%** 余白。
 *
 * 8.55 は「値そのものの ±10%」にしたが、それだと実データの変動 (利回りは日
 * 0.01% 程度) が広い軸の中に埋もれて再び横一本に見える。span 基準なら小さな
 * 動きでも軸いっぱいに見える。span が 0 の系列は `hasHistory` false として
 * そもそも chart を描かないので、ここでゼロ幅を気にする必要はない
 * (呼ばれても 0 除算しないよう最低幅は残す)。
 */
export function chartBounds(points: PortfolioPoint[]): {
  minValue: number;
  maxValue: number;
} {
  if (points.length === 0) return { minValue: 0, maxValue: 1 };
  const values = points.map((p) => p.value);
  const rawMin = Math.min(...values);
  const rawMax = Math.max(...values);
  // 保険: 全点同値でも 0 除算しない最低幅 (通常は hasHistory=false で未到達)
  const span = rawMax - rawMin || Math.abs(rawMax) * 0.01 || 1;
  const pad = span * 0.1;
  return {
    // 8.60: 評価額は負にならない。ゼロ期間を含む系列で軸に「-13 USDC」が
    // 出ていたので下端を 0 で止める
    minValue: rawMin >= 0 ? Math.max(0, rawMin - pad) : rawMin - pad,
    maxValue: rawMax + pad,
  };
}

/**
 * y 軸ラベルの数値部。
 *
 * 8.56: 小数桁は **目盛りの刻み幅 (step)** から決める。値の桁で決めていた
 * (≥100 → 1 桁) と、150.603 / 150.631 / 150.659 が全部 "150.6" に潰れて
 * 4 段の軸が 2 種類の文字列になっていた — 変動の小さい実データで再発する。
 * step 未指定時は従来どおり値の桁で決める。
 */
export function formatAxisValue(value: number, step?: number): string {
  if (!Number.isFinite(value)) return "0";
  if (step !== undefined && Number.isFinite(step) && step > 0) {
    // step が 0.028 なら 3 桁 (= 隣の目盛りと必ず違う文字列になる)
    const digits = Math.min(6, Math.max(0, Math.ceil(-Math.log10(step)) + 1));
    return value.toFixed(digits);
  }
  const abs = Math.abs(value);
  if (abs >= 100) return value.toFixed(1);
  if (abs >= 1) return value.toFixed(2);
  return value.toFixed(4);
}

/**
 * Phase 8.63: **先頭の連続ゼロ**を落とす (途中のゼロは残す)。
 *
 * 8.61 で保有ゼロの期間も描くようにしたら、入金前の長いゼロ区間が線の大半を
 * 占め、y 軸が 0 まで伸びて **直近の変動が直線に潰れて**しまった。
 * 先頭のゼロは「まだ入金していない」以上の情報を持たない (その事実は 8.60 の
 * 注記が伝えている) ので落とす。一方 **途中のゼロ** (全額引き出し → 再入金) は
 * 「資金が抜けていた」という情報なので残す。
 *
 * 全点ゼロなら空配列 (線を描かず現在値カードに落とす)。
 */
export function trimLeadingZeros(points: PortfolioPoint[]): PortfolioPoint[] {
  const firstNonZero = points.findIndex((p) => p.value > 0);
  if (firstNonZero === -1) return [];
  return firstNonZero === 0 ? points : points.slice(firstNonZero);
}

/**
 * 8.65: **元本の増減マーカー**を打つ点の index。
 *
 * Deposited のグラフは「利回りの推移」を読む面なのに、預入 / 引出があると
 * そこだけ段差になる (実測: 3M で +0.096 jlUSDC の追加預入が、3 ヶ月分の
 * 利回りとほぼ同じ高さの崖になっていた)。段差を消すのではなく **理由が
 * 読めるように** マーカーを打つ。
 *
 * 拾うのは「グラフ上で見える大きさ」の増減だけ。系列の変動幅に対する比で
 * 判定するので、dust の出入りでマーカーが散らからない。
 */
export function flowMarkerIndices(
  points: PortfolioPoint[],
  minSpanRatio = 0.06
): number[] {
  if (points.length < 2) return [];
  const values = points.map((p) => p.value);
  const span = Math.max(...values) - Math.min(...values);
  if (!(span > 0)) return [];
  const threshold = span * minSpanRatio;
  const out: number[] = [];
  points.forEach((p, i) => {
    if (i > 0 && Math.abs(p.flow ?? 0) >= threshold) out.push(i);
  });
  return out;
}

/**
 * Phase 8.60: 選択中の range に対して履歴がどこまで遡れているかを判定する。
 *
 * 「3M と 1Y が同じグラフ」の正体は **その wallet に 82 日分しか履歴が無い**
 * ことだった (それ以前は残高ゼロ)。データは正しいので、UI 側で
 * 「ここから先は存在しない」と伝える。
 *
 * 判定は server の points だけで完結させる (端末時計のズレに影響されない)。
 */
export interface HistoryCoverage {
  /** 要求 range より短い範囲しか描けていない */
  partial: boolean;
  /** 履歴の開始 (points の先頭)。points が空なら null */
  from: Date | null;
  /** 実際に描けている日数 */
  coveredDays: number;
}

/**
 * 8.63: 判定は **実際に描く系列** (先頭ゼロを落とした後) から行う。
 * server の生 points を見ると、注記の日付が線の開始とズレる。
 */
export function historyCoverage(
  points: PortfolioPoint[],
  range: RangeKey
): HistoryCoverage {
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last || points.length < 2) {
    return { partial: false, from: null, coveredDays: 0 };
  }
  const coveredDays =
    (last.date.getTime() - first.date.getTime()) / (86_400 * 1000);
  return {
    // 1 日の余裕を見る (サンプリングの刻みで端が欠けるため)
    partial: coveredDays < rangeToDays(range) - 1,
    from: first.date,
    coveredDays,
  };
}

/**
 * その range が「描ける期間」を超えているか (range チップの淡色化に使う)。
 * **カバーしきっている時は何も淡色にしない** — より長い range にデータが
 * あるかは、その range を引いてみるまで分からないため。
 */
export function rangeExceedsCoverage(
  range: RangeKey,
  coverage: HistoryCoverage
): boolean {
  if (!coverage.partial) return false;
  return rangeToDays(range) > coverage.coveredDays + 1;
}

/**
 * 一度分かった「履歴の開始」から coverage を作る。
 *
 * 開始日は **絶対的な事実** (それ以前は残高ゼロ) なので、短い range に切り替えて
 * 判定材料が無くなっても淡色表示を保つために使う。range を跨いで表示が
 * ちらつくのを防ぐ。
 */
export function coverageFromKnownStart(
  startAt: Date | null,
  now: Date
): HistoryCoverage {
  if (!startAt) return { partial: false, from: null, coveredDays: 0 };
  const coveredDays = (now.getTime() - startAt.getTime()) / (86_400 * 1000);
  return { partial: true, from: startAt, coveredDays };
}

// ── chart 領域の状態 (8.76) ──────────────────────────────────────────────────

/**
 * チャート領域に何を出すか。判定順 (上が優先):
 *   1. chart      — 描ける系列があるなら出す。**refetch 中でも表示中のチャートは
 *                   消さない** (range chip 切替で cache 済みなら即描画)
 *   2. connect    — position が無い = 未接続。読込より優先 (fixture / 未接続
 *                   ユーザーに brewing を見せない)
 *   3. brewing    — history query が in-flight
 *   4. placeholder — 取得済みだが描ける点が無い ("Tracking since …" の既存カード)
 *
 * 注意: 呼び手は TanStack Query の **isFetching を渡す。isPending は不可** —
 * disabled query は isPending が永久に true になる (未接続で brewing し続けてしまう)。
 */
export type ChartAreaState = "chart" | "brewing" | "connect" | "placeholder";

export function chartAreaState(args: {
  hasPositions: boolean;
  showChart: boolean;
  historyFetching: boolean;
}): ChartAreaState {
  if (args.showChart) return "chart";
  if (!args.hasPositions) return "connect";
  if (args.historyFetching) return "brewing";
  return "placeholder";
}

// ── 複数アドレスの合算 (web Dashboard) ─────────────────────────────────────

/** 合算後の 1 点 (USD のみ。chain をまたぐので native 建ては持たない) */
export interface MergedHistoryPoint {
  at: number;
  usd: string;
  deposited_usd: string;
  flow_usd: string;
  deposited_flow_usd: string;
}

export interface MergedHistory {
  points: MergedHistoryPoint[];
  approximated_symbols: string[];
  excluded_from_history: string[];
  /**
   * 合算の開始が、ある系列の「それ以前は不明」で切られたか
   * (UI で「History from … (limited by …)」を出す材料)
   */
  truncated: boolean;
}

/**
 * 複数アドレス (chain 混在可) の履歴を USD で合算する。
 *
 * 系列ごとに刻み (range と描ける期間から BFF が決める) も末尾時刻も違うので:
 *   - **時刻の格子** = 最も古くから描けている系列の時刻列 (同着なら刻みの粗い方)
 *   - 各系列の値 = 格子時刻以前の直近の点 (carry-forward)
 *   - flow = その系列の (前の格子時刻, 今の格子時刻] に入る flow の合計
 *   - 開始前の扱い: `starts_at_funding` の系列は「それ以前はゼロと確定」なので 0、
 *     そうでない系列は「それ以前は不明」なので **合算をその系列の先頭から始める**
 *     (不明を 0 と見なして合計を低く描かない = 架空値を出さない)
 *   - funding 系列が格子の途中で現れる点は、その評価額ぶんを flow (入金) に数える
 *
 * 金額はすべて bigint で合算する。
 */
export function mergeHistorySeries(
  responses: PortfolioHistoryResponse[]
): MergedHistory {
  const approximated = new Set<string>();
  const excluded = new Set<string>();
  for (const r of responses) {
    r.approximated_symbols.forEach((s) => approximated.add(s));
    (r.excluded_from_history ?? []).forEach((s) => excluded.add(s));
  }
  const meta = {
    approximated_symbols: [...approximated].sort(),
    excluded_from_history: [...excluded].sort(),
  };

  const series = responses
    .filter((r) => r.points.length > 0)
    .map((r) => ({
      points: [...r.points].sort((a, b) => a.at - b.at),
      fundedStart: r.starts_at_funding === true,
    }));
  if (series.length === 0) return { points: [], truncated: false, ...meta };

  // 格子 = 最も古くから描けている系列。同着なら **点の少ない (刻みの粗い) 方** —
  // 粗い系列を細かい格子に carry-forward すると実在しない階段が描かれるため
  const grid = series.reduce((best, s) => {
    const a = s.points[0]!.at;
    const b = best.points[0]!.at;
    return a < b || (a === b && s.points.length < best.points.length)
      ? s
      : best;
  });
  // 「それ以前は不明」の系列の先頭のうち最も新しいもの = 合算の開始
  const unknownBefore = series
    .filter((s) => !s.fundedStart)
    .map((s) => s.points[0]!.at);
  const start = unknownBefore.length > 0 ? Math.max(...unknownBefore) : -Infinity;
  const stamps = grid.points.map((p) => p.at).filter((at) => at >= start);
  // 開始が格子の間に落ちた場合は、その系列の先頭時刻そのものから始める
  if (Number.isFinite(start) && (stamps.length === 0 || stamps[0]! > start)) {
    stamps.unshift(start);
  }
  // 末尾はどの系列の最新点も取りこぼさないよう最も新しい時刻に揃える
  const lastAt = Math.max(...series.map((s) => s.points[s.points.length - 1]!.at));
  if (stamps.length > 0 && stamps[stamps.length - 1]! < lastAt) {
    stamps[stamps.length - 1] = lastAt;
  }
  const truncated = Number.isFinite(start) && start > grid.points[0]!.at;

  const points: MergedHistoryPoint[] = [];
  const cursors = series.map(() => -1);
  stamps.forEach((at, gi) => {
    let usd = 0n;
    let deposited = 0n;
    let flow = 0n;
    let depositedFlow = 0n;
    series.forEach((s, si) => {
      const prevCursor = cursors[si]!;
      let c = prevCursor;
      while (c + 1 < s.points.length && s.points[c + 1]!.at <= at) c++;
      cursors[si] = c;
      if (c < 0) return; // まだ始まっていない (funding 前 = 0 と確定)
      const p = s.points[c]!;
      usd += usd8ToBigInt(p.usd);
      deposited += usd8ToBigInt(p.deposited_usd);
      if (gi === 0) return; // 先頭の点に「直前からの増減」は無い
      if (prevCursor < 0) {
        // 格子の途中で現れた funding 系列: 0 → 初回評価額 は入金
        flow += usd8ToBigInt(s.points[0]!.usd);
        depositedFlow += usd8ToBigInt(s.points[0]!.deposited_usd);
      }
      for (let k = Math.max(prevCursor + 1, 1); k <= c; k++) {
        flow += signedUsd8ToBigInt(s.points[k]!.flow_usd);
        depositedFlow += signedUsd8ToBigInt(s.points[k]!.deposited_flow_usd);
      }
    });
    points.push({
      at,
      usd: bigIntToUsd8(usd),
      deposited_usd: bigIntToUsd8(deposited),
      flow_usd: bigIntToUsd8(flow),
      deposited_flow_usd: bigIntToUsd8(depositedFlow),
    });
  });
  return { points, truncated, ...meta };
}

/**
 * 表示期間の **入出金を除いた** 増減 (USD 8-dec、符号付き) = 利回り + 価格変動。
 *
 *   change = (最後の評価額 − 最初の評価額) − Σ flow (2 点目以降)
 *
 * 入金で総額が増えたのを「儲かった」と見せないため (8.65 の flow 分解と同じ考え方)。
 * 先頭のゼロ区間 (入金前) は mergedHistoryToPoints と同じく飛ばす。2 点未満は null。
 */
export function historyChangeExFlows(
  points: MergedHistoryPoint[],
  scope: PortfolioScope = "total"
): string | null {
  const deposited = scope === "deposited";
  const value = (p: MergedHistoryPoint) =>
    usd8ToBigInt(deposited ? p.deposited_usd : p.usd);
  const start = points.findIndex((p) => value(p) > 0n);
  if (start === -1 || points.length - start < 2) return null;
  let flows = 0n;
  for (let i = start + 1; i < points.length; i++) {
    const p = points[i]!;
    flows += signedUsd8ToBigInt(deposited ? p.deposited_flow_usd : p.flow_usd);
  }
  const change = value(points[points.length - 1]!) - value(points[start]!) - flows;
  return bigIntToUsd8(change);
}

/**
 * 合算済み履歴 → chart の系列 (USD 建て)。**表示直前の Number 化**なので
 * §4.5 の carve-out 内。先頭のゼロ区間は落とす (8.63)。
 */
export function mergedHistoryToPoints(
  points: MergedHistoryPoint[],
  scope: PortfolioScope = "total"
): PortfolioPoint[] {
  const deposited = scope === "deposited";
  const out: PortfolioPoint[] = [];
  for (const p of points) {
    const value = Number(deposited ? p.deposited_usd : p.usd);
    if (!Number.isFinite(value) || value < 0) continue;
    const flow = Number(deposited ? p.deposited_flow_usd : p.flow_usd);
    out.push({
      date: new Date(p.at * 1000),
      value,
      isFuture: false,
      flow: Number.isFinite(flow) ? flow : 0,
    });
  }
  return trimLeadingZeros(out);
}

// ── Allocation (category 別) ────────────────────────────────────────────────

export interface AllocationSegment {
  category: PositionCategory;
  /** Display label (legend / tooltip 用) */
  label: string;
  /** 選択 currency 単位での value (display only) */
  value: number;
  /** Donut の color token */
  color: string;
}

/** prototype の凡例順序。Vesting / Governance は表示対象外。 */
export const ALLOCATION_DISPLAY_ORDER: readonly PositionCategory[] = [
  PositionCategory.Lending,
  PositionCategory.Staking,
  PositionCategory.Restaking,
  PositionCategory.Vault,
  PositionCategory.LP,
  PositionCategory.PTYT,
  PositionCategory.Stable,
  // Phase 8.7: native SOL の wallet 保有を Other segment として表示
  PositionCategory.Other,
] as const;

export const LABEL_BY_CATEGORY: Record<PositionCategory, string> = {
  lending: "Lending",
  staking: "Staking",
  restaking: "Restaking",
  vault: "Vault",
  lp: "Liquidity Pool",
  pt_yt: "PT-YT",
  stable: "Yield-Bearing Stablecoins",
  vesting: "Vesting",
  governance: "Governance",
  other: "Other",
};

/** prototype の凡例 swatch 色 (8 segment ホイール) */
export const COLOR_BY_CATEGORY: Record<PositionCategory, string> = {
  lending: COLOR.sodaText,
  staking: COLOR.melonText,
  restaking: COLOR.melonDeep,
  vault: COLOR.caramel,
  lp: COLOR.straw,
  pt_yt: COLOR.cherry,
  stable: COLOR.sodaDeep,
  vesting: COLOR.textMuted,
  governance: COLOR.textMuted,
  other: COLOR.textMuted,
};

/** holdings の USD 合計 (8-dec string、bigint 合算) */
export function sumHoldingsUsd(
  holdings: PortfolioHolding[],
  scope: PortfolioScope = "total"
): string {
  let sum = 0n;
  for (const h of holdings) {
    if (scope === "deposited" && !h.deposited) continue;
    sum += usd8ToBigInt(h.usd);
  }
  return bigIntToUsd8(sum);
}

/**
 * holdings (chain 混在可) を category 単位で USD 集計し、凡例順序で返す。
 * 合算は bigint、segment の value は donut に渡す直前に Number 化 (display only)。
 */
export function allocationByCategory(
  holdings: PortfolioHolding[],
  scope: PortfolioScope = "total"
): AllocationSegment[] {
  const sumByCategory = new Map<PositionCategory, bigint>();
  for (const h of holdings) {
    if (scope === "deposited" && !h.deposited) continue;
    sumByCategory.set(
      h.category,
      (sumByCategory.get(h.category) ?? 0n) + usd8ToBigInt(h.usd)
    );
  }
  return ALLOCATION_DISPLAY_ORDER.map((category) => ({
    category,
    label: LABEL_BY_CATEGORY[category],
    value: Number(bigIntToUsd8(sumByCategory.get(category) ?? 0n)),
    color: COLOR_BY_CATEGORY[category],
  })).filter((seg) => seg.value > 0);
}
