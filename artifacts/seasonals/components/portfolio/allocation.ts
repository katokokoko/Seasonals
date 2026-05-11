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

/** SOL/USD 換算 (PortfolioSummary 内 SOL_TO_USD と一致、Phase 8.5 で oracle に差替) */
export const SOL_USD_PRICE = 168.5;

/**
 * 主要 mainnet asset の USD 価格 (Phase 8.5 で oracle 連携予定)。
 * 未登録 asset は price 0 → total / donut に出ない (フィルタされる)。
 */
const ASSET_USD_PRICE: Record<string, number> = {
  USDC: 1,
  USDT: 1,
  USDS: 1,
  USDG: 1,
  EURC: 1.08,
  JupUSD: 1,
  SOL: SOL_USD_PRICE,
  mSOL: SOL_USD_PRICE,
  JitoSOL: SOL_USD_PRICE,
  bSOL: SOL_USD_PRICE,
};

function decimalsOf(asset: string): number {
  if (asset in TOKEN_DECIMALS) {
    return (TOKEN_DECIMALS as Record<string, number>)[asset]!;
  }
  return 6;
}

/** 1 position の現在 USD 評価額 (smallest unit → human × asset price) */
export function positionUsdValue(p: Position): number {
  const decimals = decimalsOf(p.asset_symbol);
  const human = Number(toHumanReadable(p.current_amount, decimals));
  const usdPrice = ASSET_USD_PRICE[p.asset_symbol] ?? 0;
  if (!Number.isFinite(human) || !Number.isFinite(usdPrice)) return 0;
  return human * usdPrice;
}

/** 1 position の現在 SOL 評価額 (USD 経由) */
export function positionSolValue(p: Position): number {
  return positionUsdValue(p) / SOL_USD_PRICE;
}

/** ポートフォリオ全体の USD 評価額 (全 positions の単純合計) */
export function totalUsdValue(positions: Position[]): number {
  return positions.reduce((sum, p) => sum + positionUsdValue(p), 0);
}

/** ポートフォリオ全体の SOL 評価額 (USD 経由) */
export function totalSolValue(positions: Position[]): number {
  return totalUsdValue(positions) / SOL_USD_PRICE;
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
  currency: CurrencyUnit = "SOL"
): AllocationSegment[] {
  const protocolById = new Map(protocols.map((p) => [p.protocol_id, p]));
  const sumByCategory = new Map<PositionCategory, number>();

  for (const pos of positions) {
    const protocol = protocolById.get(pos.protocol_id);
    if (!protocol) continue;
    const value =
      currency === "USDC" ? positionUsdValue(pos) : positionSolValue(pos);
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
