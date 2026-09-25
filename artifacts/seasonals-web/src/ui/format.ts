/**
 * 表示用 format。金融値は lib/utils/numeric.ts 経由 (CLAUDE.md §3)。
 * ここで Number にするのは表示直前の比率 (APY) と日時のみ。
 */
import { formatPercentage, formatTokenAmount, formatUsd } from "@workspace/lib/utils/numeric";
import type { TimelineMetric, TokenAmountView } from "@workspace/lib/types";

const MONTH = new Intl.DateTimeFormat("en-US", { month: "short" });
const TIME = new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
const FULL = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" });

export function fmtMonthDay(d: Date): string {
  return `${MONTH.format(d).toUpperCase()} ${d.getDate()}`;
}
export function fmtTime(d: Date): string {
  return TIME.format(d);
}
export function fmtFullDate(d: Date): string {
  return FULL.format(d);
}
export function fmtMonthYear(d: Date): string {
  return new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric" }).format(d);
}
/** yyyy-MM-dd (local) → Date (local midnight) */
export function parseDayKey(key: string): Date {
  const [y, m, d] = key.split("-").map((x) => Number.parseInt(x, 10));
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1);
}

export function fmtAmount(a: TokenAmountView, maxFractionDigits = 4): string {
  return `${formatTokenAmount(a.value, a.decimals, { maxFractionDigits })} ${a.symbol}`;
}

export function fmtUsd(usd8: string): string {
  return formatUsd(usd8);
}

export function fmtRatio(r: number): string {
  return formatPercentage(r);
}

export function fmtMetric(m: TimelineMetric): string {
  switch (m.kind) {
    case "ratio":
      return fmtRatio(m.value);
    case "usd":
      return fmtUsd(m.value);
    case "token":
      return fmtAmount(m.value);
    case "text":
      return m.value;
  }
}

/** 既存 BFF の ProtocolPool.tvl_usd (number, 表示専用) を compact 表記にする */
export function fmtCompactUsd(n: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1 }).format(n);
}

export function shortAddress(a: string): string {
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}
