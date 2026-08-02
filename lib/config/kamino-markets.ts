/**
 * Kamino Lend (K-Lend) market registry — Mobile / BFF 共有 (Phase 8.15b、§32.2)
 *
 * Kamino は swap-routable でない (obligation 型、cToken は wallet に来ず Jupiter 非 routable)
 * ため swap-earn registry には載せられない。代わりに `api.kamino.finance` の REST
 * (unsigned tx builder) を叩く。本 registry は Seasonals の menu pool / underlying asset を
 * Kamino の {market, reserve} address に紐付ける (deposit/withdraw 解決 + oracle gate)。
 *
 * 収録は **K-Lend reserve のみ** (kVault = steakhouse/jitosol は別 API `/ktx/kvault/*`、
 * follow-up)。値は実 API で検証済のもののみ (§32.2 same source of truth、silent に壊れた
 * market を載せない)。underlying (USDC/SOL) は ASSET_ORACLE_FEEDS 設定済 → 新規 feed 不要。
 */

/** Kamino Lend main market (7u3He…5PfF、USDC/SOL/USDT/JLP reserve を含む) */
export const KAMINO_MAIN_MARKET = "7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF";

export interface KaminoMarket {
  protocol_id: "kamino";
  /** Seasonals menu の pool_id (deposit dispatch の一次キー) */
  pool_id: string;
  /** deposit する underlying asset symbol */
  underlying_symbol: string;
  underlying_mint: string;
  underlying_decimals: number;
  /** Kamino lending market address */
  market: string;
  /** Kamino reserve address (position key / tx build に使う) */
  reserve: string;
  /** 参考 supply APY (実値は /protocols/kamino/reserves が上書き) */
  supply_apy_hint?: number;
  /**
   * Phase 8.52: **上流の都合で deposit が必ず失敗する** market に付ける理由。
   * 預入上限 (on-chain の `deposit_limit`) とは独立した軸で、枠に空きがあっても
   * 塞ぐ。設定すると BFF が `deposit_open=false` を配り、menu の CTA が落ち、
   * deposit-tx は上流を叩く前に 409 を返す (fail-closed、§32.2)。
   * withdraw には影響しない (出口は塞がない)。
   */
  deposit_blocked_reason?: string;
}

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SOL = "So11111111111111111111111111111111111111112";

export const KAMINO_MARKETS: KaminoMarket[] = [
  // USDC main reserve (TVL ~$104M、supplyApy ~4.4%、oracle: USDC)
  {
    protocol_id: "kamino",
    pool_id: "kamino_usdc_main",
    underlying_symbol: "USDC",
    underlying_mint: USDC,
    underlying_decimals: 6,
    market: KAMINO_MAIN_MARKET,
    reserve: "D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59",
    supply_apy_hint: 4.46,
    // Phase 8.52: 上流の誤ルーティング。main market には USDC reserve が 4 本あり、
    // `/ktx/klend/deposit` は body の `reserve` を必須にしながら**値を尊重しない**。
    // この D6q6… (上限 1.00B / 使用 11%) を要求しても、返る tx は常に 5xXxt9uV…
    // (status Hidden / 上限 0) を対象にするため program が DepositLimitExceeded を
    // 投げる。枠には空きがあるので上限ガードでは捕まらない → ここで明示的に塞ぐ。
    // 解除条件: 上流が `reserve` を尊重する / USDC reserve が 1 本に統合される。
    // 判定方法は scripts/verify-tx-routes.mjs の "kamino dep USDC" (simulate)。
    // withdraw は正常に動くので塞がない (§32.2 出口は塞がない)。
    deposit_blocked_reason:
      "Kamino is routing USDC deposits to a closed reserve (upstream issue)",
  },
  // SOL main reserve (TVL ~$203M、supplyApy ~8.6%、oracle: SOL)
  {
    protocol_id: "kamino",
    pool_id: "kamino_sol_main",
    underlying_symbol: "SOL",
    underlying_mint: SOL,
    underlying_decimals: 9,
    market: KAMINO_MAIN_MARKET,
    reserve: "d4A2prbA2whesmvHaL88BH6Ewn5N4bTSU2Ze8P6Bc4Q",
    supply_apy_hint: 8.63,
  },
  // JLP main reserve (Phase 8.27。TVL ~$1.9M、supplyApy ~0% — JLP の利回りは
  // perp fee による価格上昇に内在し、lending supply APY はほぼ 0 が実態。
  // 旧 menu fixture の "jupiter_jlp_lending 10.5%" は虚構だったため実体へ移設)
  {
    protocol_id: "kamino",
    pool_id: "kamino_jlp",
    underlying_symbol: "JLP",
    underlying_mint: "27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4",
    underlying_decimals: 6,
    market: KAMINO_MAIN_MARKET,
    reserve: "EAA3VVsxUuQB1Tm5x7TJkq9ATtiX5Qwq8ok7gXwim7oo",
    supply_apy_hint: 0,
  },
];

