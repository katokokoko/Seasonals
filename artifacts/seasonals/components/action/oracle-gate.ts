/**
 * oracle-gate — Phase 8.14 §4.6 の純粋ヘルパー (ActionModal から分離、test 容易化)。
 * RN/React に依存しないので jest で軽量に検証できる。
 */
import type { AgentPlan, OracleBlockReason } from "@workspace/lib/types";
import {
  SWAP_EARN_MARKETS,
  findMarketByProtocolAsset,
  findMarketByShareMint,
} from "@workspace/lib/config/swap-earn-markets";
import {
  findKaminoMarketByAsset,
  findKaminoMarketByPool,
  findKaminoMarketByReserve,
  findKaminoVaultByAddress,
  findKaminoVaultByPool,
} from "@workspace/lib/config/kamino-markets";
import {
  findSaveMarketByAsset,
  findSaveMarketByCToken,
  findSaveMarketByPool,
} from "@workspace/lib/config/save-markets";
import {
  METEORA_MARKETS,
  findMeteoraMarketByPool,
} from "@workspace/lib/config/meteora-markets";
import { findExponentMarketByPtMint } from "@workspace/lib/config/exponent-markets";
import {
  ORCA_MARKETS,
  findOrcaMarketByPool,
} from "@workspace/lib/config/orca-markets";

/**
 * underlying symbol → mint (SWAP_EARN_MARKETS から導出、§32.2 same source of truth)。
 * Jupiter Lend 7 markets + Tier A protocol の全 underlying を網羅する。
 */
export const JUPITER_UNDERLYING_MINTS: Record<string, string> =
  Object.fromEntries(
    SWAP_EARN_MARKETS.map((m) => [m.underlying_symbol, m.underlying_mint])
  );

/**
 * Phase 8.15: oracle gate (§4.6) を引く underlying mint を解決する。
 *   deposit: (protocol_id, asset) で market を引き、その underlying mint。
 *   withdraw: metadata.share_mint で market を引き、その underlying mint。
 * registry 外 (Kamino 等 swap-earn 非対象) は null = oracle gate スキップ。
 */
export function resolveOracleMint(
  action: AgentPlan["selected_action"] | undefined
): string | null {
  if (!action) return null;
  // Menu catalog の "jupiter" は registry の "jupiter_lend" に正規化。
  const protocolId =
    action.protocol === "jupiter" ? "jupiter_lend" : action.protocol;
  if (action.action_type === "withdraw") {
    const shareMint = action.metadata?.share_mint;
    if (typeof shareMint === "string") {
      // share_mint の中身: swap-earn = token mint、Kamino = reserve address、
      // Save = cToken mint、kVault = vault address。
      // Meteora の position pubkey 等、どれにも hit しない場合は下の protocol
      // 分岐に fall through する (return しない)。
      const resolved =
        findMarketByShareMint(shareMint)?.underlying_mint ??
        findKaminoMarketByReserve(shareMint)?.underlying_mint ??
        findSaveMarketByCToken(shareMint)?.underlying_mint ??
        findKaminoVaultByAddress(shareMint)?.underlying_mint ??
        // Phase 8.34: Exponent PT redeem (share_mint = pt_mint)。underlying に
        // oracle feed が無い場合は下流で not_configured 通過 (既存設計)
        findExponentMarketByPtMint(shareMint)?.underlying_mint;
      if (resolved) return resolved;
    }
  }
  // Phase 8.15b/8.15d: Kamino deposit は pool_id (vault 優先) / asset で解決。
  if (protocolId === "kamino") {
    const poolId = action.metadata?.pool_id;
    const byVault =
      typeof poolId === "string" ? findKaminoVaultByPool(poolId) : undefined;
    if (byVault) return byVault.underlying_mint;
    const byPool =
      typeof poolId === "string" ? findKaminoMarketByPool(poolId) : undefined;
    const mkt =
      byPool ??
      (action.asset ? findKaminoMarketByAsset(action.asset) : undefined);
    return mkt?.underlying_mint ?? null;
  }
  // Phase 8.15c: Save deposit も pool_id / asset で解決。
  if (protocolId === "savefi") {
    const poolId = action.metadata?.pool_id;
    const byPool =
      typeof poolId === "string" ? findSaveMarketByPool(poolId) : undefined;
    const mkt =
      byPool ?? (action.asset ? findSaveMarketByAsset(action.asset) : undefined);
    return mkt?.underlying_mint ?? null;
  }
  // Phase 8.17: Meteora は deposit token を gate (withdraw は position pubkey が
  // registry で引けないため asset (= deposit_symbol) で解決)。
  if (protocolId === "meteora") {
    const poolId = action.metadata?.pool_id;
    const byPool =
      typeof poolId === "string" ? findMeteoraMarketByPool(poolId) : undefined;
    const mkt =
      byPool ??
      METEORA_MARKETS.find((m) => m.deposit_symbol === action.asset);
    return mkt?.deposit_mint ?? null;
  }
  // Phase 8.18: Orca も deposit token を gate (withdraw は position mint が
  // registry で引けないため asset (= deposit_symbol) で解決)。
  if (protocolId === "orca") {
    const poolId = action.metadata?.pool_id;
    const byPool =
      typeof poolId === "string" ? findOrcaMarketByPool(poolId) : undefined;
    const mkt =
      byPool ?? ORCA_MARKETS.find((m) => m.deposit_symbol === action.asset);
    return mkt?.deposit_mint ?? null;
  }
  if (protocolId && action.asset) {
    return (
      findMarketByProtocolAsset(protocolId, action.asset)?.underlying_mint ??
      null
    );
  }
  return null;
}

/** block reason (§4.6) の表示ラベル */
export function oracleBlockLabel(
  reason: OracleBlockReason | null | undefined
): string {
  switch (reason) {
    case "oracle_both_stale":
      return "Both Pyth and Switchboard are stale (>60s)";
    case "oracle_divergence_too_large":
      return "Pyth ↔ Switchboard divergence >5%";
    case "oracle_unavailable":
      return "Price oracle unavailable";
    default:
      return "oracle check failed";
  }
}

/**
 * Phase 8.78: oracle が blocked の間だけ 15 秒間隔で再チェックする
 * (`useOracleStatus` の refetchInterval に渡す)。
 *
 * これが無いとシートを開いたまま oracle が回復しても banner が消えず、
 * ユーザーはシートを閉じて開き直すしかなかった (そうとは分からないまま)。
 * ok / warning / 未取得ではポーリングしない — 正常時に余計な負荷を掛けない。
 */
export const ORACLE_BLOCKED_REFETCH_MS = 15_000;

export function oracleRefetchInterval(
  data: { status?: string } | undefined
): number | false {
  return data?.status === "blocked" ? ORACLE_BLOCKED_REFETCH_MS : false;
}
