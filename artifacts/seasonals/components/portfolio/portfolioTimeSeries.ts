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

import type { Position } from "@workspace/lib/types";

// Phase 8.4.1: 計算ロジックは allocation.ts に集約済 (asset_symbol → price table)。
// 旧 currentSolOf (position.unit_price_sol 依存) は撤去。
import { totalSolValue as allocationTotalSolValue } from "./allocation";

export type RangeKey = "1W" | "1M" | "3M" | "1Y" | "ALL";

export interface PortfolioPoint {
  date: Date;
  sol: number;
  /** today より未来か (chart の dashed forecast 区間) */
  isFuture: boolean;
}

/** ポートフォリオ全体の現在 SOL 評価額 (allocation.ts と同じ計算ロジック) */
export function totalSolValue(positions: Position[]): number {
  return allocationTotalSolValue(positions);
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

/**
 * Phase 8.4: history を偽造しない。
 * - positions が空: 空配列を返し、PortfolioSummary 側で empty state を出す
 * - positions あり: 現在値だけの **flat line** (range の両端 2 点)。chart が破綻
 *   しない最低 data。実際に過去 balance を retrieve するには Helius tx history
 *   から逐次再構築が必要だが、別 phase で対応。
 *
 * 旧版は APY 5.7% mock で linear 推移を生成していた (Prototype "+5.70%" のため
 * の演出) が、本物の wallet position と整合が取れないため撤去。
 */
export function buildPortfolioTimeSeries(
  positions: Position[],
  range: RangeKey,
  today: Date
): PortfolioPoint[] {
  if (positions.length === 0) return [];
  const totalSol = totalSolValue(positions);
  const pastDays = rangeToDays(range);
  const start = addDays(today, -pastDays);
  return [
    { date: start, sol: totalSol, isFuture: false },
    { date: today, sol: totalSol, isFuture: false },
  ];
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
