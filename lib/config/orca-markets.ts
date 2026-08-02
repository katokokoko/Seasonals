/**
 * Orca Whirlpools market registry — Mobile / BFF 共有 (Phase 8.18、§32.2)
 *
 * LP トラック第2弾。full-range position を **zap-in** で one-tap 化する:
 *   tx1 = Jupiter swap (入金 USDC の半分 → 相方 token)
 *   tx2 = full-range open + increase (position mint keypair の部分署名済み)
 * full-range は両 token を価格比で要求する CLMM の性質を、swap 脚で single-token
 * 入金に変換する。余り (dust) は wallet に残る仕様。
 *
 * position は NFT — **position mint の実 pubkey** を `EarnPosition.share_mint` に
 * 流用 (Meteora と同型、canWithdraw は protocol_id === "orca" 判定)。
 * pool address / A・B mint / tickSpacing は on-chain (client.getPool) 検証済 (2026-07-10)。
 */

export interface OrcaWhirlpoolMarket {
  protocol_id: "orca";
  /** Seasonals menu の pool_id */
  pool_id: string;
  pair_name: string;
  /** whirlpool address (on-chain 検証済) */
  pool_address: string;
  /** zap-in の入金 token */
  deposit_symbol: string;
  deposit_mint: string;
  deposit_decimals: number;
  /** deposit token が pool の A 側か B 側か (on-chain 検証済) */
  deposit_side: "a" | "b";
  /** zap で半分交換する相方 token */
  other_symbol: string;
  other_mint: string;
  other_decimals: number;
  tick_spacing: number;
  /**
   * Phase 8.19: 両脚が 1:1 の stable 同士 (USDC-USDT 等) か。true なら LP cost-basis
   * を「deposit 脚 + 相方脚 (1:1 換算)」で全 tx 形状に対して計算できる (§8.19)。
   */
  stable_pair: boolean;
}

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const SOL = "So11111111111111111111111111111111111111112";
const JITOSOL = "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn";

export const ORCA_MARKETS: OrcaWhirlpoolMarket[] = [
  // USDC-USDT (A=USDC / B=USDT、tickSpacing 1、TVL ~$1.2M — 検証済)
  {
    protocol_id: "orca",
    pool_id: "orca_usdc_usdt_whirlpool",
    pair_name: "USDC-USDT",
    pool_address: "4fuUiYxTQ6QCrdSq9ouBYcTM7bqSwYTSyLueGZLTy4T4",
    deposit_symbol: "USDC",
    deposit_mint: USDC,
    deposit_decimals: 6,
    deposit_side: "a",
    other_symbol: "USDT",
    other_mint: USDT,
    other_decimals: 6,
    tick_spacing: 1,
    stable_pair: true,
  },
  // SOL-USDC (A=SOL / B=USDC、tickSpacing 4、TVL ~$32.5M — 検証済)
  {
    protocol_id: "orca",
    pool_id: "orca_sol_usdc_whirlpool",
    pair_name: "SOL-USDC",
    pool_address: "Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE",
    deposit_symbol: "USDC",
    deposit_mint: USDC,
    deposit_decimals: 6,
    deposit_side: "b",
    other_symbol: "SOL",
    other_mint: SOL,
    other_decimals: 9,
    tick_spacing: 4,
    stable_pair: false,
  },
  // JitoSOL-SOL (A=SOL / B=JitoSOL、tickSpacing 1、TVL ~$31.4M — 検証済 2026-07-10)
  // deposit SOL の zap: 半分を Jupiter で JitoSOL へ。注: deposit 脚が SOL のため
  // zap open の user delta が一時 WSOL account 経由になり cost-basis の volatile
  // 規則が不成立になりうる → その場合 earned は fee-only に自然 fallback (8.19)。
  {
    protocol_id: "orca",
    pool_id: "orca_jitosol_sol_whirlpool",
    pair_name: "JitoSOL-SOL",
    pool_address: "Hp53XEtt4S8SvPCXarsLSdGfZBuUr5mMmZmX2DRNXQKp",
    deposit_symbol: "SOL",
    deposit_mint: SOL,
    deposit_decimals: 9,
    deposit_side: "a",
    other_symbol: "JitoSOL",
    other_mint: JITOSOL,
    other_decimals: 9,
    tick_spacing: 1,
    stable_pair: false,
  },
];

/** menu pool_id → market (pool tap 由来の deposit dispatch) */
export function findOrcaMarketByPool(
  poolId: string
): OrcaWhirlpoolMarket | undefined {
  return ORCA_MARKETS.find((m) => m.pool_id === poolId);
}

/** whirlpool address → market (positions / withdraw の解決) */
export function findOrcaMarketByAddress(
  poolAddress: string
): OrcaWhirlpoolMarket | undefined {
  return ORCA_MARKETS.find((m) => m.pool_address === poolAddress);
}
