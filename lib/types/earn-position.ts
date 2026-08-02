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
  /**
   * Seasonals 内 protocol_id ("jupiter_lend" / "kamino" / "jito" / "marinade" /
   * "sanctum" / "perena" ...)。Phase 8.15 で swap-earn protocol を一般化したため
   * closed union から string に緩和 (registry の protocol_id と一致させる)。
   */
  protocol_id: string;
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
  /**
   * Phase 8.13: 実 accrued yield。
   * earned の **絶対値** を underlying smallest unit string で保持 (§4.5 `^[0-9]+$`)。
   * 損失 (current < cost-basis) でも magnitude を入れ、符号は `accrued_yield_sign`
   * で表す (`TOKEN_AMOUNT_REGEX` が負数を禁止するため magnitude + sign 方式)。
   * cost-basis 不明時は "0"。
   * 注: earned は **underlying トークン建て**で、価格変動を含まない
   *     (stablecoin ≈ USD 利回り、SOL は SOL 建て利回り)。
   */
  accrued_yield_amount: string;
  /**
   * Phase 8.13: earned の符号。
   *   "gain"    — current >= cost-basis (利益 or break-even)
   *   "loss"    — current <  cost-basis (含み損)
   *   "unknown" — cost-basis 不明 (tx 履歴 window 外 / 別 wallet / API 失敗)。
   *               UI は実額でなく "—" を表示し、概算 fallback に切替える。
   */
  accrued_yield_sign: "gain" | "loss" | "unknown";
  /**
   * Phase 8.13: cost-basis (純入金 underlying 量、smallest unit string)。
   * tx 履歴の deposit − withdraw 累計。不明なら null。
   * 既知なら Position.principal_amount の実元本として使う。
   */
  cost_basis_amount: string | null;
  /**
   * Phase 8.33: 固定 maturity (ISO 8601)。Exponent PT のような満期付き position のみ。
   * mobile の earn-to-position が Position.maturity_at へそのまま通す。
   * 満期を持たない protocol は undefined / null。
   */
  maturity_at?: string | null;
}

/** BFF /positions/earn のレスポンス shape */
export interface EarnPositionsResponse {
  /** Jupiter Lend で確定検出された positions (shares > 0 のみ) */
  jupiterLend: EarnPosition[];
  /**
   * Kamino positions。8.15b で実 obligation、8.15d で kVault 保有も合流
   * (実データ取得失敗時のみ Helius DAS best-effort 検出に fallback)。
   */
  kaminoBestEffort: EarnPosition[];
  /**
   * Phase 8.15.x: LST/USD* (swap-earn、jupiter_lend 除く) の enriched 保有。
   * underlying/USD は実 rate 換算、earned は cost-basis が取れた場合のみ実値。
   * undefined = 旧 BFF / fixture (mobile は client 側 fallback を使う)。
   */
  swapEarn?: EarnPosition[];
  /** Phase 8.15.x: Save cToken の enriched 保有 (同上)。 */
  save?: EarnPosition[];
  /**
   * Phase 8.33: Exponent PT の保有 (read-only、share_mint = pt_mint)。
   * maturity_at が必ず入る (カレンダーの maturity event は /time-events/wallet 側で導出)。
   */
  exponent?: EarnPosition[];
  /**
   * Phase 8.17: Meteora DLMM LP positions (SDK read)。share_mint = position account
   * の実 pubkey。underlying は deposit token 建て総額、earned = 未請求 swap fee。
   */
  meteora?: EarnPosition[];
  /**
   * Phase 8.18: Orca Whirlpools full-range LP positions (SDK read)。share_mint =
   * position mint (NFT) の実 pubkey。underlying は deposit token 建て、earned = feeOwed。
   */
  orca?: EarnPosition[];
}
