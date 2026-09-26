/**
 * Pendle PT / YT 売買の価格 guard (CLAUDE.md §4 fail-closed を Pendle に当てはめたもの)。
 *
 * 2 つの値を比べる:
 * - 一次: Pendle PYLpOracle の TWAP (15 分、SY 建て)。getOracleState で準備済みかを確かめる
 * - 二次: Convert の見積もりを SY 建てに換算した実効レート (SY の previewDeposit / previewRedeem を eth_call)
 *
 * 判定 (§4 と同じ閾値): ≤2% 通す / 2–5% warning 付きで通す / >5% は plan では warning、execute は拒否。
 * オラクル未準備・取得失敗は plan / execute とも拒否 (oracle_unavailable)。
 * 価格は mainnet (getEthClient) から読む。fork 実行時も価格の正は mainnet
 */
import type { PublicClient } from "viem";
import { pendleOracleAbi, pendleSyAbi } from "./abis";
import { PENDLE_PY_LP_ORACLE } from "./config";
import { PlanError } from "./plans";

export const TWAP_SECONDS = 900;
const E18 = 10n ** 18n;
/** 乖離の閾値 (basis points) */
export const WARN_BPS = 200n;
export const BLOCK_BPS = 500n;

export type GuardLevel = "ok" | "warn" | "block";

/** |eff − twap| / twap を bps で (bigint、切り上げ: 境界で甘くしない) */
export function divergenceBps(twap: bigint, eff: bigint): bigint {
  if (twap <= 0n) throw new PlanError("oracle_unavailable", "The Pendle oracle returned no price.");
  const diff = eff > twap ? eff - twap : twap - eff;
  return (diff * 10_000n + twap - 1n) / twap;
}

export function levelOf(bps: bigint): GuardLevel {
  return bps > BLOCK_BPS ? "block" : bps > WARN_BPS ? "warn" : "ok";
}

export interface GuardResult {
  level: GuardLevel;
  bps: bigint;
  /** 1 PT/YT あたりの SY (1e18 scale) */
  twapSyPerToken: bigint;
  quoteSyPerToken: bigint;
  message: string;
}

/** TWAP が読める状態か (UI の事前表示用。売買の判定は checkPendlePrice が毎回やり直す) */
export async function pendleOracleReady(client: PublicClient, market: string): Promise<boolean> {
  try {
    const [increase, , satisfied] = (await client.readContract({
      address: PENDLE_PY_LP_ORACLE,
      abi: pendleOracleAbi,
      functionName: "getOracleState",
      args: [market as `0x${string}`, TWAP_SECONDS],
    })) as readonly [boolean, number, boolean];
    return !increase && satisfied;
  } catch {
    return false;
  }
}

const pct = (bps: bigint) => `${(Number(bps) / 100).toFixed(2)}%`;
const rate = (r: bigint) => {
  const whole = r / E18;
  const frac = ((r % E18) * 10_000n) / E18;
  return `${whole}.${frac.toString().padStart(4, "0")}`;
};

/**
 * @param kind PT か YT
 * @param side buy = token → PT/YT、sell = PT/YT → token
 * @param tokenAmount 入力 (buy) / 出力 (sell) のトークン量 (smallest unit)
 * @param pyAmount 出力 (buy) / 入力 (sell) の PT / YT 量 (smallest unit)
 */
export async function checkPendlePrice(
  client: PublicClient,
  input: { market: string; sy: string; token: string; kind: "pt" | "yt"; side: "buy" | "sell"; tokenAmount: bigint; pyAmount: bigint; label: string }
): Promise<GuardResult> {
  const market = input.market as `0x${string}`;
  let twap: bigint;
  try {
    const [increase, , satisfied] = (await client.readContract({
      address: PENDLE_PY_LP_ORACLE,
      abi: pendleOracleAbi,
      functionName: "getOracleState",
      args: [market, TWAP_SECONDS],
    })) as readonly [boolean, number, boolean];
    if (increase || !satisfied) {
      throw new PlanError("oracle_unavailable", "Pendle's on-chain price oracle is not ready for this market, so trading it is blocked.");
    }
    twap = (await client.readContract({
      address: PENDLE_PY_LP_ORACLE,
      abi: pendleOracleAbi,
      functionName: input.kind === "pt" ? "getPtToSyRate" : "getYtToSyRate",
      args: [market, TWAP_SECONDS],
    })) as bigint;
  } catch (e) {
    if (e instanceof PlanError) throw e;
    throw new PlanError("oracle_unavailable", "Pendle's on-chain price oracle could not be read, so trading is blocked.");
  }
  // 見積もりのトークン量を SY 建てに直す (buy: 入れる token → SY、sell: 出る token ← SY)
  let sy: bigint;
  try {
    if (input.side === "buy") {
      sy = (await client.readContract({ address: input.sy as `0x${string}`, abi: pendleSyAbi, functionName: "previewDeposit", args: [input.token as `0x${string}`, input.tokenAmount] })) as bigint;
    } else {
      const perSy = (await client.readContract({ address: input.sy as `0x${string}`, abi: pendleSyAbi, functionName: "previewRedeem", args: [input.token as `0x${string}`, E18] })) as bigint;
      if (perSy === 0n) throw new Error("zero rate");
      sy = (input.tokenAmount * E18) / perSy;
    }
  } catch {
    throw new PlanError("oracle_unavailable", "The quote could not be converted to SY terms to compare with the oracle, so trading is blocked.");
  }
  if (input.pyAmount === 0n) throw new PlanError("upstream_error", "Pendle's quote returned zero.");
  const quote = (sy * E18) / input.pyAmount;
  const bps = divergenceBps(twap, quote);
  const level = levelOf(bps);
  const base = `Pendle TWAP (15 min): 1 ${input.label} = ${rate(twap)} SY; this quote: ${rate(quote)} SY (${pct(bps)} apart).`;
  const message =
    level === "block"
      ? `${base} More than 5% from the oracle, so executing is refused.`
      : level === "warn"
        ? `${base} Between 2% and 5% from the oracle; check the size and price impact.`
        : base;
  return { level, bps, twapSyPerToken: twap, quoteSyPerToken: quote, message };
}
