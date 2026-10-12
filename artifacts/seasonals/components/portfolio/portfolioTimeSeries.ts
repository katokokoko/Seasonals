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
// web Dashboard 追加時: chain 非依存の helper は lib/derive/portfolio.ts に移設。
// mobile はここ経由の re-export で従来どおり import できる (実装は 1 つ)
import {
  rangeToDays,
  trimLeadingZeros,
  type PortfolioPoint,
  type PortfolioScope,
  type RangeKey,
} from "@workspace/lib/derive/portfolio";
export {
  chartBounds,
  coverageFromKnownStart,
  flowMarkerIndices,
  formatAxisValue,
  hasHistory,
  historyCoverage,
  rangeExceedsCoverage,
  rangeToDays,
  trimLeadingZeros,
  type HistoryCoverage,
  type PortfolioPoint,
  type PortfolioScope,
  type RangeKey,
} from "@workspace/lib/derive/portfolio";

/** ポートフォリオ全体の現在 SOL 評価額 (allocation.ts と同じ計算ロジック) */
export function totalSolValue(
  positions: Position[],
  prices: PriceMap = {}
): number {
  return allocationTotalSolValue(positions, prices);
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
 * Phase 8.58: BFF が tx から復元した履歴 (day/usd/sol の 8-dec string) を
 * chart の系列に変換する。**表示直前の Number 化**なので §4.5 の carve-out 内。
 */
export interface ServerHistoryPoint {
  /** 8.59: unix 秒 (日内サンプリングのため日付文字列から変更) */
  at: number;
  usd: string;
  sol: string;
  /** 8.62: protocol に預けた分のみ (Total / Deposited トグル) */
  deposited_usd?: string;
  deposited_sol?: string;
  /** 8.65: 直前の点からの元本の増減 (USD 8-dec、符号付き)。価格変動は含まない */
  flow_usd?: string;
  deposited_flow_usd?: string;
}

export function serverHistoryToPoints(
  points: ServerHistoryPoint[],
  currency: CurrencyUnit,
  scope: PortfolioScope = "total"
): PortfolioPoint[] {
  const out: PortfolioPoint[] = [];
  for (const p of points) {
    const deposited = scope === "deposited";
    const usd = Number(deposited ? (p.deposited_usd ?? "0") : p.usd);
    const sol = Number(deposited ? (p.deposited_sol ?? "0") : p.sol);
    const value = currency === "SOL" ? sol : usd;
    if (!Number.isFinite(value) || value < 0) continue;
    // 8.60: **0 は落とさない** — 入金前 / 全額引き出し後の「保有ゼロ」は事実。
    // ただし SOL 建てだけ 0 で USD が正の点は「SOL 価格が引けなかった」なので落とす
    if (currency === "SOL" && sol === 0 && usd > 0) continue;
    // 8.65: flow は USD で来るので、SOL 表示なら同じ点の USD→SOL 比で換算する
    // (その時点の SOL 価格。現在価格で割ると過去の段差の大きさが狂う)
    const flowUsd = Number(
      (deposited ? p.deposited_flow_usd : p.flow_usd) ?? "0"
    );
    const toUnit = currency === "SOL" && usd > 0 ? sol / usd : 1;
    const flow =
      Number.isFinite(flowUsd) && flowUsd !== 0 ? flowUsd * toUnit : 0;
    out.push({ date: new Date(p.at * 1000), value, isFuture: false, flow });
  }
  // 8.63: 入金前のゼロ区間で軸が潰れるので落とす (途中のゼロは残る)
  return trimLeadingZeros(out);
}
