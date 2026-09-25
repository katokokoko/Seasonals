/**
 * Chainlink 価格 (Ethereum v3 §6 Pricing and oracles) + fail-closed の peg guard。
 *
 * - Chainlink Feed Registry (0x47Fb…eeeDf) の latestRoundData(base, USD) を読む。feed address を
 *   adapter に直書きしない。registry が返す feed の description() は 2026-09-26 に
 *   "USDC / USD" / "USDe / USD" / "ETH / USD" であることを確認済み
 * - 価格は answer (int256) と decimals のまま保持し、比較は bigint で行う (CLAUDE.md §3)
 * - stale 判定は feed ごとの heartbeat + 余裕 (heartbeat を超えて更新が無ければ stale)
 * - 価格は「表示」と「価格依存の実行前ガード」にのみ使う。時刻イベントの導出には使わない
 * - checkPeg は唯一の fail-closed: 欠損・stale・非正・乖離超過のいずれかで refuse (CLAUDE.md §4)
 */
import { parseAbi } from "viem";
import { getEthClient, sanitizeError } from "./client";

export const FEED_REGISTRY = "0x47Fb2585D2C56Fe188D0E6ec628a38b74fCeeeDf" as const;
const USD = "0x0000000000000000000000000000000000000348" as const;

export const PRICE_ASSETS = {
  USDC: { base: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", heartbeatSec: 86_400 },
  USDe: { base: "0x4c9EDD5852cd905f086C759E8383e09bff1E68B3", heartbeatSec: 86_400 },
  ETH: { base: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeEEeE", heartbeatSec: 3_600 },
  stETH: { base: "0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84", heartbeatSec: 86_400 },
} as const;
export type PriceAsset = keyof typeof PRICE_ASSETS;

const registryAbi = parseAbi([
  "function latestRoundData(address base, address quote) view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
  "function decimals(address base, address quote) view returns (uint8)",
]);

export interface ChainlinkPrice {
  asset: PriceAsset;
  /** answer (整数、decimals 桁) */
  answer: string;
  decimals: number;
  updatedAt: string;
  stale: boolean;
  source: "chainlink";
}

/** 1 資産の価格。取れなければ null (0 や推測で埋めない、v3 §6) */
export async function getChainlinkPrice(asset: PriceAsset, now = Date.now()): Promise<ChainlinkPrice | null> {
  const client = getEthClient();
  if (!client) return null;
  const { base, heartbeatSec } = PRICE_ASSETS[asset];
  try {
    const [round, dec] = await Promise.all([
      client.readContract({ address: FEED_REGISTRY, abi: registryAbi, functionName: "latestRoundData", args: [base, USD] }),
      client.readContract({ address: FEED_REGISTRY, abi: registryAbi, functionName: "decimals", args: [base, USD] }),
    ]);
    const [, answer, , updatedAt] = round as readonly [bigint, bigint, bigint, bigint, bigint];
    const ageSec = now / 1000 - Number(updatedAt);
    return {
      asset,
      answer: answer.toString(),
      decimals: Number(dec),
      updatedAt: new Date(Number(updatedAt) * 1000).toISOString(),
      stale: ageSec > heartbeatSec * 1.1,
      source: "chainlink",
    };
  } catch (e) {
    void sanitizeError(e);
    return null;
  }
}

export interface PegCheck {
  ok: boolean;
  /** 乖離 (bps、整数に切り上げ)。判定できなかった時は null */
  deviationBps: number | null;
  bandBps: number;
  reason: string;
  prices: Array<ChainlinkPrice | null>;
}

/**
 * 2 資産の peg を確認する (Aqua pegged 戦略 / stable swap の前)。pure: 価格を引数で受ける。
 * |a - b| / b を bigint で計算し band (bps) と比較。欠損・stale・非正は必ず refuse。
 */
export function evaluatePeg(a: ChainlinkPrice | null, b: ChainlinkPrice | null, bandBps: number): PegCheck {
  const prices = [a, b];
  if (!a || !b) return { ok: false, deviationBps: null, bandBps, reason: "Price unavailable — refusing (fail-closed).", prices };
  if (a.stale || b.stale) return { ok: false, deviationBps: null, bandBps, reason: "Price is stale — refusing (fail-closed).", prices };
  const pa = BigInt(a.answer) * 10n ** BigInt(18 - a.decimals);
  const pb = BigInt(b.answer) * 10n ** BigInt(18 - b.decimals);
  if (pa <= 0n || pb <= 0n) return { ok: false, deviationBps: null, bandBps, reason: "Non-positive price — refusing (fail-closed).", prices };
  const diff = pa > pb ? pa - pb : pb - pa;
  // bps を切り上げ: ceil(diff * 10000 / pb)
  const bps = (diff * 10_000n + pb - 1n) / pb;
  const ok = bps <= BigInt(bandBps);
  return {
    ok,
    deviationBps: Number(bps),
    bandBps,
    reason: ok ? `Within ${bandBps} bps (${bps} bps).` : `Deviation ${bps} bps exceeds ${bandBps} bps — refusing (fail-closed).`,
    prices,
  };
}

export async function checkPeg(a: PriceAsset, b: PriceAsset, bandBps: number): Promise<PegCheck> {
  const [pa, pb] = await Promise.all([getChainlinkPrice(a), getChainlinkPrice(b)]);
  return evaluatePeg(pa, pb, bandBps);
}
