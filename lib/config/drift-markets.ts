/**
 * Drift spot market registry — Mobile / BFF 共有 (Phase 8.15e、§32.2)
 *
 * Drift spot lending は SPL 受取 token を持たない (deposit は Drift User account 内の
 * SpotPosition)。tx 構築・positions 読み取りとも @drift-labs/sdk (BFF のみ) 経由。
 * position key は合成 string (`drift_spot_{marketIndex}`) を EarnPosition.share_mint に
 * 流用する (Kamino の reserve address 流用と同型 — 既存 withdraw 配管に乗る)。
 *
 * market_index は installed SDK (v2.156.0) の MainnetSpotMarkets で検証済:
 *   USDC = 0 (dec 6) / SOL = 1 (dec 9)。underlying は oracle feed 設定済。
 */

export interface DriftMarket {
  protocol_id: "drift";
  /** Seasonals menu の pool_id (deposit dispatch の一次キー) */
  pool_id: string;
  underlying_symbol: string;
  underlying_mint: string;
  underlying_decimals: number;
  /** Drift spot market index (mainnet) */
  market_index: number;
  /** EarnPosition.share_mint 流用の合成キー */
  position_key: string;
}

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SOL = "So11111111111111111111111111111111111111112";

export const DRIFT_MARKETS: DriftMarket[] = [
  {
    protocol_id: "drift",
    pool_id: "drift_usdc_spot",
    underlying_symbol: "USDC",
    underlying_mint: USDC,
    underlying_decimals: 6,
    market_index: 0,
    position_key: "drift_spot_0",
  },
  {
    protocol_id: "drift",
    pool_id: "drift_sol_spot",
    underlying_symbol: "SOL",
    underlying_mint: SOL,
    underlying_decimals: 9,
    market_index: 1,
    position_key: "drift_spot_1",
  },
];

/** menu pool_id → market (pool tap 由来の deposit dispatch) */
export function findDriftMarketByPool(poolId: string): DriftMarket | undefined {
  return DRIFT_MARKETS.find((m) => m.pool_id === poolId);
}

/** position_key (share_mint 流用) → market (withdraw / positions の解決) */
export function findDriftMarketByKey(
  positionKey: string
): DriftMarket | undefined {
  return DRIFT_MARKETS.find((m) => m.position_key === positionKey);
}

/** underlying symbol → market (pool_id 不明時の deposit fallback) */
export function findDriftMarketByAsset(
  underlyingSymbol: string
): DriftMarket | undefined {
  return DRIFT_MARKETS.find((m) => m.underlying_symbol === underlyingSymbol);
}
