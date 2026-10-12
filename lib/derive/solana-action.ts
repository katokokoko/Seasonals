/**
 * solana-action — Solana の deposit / withdraw action を BFF の unsigned tx builder 1 本に解決する純関数。
 *
 * Seeker の `ActionModal.handleExecute` (Phase 8.15〜8.37) の market dispatch を **順序込みで** 転写したもの。
 * Web はこれを使い、Seeker も後続 phase でこれに乗せ替える (same source of truth、CLAUDE.md §1)。
 * どの route にも当たらなければ null = fail-closed (Seeker 8.37 M-H1: 偽の成功表示にしない)。
 *
 * 解決順 (ActionModal の if 連鎖と同一):
 *   swap-earn deposit / withdraw → Kamino reserve deposit / withdraw → kVault deposit / withdraw →
 *   Meteora deposit / withdraw → Orca deposit / withdraw → Save deposit / withdraw → Exponent redeem
 */
import type { EarnPosition, SolanaActionInput, SolanaActionShape } from "../types";
import { isValidTokenAmount } from "../utils/numeric";
import { isSolanaAddress } from "../config/chains";
import { findMarketByProtocolAsset, findMarketByShareMint } from "../config/swap-earn-markets";
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
  findSaveMarketByReserve,
} from "../config/save-markets";
import { findExponentMarketByPtMint } from "../config/exponent-markets";
import { findMeteoraMarketByPool } from "../config/meteora-markets";
import { findOrcaMarketByPool } from "../config/orca-markets";

/** BFF の tx builder 1 本と、その body に入る識別子 */
export type SolanaRoute =
  | { kind: "swap_earn_deposit"; shareMint: string }
  | { kind: "swap_earn_withdraw"; shareMint: string }
  | { kind: "kamino_deposit"; reserve: string }
  | { kind: "kamino_withdraw"; reserve: string }
  | { kind: "kamino_vault_deposit"; vault: string }
  | { kind: "kamino_vault_withdraw"; vault: string }
  | { kind: "meteora_deposit"; poolKey: string }
  | { kind: "meteora_withdraw"; position: string }
  | { kind: "orca_deposit"; poolKey: string }
  | { kind: "orca_withdraw"; position: string }
  | { kind: "save_deposit"; reserve: string }
  | { kind: "save_withdraw"; ctokenMint: string }
  | { kind: "exponent_redeem"; ptMint: string };

/** Seeker と同じ文言 (ActionModal L669) */
export const UNSUPPORTED_MARKET_MESSAGE = "Unsupported market — no onchain route resolved for this pool";

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** Menu catalog の "jupiter" は registry の "jupiter_lend" (Seeker 8.15) */
export function normalizeSolanaProtocol(protocol: string): string {
  return protocol === "jupiter" ? "jupiter_lend" : protocol;
}

