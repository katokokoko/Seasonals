/**
 * Allocation aggregation — positions × protocols → SOL value per PositionCategory
 *
 * 数値表現規約 (CLAUDE.md §3): smallest unit を toHumanReadable で human 化してから
 * Number 演算。chart 描画値 (display only) のため §3 末尾「適用外」相当 — execute /
 * settle 経路には届かない。
 */

import {
  PositionCategory,
  type Position,
  type Protocol,
} from "@workspace/lib/types";
import { TOKEN_DECIMALS, toHumanReadable } from "@workspace/lib/utils/numeric";
import { COLOR } from "@workspace/lib/design-system";

export interface AllocationSegment {
  category: PositionCategory;
  /** Display label (legend / tooltip 用) */
  label: string;
  /** SOL value (display only — Number で十分、§3 carve-out) */
  sol: number;
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

function decimalsOf(asset: string): number {
  if (asset in TOKEN_DECIMALS) {
    return (TOKEN_DECIMALS as Record<string, number>)[asset]!;
  }
  return 6;
}

function positionSolValue(p: Position): number {
  const decimals = decimalsOf(p.asset_symbol);
  const amount = Number(toHumanReadable(p.current_amount, decimals));
  const price = Number(p.unit_price_sol);
  return amount * price;
}

/**
 * positions を category 単位で SOL 額集計し、prototype の凡例順序で返す。
 * Vesting / Governance / Other は除外 (空 segment になりがちで donut が崩れる)。
 */
export function aggregateAllocation(
  positions: Position[],
  protocols: Protocol[]
): AllocationSegment[] {
  const protocolById = new Map(protocols.map((p) => [p.protocol_id, p]));
  const sumByCategory = new Map<PositionCategory, number>();

  for (const pos of positions) {
    const protocol = protocolById.get(pos.protocol_id);
    if (!protocol) continue;
    const sol = positionSolValue(pos);
    sumByCategory.set(
      protocol.category,
      (sumByCategory.get(protocol.category) ?? 0) + sol
    );
  }

  return ALLOCATION_DISPLAY_ORDER.map((category) => ({
    category,
    label: LABEL_BY_CATEGORY[category],
    sol: sumByCategory.get(category) ?? 0,
    color: COLOR_BY_CATEGORY[category],
  })).filter((seg) => seg.sol > 0);
}

/** segment 合計 SOL */
export function totalAllocationSol(segments: AllocationSegment[]): number {
  return segments.reduce((acc, s) => acc + s.sol, 0);
}
