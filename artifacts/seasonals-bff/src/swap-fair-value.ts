/**
 * swap-fair-value — swap quote に償還価値ガードを掛ける I/O 部分 (Phase 8.72、2026-10-08 に server.ts から移設)
 *
 * 判定は fair-value.ts の純関数。ここは参照レート (protocol 自身の LST NAV) の取得と log だけを持つ。
 * execute の `buildSwapEarnTx` (block なら 409) と simulate の見積り (agent-plan-estimate.ts、
 * block は warning に落とすだけ) が同じ判定を使う。
 *
 * 参照レートの取得に失敗しても **通さない** — 参照を持つはずの LST で値が無ければ
 * `evaluateFairValue` が fail-closed 側に倒す (空 Map を渡す)。
 */
import type { FastifyBaseLogger } from "fastify";

import { fetchLstSolValues } from "./clients/lst-rates";
import {
  evaluateFairValue,
  FAIR_VALUE_LST_SYMBOLS,
  fairValueGuardBps,
  type FairValueVerdict,
} from "./fair-value";

export interface SwapFairValueTarget {
  direction: "deposit" | "withdraw";
  shareSymbol: string;
}

export async function evaluateSwapFairValue(
  log: Pick<FastifyBaseLogger, "warn">,
  quote: { inAmount: string; outAmount: string },
  fairValue: SwapFairValueTarget | undefined
): Promise<FairValueVerdict> {
  if (!fairValue || !FAIR_VALUE_LST_SYMBOLS.has(fairValue.shareSymbol)) {
    return { status: "no_reference" };
  }
  // 8.73: 参照は protocol 自身の値 (stake pool / Marinade / Sanctum Infinity の
  // pool state)。以前使っていた Sanctum の集計値は 1.3-2.1% 低く、幻の乖離を
  // 生んでいた
  const rates = await fetchLstSolValues().catch((err) => {
    log.warn(
      { err: (err as Error).message },
      "lst rate fetch failed - fair value guard fails closed"
    );
    return new Map<string, bigint>();
  });
  const verdict = evaluateFairValue({
    direction: fairValue.direction,
    inAmount: quote.inAmount,
    outAmount: quote.outAmount,
    lamportsPerLst: rates.get(fairValue.shareSymbol),
    hasReference: true,
    guardBps: fairValueGuardBps(),
  });
  if (verdict.status === "blocked") {
    log.warn(
      { ...fairValue, reason: verdict.reason, deviation_bps: verdict.deviation_bps },
      "swap blocked by fair value guard"
    );
  }
  return verdict;
}
