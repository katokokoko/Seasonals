/**
 * Allocation aggregation — positions × protocols → value per PositionCategory
 *
 * Phase 8.4.1: position の `unit_price_*` フィールドは BFF mapping (Helius / Jupiter Lend)
 * で空や 0 で来ることが多いため信頼せず、asset_symbol → 固定 USD price table から
 * 価値を計算する。Phase 8.5 で Pyth oracle 連携時に動的化予定。
 *
 * 数値表現規約 (CLAUDE.md §3 carve-out): chart / donut の表示用 Number 演算は
 * §3 末尾「適用外」相当 — execute / settle 経路には届かない display only。
 */

import {
  PositionCategory,
  type Position,
  type Protocol,
} from "@workspace/lib/types";
import { TOKEN_DECIMALS, toHumanReadable } from "@workspace/lib/utils/numeric";
import { COLOR } from "@workspace/lib/design-system";

export type CurrencyUnit = "USDC" | "SOL";

export interface AllocationSegment {
  category: PositionCategory;
  /** Display label (legend / tooltip 用) */
  label: string;
  /** 選択 currency 単位での value (USDC 1:1 USD、SOL: USD/168.5) */
  value: number;
  /** Donut の color token */
  color: string;
}

/** prototype の凡例順序。Vesting / Governance / Other は表示対象外。 */
export const ALLOCATION_DISPLAY_ORDER: readonly PositionCategory[] = [
  PositionCategory.Lending,
  PositionCategory.Staking,
  PositionCategory.Restaking,
  PositionCategory.Vault,
  PositionCategory.LP,
  PositionCategory.PTYT,
  PositionCategory.Stable,
  // Phase 8.7: native SOL の wallet 保有を Other segment として表示
  PositionCategory.Other,
] as const;

const LABEL_BY_CATEGORY: Record<PositionCategory, string> = {
  lending: "Lending",
  staking: "Staking",
  restaking: "Restaking",
  vault: "Vault",
  lp: "Liquidity Pool",
  pt_yt: "PT-YT",
  stable: "Yield-Bearing Stablecoins",
  vesting: "Vesting",
  governance: "Governance",
  other: "Other",
};

/** prototype の凡例 swatch 色 (8 segment ホイール) */
const COLOR_BY_CATEGORY: Record<PositionCategory, string> = {
  lending: COLOR.sodaText, // #00ACC1 cyan
  staking: COLOR.melonText, // #2E9968 dark green
  restaking: COLOR.melonDeep, // #56C596 mid green
  vault: COLOR.caramel, // #C4956A tan
  lp: COLOR.straw, // #FFD54F yellow
  pt_yt: COLOR.cherry, // #E57373 coral
  stable: COLOR.sodaDeep, // #80DEEA light cyan
  vesting: COLOR.textMuted,
  governance: COLOR.textMuted,
  other: COLOR.textMuted,
};

/**
 * symbol → USD 価格 (実価格)。source は 2 つ:
 *   1. position の `unit_price_usd` (Helius DAS。SPL token は基本ここで埋まる)
 *   2. BFF `/prices` (oracle)。**native SOL は DAS に price_info が無く 0** で
 *      来るため、そこを埋めるのがこちら
 * Phase 8.57 以前は下の固定表だけを見ていて、SOL を $168.5 (実勢の 2 倍超) で
 * 評価していた。
 */
export type PriceMap = Record<string, number>;

/**
 * 最終 fallback の固定価格。**stale な可能性がある** ので、live 価格
 * (DAS / oracle) が取れた asset には使わない。stablecoin だけに留める
 * (SOL 系は実勢との乖離が大きく、固定値で出すと誤情報になる)。
 */
const FALLBACK_USD_PRICE: Record<string, number> = {
  USDC: 1,
  USDT: 1,
  USDS: 1,
  USDG: 1,
  JupUSD: 1,
};

/** 表示用の SOL/USD レート。live 価格が無ければ null (レートを騙らない) */
export function solUsdPrice(prices: PriceMap): number | null {
  const sol = prices.SOL;
  return typeof sol === "number" && sol > 0 ? sol : null;
}

