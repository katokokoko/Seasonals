/**
 * oracle-gate — Phase 8.14 §4.6 の純粋ヘルパー (ActionModal から分離、test 容易化)。
 * RN/React に依存しないので jest で軽量に検証できる。
 */
import type { OracleBlockReason, OracleWarning, OracleWarningKind, SolanaActionShape } from "../types";
import {
  SWAP_EARN_MARKETS,
  findMarketByProtocolAsset,
  findMarketByShareMint,
} from "../config/swap-earn-markets";
import {
  findKaminoMarketByAsset,
  findKaminoMarketByPool,
  findKaminoMarketByReserve,
  findKaminoVaultByAddress,
  findKaminoVaultByPool,
} from "../config/kamino-markets";
import {
  findSaveMarketByAsset,
  findSaveMarketByCToken,
  findSaveMarketByPool,
} from "../config/save-markets";
import {
  METEORA_MARKETS,
  findMeteoraMarketByPool,
} from "../config/meteora-markets";
import { findExponentMarketByPtMint } from "../config/exponent-markets";
import {
  ORCA_MARKETS,
  findOrcaMarketByPool,
} from "../config/orca-markets";

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
  action: SolanaActionShape | null | undefined
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
  // source 名は出さない (2026-10 に Pyth push + RedStone push へ移行、asset ごとに構成が違う)
  switch (reason) {
    case "oracle_both_stale":
      return "Price sources are stale";
    case "oracle_divergence_too_large":
      return "Price sources disagree by more than 5%";
    case "oracle_unavailable":
      return "Price oracle unavailable";
    default:
      return "oracle check failed";
  }
}

/**
 * oracle warning の見出しと本文 (Seeker WarningArea と Web OracleGate が共有)。
 * secondary の source 名は出さない (asset ごとに構成が違い、今後 source が増えても文言を変えない)
 */
export const ORACLE_WARNING_HEADLINE: Record<OracleWarningKind, string> = {
  oracle_divergence_warning: "Price oracle anomaly detected",
  oracle_pyth_stale: "Pyth is returning a stale price",
  oracle_secondary_stale: "Secondary price source is stale",
};

export function oracleWarningBody(w: OracleWarning): string {
  switch (w.kind) {
    case "oracle_divergence_warning":
      return w.divergencePct !== undefined
        ? `Pyth and the secondary price source differ by ${w.divergencePct.toFixed(1)}%`
        : "Pyth and the secondary price source differ";
    case "oracle_pyth_stale":
      return w.pythAgeSeconds !== undefined
        ? `Pyth last updated ${Math.floor(w.pythAgeSeconds)}s ago · using the secondary source`
        : "Pyth is stale · using the secondary source";
    case "oracle_secondary_stale":
      return w.secondaryAgeSeconds !== undefined
        ? `Secondary source last updated ${Math.floor(w.secondaryAgeSeconds)}s ago · using Pyth (prices not cross-checked)`
        : "Secondary source is stale · using Pyth (prices not cross-checked)";
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