export function resolveSolanaRoute(action: SolanaActionShape | null | undefined): SolanaRoute | null {
  if (!action) return null;
  const isDeposit = action.action_type === "deposit";
  const isWithdraw = action.action_type === "withdraw";
  if (!isDeposit && !isWithdraw) return null;

  const protocolId = normalizeSolanaProtocol(action.protocol);
  const shareMint = str(action.metadata?.share_mint);
  const poolId = str(action.metadata?.pool_id);

  if (isDeposit) {
    const swap = action.asset ? findMarketByProtocolAsset(protocolId, action.asset) : undefined;
    if (swap) return { kind: "swap_earn_deposit", shareMint: swap.share_mint };
  } else if (shareMint) {
    const swap = findMarketByShareMint(shareMint);
    if (swap) return { kind: "swap_earn_withdraw", shareMint };
  }

  // Kamino: kVault は pool_id でのみ解決 (同一 asset の reserve pool と併存するため asset fallback しない)
  const kVaultDeposit = protocolId === "kamino" && poolId ? findKaminoVaultByPool(poolId) : undefined;
  if (isDeposit && protocolId === "kamino" && !kVaultDeposit) {
    const reserve = (poolId ? findKaminoMarketByPool(poolId) : undefined) ?? (action.asset ? findKaminoMarketByAsset(action.asset) : undefined);
    if (reserve) return { kind: "kamino_deposit", reserve: reserve.reserve };
  }
  if (isWithdraw && shareMint) {
    const reserve = findKaminoMarketByReserve(shareMint);
    if (reserve) return { kind: "kamino_withdraw", reserve: reserve.reserve };
  }
  if (isDeposit && kVaultDeposit) return { kind: "kamino_vault_deposit", vault: kVaultDeposit.vault };
  if (isWithdraw && shareMint) {
    const vault = findKaminoVaultByAddress(shareMint);
    if (vault) return { kind: "kamino_vault_withdraw", vault: vault.vault };
  }

  // Meteora DLMM / Orca Whirlpools: deposit は pool_id 必須 (asset fallback 無し)。
  // withdraw は share_mint = position の実 pubkey で、静的 registry では引けないので protocol で判定
  if (isDeposit && protocolId === "meteora" && poolId) {
    const m = findMeteoraMarketByPool(poolId);
    if (m) return { kind: "meteora_deposit", poolKey: m.pool_id };
  }
  if (isWithdraw && protocolId === "meteora" && shareMint) return { kind: "meteora_withdraw", position: shareMint };
  if (isDeposit && protocolId === "orca" && poolId) {
    const m = findOrcaMarketByPool(poolId);
    if (m) return { kind: "orca_deposit", poolKey: m.pool_id };
  }
  if (isWithdraw && protocolId === "orca" && shareMint) return { kind: "orca_withdraw", position: shareMint };

  // Save (旧 Solend): deposit は pool_id → reserve、fallback で asset。withdraw は cToken mint
  if (isDeposit && protocolId === "savefi") {
    const m = (poolId ? findSaveMarketByPool(poolId) : undefined) ?? (action.asset ? findSaveMarketByAsset(action.asset) : undefined);
    if (m) return { kind: "save_deposit", reserve: m.reserve };
  }
  if (isWithdraw && shareMint) {
    const m = findSaveMarketByCToken(shareMint);
    if (m) return { kind: "save_withdraw", ctokenMint: m.ctoken_mint };
  }

  // Exponent PT redeem (withdraw としてモデル化。満期前は BFF が 400 not_matured で fail-closed)
  if (isWithdraw && shareMint) {
    const m = findExponentMarketByPtMint(shareMint);
    if (m) return { kind: "exponent_redeem", ptMint: m.pt_mint };
  }
  return null;
}

/**
 * withdraw できる position か (Seeker MenuDrawer `canWithdrawPosition` の移設)。
 * Exponent PT は満期後のみ (満期前は BFF も 400 で拒否)
 */
export function canWithdrawEarnPosition(position: EarnPosition, now: Date = new Date()): boolean {
  if (position.protocol_id === "meteora" || position.protocol_id === "orca") return true;
  if (findExponentMarketByPtMint(position.share_mint)) {
    return position.maturity_at != null && new Date(position.maturity_at).getTime() <= now.getTime();
  }
  return resolveSolanaRoute(withdrawActionFromPosition(position)) !== null;
}

/** Menu の pool から deposit action (Seeker app/index.tsx handleStartActionFromServices と同形) */
export function depositAction(protocolId: string, asset: string, poolId: string | undefined, amount = ""): SolanaActionInput {
  return {
    action_type: "deposit",
    protocol: protocolId,
    asset,
    amount,
    ...(poolId ? { metadata: { pool_id: poolId } } : {}),
  };
}

