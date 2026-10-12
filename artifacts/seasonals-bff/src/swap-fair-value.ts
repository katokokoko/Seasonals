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

import type { OracleResult } from "@workspace/lib/types";
import type {
  SwapEarnDepositInput,
  SwapEarnMarket,
} from "@workspace/lib/config/swap-earn-markets";

import { fetchEarnMarkets } from "./clients/jupiter-lend";
import { fetchLstSolValues } from "./clients/lst-rates";
import { evaluateCrossAssetFairValue } from "./funding-fair-value";
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

export interface FundingFairValueTarget {
  market: SwapEarnMarket;
  /** 支払う funding token (`swapEarnDepositInput` の結果、isFunding = true) */
  input: SwapEarnDepositInput;
  /** §4.6 gate で引いた結果 (再取得しない)。undefined = 取れていない → fail-closed */
  fundingOracle: OracleResult | undefined;
  underlyingOracle: OracleResult | undefined;
}

/**
 * 2026-10-13: funding token deposit (USDC → jlJupUSD) の cross-asset 償還価値ガード (I/O 部分)。
 * 判定は funding-fair-value.ts の純関数。ここは C (Jupiter Lend の convertToAssets) の取得と log だけ。
 * 参照を持てるのは Jupiter Lend market だけ — それ以外の funding market、markets の取得失敗、
 * share mint が catalog に無い時はすべて fair_value_unavailable (fail-closed、warn log)。
 */
export async function evaluateFundingFairValue(
  log: Pick<FastifyBaseLogger, "warn">,
  quote: { inAmount: string; outAmount: string },
  target: FundingFairValueTarget
): Promise<FairValueVerdict> {
  const { market, input } = target;
  const ctx = { share: market.share_symbol, funding: input.symbol };
  const unavailable = (why: string, err?: unknown): FairValueVerdict => {
    log.warn(
      { ...ctx, why, ...(err ? { err: (err as Error).message } : {}) },
      "funding fair value unavailable - guard fails closed"
    );
    return { status: "blocked", reason: "fair_value_unavailable" };
  };
  const guardBps = fairValueGuardBps();
  // env で無効化されていれば参照を取りに行かない (LST ガードと同じ扱い)
  if (guardBps <= 0) return { status: "no_reference" };
  if (market.protocol_id !== "jupiter_lend") return unavailable("no_exchange_rate_source");

  let convertToAssets: string | undefined;
  try {
    const markets = await fetchEarnMarkets();
    convertToAssets = markets.find((m) => m.jlMint === market.share_mint)?.convertToAssets;
  } catch (err) {
    return unavailable("jupiter_lend_markets_failed", err);
  }
  if (!convertToAssets) return unavailable("convert_to_assets_missing");

  const verdict = evaluateCrossAssetFairValue({
    inAmount: quote.inAmount,
    outAmount: quote.outAmount,
    fundingDecimals: input.decimals,
    underlyingDecimals: market.underlying_decimals,
    shareDecimals: market.share_decimals,
    fundingPriceUsd8: target.fundingOracle?.price_usd,
    underlyingPriceUsd8: target.underlyingOracle?.price_usd,
    convertToAssets,
    guardBps,
  });
  if (verdict.status === "blocked") {
    log.warn(
      { ...ctx, reason: verdict.reason, deviation_bps: verdict.deviation_bps },
      "funded swap blocked by cross-asset fair value guard"
    );
  }
  return verdict;
}
