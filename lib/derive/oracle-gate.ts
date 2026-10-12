/**
 * oracle-gate — Phase 8.14 §4.6 の純粋ヘルパー (ActionModal から分離、test 容易化)。
 * RN/React に依存しないので jest で軽量に検証できる。
 */
import type {
  OracleBlockReason,
  OracleResult,
  OracleWarning,
  OracleWarningKind,
  SolanaActionShape,
} from "../types";
import {
  SWAP_EARN_MARKETS,
  findMarketByProtocolAsset,
  findMarketByShareMint,
  swapEarnDepositInputBySymbol,
} from "../config/swap-earn-markets";
import { pinnedSwapEarnMarket } from "./solana-action";
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
  // 2026-10-13: share_mint で固定された swap-earn deposit (funding deposit を含む) は
  // asset で引かず、その market の underlying を gate する (asset で引くと別 market に流れる)。
  // funding mint は resolveOracleMints が 2 本目として返す
  const pinned = pinnedSwapEarnMarket(action);
  if (pinned) return pinned.underlying_mint;
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

/**
 * 2026-10-13: gate を引く mint をすべて返す。funding deposit (USDC で jlJupUSD を買う) は
 * [underlying, funding] の 2 本 — どちらかが blocked なら execute を止める (§4.6 fail-closed)。
 * それ以外は resolveOracleMint 1 本 (無ければ [])。先頭 = resolveOracleMint と同じ値 (back-compat)
 */
export function resolveOracleMints(
  action: SolanaActionShape | null | undefined
): string[] {
  const pinned = pinnedSwapEarnMarket(action);
  if (pinned) {
    const input = swapEarnDepositInputBySymbol(pinned, action?.asset);
    return input?.isFunding && input.mint !== pinned.underlying_mint
      ? [pinned.underlying_mint, input.mint]
      : [pinned.underlying_mint];
  }
  const primary = resolveOracleMint(action);
  return primary ? [primary] : [];
}

/**
 * block reason の重さ。両 stale / 未取得は「価格が無い」= divergence (両方 fresh で乖離) より重い。
 * simulate は divergence だけ warning で通すので、merge で divergence が他の block を隠すと
 * §4.6 の fail-closed が破れる (#49 review)
 */
function blockReasonRank(reason: OracleBlockReason | null): number {
  switch (reason) {
    case "oracle_unavailable":
      return 3;
    case "oracle_both_stale":
      return 2;
    case "oracle_divergence_too_large":
      return 1;
    default:
      return 0;
  }
}

/**
 * 複数 asset の oracle 判定を 1 つにまとめる (funding deposit の WarningArea / CTA 用)。
 * status は最悪値 (blocked > warning > ok)、block_reason は最初に blocked だった asset のもの、
 * warnings は連結、price_usd / asset_symbol は先頭 (= underlying) のもの。空配列は null。
 * tier は最も弱い構成 (D > C > B > A)、not_configured はどれかが gate 対象外なら true
 */
export function mergeOracleResults(results: OracleResult[]): OracleResult | null {
  if (results.length === 0) return null;
  if (results.length === 1) return results[0]!;
  const rank = { ok: 0, warning: 1, blocked: 2 } as const;
  const tierRank = { A: 0, B: 1, C: 2, D: 3 } as const;
  const worst = results.reduce((acc, r) => (rank[r.status] > rank[acc.status] ? r : acc));
  // blocked が複数なら最も重い block_reason を採る (divergence が both_stale を隠さない)
  const blocked = results
    .filter((r) => r.status === "blocked")
    .reduce<OracleResult | undefined>(
      (acc, r) => (!acc || blockReasonRank(r.block_reason) > blockReasonRank(acc.block_reason) ? r : acc),
      undefined
    );
  const first = results[0]!;
  const weakestTier = results.reduce(
    (acc, r) => (tierRank[r.tier] > tierRank[acc] ? r.tier : acc),
    first.tier
  );
  const notConfigured = results.some((r) => r.not_configured);
  return {
    ...first,
    asset_symbol: results.map((r) => r.asset_symbol).join(" / "),
    status: worst.status,
    price_usd: blocked ? null : first.price_usd,
    tier: weakestTier,
    divergence_pct: first.divergence_pct,
    warnings: results.flatMap((r) => r.warnings),
    block_reason: blocked?.block_reason ?? null,
    ...(notConfigured ? { not_configured: true } : {}),
    ...(blocked?.reason ?? first.reason ? { reason: blocked?.reason ?? first.reason } : {}),
  };
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
