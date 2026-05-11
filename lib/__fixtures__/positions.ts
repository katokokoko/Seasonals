import type { Position } from "../types/position";

/**
 * Kamino USDC Lending position
 * - 1500 USDC 預け入れ、現在 1542.30 USDC、accrued yield 42.30 USDC
 * - 30日後に satisfy 可能 (lockup_end)
 */
export const fixturePositionKaminoLending: Position = {
  position_id: "pos_001",
  wallet_id: "wal_001",
  protocol_id: "kamino",
  asset_symbol: "USDC",
  // smallest unit (decimals=6)
  principal_amount: "1500000000", // 1500 USDC
  current_amount: "1542300000", // 1542.3 USDC
  accrued_yield_amount: "42300000", // 42.3 USDC
  // 1 USDC = 1.00 USD, 1 USDC ≈ 0.005 SOL (mock)
  unit_price_usd: "1.00000000",
  unit_price_sol: "0.00500000",
  deposited_at: "2026-04-06T00:00:00.000Z",
  maturity_at: null,
  unlock_at: "2026-06-06T00:00:00.000Z",
  health_factor: null,
  auto_roll_rule: null,
  risk_score: 0.85,
  raw_state: { reserve: "USDC-Main", utilization: 0.72 },
};

/**
 * Jito staking position (LST)
 * - 50 SOL → 49.2 jitoSOL (rate: ~1.016)
 * - 現在の rate で 51.5 SOL 相当
 */
export const fixturePositionJitoStaking: Position = {
  position_id: "pos_002",
  wallet_id: "wal_002",
  protocol_id: "jito",
  asset_symbol: "jitoSOL",
  principal_amount: "49200000000", // 49.2 jitoSOL (decimals=9)
  current_amount: "49200000000",
  accrued_yield_amount: "0", // LST は token 数量変わらず、価格で増価
  unit_price_usd: "168.50000000",
  unit_price_sol: "1.04700000", // 1 jitoSOL = 1.047 SOL
  deposited_at: "2026-01-15T00:00:00.000Z",
  maturity_at: null,
  unlock_at: null, // unstake delay は別途 epoch ベース
  health_factor: null,
  auto_roll_rule: null,
  risk_score: 0.92,
  raw_state: { exchange_rate: 1.047, epoch_at_deposit: 720 },
};

/**
 * Kamino borrow position (健全性監視あり)
 * - USDC 5000 借入、collateral SOL
 * - health_factor = 1.45 (yellow zone)
 */
export const fixturePositionKaminoBorrow: Position = {
  position_id: "pos_003",
  wallet_id: "wal_001",
  protocol_id: "kamino",
  asset_symbol: "USDC",
  principal_amount: "5000000000", // 5000 USDC borrowed
  current_amount: "5012500000", // 5012.5 USDC (interest accrued)
  accrued_yield_amount: "12500000", // 12.5 USDC interest (negative for borrower)
  unit_price_usd: "1.00000000",
  unit_price_sol: "0.00500000",
  deposited_at: "2026-03-20T00:00:00.000Z",
  maturity_at: null,
  unlock_at: null,
  health_factor: 1.45, // yellow zone (1.0 で清算)
  auto_roll_rule: null,
  risk_score: 0.85,
  raw_state: { collateral_asset: "SOL", collateral_amount_lamports: "20000000000" },
};

/**
 * Streamflow vesting position
 * - 10000 SEAS token、6 ヶ月 cliff、12 ヶ月 linear
 */
export const fixturePositionStreamflowVesting: Position = {
  position_id: "pos_004",
  wallet_id: "wal_001",
  protocol_id: "streamflow",
  asset_symbol: "SEAS",
  principal_amount: "10000000000000", // 10000 SEAS (decimals=9 想定)
  current_amount: "10000000000000",
  accrued_yield_amount: "0",
  unit_price_usd: "0.45000000",
  unit_price_sol: "0.00267000",
  deposited_at: "2026-01-01T00:00:00.000Z",
  maturity_at: "2027-07-01T00:00:00.000Z", // 18 ヶ月後
  unlock_at: "2026-07-01T00:00:00.000Z", // cliff (6 ヶ月)
  health_factor: null,
  auto_roll_rule: null,
  risk_score: 0.7,
  raw_state: { cliff_at: "2026-07-01", linear_until: "2027-07-01" },
};

/**
 * Kamino Restaking (kRestSOL-style restaked LST)
 * - 30.9 jitoSOL re-staked、unit_price 1.047 SOL → ~32.36 SOL
 */
