/**
 * EarnPosition — Mobile / BFF 共有型 (Phase 8.2)
 *
 * `getAssetsByOwner` の raw token list ではなく、Jupiter Lend / Kamino 等の
 * yield-earning vault に預けた "意味のある DeFi position" を正規化した形。
 * BFF /positions/earn が返し、MenuDrawer "Your Positions" section が render する。
 *
 * 規約:
 * - amount 系は smallest unit string (§4.5)
 * - USD は 8 decimals string、不明値は "0"
 * - APY は basis points (Number、Solana DeFi 慣習)、不明値は null
 */

export interface EarnPosition {
  /** Seasonals 内 protocol_id ("jupiter_lend" / "kamino") */
  protocol_id: "jupiter_lend" | "kamino";
  /** UI 表示用 protocol 名 */
  protocol_name: string;
  /**
   * Market 別 label。
   *   Jupiter: "USDC" / "SOL" / "EURC" 等 (jlToken の underlying)
   *   Kamino: token metadata から推測される vault 名
   */
  market_symbol: string;
  /** share token (jlToken / kVault share) の mint pubkey */
  share_mint: string;
  /** share token (jlToken) 保有量 (smallest unit string、withdraw 時の input amount) */
  shares: string;
  /** share token (jlToken) の decimals */
  share_decimals: number;
  /** underlying asset symbol ("USDC" / "SOL" / "USDT" 等) */
  asset_symbol: string;
  /** underlying 数量 (smallest unit string、underlying decimals 基準) */
  underlying_amount: string;
  /** underlying asset の decimals */
  underlying_decimals: number;
  /** USD 換算 (8 decimals string、不明なら "0") */
  underlying_usd: string;
  /** Supply APR の basis points (Jupiter は供給、Kamino は best-effort で null) */
  supply_rate_bps: number | null;
}

/** BFF /positions/earn のレスポンス shape */
export interface EarnPositionsResponse {
  /** Jupiter Lend で確定検出された positions (shares > 0 のみ) */
  jupiterLend: EarnPosition[];
  /**
   * Helius DAS metadata から "Kamino" 系 token を best-effort で検出したもの。
   * APY / USD 値は不明なため null/0、表示は label-only。
   */
  kaminoBestEffort: EarnPosition[];
}
