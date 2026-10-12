/**
 * funding-fair-value — funding token で支払う swap-earn deposit の cross-asset 償還価値ガード (2026-10-13)
 *
 * 例: USDC を払って jlJupUSD (Jupiter Lend JupUSD market の share) を受け取る。Jupiter は
 * USDC → jlJupUSD を 1 本の swap で route するが、quote の実効レートが妥当かは誰も見ていない。
 * LST の 8.72 ガード (fair-value.ts) と同じく、**ユーザー不利方向の乖離だけ**を署名前に止める。
 *
 * 参照値 (fair な受取 share 量) は 3 つの一次情報から組む:
 *   - P_f / P_u: funding / underlying の oracle 価格 (§4.6 gate で引いた OracleResult.price_usd、
 *     8 decimals string)。呼び手は gate の結果をそのまま渡す (再取得しない)
 *   - C: 1 whole share あたりの underlying smallest unit (Jupiter Lend earn/tokens の `convertToAssets`、
 *     protocol 自身が出す償還価値。jupiter-lend.ts `JupiterLendMarket.convertToAssets`)。
 *     API が直接返すので totalAssets / totalSupply からは導出しない
 *     (仮に導出するなら C = totalAssets × 10^d_s / totalSupply — totalSupply は API に無い)
 *
 *   fairOut (share smallest) = inAmount × P_f8 × 10^(d_u + d_s) / (P_u8 × C × 10^d_f)
 *     (= in を USD に → underlying に → share に。P_*8 は scale-8 の bigint で 10^8 は約分される)
 *   deviation_bps = (fairOut − outAmount) × 10000 / fairOut  (正 = ユーザー不利)
 *
 * 判定材料が欠けたら **止める** (fail-closed): どちらかの価格が null (blocked / not_configured を含む)、
 * C が無い / 0、金額が不正。参照を持つはずの funded deposit で値が無いのは「参照が取れない」側
 * (fair-value.ts の区別と同じ)。
 *
 * §4.5: 判定はすべて bigint (`toBigInt` / `usd8ToBigInt`)。Number は bps (表示用の小整数) だけ。
 */
import {
  isValidTokenAmount,
  toBigInt,
  toHumanReadable,
  usd8ToBigInt,
} from "@workspace/lib/utils/numeric";

import { bpsToPercent, type FairValueVerdict } from "./fair-value";

const BPS = 10_000n;

export interface CrossAssetFairValueInput {
  /** 支払う funding token の量 (smallest unit string、decimals = fundingDecimals) */
  inAmount: string;
  /** quote の受取 share 量 (smallest unit string、decimals = shareDecimals) */
  outAmount: string;
  fundingDecimals: number;
  underlyingDecimals: number;
  shareDecimals: number;
  /** funding の oracle 価格 (USD 8-dec string)。null / undefined = 取れていない */
  fundingPriceUsd8: string | null | undefined;
  /** underlying の oracle 価格 (USD 8-dec string)。null / undefined = 取れていない */
  underlyingPriceUsd8: string | null | undefined;
  /** 1 whole share = underlying 何 smallest unit か (integer string)。undefined = 取れていない */
  convertToAssets: string | null | undefined;
  /** 許容乖離 (bps)。0 で無効 */
  guardBps: number;
}

const UNAVAILABLE: FairValueVerdict = { status: "blocked", reason: "fair_value_unavailable" };

function priceOrNull(v: string | null | undefined): bigint | null {
  if (typeof v !== "string") return null;
  try {
    const p = usd8ToBigInt(v);
    return p > 0n ? p : null;
  } catch {
    return null;
  }
}

function isSmallInt(n: number): boolean {
  return Number.isInteger(n) && n >= 0 && n <= 30;
}

/** quote が funding → share の fair レートからどれだけ外れているか (純関数、I/O は呼び手) */
export function evaluateCrossAssetFairValue(p: CrossAssetFairValueInput): FairValueVerdict {
  // 0 = 無効化 (fair-value.ts の LST ガードと同じ env で一括)
  if (p.guardBps <= 0) return { status: "no_reference" };
  if (!isValidTokenAmount(p.inAmount) || !isValidTokenAmount(p.outAmount)) return UNAVAILABLE;
  if (![p.fundingDecimals, p.underlyingDecimals, p.shareDecimals].every(isSmallInt)) return UNAVAILABLE;
  const pf = priceOrNull(p.fundingPriceUsd8);
  const pu = priceOrNull(p.underlyingPriceUsd8);
  if (pf === null || pu === null) return UNAVAILABLE;
  if (!isValidTokenAmount(p.convertToAssets)) return UNAVAILABLE;
  const c = toBigInt(p.convertToAssets);
  if (c <= 0n) return UNAVAILABLE;

  const inAmount = toBigInt(p.inAmount);
  const outAmount = toBigInt(p.outAmount);
  if (inAmount <= 0n) return UNAVAILABLE;

  const num = inAmount * pf * 10n ** BigInt(p.underlyingDecimals + p.shareDecimals);
  const den = pu * c * 10n ** BigInt(p.fundingDecimals);
  const fairOut = num / den;
  if (fairOut <= 0n) return UNAVAILABLE;

  // 正 = ユーザー不利 (受け取りが fair より少ない)。負 (有利) は通す
  const deviationBps = Number(((fairOut - outAmount) * BPS) / fairOut);
  if (deviationBps > p.guardBps) {
    return { status: "blocked", reason: "fair_value_deviation", deviation_bps: deviationBps };
  }
  return { status: "ok", deviation_bps: deviationBps };
}

/**
 * 409 fair_value_blocked の message (mobile / web はそのまま出す)。
 * 例: "Quote is 3.10% below what 1 USDC should buy in jlJupUSD (limit 2.00%). Stopped before signing — …"
 */
export function fundingFairValueBlockMessage(p: {
  reason: "fair_value_deviation" | "fair_value_unavailable";
  deviationBps: number | undefined;
  guardBps: number;
  inAmount: string;
  fundingSymbol: string;
  fundingDecimals: number;
  shareSymbol: string;
  underlyingSymbol: string;
}): string {
  if (p.reason === "fair_value_unavailable") {
    return `Could not read the ${p.fundingSymbol} / ${p.underlyingSymbol} prices or the ${p.shareSymbol} exchange rate, so this quote can't be checked. Stopped before signing.`;
  }
  const amount = isValidTokenAmount(p.inAmount)
    ? toHumanReadable(p.inAmount, p.fundingDecimals)
    : p.inAmount;
  const off = p.deviationBps === undefined ? "off" : `${bpsToPercent(p.deviationBps)} below`;
  return `Quote is ${off} what ${amount} ${p.fundingSymbol} should buy in ${p.shareSymbol} (limit ${bpsToPercent(
    p.guardBps
  )}). Stopped before signing — this is a routing or liquidity problem, not your amount.`;
}