/** Your Positions の行から全量 withdraw action (Seeker app/index.tsx handleWithdrawPosition と同形) */
export function withdrawActionFromPosition(position: EarnPosition): SolanaActionInput {
  return {
    action_type: "withdraw",
    protocol: position.protocol_id,
    asset: position.asset_symbol,
    // shares smallest unit (全量 withdraw 起点、UI で編集可)
    amount: position.shares,
    metadata: {
      share_mint: position.share_mint,
      share_decimals: position.share_decimals,
      underlying_decimals: position.underlying_decimals,
      // 部分 withdraw の ≈underlying 換算表示用 (display-only)
      underlying_amount: position.underlying_amount,
    },
  };
}

/** calendar event の action params (すべて string) に載る withdraw 用 metadata のキー */
export const WITHDRAW_PARAM_KEYS = [
  "protocol_id",
  "asset_symbol",
  "shares",
  "share_mint",
  "share_decimals",
  "underlying_decimals",
  "underlying_amount",
] as const;

function intParam(v: string | undefined): number | null {
  return v !== undefined && /^[0-9]{1,2}$/.test(v) ? Number(v) : null;
}

/**
 * calendar event action の params → 全量 withdraw action。
 * 検証は Seeker `syntheticPlanFromEventAction` と同じ (どれか欠ければ null = 実行させない)
 */
