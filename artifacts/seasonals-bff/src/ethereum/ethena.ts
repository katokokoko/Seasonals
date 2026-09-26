/**
 * Ethena adapter — sUSDe cooldown end (Ethereum v3 §3 Ethena)
 * cooldownDuration() は動的 (1/3/5/7 日)。7 日を決め打ちしない。
 */
import type { TimelineEvent } from "@workspace/lib/types";
import { getEthClient } from "./client";
import { sUSDeAbi } from "./abis";
import { ETHENA } from "./config";
import { baseEvent, etherscanAddress } from "./common";

export function deriveEthenaCooldownEvent(
  owner: string,
  cooldown: { cooldownEnd: bigint; underlyingAmount: bigint },
  cooldownDurationSec: number,
  observedAt: string
): TimelineEvent | null {
  if (cooldown.underlyingAmount === 0n || cooldown.cooldownEnd === 0n) return null;
  const endMs = Number(cooldown.cooldownEnd) * 1000; // unix seconds (時刻値、金融値ではない)
  const ready = endMs <= Date.parse(observedAt);
  return baseEvent({
    id: `ethereum:ethena:cooldown_end:${owner.toLowerCase()}`,
    kind: "cooldown_end",
    protocol: "ethena",
    protocolName: "Ethena",
    title: ready ? "sUSDe cooldown finished — USDe claimable" : "sUSDe cooldown ends",
    asset: "sUSDe → USDe",
    at: new Date(endMs).toISOString(),
    owner,
    amount: { value: cooldown.underlyingAmount.toString(), decimals: 18, symbol: "USDe" },
    metrics: [{ label: "Current cooldown length", kind: "text", value: `${Math.round(cooldownDurationSec / 3600)} h (set by Ethena, can change)` }],
    actions: [
      {
        actionType: "ethena_unstake",
        label: "Claim USDe",
        requiresWallet: true,
        availability: ready ? "available" : "not_yet",
        ...(ready ? {} : { reason: "USDe can be claimed when the cooldown ends." }),
        params: { receiver: owner },
      },
    ],
    links: [etherscanAddress(ETHENA.sUSDe)],
    source: "susde.cooldowns",
    observedAt,
  });
}

export async function fetchEthenaUserEvents(owner: string, observedAt: string): Promise<TimelineEvent[]> {
  const client = getEthClient();
  if (!client) throw new Error("Ethereum RPC is not configured.");
  const [cd, dur] = await Promise.all([
    client.readContract({ address: ETHENA.sUSDe, abi: sUSDeAbi, functionName: "cooldowns", args: [owner as `0x${string}`] }),
    client.readContract({ address: ETHENA.sUSDe, abi: sUSDeAbi, functionName: "cooldownDuration" }),
  ]);
  const [cooldownEnd, underlyingAmount] = cd as readonly [bigint, bigint];
  const e = deriveEthenaCooldownEvent(owner, { cooldownEnd, underlyingAmount }, Number(dur), observedAt);
  return e ? [e] : [];
}
