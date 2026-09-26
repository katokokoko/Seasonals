/**
 * Solana の EarnPosition (BFF /positions/earn) → menu の pool_id 対応付け。
 * mobile の MenuDrawer (vault-rows.ts) と Web の Menu「Deposited only」で共有する純関数。
 * 依存は lib の market registry だけ。
 */
import type { EarnPosition, EarnPositionsResponse, ProtocolMenuEntry, ProtocolPool } from "../types";
import { findKaminoMarketByReserve, findKaminoVaultByAddress } from "../config/kamino-markets";
import { findSaveMarketByCToken } from "../config/save-markets";
import { findExponentMarketByPtMint } from "../config/exponent-markets";

/**
 * position → menu の pool_id を registry で解決する。
 *
 * share_mint の意味は protocol ごとに違う (§8.15):
 *   Kamino  … reserve address / kVault address
 *   Save    … cToken mint
 *   Exponent… PT mint
 *   swap-earn (jito/marinade/sanctum/perena/hylo/solstice) … share token mint
 *
 * **swap-earn registry は pool_id を持たない** (`SwapEarnMarket` は protocol_id +
 * underlying_symbol で引く設計) ので、そこは呼び手が asset 一致で fallback する。
 */
export function poolIdForPosition(position: EarnPosition): string | undefined {
  const mint = position.share_mint;
  return (
    findKaminoMarketByReserve(mint)?.pool_id ??
    findKaminoVaultByAddress(mint)?.pool_id ??
    findSaveMarketByCToken(mint)?.pool_id ??
    findExponentMarketByPtMint(mint)?.market_id
  );
}

export interface PositionPartition {
  /** pool_id → position (行に統合できたもの) */
  byPool: Map<string, EarnPosition>;
  /**
   * どの pool にも紐付かなかった position (Meteora / Orca の LP position、
   * Kamino best-effort 等)。**捨てずに** 従来の "Your Positions" に出す。
   */
  unlinked: EarnPosition[];
}

/**
 * protocol の pools と保有 positions を突き合わせる。
 * registry で pool_id が引ければそれを使い、引けない protocol は
 * **同 protocol 内の asset 一致**で紐付ける (1 asset 1 pool の swap-earn 系)。
 */
export function partitionPositions(
  pools: ProtocolPool[],
  positions: EarnPosition[]
): PositionPartition {
  const byPool = new Map<string, EarnPosition>();
  const unlinked: EarnPosition[] = [];
  const poolIds = new Set(pools.map((p) => p.pool_id));
  for (const position of positions) {
    const viaRegistry = poolIdForPosition(position);
    if (viaRegistry && poolIds.has(viaRegistry) && !byPool.has(viaRegistry)) {
      byPool.set(viaRegistry, position);
      continue;
    }
    // fallback: asset 一致 (registry に pool_id が無い swap-earn 系)。
    // 既に埋まっている pool は上書きしない (先勝ち = 表示順の安定)
    const byAsset = pools.find(
      (p) =>
        (p.deposit_asset ?? p.asset) === position.asset_symbol &&
        !byPool.has(p.pool_id)
    );
    if (byAsset && !viaRegistry) {
      byPool.set(byAsset.pool_id, position);
      continue;
    }
    unlinked.push(position);
  }
  return { byPool, unlinked };
}

/**
 * menu の protocol_id → BFF /positions/earn の該当配列 (mobile MenuDrawer の positionsForProtocol と同じ対応)。
 * mobile 側にある client fallback (旧 BFF 用) は持たない — Web は enriched 配列だけを見る。
 */
export function earnPositionsForProtocol(protocolId: string, earn: EarnPositionsResponse | undefined): EarnPosition[] {
  switch (protocolId) {
    case "jupiter":
      return earn?.jupiterLend ?? [];
    case "kamino":
      return earn?.kaminoBestEffort ?? [];
    case "savefi":
      return earn?.save ?? [];
    case "exponent":
      return earn?.exponent ?? [];
    case "meteora":
      return earn?.meteora ?? [];
    case "orca":
      return earn?.orca ?? [];
    default:
      return earn?.swapEarn?.filter((p) => p.protocol_id === protocolId) ?? [];
  }
}

/** 複数 wallet の保有を menu の pool_id ごとに集める (`${protocol_id}:${pool_id}` → positions) */
export function heldPoolKeys(entries: ProtocolMenuEntry[], earns: EarnPositionsResponse[]): Map<string, EarnPosition[]> {
  const out = new Map<string, EarnPosition[]>();
  for (const entry of entries) {
    for (const earn of earns) {
      const { byPool } = partitionPositions(entry.pools, earnPositionsForProtocol(entry.protocol_id, earn));
      for (const [poolId, pos] of byPool) {
        const k = `${entry.protocol_id}:${poolId}`;
        out.set(k, [...(out.get(k) ?? []), pos]);
      }
    }
  }
  return out;
}
