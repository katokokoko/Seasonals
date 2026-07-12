/**
 * Meteora DLMM market registry — Mobile / BFF 共有 (Phase 8.17、§32.2)
 *
 * LP トラック第1弾。deposit は **single-sided** (deposit_mint の 1 トークンのみ、
 * server が Spot strategy で active bin 片側 N bins に配分 — range UI 不要)。
 * position は non-fungible account で、**position account の実 pubkey** を
 * `EarnPosition.share_mint` に流用する (静的 registry キーではない点が他 protocol と
 * 違う — withdraw 解決は protocol_id === "meteora" + share_mint で行う)。
 *
 * pool address / X・Y mint / activeBin price は on-chain (DLMM.create) で検証済
 * (2026-07-10)。表示 APY/TVL はデータ API 復旧まで menu fixture 値。
 */

export interface MeteoraDlmmMarket {
  protocol_id: "meteora";
  /** Seasonals menu の pool_id (deposit dispatch の一次キー) */
  pool_id: string;
  /** 表示用 pair 名 */
  pair_name: string;
  /** DLMM LbPair address (on-chain 検証済) */
  pool_address: string;
  /** single-sided で入れる token */
  deposit_symbol: string;
  deposit_mint: string;
  deposit_decimals: number;
  /** deposit token が pool の X 側か Y 側か (on-chain 検証済。range の向きに使う) */
  deposit_side: "x" | "y";
  /** 相方 token (position の残り側。表示換算は deposit 建てに統一) */
  other_symbol: string;
  other_mint: string;
  other_decimals: number;
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

export const METEORA_MARKETS: MeteoraDlmmMarket[] = [
  // USDC-USDT (X=USDC / Y=USDT、activeBin price ≈1.0006 で検証済)
  {
    protocol_id: "meteora",
    pool_id: "meteora_usdc_usdt_dlmm",
    pair_name: "USDC-USDT",
    pool_address: "ARwi1S4DaiTG5DX7S4M4ZsrXqpMD1MrTmbu9ue2tpmEq",
    deposit_symbol: "USDC",
    deposit_mint: USDC,
    deposit_decimals: 6,
    deposit_side: "x",
    other_symbol: "USDT",
    other_mint: USDT,
    other_decimals: 6,
    stable_pair: true,
  },
  // SOL-USDC (X=SOL / Y=USDC、price 0.0788 = 78.8 USDC/SOL で on-chain 検証済 2026-07-10)
  // 旧 pool G2YJfYeB… は TVL $32 に枯死したため、dlmm.datapi.meteora.ag の
  // TVL 最大 SOL-USDC pool ($4.0M) に差し替え (Phase 8.24)
  {
    protocol_id: "meteora",
    pool_id: "meteora_sol_usdc_dlmm",
    pair_name: "SOL-USDC",
    pool_address: "5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6",
    deposit_symbol: "USDC",
    deposit_mint: USDC,
    deposit_decimals: 6,
    deposit_side: "y",
    other_symbol: "SOL",
    other_mint: SOL,
    other_decimals: 9,
    stable_pair: false,
  },
  // JitoSOL-SOL (X=JitoSOL / Y=SOL、price 1.2886 SOL/JitoSOL で on-chain 検証済
  // 2026-07-11。dlmm.datapi の TVL 最大 pool $2.8M — Phase 8.27)
  {
    protocol_id: "meteora",
    pool_id: "meteora_jitosol_sol_dlmm",
    pair_name: "JitoSOL-SOL",
    pool_address: "BoeMUkCLHchTD31HdXsbDExuZZfcUppSLpYtV3LZTH6U",
    deposit_symbol: "SOL",
    deposit_mint: SOL,
    deposit_decimals: 9,
    deposit_side: "y",
    other_symbol: "JitoSOL",
    other_mint: JITOSOL,
    other_decimals: 9,
    stable_pair: false,
  },
];

/** menu pool_id → market (pool tap 由来の deposit dispatch) */
export function findMeteoraMarketByPool(
  poolId: string
): MeteoraDlmmMarket | undefined {
  return METEORA_MARKETS.find((m) => m.pool_id === poolId);
}

/** LbPair address → market (positions / withdraw の解決) */
export function findMeteoraMarketByAddress(
  poolAddress: string
): MeteoraDlmmMarket | undefined {
  return METEORA_MARKETS.find((m) => m.pool_address === poolAddress);
}
