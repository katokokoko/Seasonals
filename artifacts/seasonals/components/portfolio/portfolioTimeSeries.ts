/**
 * Portfolio time-series — Σ (current_amount × unit_price_sol) over time
 *
 * fixture から past + 14 day forecast を生成。chart 描画用。
 *
 * 数値表現規約 (CLAUDE.md §3): smallest unit を toHumanReadable で human 化してから
 * Number 演算。CLAUDE.md §3 末尾の「適用外 (通常の整数として扱ってよい)」 carve-out
 * 「APY / risk_score (0..1 のパーセンテージ、Number 精度で十分)」相当 — 本層は chart
 * 描画値 (display only) で execute / settle 経路には届かないため Number 化を許容。
 * 実 BFF / approve flow では smallest unit string + bigint 経路を維持する (PortfolioSummary
 * の totalSol も同様の display-only 計算)。
 */

import { addDays } from "date-fns";

import { TOKEN_DECIMALS, toHumanReadable } from "@workspace/lib/utils/numeric";
import type { Position } from "@workspace/lib/types";

export type RangeKey = "1W" | "1M" | "3M" | "1Y" | "ALL";

export interface PortfolioPoint {
  date: Date;
  sol: number;
  /** today より未来か (chart の dashed forecast 区間) */
  isFuture: boolean;
}

/** asset_symbol → decimals。TOKEN_DECIMALS に無い未知 asset は 6 fallback */
function decimalsOf(asset: string): number {
  if (asset in TOKEN_DECIMALS) {
    return (TOKEN_DECIMALS as Record<string, number>)[asset]!;
  }
  return 6;
}

/** 1 position の現在 SOL 評価額 (smallest unit を decimals で正規化) */
function currentSolOf(p: Position): number {
  const decimals = decimalsOf(p.asset_symbol);
  const amount = Number(toHumanReadable(p.current_amount, decimals));
  const sol = Number(p.unit_price_sol);
  return amount * sol;
}

/** ポートフォリオ全体の現在 SOL 評価額 (debt 含む単純合計) */
export function totalSolValue(positions: Position[]): number {
  return positions.reduce((sum, p) => sum + currentSolOf(p), 0);
}

/** range key → 過去日数 */
function rangeToDays(range: RangeKey): number {
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

const FUTURE_DAYS = 14;

/**
 * fixture positions から portfolio time-series を生成。
 *
 * 単純モデル: 現在の総 SOL 額を起点に、APY 5.7% (prototype の "+5.70%" と一致) で
 * past 方向 / future 方向に linear 推移。実 production では reserve ごとの実 rate
 * + 過去価格を read してマージ。
 */
export function buildPortfolioTimeSeries(
  positions: Position[],
  range: RangeKey,
  today: Date,
  apy = 0.057
): PortfolioPoint[] {
  const pastDays = rangeToDays(range);
  const totalDays = pastDays + FUTURE_DAYS;
  const dailyRate = apy / 365;
  const currentSol = totalSolValue(positions);

  const points: PortfolioPoint[] = [];
  // step を粗く: 1Y / ALL では daily だと点が多すぎ、5-day step に間引く
  const step = pastDays > 90 ? 5 : 1;

  for (let i = 0; i <= totalDays; i += step) {
    const dayOffset = i - pastDays; // negative = past, 0 = today, positive = future
    const date = addDays(today, dayOffset);
    // 単純線形: today を起点に過去 / 未来を APY 比率で逆算 / 推進
    const factor = 1 + dailyRate * dayOffset;
    const sol = currentSol * factor;
    points.push({
      date,
      sol,
      isFuture: dayOffset > 0,
    });
  }
  return points;
}

/** chart の y 軸範囲 (min / max を少し膨らませて余白) */
export function chartBounds(points: PortfolioPoint[]): {
  minSol: number;
  maxSol: number;
} {
  if (points.length === 0) return { minSol: 0, maxSol: 1 };
  const sols = points.map((p) => p.sol);
  const rawMin = Math.min(...sols);
  const rawMax = Math.max(...sols);
  const span = Math.max(rawMax - rawMin, 0.01);
  return {
    minSol: rawMin - span * 0.1,
    maxSol: rawMax + span * 0.1,
  };
}
