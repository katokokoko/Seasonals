/**
 * deposited-breakdown — Wallet holdings 行タップで出す預入内訳 (Phase 8.76)
 *
 * 8.55 の展開は「同じ量の通貨換算」(≈ 50.15 USDC · 0.2975 SOL) を出していたが、
 * ユーザーが知りたいのは **その通貨で何をどこに預けているか** だった。
 * USDC 行 → jlUSDC / sHYUSD / USD* …、SOL 行 → jitoSOL / mSOL / INF … を
 * 「share symbol + underlying 換算量」で並べる。
 *
 * データ源: merge 済み Position[] (earn 行は asset_symbol = underlying、
 * current_amount = underlying 換算量、raw_state.share_mint = 種別ごとのキー)。
 * share symbol は Position に無いので、share_mint を lib/config の registry 群で
 * 逆引きする (MenuDrawer の heldSwapEarnPositions と同じ手法)。
 *
 * §4.5: 量は toHumanReadable の文字列操作のまま。USD は表示専用 Number
 * (allocation.ts と同じ carve-out)。
 */
import type { Position } from "@workspace/lib/types";
import { toHumanReadable } from "@workspace/lib/utils/numeric";
import { findMarketByShareMint } from "@workspace/lib/config/swap-earn-markets";
import { findSaveMarketByCToken } from "@workspace/lib/config/save-markets";
import { findExponentMarketByPtMint } from "@workspace/lib/config/exponent-markets";
import {
  findKaminoMarketByReserve,
  findKaminoVaultByAddress,
} from "@workspace/lib/config/kamino-markets";

import { positionUsdValue, type PriceMap } from "./allocation";
import { decimalsOf, trimDecimals } from "./holding-view";

export type HoldingFamily = "stable" | "sol";

/**
 * USD ペッグの underlying 集合。**EURC は EUR 建てなので入れない** —
 * 「usdc 換算でいくら」という表示に EUR 建てを混ぜると値が嘘になる。
 * EURC の wallet holding 行が生まれたら独自 family を検討する。
 */
const STABLE_UNDERLYINGS = new Set(["USDC", "USDT", "USDS", "USDG", "JupUSD"]);

/** タップされた wallet holdings 行の symbol → family。対象外は null (展開なし) */
export function familyOfHolding(symbol: string): HoldingFamily | null {
  if (symbol === "SOL" || symbol === "WSOL") return "sol";
  if (STABLE_UNDERLYINGS.has(symbol)) return "stable";
  return null;
}

export interface DepositedBreakdownRow {
  /** position_id (list key 用) */
  key: string;
  /** "jlUSDC" / "jitoSOL" / "cUSDC" / "PT-xSOL" … 引けなければ protocol 名 */
  shareSymbol: string;
  /** "≈ 12.34 USDC" / "≈ 0.5000 SOL" (underlying 換算量) */
  amountLine: string;
  /** USD 換算 (display only、sol family の併記と sort に使う) */
  usd: number;
}

/** share_mint → 人が読む share symbol。registry を種別順に逆引き */
function shareSymbolOf(p: Position): string {
  const mint = p.raw_state?.["share_mint"];
  if (typeof mint === "string" && mint.length > 0) {
    const swapEarn = findMarketByShareMint(mint);
    if (swapEarn) return swapEarn.share_symbol;
    const save = findSaveMarketByCToken(mint);
    if (save) return save.ctoken_symbol;
    const exponent = findExponentMarketByPtMint(mint);
    if (exponent) return `PT-${exponent.underlying_symbol}`;
    // kamino は lending reserve / kvault とも address を share_mint に流用している
    const kaminoReserve = findKaminoMarketByReserve(mint);
    if (kaminoReserve) return `k${kaminoReserve.underlying_symbol}`;
    const kaminoVault = findKaminoVaultByAddress(mint);
    if (kaminoVault) return `k${kaminoVault.underlying_symbol}`;
  }
  // meteora / orca (position pubkey) 等は registry が無い → protocol 名で示す
  return p.protocol_id.charAt(0).toUpperCase() + p.protocol_id.slice(1);
}

function underlyingOf(p: Position): string {
  return p.asset_symbol === "WSOL" ? "SOL" : p.asset_symbol;
}

/**
 * family に属する預入 position を USD 降順で返す。
 * 預入 = `protocol_id` が `wallet_` 始まりでないもの (mergeEarnPositions 後の
 * earn 行 + 将来の protocol 行)。
 */
export function depositedBreakdown(
  family: HoldingFamily,
  positions: Position[],
  prices: PriceMap = {}
): DepositedBreakdownRow[] {
  const rows: DepositedBreakdownRow[] = [];
  for (const p of positions) {
    if (p.protocol_id.startsWith("wallet_")) continue;
    const underlying = underlyingOf(p);
    if (familyOfHolding(underlying) !== family) continue;
    const decimals = decimalsOf(underlying);
    const places = family === "stable" ? 2 : 4;
    const amount = trimDecimals(
      toHumanReadable(p.current_amount, decimals),
      places
    );
    rows.push({
      key: p.position_id,
      shareSymbol: shareSymbolOf(p),
      amountLine: `≈ ${amount} ${underlying}`,
      usd: positionUsdValue(
        underlying === p.asset_symbol
          ? p
          : ({ ...p, asset_symbol: underlying } as Position),
        prices
      ),
    });
  }
  rows.sort((a, b) => b.usd - a.usd);
  return rows;
}

/** 預入ゼロ時の 1 行 */
export function emptyBreakdownLine(_family: HoldingFamily): string {
  return "Nothing deposited from this asset yet";
}
