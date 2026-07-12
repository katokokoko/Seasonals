/**
 * Save (旧 Solend) main pool market registry — Mobile / BFF 共有 (Phase 8.15c、§32.2)
 *
 * Save の deposit は pure-supply flow (reserve liquidity deposit → cToken を wallet に
 * mint)。cToken は wallet に残る SPL なので、positions/withdraw は 8.15 LST パターン
 * (mint-keyed) を踏襲する。tx 構築は @solendprotocol/solend-sdk (BFF 側のみ)、
 * market/reserve の詳細 config (oracle / fee receiver) は BFF が
 * api.save.finance /v1/markets/configs から実行時に取得する。
 *
 * 本 registry は product レベルのキーだけを持つ:
 *   pool_id (menu) ⇔ reserve address ⇔ cToken mint ⇔ underlying
 * 値は実 API で検証済のもののみ収録 (silent に壊れた market を載せない)。
 * underlying (USDC/SOL) は ASSET_ORACLE_FEEDS 設定済 → oracle gate 追加不要。
 */

import type { EarnPosition } from "../types/earn-position";
import type { Position } from "../types/position";

/** Save main pool lending market (4UpD2…KvdY) */
export const SAVE_MAIN_MARKET = "4UpD2fh7xH3VP9QQaXtsS1YY3bxzWhtfpks7FatyKvdY";

export interface SaveMarket {
  protocol_id: "savefi";
  /** Seasonals menu の pool_id (deposit dispatch の一次キー) */
  pool_id: string;
  /** underlying asset symbol ("USDC" | "SOL") */
  underlying_symbol: string;
  underlying_mint: string;
  underlying_decimals: number;
  /** Save lending market address */
  market: string;
  /** reserve address (tx build / REST APY 取得キー) */
  reserve: string;
  /** collateral cToken mint (wallet 検出 + withdraw 解決キー)。decimals は underlying と同一 */
  ctoken_mint: string;
  /** cToken symbol (表示用、"cUSDC" 等) */
  ctoken_symbol: string;
}

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SOL = "So11111111111111111111111111111111111111112";

export const SAVE_MARKETS: SaveMarket[] = [
  // USDC main reserve (supplyInterest ~2.0%、oracle: USDC)
  {
    protocol_id: "savefi",
    pool_id: "savefi_usdc_main",
    underlying_symbol: "USDC",
    underlying_mint: USDC,
    underlying_decimals: 6,
    market: SAVE_MAIN_MARKET,
    reserve: "BgxfHJDzm44T7XG68MYKx7YisTjZu73tVovyZSjJMpmw",
    ctoken_mint: "993dVFL2uXWYeoXuEBFXR4BijeXdTv4s6BzsCjJZuwqk",
    ctoken_symbol: "cUSDC",
  },
  // SOL main reserve (supplyInterest ~2.7%、oracle: SOL)
  {
    protocol_id: "savefi",
    pool_id: "savefi_sol_main",
    underlying_symbol: "SOL",
    underlying_mint: SOL,
    underlying_decimals: 9,
    market: SAVE_MAIN_MARKET,
    reserve: "8PbodeaosQP19SjYFx855UMqWxH2HynZLdBXmsrbac36",
    ctoken_mint: "5h6ssFpeDeRbzsEHDbTQNH7nVGgsKrZydxdSTnLm6QdV",
    ctoken_symbol: "cSOL",
  },
];

/** reserve address → market (deposit-tx / REST APY の解決) */
export function findSaveMarketByReserve(
  reserve: string
): SaveMarket | undefined {
  return SAVE_MARKETS.find((m) => m.reserve === reserve);
}

/** cToken mint → market (withdraw / 保有 position の解決) */
export function findSaveMarketByCToken(
  ctokenMint: string
): SaveMarket | undefined {
  return SAVE_MARKETS.find((m) => m.ctoken_mint === ctokenMint);
}

/** menu pool_id → market (pool tap 由来の deposit dispatch) */
export function findSaveMarketByPool(poolId: string): SaveMarket | undefined {
  return SAVE_MARKETS.find((m) => m.pool_id === poolId);
}

/** underlying symbol → market (pool_id 不明時の deposit fallback) */
export function findSaveMarketByAsset(
  underlyingSymbol: string
): SaveMarket | undefined {
  return SAVE_MARKETS.find((m) => m.underlying_symbol === underlyingSymbol);
}

/**
 * Phase 8.15c: 保有 cToken の raw Position を EarnPosition に正規化する
 * (heldSwapEarnPositions の Save 版)。`raw_state.mint` が ctoken_mint に hit する
 * position だけを返す。表示は cToken 建て (shares = cToken 量、underlying 換算は
 * cTokenExchangeRate が要るため follow-up)、USD/APY は 0/null の graceful degrade。
 */
export function heldSavePositions(
  positions: Position[],
  protocolId: string
): EarnPosition[] {
  const out: EarnPosition[] = [];
  for (const p of positions) {
    const mint = (p.raw_state as { mint?: unknown } | undefined)?.mint;
    if (typeof mint !== "string") continue;
    const m = findSaveMarketByCToken(mint);
    if (!m || m.protocol_id !== protocolId) continue;
    out.push({
      protocol_id: m.protocol_id,
      protocol_name: "Save",
      market_symbol: m.underlying_symbol,
      share_mint: m.ctoken_mint,
      shares: p.current_amount, // cToken smallest unit = withdraw (redeem) 入力
      share_decimals: m.underlying_decimals, // cToken decimals = underlying と同一
      asset_symbol: m.ctoken_symbol,
      underlying_amount: p.current_amount,
      underlying_decimals: m.underlying_decimals,
      underlying_usd: "0",
      supply_rate_bps: null,
      accrued_yield_amount: "0",
      accrued_yield_sign: "unknown",
      cost_basis_amount: null,
    });
  }
  return out;
}
