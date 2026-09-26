/**
 * Lido adapter — WithdrawalQueue (Ethereum v3 §3 Lido)
 * 未 finalize → withdrawal_pending (ETA 不明)、finalize 済み未 claim → withdrawal_claimable
 */
import type { TimelineEvent } from "@workspace/lib/types";
import { getEthClient } from "./client";
import { withdrawalQueueAbi } from "./abis";
import { LIDO } from "./config";
import { baseEvent, etherscanAddress } from "./common";

export interface LidoRequestStatus {
  requestId: bigint;
  amountOfStETH: bigint;
  timestamp: bigint;
  isFinalized: boolean;
  isClaimed: boolean;
}

export function deriveLidoEvents(owner: string, reqs: LidoRequestStatus[], observedAt: string): TimelineEvent[] {
  return reqs
    .filter((r) => !r.isClaimed)
    .map((r) => {
      const id = r.requestId.toString();
      const requestedAt = new Date(Number(r.timestamp) * 1000).toISOString();
      if (!r.isFinalized) {
        return baseEvent({
          id: `ethereum:lido:withdrawal:${id}`,
          kind: "withdrawal_pending",
          protocol: "lido",
          protocolName: "Lido",
          title: `Lido withdrawal #${id} pending`,
          asset: "stETH → ETH",
          at: null,
          etaNote: "Waiting for Lido to finalize the request (typically 1–5 days). Requested " + requestedAt.slice(0, 10) + ".",
          owner,
          amount: { value: r.amountOfStETH.toString(), decimals: 18, symbol: "stETH" },
          actions: [
            {
              actionType: "lido_claim",
              label: "Claim ETH",
              requiresWallet: true,
              availability: "not_yet",
              reason: "Claimable after Lido finalizes the request.",
              params: { requestId: id },
            },
          ],
          links: [etherscanAddress(LIDO.withdrawalQueue)],
          source: "lido.withdrawalQueue",
          observedAt,
        });
      }
      return baseEvent({
        id: `ethereum:lido:withdrawal:${id}`,
        kind: "withdrawal_claimable",
        protocol: "lido",
        protocolName: "Lido",
        title: `Lido withdrawal #${id} claimable`,
        asset: "stETH → ETH",
        // finalize 時刻は status に無いので観測時刻に置く (「今 claim できる」)
        at: observedAt,
        etaNote: "Finalized. The ETH waits in the queue until you claim it. Requested " + requestedAt.slice(0, 10) + ".",
        owner,
        amount: { value: r.amountOfStETH.toString(), decimals: 18, symbol: "stETH" },
        actions: [
          { actionType: "lido_claim", label: "Claim ETH", requiresWallet: true, availability: "available", params: { requestId: id } },
        ],
        links: [etherscanAddress(LIDO.withdrawalQueue)],
        source: "lido.withdrawalQueue",
        observedAt,
      });
    });
}

export async function fetchLidoUserEvents(owner: string, observedAt: string): Promise<TimelineEvent[]> {
  const client = getEthClient();
  if (!client) throw new Error("Ethereum RPC is not configured.");
  const ids = (await client.readContract({
    address: LIDO.withdrawalQueue,
    abi: withdrawalQueueAbi,
    functionName: "getWithdrawalRequests",
    args: [owner as `0x${string}`],
  })) as readonly bigint[];
  if (ids.length === 0) return [];
  const statuses = (await client.readContract({
    address: LIDO.withdrawalQueue,
    abi: withdrawalQueueAbi,
    functionName: "getWithdrawalStatus",
    args: [[...ids]],
  })) as ReadonlyArray<{ amountOfStETH: bigint; timestamp: bigint; isFinalized: boolean; isClaimed: boolean }>;
  return deriveLidoEvents(
    owner,
    statuses.map((s, i) => ({ requestId: ids[i]!, amountOfStETH: s.amountOfStETH, timestamp: s.timestamp, isFinalized: s.isFinalized, isClaimed: s.isClaimed })),
    observedAt
  );
}