function decimalsOf(asset: string): number {
  if (asset in TOKEN_DECIMALS) {
    return (TOKEN_DECIMALS as Record<string, number>)[asset]!;
  }
  return 6;
}

/**
 * asset 1 単位の USD 価格を解決する (優先順: position の実価格 → oracle → 固定)。
 * どこからも取れなければ null = **評価額不明** (0 として合算しない)。
 */
export function unitUsdPrice(p: Position, prices: PriceMap): number | null {
  // 1. Helius DAS 由来の実価格 (SPL token はここで埋まる。native SOL は 0)
  const fromPosition = Number(p.unit_price_usd);
  if (Number.isFinite(fromPosition) && fromPosition > 0) return fromPosition;
  // 2. oracle (BFF /prices)。native SOL はここで埋まる
  const symbol = p.asset_symbol === "WSOL" ? "SOL" : p.asset_symbol;
  const fromOracle = prices[symbol];
  if (typeof fromOracle === "number" && fromOracle > 0) return fromOracle;
  // 3. stablecoin の固定 fallback のみ
  return FALLBACK_USD_PRICE[symbol] ?? null;
}

/** 1 position の現在 USD 評価額。価格不明は 0 (合算に影響させない) */
export function positionUsdValue(p: Position, prices: PriceMap = {}): number {
  const decimals = decimalsOf(p.asset_symbol);
  const human = Number(toHumanReadable(p.current_amount, decimals));
  const usdPrice = unitUsdPrice(p, prices);
  if (!Number.isFinite(human) || usdPrice === null) return 0;
  return human * usdPrice;
}

/** 1 position の現在 SOL 評価額 (USD 経由)。SOL 価格不明なら 0 */
export function positionSolValue(p: Position, prices: PriceMap = {}): number {
  const solUsd = solUsdPrice(prices);
  if (solUsd === null) return 0;
  return positionUsdValue(p, prices) / solUsd;
}

/** ポートフォリオ全体の USD 評価額 (全 positions の単純合計) */
export function totalUsdValue(
  positions: Position[],
  prices: PriceMap = {}
): number {
  return positions.reduce((sum, p) => sum + positionUsdValue(p, prices), 0);
}

/** ポートフォリオ全体の SOL 評価額 (USD 経由)。SOL 価格不明なら 0 */
export function totalSolValue(
  positions: Position[],
  prices: PriceMap = {}
): number {
  const solUsd = solUsdPrice(prices);
  if (solUsd === null) return 0;
  return totalUsdValue(positions, prices) / solUsd;
}

/**
 * positions を category 単位で集計し、prototype の凡例順序で返す。
 * Vesting / Governance / Other は除外 (空 segment になりがちで donut が崩れる)。
 *
 * @param currency 集計 unit。USDC = USD 値、SOL = SOL 値。Donut の見た目比率は
 *                 currency にかかわらず同じだが、絶対値は単位に追従する。
 */
export function aggregateAllocation(
  positions: Position[],
  protocols: Protocol[],
  currency: CurrencyUnit = "SOL",
  prices: PriceMap = {}
): AllocationSegment[] {
  const protocolById = new Map(protocols.map((p) => [p.protocol_id, p]));
  const sumByCategory = new Map<PositionCategory, number>();

  for (const pos of positions) {
    const protocol = protocolById.get(pos.protocol_id);
    if (!protocol) continue;
    const value =
      currency === "USDC"
        ? positionUsdValue(pos, prices)
        : positionSolValue(pos, prices);
    sumByCategory.set(
      protocol.category,
      (sumByCategory.get(protocol.category) ?? 0) + value
    );
  }

  return ALLOCATION_DISPLAY_ORDER.map((category) => ({
    category,
    label: LABEL_BY_CATEGORY[category],
    value: sumByCategory.get(category) ?? 0,
    color: COLOR_BY_CATEGORY[category],
  })).filter((seg) => seg.value > 0);
}

/** segment 合計 (currency unit) */
export function totalAllocationValue(segments: AllocationSegment[]): number {
  return segments.reduce((acc, s) => acc + s.value, 0);
}