/** reserve address → market (deposit/withdraw-tx・position key の解決) */
export function findKaminoMarketByReserve(
  reserve: string
): KaminoMarket | undefined {
  return KAMINO_MARKETS.find((m) => m.reserve === reserve);
}

/** menu pool_id → market (pool tap 由来の deposit dispatch) */
export function findKaminoMarketByPool(
  poolId: string
): KaminoMarket | undefined {
  return KAMINO_MARKETS.find((m) => m.pool_id === poolId);
}

/** underlying symbol → market (pool_id 不明時の deposit fallback) */
export function findKaminoMarketByAsset(
  underlyingSymbol: string
): KaminoMarket | undefined {
  return KAMINO_MARKETS.find((m) => m.underlying_symbol === underlyingSymbol);
}

// ─────────────────────────────────────────────────────────────────────────────
// Kamino Earn vault (kVault) — Phase 8.15d
// ─────────────────────────────────────────────────────────────────────────────

/**
 * kVault は K-Lend reserve と別プロダクト (複数 reserve に配分する Earn vault、
 * 受取は vault share)。tx build は `POST /ktx/kvault/deposit|withdraw`
 * ({wallet, kvault, amount} — amount は human/decimal。**withdraw は share 建て**、
 * klend-sdk kvault tutorial で確認済)。
 * 両 vault とも farm 付きで share は auto-stake され wallet に SPL が残らない →
 * 保有検出は `GET /kvaults/users/{wallet}/positions` (REST) のみ。
 * EarnPosition の share_mint には **vault address を流用** (reserve 流用と同型)。
 */
export interface KaminoVault {
  protocol_id: "kamino";
  /** Seasonals menu の pool_id (deposit dispatch の一次キー) */
  pool_id: string;
  display_name: string;
  underlying_symbol: string;
  underlying_mint: string;
  underlying_decimals: number;
  /** kvault address (tx build / positions / share_mint 流用キー) */
  vault: string;
  /** vault share の decimals (positions API の human 単位 → smallest 変換に使う) */
  shares_decimals: number;
}

export const KAMINO_VAULTS: KaminoVault[] = [
  // Steakhouse USDC (APY ~4.8%、farm 付き。/kvaults/vaults で検証済)
  {
    protocol_id: "kamino",
    pool_id: "kamino_steakhouse_usdc",
    display_name: "Steakhouse USDC",
    underlying_symbol: "USDC",
    underlying_mint: USDC,
    underlying_decimals: 6,
    vault: "HDsayqAsDWy3QvANGqh2yNraqcD8Fnjgh73Mhb3WRS5E",
    shares_decimals: 6,
  },
  // Allez SOL (APY ~11%、TVL $6.6M / 1950 holders — SOL vault 最大。farm 付き)
  {
    protocol_id: "kamino",
    pool_id: "kamino_allez_sol_vault",
    display_name: "Allez SOL",
    underlying_symbol: "SOL",
    underlying_mint: SOL,
    underlying_decimals: 9,
    vault: "A1so1bPD3W1TfeFwboDh8yfAAVaVtcdAYBYCjhg2mJQ",
    shares_decimals: 6,
  },
];

/** vault address → vault (withdraw / positions の解決) */
export function findKaminoVaultByAddress(
  vault: string
): KaminoVault | undefined {
  return KAMINO_VAULTS.find((v) => v.vault === vault);
}

/** menu pool_id → vault (pool tap 由来の deposit dispatch) */
export function findKaminoVaultByPool(
  poolId: string
): KaminoVault | undefined {
  return KAMINO_VAULTS.find((v) => v.pool_id === poolId);
}
