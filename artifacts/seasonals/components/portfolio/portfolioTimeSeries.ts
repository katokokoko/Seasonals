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

import type { Position } from "@workspace/lib/types";

// Phase 8.4.1: 計算ロジックは allocation.ts に集約済 (asset_symbol → price table)。
// 旧 currentSolOf (position.unit_price_sol 依存) は撤去。
import {
  solUsdPrice,
  totalSolValue as allocationTotalSolValue,
  type CurrencyUnit,
  type PriceMap,
} from "./allocation";
// 8.56: 実測スナップショット (store は stores/portfolioHistory.ts)
import {
  dayKey,
  dayKeyToDate,
  snapshotsInRange,
  type PortfolioSnapshot,
} from "./history";

export type RangeKey = "1W" | "1M" | "3M" | "1Y" | "ALL";

export interface PortfolioPoint {
  date: Date;
  /** 選択通貨建ての評価額 (8.55: 旧 `sol` を一般化) */
  value: number;
  /** today より未来か (chart の dashed forecast 区間) */
  isFuture: boolean;
}

/** ポートフォリオ全体の現在 SOL 評価額 (allocation.ts と同じ計算ロジック) */
export function totalSolValue(
  positions: Position[],
  prices: PriceMap = {}
): number {
  return allocationTotalSolValue(positions, prices);
}

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
 * Phase 8.4 / 8.56: history を偽造しない。**観測した点だけ**を並べる。
 *
 * - positions が空 → 空配列 (PortfolioSummary が empty state を出す)
 * - 端末に貯めた日次スナップショット (range 内) + 末尾に今日の現在値
 * - 過去に遡って点を作らない。したがって記録初日は 1 点だけ = 線にならない。
 *   その状態は `hasHistory` false として呼び手が現在値カードに切り替える
 *
 * 旧版 (8.4〜8.55) は現在値を range の両端 2 点に置いた水平線で、
 * 中身のない目盛りが出ていた。
 */
export function buildPortfolioTimeSeries(
  snapshots: PortfolioSnapshot[],
  positions: Position[],
  range: RangeKey,
  today: Date,
  currency: CurrencyUnit = "SOL",
  prices: PriceMap = {}
): PortfolioPoint[] {
  if (positions.length === 0) return [];
  // 8.57: 過去の snapshot は SOL 建てで保存されているので、USDC 表示は
  // **現在の** SOL 価格で換算する (過去価格での再評価は 8.58 の履歴再構築で扱う)
  const solUsd = solUsdPrice(prices);
  const toValue = (sol: number) =>
    currency === "SOL" ? sol : sol * (solUsd ?? 0);
  const todayKey = dayKey(today);
  const past = snapshotsInRange(snapshots, rangeToDays(range), today)
    // 今日の分は現在値 (最新) を優先するので除く
    .filter((s) => s.day !== todayKey)
    .map<PortfolioPoint>((s) => ({
      date: dayKeyToDate(s.day),
      value: toValue(s.sol),
      isFuture: false,
    }));
  return [
    ...past,
    {
      date: today,
      value: toValue(totalSolValue(positions, prices)),
      isFuture: false,
    },
  ];
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
    minValue: rawMin - pad,
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
 * Phase 8.58: BFF が tx から復元した履歴 (day/usd/sol の 8-dec string) を
 * chart の系列に変換する。**表示直前の Number 化**なので §4.5 の carve-out 内。
 */
export interface ServerHistoryPoint {
  day: string;
  usd: string;
  sol: string;
}

export function serverHistoryToPoints(
  points: ServerHistoryPoint[],
  currency: CurrencyUnit
): PortfolioPoint[] {
  const out: PortfolioPoint[] = [];
  for (const p of points) {
    const value = Number(currency === "SOL" ? p.sol : p.usd);
    if (!Number.isFinite(value) || value <= 0) continue;
    out.push({ date: dayKeyToDate(p.day), value, isFuture: false });
  }
  return out;
}
