/**
 * earn-to-position — EarnPosition (Phase 8.2) を Position (CLAUDE.md §11.3) に
 * 変換する mobile helper (Phase 8.3 Part A)。
 *
 * `aggregateAllocation` / `totalSolValue` 等の既存 Portfolio ロジックを
 * EarnPosition にも適用するため、共通の Position 形に揃える。
 *
 * 規約:
 *   - amount は smallest unit string のまま保持 (§4.5)
 *   - unit_price_sol は 8 decimals string、SOL_USD 168.5 で USD → SOL 換算
 *     (Phase 8.4 で Pyth に差替予定。PortfolioSummary 内 SOL_TO_USD と整合)
 *   - protocol_id は EarnPosition のまま (fixtureProtocols に "jupiter_lend" /
 *     "kamino" が登録済なので aggregateAllocation で Lending segment に集計される)
 */

import type {
  EarnPosition,
  EarnPositionsResponse,
  Position,
} from "@workspace/lib/types";

/** PortfolioSummary 内の SOL_TO_USD と一致させる (Phase 8.4 で oracle 差替え予定) */
const SOL_TO_USD = 168.5;

/**
 * Phase 8.3.1: BFF が underlying_usd を "0" で返す protocol があるため、
 * asset_symbol から固定 USD 価格を解決して unit_price_sol を補完する。
 * Phase 8.4 で Pyth oracle に差替予定。
 */
const ASSET_USD_PRICE: Record<string, number> = {
  USDC: 1,
  USDT: 1,
  USDS: 1,
  USDG: 1,
  EURC: 1.08,
  JupUSD: 1,
  SOL: SOL_TO_USD,
  mSOL: SOL_TO_USD,
  JitoSOL: SOL_TO_USD,
  bSOL: SOL_TO_USD,
};

function fallbackAssetUsd(asset: string): number {
  return ASSET_USD_PRICE[asset] ?? 0;
}

export function earnPositionToPosition(earn: EarnPosition): Position {
  // 1 human unit あたりの USD price を解決。BFF underlying_usd が "0"/NaN なら fallback。
  const amountSmallest = Number(earn.underlying_amount) || 0;
  const human =
    earn.underlying_decimals > 0
      ? amountSmallest / Math.pow(10, earn.underlying_decimals)
      : amountSmallest;
  const usdTotal = Number.parseFloat(earn.underlying_usd) || 0;
  // per-unit USD: usdTotal が有効ならそれを human で割る、無効なら asset fallback
  const usdPerUnit =
    human > 0 && usdTotal > 0 ? usdTotal / human : fallbackAssetUsd(earn.asset_symbol);
  const solPerUnit = usdPerUnit / SOL_TO_USD;
  const unit_price_sol = solPerUnit > 0 ? solPerUnit.toFixed(8) : "0.00000000";

  return {
    position_id: `earn_${earn.protocol_id}_${earn.share_mint}`,
    wallet_id: "current",
    protocol_id: earn.protocol_id,
    asset_symbol: earn.asset_symbol,
    // Phase 8.13: cost-basis が既知なら実元本、不明なら現状動作 (current = principal) を踏襲。
    principal_amount: earn.cost_basis_amount ?? earn.underlying_amount,
    current_amount: earn.underlying_amount,
    // Phase 8.13: BFF が tx 履歴の cost-basis から算出した実 accrued yield の magnitude。
    // 符号・既知性は raw_state (accrued_yield_sign / cost_basis_amount) で伝搬する
    // (Position.accrued_yield_amount は §4.5 `^[0-9]+$` の magnitude string を維持)。
    accrued_yield_amount: earn.accrued_yield_amount,
    unit_price_usd: earn.underlying_usd,
    unit_price_sol,
    deposited_at: new Date().toISOString(),
    maturity_at: null,
    unlock_at: null,
    health_factor: null,
    auto_roll_rule: null,
    risk_score: 0.3,
    raw_state: {
      source: "earn_position",
      share_mint: earn.share_mint,
      supply_rate_bps: earn.supply_rate_bps,
      accrued_yield_sign: earn.accrued_yield_sign,
      cost_basis_amount: earn.cost_basis_amount,
    },
  };
}

/**
 * 既存 fixture positions と earn positions を合わせて 1 つの Position[] にする。
 * PortfolioSummary はこの合成済 array を受け取って allocation / total を算出。
 */
export function mergeEarnPositions(
  basePositions: Position[],
  earnPositions: EarnPositionsResponse | undefined
): Position[] {
  if (!earnPositions) return basePositions;
  // Phase 8.15.x: swapEarn (LST/USD*) / save (cToken) も合成 → total/donut に反映。
  const earnAll: EarnPosition[] = [
    ...earnPositions.jupiterLend,
    ...earnPositions.kaminoBestEffort,
    ...(earnPositions.swapEarn ?? []),
    ...(earnPositions.save ?? []),
    // Phase 8.17: Meteora DLMM (position pubkey は raw mint に現れない)
    ...(earnPositions.meteora ?? []),
    // Phase 8.18: Orca Whirlpools (position mint は NFT — raw SPL 保有行と重複しうるが
    // dedup ガードが share_mint 一致で置換するため二重計上しない)
    ...(earnPositions.orca ?? []),
  ];
  const earnAsPositions: Position[] = earnAll.map(earnPositionToPosition);
  // 二重計上ガード: earn 行の share_mint (jlToken / jitoSOL / cUSDC 等の wallet SPL)
  // と同じ mint の raw 保有行は earn 行が置換する (donut 合計を二重にしない)。
  // Kamino の share_mint (reserve/vault address) は raw mint に現れないため無害。
  const coveredMints = new Set(earnAll.map((e) => e.share_mint));
  const filteredBase = basePositions.filter((p) => {
    const mint = (p.raw_state as { mint?: unknown } | undefined)?.mint;
    return typeof mint !== "string" || !coveredMints.has(mint);
  });
  return [...filteredBase, ...earnAsPositions];
}
