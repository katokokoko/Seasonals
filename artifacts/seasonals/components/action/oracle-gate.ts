/**
 * oracle-gate — Phase 8.14 §4.6 の純粋ヘルパー (ActionModal から分離、test 容易化)。
 * RN/React に依存しないので jest で軽量に検証できる。
 */
import type { AgentPlan, OracleBlockReason } from "@workspace/lib/types";

/** Jupiter Lend Earn 7 markets の underlying symbol → mint */
export const JUPITER_UNDERLYING_MINTS: Record<string, string> = {
  USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  SOL: "So11111111111111111111111111111111111111112",
  USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  EURC: "HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr",
  USDS: "USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA",
  USDG: "2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH",
  JupUSD: "JuprjznTrTSp2UFa3ZBUFgwdAmtZCq4MQCwysN55USD",
};

/** oracle gate を引く underlying mint (Jupiter Lend action のみ、他は null) */
export function resolveOracleMint(
  action: AgentPlan["selected_action"] | undefined
): string | null {
  if (!action) return null;
  const isJL =
    action.protocol === "jupiter_lend" || action.protocol === "jupiter";
  if (!isJL || !action.asset) return null;
  return JUPITER_UNDERLYING_MINTS[action.asset] ?? null;
}

/** block reason (§4.6) の表示ラベル */
export function oracleBlockLabel(
  reason: OracleBlockReason | null | undefined
): string {
  switch (reason) {
    case "oracle_both_stale":
      return "Pyth / Switchboard どちらも stale (>60s)";
    case "oracle_divergence_too_large":
      return "Pyth ↔ Switchboard の価格乖離が >5%";
    case "oracle_unavailable":
      return "価格 oracle を取得できません";
    default:
      return "oracle check failed";
  }
}
