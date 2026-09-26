import type { TimelineEvent, TimelineLink } from "@workspace/lib/types";

export const etherscanAddress = (a: string): TimelineLink => ({ label: "View on Etherscan", url: `https://etherscan.io/address/${a}` });
export const etherscanTx = (h: string): TimelineLink => ({ label: "View transaction", url: `https://etherscan.io/tx/${h}` });

/** API の USD number (表示専用、protocol 提供の indicative 値) → 8 decimals string。負値・非有限は undefined */
export function usdNumberTo8(n: unknown): string | undefined {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return undefined;
  return n.toFixed(8);
}

export function baseEvent(
  partial: Pick<TimelineEvent, "id" | "kind" | "protocol" | "protocolName" | "title" | "at" | "source" | "observedAt"> &
    Partial<TimelineEvent>
): TimelineEvent {
  return {
    chain: "ethereum",
    class: "protocol",
    atApprox: false,
    settled: false,
    metrics: [],
    actions: [],
    requiresWallet: true,
    links: [],
    ...partial,
  };
}