export function withdrawActionFromParams(params: Record<string, string>): SolanaActionInput | null {
  const protocol = str(params.protocol_id);
  const asset = str(params.asset_symbol);
  const shares = str(params.shares);
  const shareMint = str(params.share_mint);
  const shareDecimals = intParam(params.share_decimals);
  const underlyingDecimals = intParam(params.underlying_decimals);
  const underlyingAmount = str(params.underlying_amount);
  if (!protocol || !asset || !shares || !shareMint || shareDecimals === null || underlyingDecimals === null || !underlyingAmount) {
    return null;
  }
  if (!/^[0-9]+$/.test(shares) || !/^[0-9]+$/.test(underlyingAmount)) return null;
  return {
    action_type: "withdraw",
    protocol,
    asset,
    amount: shares,
    metadata: {
      share_mint: shareMint,
      share_decimals: shareDecimals,
      underlying_decimals: underlyingDecimals,
      underlying_amount: underlyingAmount,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// action metadata の境界検証 (2026-10-08、MCP simulate_action が metadata を運べるようにした時の入口)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Solana action の `metadata` に載ってよいキー。これ以外は境界 (BFF simulate / MCP zod) で拒否する。
 * - pool_id: deposit の market 特定 (resolveSolanaRoute / resolveOracleMint)
 * - share_mint: withdraw の market 特定 (swap-earn share mint / Kamino reserve / kVault address /
 *   Save cToken / Exponent PT mint / Meteora・Orca の position pubkey)
 * - share_decimals / underlying_decimals: 入力単位 (resolveAmountUnit)
 * - underlying_amount: 部分 withdraw の ≈underlying 表示用 (display-only)
 * withdrawActionFromPosition / withdrawActionFromParams が組む形と同じ集合。
 */
export const ACTION_METADATA_KEYS = [
  "pool_id",
  "share_mint",
  "share_decimals",
  "underlying_decimals",
  "underlying_amount",
] as const;

export type ActionMetadataKey = (typeof ACTION_METADATA_KEYS)[number];

/** Menu の pool_id (lib/config の registry と BFF の exponentPoolId が作る形はすべて英小文字・数字・_) */
export const POOL_ID_RE = /^[a-z0-9_]{1,64}$/;

/** decimals の上限 (SPL token は 0..18 で十分。Number の小整数で扱ってよい §4.5 適用外) */
const MAX_DECIMALS = 18;

function isDecimals(v: unknown): boolean {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= MAX_DECIMALS;
}

/**
 * action metadata を厳格に検証する (未知キーは拒否)。値は読むだけで書き換えない
 * (bundle_hash は action を丸ごと hash するので、境界で正規化すると承認と実行がずれる)。
 * undefined (metadata 無し) は ok。失敗時は最初に問題のあった field 名を返す。
 */
export function validateActionMetadata(
  m: unknown
): { ok: true } | { ok: false; field: string } {
  if (m === undefined) return { ok: true };
  if (m === null || typeof m !== "object" || Array.isArray(m)) {
    return { ok: false, field: "metadata" };
  }
  const allowed = new Set<string>(ACTION_METADATA_KEYS);
  for (const [key, value] of Object.entries(m as Record<string, unknown>)) {
    if (!allowed.has(key)) return { ok: false, field: key };
    switch (key as ActionMetadataKey) {
      case "pool_id":
        if (typeof value !== "string" || !POOL_ID_RE.test(value)) return { ok: false, field: key };
        break;
      case "share_mint":
        if (typeof value !== "string" || !isSolanaAddress(value)) return { ok: false, field: key };
        break;
      case "share_decimals":
      case "underlying_decimals":
        if (!isDecimals(value)) return { ok: false, field: key };
        break;
      case "underlying_amount":
        if (!isValidTokenAmount(value)) return { ok: false, field: key };
        break;
    }
  }
  return { ok: true };
}

/** route に預け入れる token (deposit 側) */
export interface RouteInputToken {
  mint: string;
  symbol: string;
  decimals: number;
}

/**
 * deposit route が受け取る token。withdraw route (入力は share 等で、asset 照合の対象外) は null。
 * BFF simulate の `asset_mismatch` 判定 (pool_id が指す market と action.asset の不一致) に使う。
 * resolveSolanaRoute は pool_id を信じて market を引くので、SOL pool に USDC 建ての amount を
 * 渡すと 1000 倍の桁ずれになる。それを simulate / 承認の前に止めるための材料。
 */
export function routeInputSymbol(route: SolanaRoute): RouteInputToken | null {
  switch (route.kind) {
    case "swap_earn_deposit": {
      const m = findMarketByShareMint(route.shareMint);
      return m ? { mint: m.underlying_mint, symbol: m.underlying_symbol, decimals: m.underlying_decimals } : null;
    }
    case "kamino_deposit": {
      const m = findKaminoMarketByReserve(route.reserve);
      return m ? { mint: m.underlying_mint, symbol: m.underlying_symbol, decimals: m.underlying_decimals } : null;
    }
    case "kamino_vault_deposit": {
      const v = findKaminoVaultByAddress(route.vault);
      return v ? { mint: v.underlying_mint, symbol: v.underlying_symbol, decimals: v.underlying_decimals } : null;
    }
    case "meteora_deposit": {
      const m = findMeteoraMarketByPool(route.poolKey);
      return m ? { mint: m.deposit_mint, symbol: m.deposit_symbol, decimals: m.deposit_decimals } : null;
    }
    case "orca_deposit": {
      const m = findOrcaMarketByPool(route.poolKey);
      return m ? { mint: m.deposit_mint, symbol: m.deposit_symbol, decimals: m.deposit_decimals } : null;
    }
    case "save_deposit": {
      const m = findSaveMarketByReserve(route.reserve);
      return m ? { mint: m.underlying_mint, symbol: m.underlying_symbol, decimals: m.underlying_decimals } : null;
    }
    default:
      return null;
  }
}

/** 表記揺れの吸収: 大文字小文字 (JitoSOL / jitoSOL) と wrapped SOL (WSOL = SOL) */
function normalizeAssetSymbol(symbol: string): string {
  const upper = symbol.trim().toUpperCase();
  return upper === "WSOL" ? "SOL" : upper;
}

/** action.asset と deposit route の入力 token が同じ asset か (asset 無しは不一致扱い) */
export function assetMatchesRouteInput(asset: string | undefined, input: RouteInputToken): boolean {
  if (!asset) return false;
  return normalizeAssetSymbol(asset) === normalizeAssetSymbol(input.symbol);
}
