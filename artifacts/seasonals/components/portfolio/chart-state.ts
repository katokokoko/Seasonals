/**
 * chart-state — チャート領域に何を出すかの純関数 (Phase 8.76)
 *
 * 実装は web Dashboard と共有するため lib/derive/portfolio.ts に移設した
 * (判定順と isFetching を渡す理由の説明もそちら)。
 */

export {
  chartAreaState,
  type ChartAreaState,
} from "@workspace/lib/derive/portfolio";
