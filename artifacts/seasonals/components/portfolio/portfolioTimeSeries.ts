/**
 * Portfolio time-series — Σ (current_amount × unit_price) over time
 *
 * fixture から past + 14 day forecast を生成。chart 描画用。
 *
 * 数値表現規約 (CLAUDE.md §3): smallest unit を toHumanReadable で human 化してから
 * Number 演算。CLAUDE.md §3 末尾の「適用外 (通常の整数として扱ってよい)」 carve-out
 * 「APY / risk_score (0..1 のパーセンテージ、Number 精度で十分)」相当 — 本層は chart
 * 描画値 (display only) で execute / settle 経路には届かないため Number 化を許容。
 * 実 BFF / approve flow では smallest unit string + bigint 経路を維持する (PortfolioSummary
 * の totalSol も同様の display-only 計算)。
 *
 * Phase 8.55: 系列は **選択通貨建て** (USDC ↔ SOL トグルに追従)。以前は SOL 固定で、
 * トグルを USDC にしても縦軸が SOL のままだった。
 */

import { addDays } from "date-fns";

import type { Position } from "@workspace/lib/types";

// Phase 8.4.1: 計算ロジックは allocation.ts に集約済 (asset_symbol → price table)。
// 旧 currentSolOf (position.unit_price_sol 依存) は撤去。
import {
  SOL_USD_PRICE,
  totalSolValue as allocationTotalSolValue,
  type CurrencyUnit,
} from "./allocation";

export type RangeKey = "1W" | "1M" | "3M" | "1Y" | "ALL";

export interface PortfolioPoint {
  date: Date;
  /** 選択通貨建ての評価額 (8.55: 旧 `sol` を一般化) */
  value: number;
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
  today: Date,
  currency: CurrencyUnit = "SOL"
): PortfolioPoint[] {
  if (positions.length === 0) return [];
  const totalSol = totalSolValue(positions);
  const value = currency === "SOL" ? totalSol : totalSol * SOL_USD_PRICE;
  const pastDays = rangeToDays(range);
  const start = addDays(today, -pastDays);
  return [
    { date: start, value, isFuture: false },
    { date: today, value, isFuture: false },
  ];
}

/**
 * chart の y 軸範囲。
 *
 * 8.55: **値そのものの ±10%** を上下端にする (min×0.9 〜 max×1.1)。
 * 旧実装は「値幅 (max−min) の ±10%」だったため、履歴未実装の水平線 (幅 0) では
 * ほぼゼロ幅になり、4 つの軸ラベルが全部同じ値に丸まっていた。
 */
export function chartBounds(points: PortfolioPoint[]): {
  minValue: number;
  maxValue: number;
} {
  if (points.length === 0) return { minValue: 0, maxValue: 1 };
  const values = points.map((p) => p.value);
  const rawMin = Math.min(...values);
  const rawMax = Math.max(...values);
  if (rawMax <= 0) return { minValue: 0, maxValue: 1 };
  return {
    minValue: rawMin * 0.9,
    maxValue: rawMax * 1.1,
  };
}

/**
 * y 軸ラベルの数値部。値の桁に応じて小数桁を変える
 * (≥100 → 1 桁 / ≥1 → 2 桁 / それ未満 → 4 桁)。
 */
export function formatAxisValue(value: number): string {
  if (!Number.isFinite(value)) return "0";
  const abs = Math.abs(value);
  if (abs >= 100) return value.toFixed(1);
  if (abs >= 1) return value.toFixed(2);
  return value.toFixed(4);
}