export const fixturePositionKaminoRestaking: Position = {
  position_id: "pos_005",
  wallet_id: "wal_001",
  protocol_id: "kamino_restake",
  asset_symbol: "jitoSOL",
  principal_amount: "30900000000", // 30.9 jitoSOL
  current_amount: "30900000000",
  accrued_yield_amount: "0",
  unit_price_usd: "176.50000000",
  unit_price_sol: "1.04700000",
  deposited_at: "2026-02-10T00:00:00.000Z",
  maturity_at: null,
  unlock_at: null,
  health_factor: null,
  auto_roll_rule: null,
  risk_score: 0.78,
  raw_state: { restake_layer: "kamino-rest", reward_apy: 0.0625 },
};

/**
 * Kamino Vault (multi-strategy USDC vault)
 * - 9074 USDC、unit_price 0.005 SOL → ~45.37 SOL
 */
export const fixturePositionKaminoVault: Position = {
  position_id: "pos_006",
  wallet_id: "wal_001",
  protocol_id: "kamino_vault",
  asset_symbol: "USDC",
  principal_amount: "9000000000", // 9000 USDC
  current_amount: "9074000000", // 9074 USDC (yield accrued)
  accrued_yield_amount: "74000000", // 74 USDC
  unit_price_usd: "1.00000000",
  unit_price_sol: "0.00500000",
  deposited_at: "2026-03-01T00:00:00.000Z",
  maturity_at: null,
  unlock_at: null,
  health_factor: null,
  auto_roll_rule: null,
  risk_score: 0.82,
  raw_state: { vault_strategy: "blend-usdc-1", apy: 0.0815 },
};

/**
 * Meteora LP (USDC-USDT concentrated)
 * - 5772 USDC equivalent、unit_price 0.005 SOL → ~28.86 SOL
 */
export const fixturePositionMeteoraLP: Position = {
  position_id: "pos_007",
  wallet_id: "wal_001",
  protocol_id: "meteora",
  asset_symbol: "USDC",
  principal_amount: "5772000000",
  current_amount: "5772000000",
  accrued_yield_amount: "0",
  unit_price_usd: "1.00000000",
  unit_price_sol: "0.00500000",
  deposited_at: "2026-04-15T00:00:00.000Z",
  maturity_at: null,
  unlock_at: null,
  health_factor: null,
  auto_roll_rule: null,
  risk_score: 0.7,
  raw_state: { pool: "USDC-USDT", price_lower: 0.998, price_upper: 1.002 },
};

/**
 * RateX PT-YT split position (PT side)
 * - 9762 PT-USDC equivalent、unit_price 0.005 SOL → ~48.81 SOL
 */
export const fixturePositionRateXPTYT: Position = {
  position_id: "pos_008",
  wallet_id: "wal_001",
  protocol_id: "ratex",
  asset_symbol: "USDC",
  principal_amount: "9762000000",
  current_amount: "9762000000",
  accrued_yield_amount: "0",
  unit_price_usd: "1.00000000",
  unit_price_sol: "0.00500000",
  deposited_at: "2026-04-20T00:00:00.000Z",
  maturity_at: "2026-09-20T00:00:00.000Z", // 5 ヶ月後 PT 満期
  unlock_at: null,
  health_factor: null,
  auto_roll_rule: null,
  risk_score: 0.65,
  raw_state: { side: "PT", underlying: "jupSOL", maturity_at: "2026-09-20" },
};

/**
 * Jupiter Lend (yield-bearing stablecoin: jupUSD)
 * - 4460 USDC equivalent、unit_price 0.005 SOL → ~22.30 SOL
 */
export const fixturePositionJupiterLendStable: Position = {
  position_id: "pos_009",
  wallet_id: "wal_001",
  protocol_id: "jupiter_lend",
  asset_symbol: "USDC",
  principal_amount: "4460000000",
  current_amount: "4460000000",
  accrued_yield_amount: "0",
  unit_price_usd: "1.00000000",
  unit_price_sol: "0.00500000",
  deposited_at: "2026-04-01T00:00:00.000Z",
  maturity_at: null,
  unlock_at: null,
  health_factor: null,
  auto_roll_rule: null,
  risk_score: 0.88,
  raw_state: { wrapped: "jupUSD", apy: 0.0530 },
};

// Phase 8.4: test 用に fixture array を維持。BFF / Mobile の production path は
// 直接 [] を返すよう変更 (server.ts / api.ts)。本配列は golden test と
// integration test のための canonical data として残置。
export const fixturePositions: Position[] = [
  fixturePositionKaminoLending,
  fixturePositionJitoStaking,
  fixturePositionKaminoBorrow,
  fixturePositionStreamflowVesting,
  fixturePositionKaminoRestaking,
  fixturePositionKaminoVault,
  fixturePositionMeteoraLP,
  fixturePositionRateXPTYT,
  fixturePositionJupiterLendStable,
];
