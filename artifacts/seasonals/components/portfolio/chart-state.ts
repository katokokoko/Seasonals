/**
 * chart-state — チャート領域に何を出すかの純関数 (Phase 8.76)
 *
 * これまで PortfolioSummary は「チャートを描けるか」の二値しか見ておらず、
 * history の読込中 (cold で数秒: Helius tx 最大 10 page 逐次 + Pyth + Llama) も
 * 静的 placeholder が出ていた。読込中は "Brewing your chart…" を出す。
 *
 * 判定順 (上が優先):
 *   1. chart      — 描ける系列があるなら出す。**refetch 中でも表示中のチャートは
 *                   消さない** (range chip 切替で cache 済みなら即描画)
 *   2. connect    — position が無い = 未接続。読込より優先 (fixture / 未接続
 *                   ユーザーに brewing を見せない)
 *   3. brewing    — history query が in-flight
 *   4. placeholder — 取得済みだが描ける点が無い ("Tracking since …" の既存カード)
 *
 * 注意: 呼び手は TanStack Query の **isFetching を渡す。isPending は不可** —
 * usePortfolioHistory は `enabled: Boolean(address)` で、disabled query は
 * isPending が永久に true になる (未接続で brewing し続けてしまう)。
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
