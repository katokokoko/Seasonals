/**
 * SKR staking (Solana Mobile) — R0 読取用の固定値 (docs/skr-r0-implementation.md §2)
 *
 * - **Menu registry には載せない** (deposit / withdraw の menu を持たない read-only 連携)。
 *   載せると oracle-feeds の tier 宣言が必要になり、Agent 候補 (/menu-listings) にも出てしまう
 * - layout は公式 IDL (lib/__fixtures__/skr-staking/idl.json、SHA-256 は SKR_IDL_SHA256) から
 *   計算した offset。skr-staking.test.ts が IDL を読んで一致を検査する
 * - cooldown 秒は **ここに置かない**。config account から毎回読む (変更可能な値のため)
 */

export const SKR_STAKING_PROTOCOL_ID = "skr_staking";
/** BFF は Helius mainnet だけを読む (cluster env は無い) */
export const SKR_STAKING_CLUSTER = "mainnet-beta";

export const SKR_STAKING_PROGRAM_ID = "SKRskrmtL83pcL4YqLWt6iPefDqwXQWHSw9S9vz94BZ";
/** PDA ["stake_config"] */
export const SKR_STAKE_CONFIG = "4HQy82s9CHTv1GsYKnANHMiHfhcqesYkK6sB3RDSYyqw";
/** PDA ["stake_vault"] (SPL token account、authority = stake config) */
export const SKR_STAKE_VAULT = "8isViKbwhuhFhsv2t8vaFL74pKCqaFPQXo1KkeQwZbB8";
/** R0 の対象 pool。PDA ["guardian_pool", stake_config, SKR_GUARDIAN] */
export const SKR_GUARDIAN_POOL = "DPJ58trLsF9yPrBa2pk6UaRkvqW8hWUYjawe788WBuqr";
export const SKR_GUARDIAN = "SKRGdBwzb1AtFW2chhBnZpGFnFLj6Mi7HM7iwjXALvw";
export const SKR_MINT = "SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3";
export const SKR_SYMBOL = "SKR";
export const SKR_DECIMALS = 6;
/** StakeConfig.share_price の scale (公式 sample / IDL doc "scaled, e.g., 1e9") */
export const SKR_SHARE_PRICE_SCALE = "1000000000";

/** 解除・withdraw は公式ポータルで行う (R0 は署名しない) */
export const SKR_STAKING_PORTAL_URL = "https://stake.solanamobile.com/";

/** 取得 IDL の SHA-256 (資料の識別値。live deployment との一致証明ではない) */
export const SKR_IDL_SHA256 =
  "6e71d7a36ee9ea4410394ec69d9007dca4fb05ad902741004f1d3746b607df03";

/** PDA seed の固定 prefix (utf-8) */
export const SKR_PDA_SEEDS = {
  stakeConfig: "stake_config",
  stakeVault: "stake_vault",
  guardianPool: "guardian_pool",
  userStake: "user_stake",
} as const;

/** Anchor account の discriminator / 全長 / field offset (little endian) */
export const SKR_LAYOUT = {
  stakeConfig: {
    discriminator: [238, 151, 43, 3, 11, 151, 63, 176],
    size: 193,
    offsets: {
      bump: 8, // u8
      authority: 9, // pubkey
      mint: 41, // pubkey
      stake_vault: 73, // pubkey
      min_stake_amount: 105, // u64
      cooldown_seconds: 113, // u64
      total_shares: 121, // u128
      share_price: 137, // u128
      commission_weight_sum: 153, // u128
      cumulative_commission_per_share: 169, // u128
      last_vault_amount: 185, // u64
    },
  },
  guardianPool: {
    discriminator: [133, 238, 255, 214, 215, 11, 189, 23],
    size: 188,
    offsets: {
      stake_config: 8, // pubkey
      guardian: 40, // pubkey
      authority: 72, // pubkey
      total_shares: 104, // u128
      cumulative_commission_per_share: 120, // u128
      last_share_price: 136, // u128
      accrued_commission: 152, // u128
      commission_bps: 168, // u16
      bump: 170, // u8
      active: 171, // bool
      deregistered_share_price: 172, // u128
    },
  },
  userStake: {
    discriminator: [102, 53, 163, 107, 9, 138, 87, 153],
    size: 169,
    offsets: {
      bump: 8, // u8
      stake_config: 9, // pubkey
      user: 41, // pubkey
      guardian_pool: 73, // pubkey
      shares: 105, // u128
      cost_basis: 121, // u128
      cumulative_commission_before_staking: 137, // u128
      unstaking_amount: 153, // u64 (token 量。shares ではない)
      unstake_timestamp: 161, // i64
    },
  },
} as const;

// ── Solana 標準 account ──

export const SOLANA_CLOCK_SYSVAR = "SysvarC1ock11111111111111111111111111111111";
export const SOLANA_SYSVAR_OWNER = "Sysvar1111111111111111111111111111111111111";
/** Clock: slot u64, epoch_start_timestamp i64, epoch u64, leader_schedule_epoch u64, unix_timestamp i64 */
export const SOLANA_CLOCK_LAYOUT = {
  size: 40,
  offsets: {
    slot: 0,
    epoch_start_timestamp: 8,
    epoch: 16,
    leader_schedule_epoch: 24,
    unix_timestamp: 32,
  },
} as const;

export const SPL_TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
/** SPL token account: mint pubkey@0, owner pubkey@32, amount u64@64 */
export const SPL_TOKEN_ACCOUNT_LAYOUT = {
  size: 165,
  offsets: { mint: 0, owner: 32, amount: 64 },
} as const;
/** SPL mint: decimals u8@44, is_initialized bool@45 */
export const SPL_MINT_LAYOUT = {
  size: 82,
  offsets: { supply: 36, decimals: 44, is_initialized: 45 },
} as const;
