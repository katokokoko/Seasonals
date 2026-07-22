/**
 * Protocol menu の階層型 (Phase 6.1)
 *
 * 1 protocol が複数の deposit pool / market を持つ階層を表現。
 * 例: Kamino → "USDC Main Market" / "Steakhouse USDC High Yield" / etc.
 *
 * 数値表現規約 (CLAUDE.md §3) 適用外:
 * - apy / tvl_usd / borrowed_usd は **display 用 mock** (BFF / DefiLlama 連携で実値を取得する想定)
 * - smallest unit string ではなく Number で十分 (CLAUDE.md §3 末尾「適用外」相当)
 *
 * Mobile / BFF / MCP Server 共有のため `lib/types/` 直下に置く (§1)。
 */

import type { PositionCategory } from "./enums";

/**
 * 1 つの deposit 候補 (lending market / vault / LP / staking pool 等)。
 */
export interface ProtocolPool {
  /** stable id (例: "kamino_steakhouse_usdc_high_yield") */
  pool_id: string;
  /** 表示名 (例: "Steakhouse USDC High Yield" / "USDC Main Market") */
  name: string;
  /** PositionCategory — protocol primary と異なるケースあり (Kamino は lending だが vault pool もある) */
  category: PositionCategory;
  /** 表示用 asset symbol (例: "USDC" / "SOL" / "USDC-USDT" / "JLP") */
  asset: string;
  /** 0..1 (例: 0.0407 = 4.07%) */
  apy: number;
  /** TVL (USD)。表示時は formatTvlUsd で $X.XM / $X.XB に整形 */
  tvl_usd: number;
  /** lending market のみ。borrowed amount in USD */
  borrowed_usd?: number;
  /**
   * lending market の稼働率 (borrow/supply、0..1、§3 display carve-out。Phase 8.26)。
   * 1.0 近傍は貸出が満杯 = **withdraw が流動性不足で滞る可能性**を示す —
   * UI は ≥0.9 を警告色で表示する。ソースが無い protocol は undefined。
   */
  utilization?: number;
  /** tap → onStartAction(asset) 用の deposit 通貨。未指定なら `asset` を使う */
  deposit_asset?: string;
  /**
   * read-only listing (Phase 8.33)。true の pool は deposit 経路を持たない —
   * MenuDrawer は tap を無効化し、autonomous / MCP compare の候補からも除外する
   * (実行不能な候補を agent に見せない fail-closed、§32.2)。
   */
  display_only?: boolean;
}

/**
 * Menu drawer の 1 protocol entry (top-level card)。
 * pools[] を持ち、tap で expand される。
 */
export interface ProtocolMenuEntry {
  /** Position.protocol_id と一致する場合は deposited 判定に使う */
  protocol_id: string;
  /** カード見出し (例: "Kamino") */
  display_name: string;
  /** Collapsed view の category 表示 (pool 別 category とは独立) */
  primary_category: PositionCategory;
  /** Collapsed view "USDC · SOL" 表示用 */
  supported_assets: string[];
  /** Mobile 側の require map で参照する key (例: "kamino" → kamino.png) */
  icon_id: string;
  /** Image load 失敗時 / placeholder bg color */
  icon_bg: string;
  /** 1 つ以上の pool. pools.length === 1 でも accordion で対応 */
  pools: ProtocolPool[];
}
