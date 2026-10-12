/**
 * 保有の 1 行表示 ("You hold 1.2345 stETH · 0.5 wstETH (≈ $1,234.56)")。
 * 複数 address の保有は symbol ごとに bigint で合算する (CLAUDE.md §3: Number で足さない)。
 * USD は全 address 分が揃っている時だけ出す (一部欠けた合計は誤解を招くので出さない)。
 */
import { fromBigInt, toBigInt, toHumanReadable, toSmallestUnit } from "@workspace/lib/utils/numeric";
import type { EarnPosition, MenuHolding, TokenAmountView } from "@workspace/lib/types";
import { fmtAmount, fmtFullDate, fmtTime, fmtUsd } from "../ui/format";

const USD_DECIMALS = 8;

function sumAmounts(list: TokenAmountView[]): TokenAmountView[] {
  const by = new Map<string, TokenAmountView>();
  for (const a of list) {
    const prev = by.get(a.symbol);
    by.set(a.symbol, prev ? { ...a, value: fromBigInt(toBigInt(prev.value) + toBigInt(a.value)) } : a);
  }
  return [...by.values()];
}

/** 8 decimals USD string の合計。1 つでも欠けていれば null */
export function sumUsd(values: Array<string | undefined>): string | null {
  if (values.length === 0 || values.some((v) => v === undefined)) return null;
  try {
    const total = values.reduce((acc, v) => acc + toBigInt(toSmallestUnit(v!, USD_DECIMALS)), 0n);
    return toHumanReadable(fromBigInt(total), USD_DECIMALS);
  } catch {
    return null; // 形式外 (桁あふれ等) は合計しない
  }
}

export function ethHoldingText(holdings: MenuHolding[]): { text: string; note?: string } {
  const amounts = sumAmounts(holdings.flatMap((h) => h.amounts));
  const usd = sumUsd(holdings.map((h) => h.usd));
  const note =
    holdings
      .flatMap((h) => (h.pending ? [`${fmtAmount(h.pending.amount, 2)} ${h.pending.label.toLowerCase()} until ${fmtFullDate(new Date(h.pending.endsAt))}, ${fmtTime(new Date(h.pending.endsAt))}`] : []))
      .join(" · ") || undefined;
  const parts = amounts.map((a) => fmtAmount(a, 4));
  return { text: parts.length ? `You hold ${parts.join(" · ")}${usd ? ` (≈ ${fmtUsd(usd)})` : ""}` : "Nothing liquid held", ...(note ? { note } : {}) };
}

export function solHoldingText(positions: EarnPosition[]): { text: string } {
  const amounts = sumAmounts(positions.map((p) => ({ value: p.underlying_amount, decimals: p.underlying_decimals, symbol: p.asset_symbol })));
  // EarnPosition の USD は不明時 "0" (§ earn-position.ts)。0 が混ざる時は合計を出さない
  const usd = sumUsd(positions.map((p) => (/^0(\.0+)?$/.test(p.underlying_usd) ? undefined : p.underlying_usd)));
  return { text: `You hold ${amounts.map((a) => fmtAmount(a, 4)).join(" · ")}${usd ? ` (≈ ${fmtUsd(usd)})` : ""}` };
}
