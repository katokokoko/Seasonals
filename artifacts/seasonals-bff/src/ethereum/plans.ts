/**
 * Unsigned transaction plan (Ethereum v3 §5 ExecutableAction, §11 D Transaction preview)
 *
 * - event は同じ event source (getUserEvents) から id で引き直し、action の可否は
 *   on-chain 状態を読み直して検証する (client の params を鵜呑みにしない)
 * - calldata は protocol の ABI / Pendle Hosted SDK Convert からのみ作る (AI は作らない)
 * - mainnet に対して eth_call で「送らずに」実行可否を確かめる。署名・broadcast はしない
 * - 価格に依存しない action のみ (claim / unstake / redeem)。価格依存 action は未対応 (fail-closed)
 */
import { encodeFunctionData, type PublicClient } from "viem";
import { z } from "zod";
import { formatTokenAmount } from "@workspace/lib/utils/numeric";
import type { ActionPlan, TimelineEvent, TxStep } from "@workspace/lib/types";
import { executionTarget, getEthClient, getJson, sanitizeError } from "./client";
import { ccaAuctionAbi, erc20Abi, sUSDeAbi, withdrawalQueueAbi } from "./abis";
import { ETHENA, LIDO, MAINNET_CHAIN_ID, PENDLE_API } from "./config";
import { getUserEvents } from "./events";
import { fetchPendleMarkets } from "./pendle";

const hex = z.string().regex(/^0x[0-9a-fA-F]*$/);
const addr = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
export const TxStepSchema = z.object({
  kind: z.enum(["approval", "call"]),
  to: addr,
  data: hex,
  value: z.string().regex(/^[0-9]+$/),
  description: z.string(),
});
const assetView = z.object({ key: z.string().min(1), value: z.string().regex(/^[0-9]+$/), decimals: z.number().int().min(0), symbol: z.string() });
/** Strategy Brief 用の効果 (lib EthPlanEffects と同形)。Menu の plan だけが付ける */
export const EffectsSchema = z.object({
  in: z.array(assetView),
  out: z.array(assetView),
  pending: z.array(assetView).optional(),
  availableAt: z.string().optional(),
  approx: z.boolean().optional(),
});
export const ActionPlanSchema = z.object({
  eventId: z.string(),
  actionType: z.string(),
  chainId: z.literal(MAINNET_CHAIN_ID),
  owner: addr,
  target: z.enum(["fork", "mainnet"]),
  summary: z.string(),
  steps: z.array(TxStepSchema).min(1),
  simulation: z.object({ ran: z.boolean(), ok: z.boolean().optional(), error: z.string().optional(), note: z.string() }),
  /** 実行前に人が知っておくべきこと (例: cooldown タイマーの再スタート、価格 guard の乖離) */
  warnings: z.array(z.string()).optional(),
  effects: EffectsSchema.optional(),
  builtAt: z.string(),
  source: z.string(),
  broadcast: z.literal(false),
});
// 型は lib が canonical (web / MCP と共有、CLAUDE.md §1)。zod の出力が lib 型に収まることをここで固定する
({}) as z.infer<typeof ActionPlanSchema> satisfies ActionPlan;
({}) as z.infer<typeof TxStepSchema> satisfies TxStep;
export type { ActionPlan, TxStep };

export class PlanError extends Error {
  constructor(
    public readonly code:
      | "event_not_found"
      | "action_not_available"
      | "unsupported_action"
      | "rpc_unavailable"
      | "upstream_error"
      | "invalid_amount"
      | "insufficient_balance"
      | "oracle_unavailable"
      | "oracle_divergence_too_large",
    message: string
  ) {
    super(message);
  }
}

export async function simulate(owner: string, steps: TxStep[], client: PublicClient | null, where: string): Promise<ActionPlan["simulation"]> {
  if (!client) return { ran: false, note: "Ethereum RPC is not configured." };
  // approval が要る場合、本体 call は approval 後でないと通らないので approval のみ確認する
  const first = steps[0]!;
  try {
    await client.call({ account: owner as `0x${string}`, to: first.to as `0x${string}`, data: first.data as `0x${string}`, value: BigInt(first.value) });
    return {
      ran: true,
      ok: true,
      note:
        steps.length > 1
          ? `Step 1 of ${steps.length} succeeds against current ${where} state (eth_call). Later steps depend on it. Nothing was sent.`
          : `Succeeds against current ${where} state (eth_call). Nothing was sent.`,
    };
  } catch (e) {
    return { ran: true, ok: false, error: sanitizeError(e), note: `Would revert against current ${where} state (eth_call). Nothing was sent.` };
  }
}

function findEvent(events: TimelineEvent[], eventId: string): TimelineEvent {
  const e = events.find((x) => x.id === eventId);
  if (!e) throw new PlanError("event_not_found", "This event is not in the current data for that address.");
  return e;
}

export interface PlanOptions {
  /** 状態の読み取り / eth_call 先 (既定: mainnet)。fork 実行時は fork client */
  client?: PublicClient;
  /** true なら event 側の availability (mainnet 由来) を見ず、client の状態だけで判定 (fork の時間送り用) */
  stateOnly?: boolean;
  where?: "mainnet" | "fork";
}

export async function buildActionPlan(input: { owner: string; eventId: string; actionType: string }, opts: PlanOptions = {}): Promise<ActionPlan> {
  const client = opts.client ?? getEthClient();
  if (!client) throw new PlanError("rpc_unavailable", "Ethereum RPC is not configured.");
  const where = opts.where ?? "mainnet";
  const owner = input.owner as `0x${string}`;
  const { events } = await getUserEvents(owner);
  const event = findEvent(events, input.eventId);
  const action = event.actions.find((a) => a.actionType === input.actionType);
  if (!action) throw new PlanError("unsupported_action", "This event has no such action.");
  if (action.availability === "unsupported" || (!opts.stateOnly && action.availability !== "available")) {
    throw new PlanError("action_not_available", action.reason ?? "This action is not available yet.");
  }

  let steps: TxStep[];
  let summary: string;
  let source: string;

  switch (action.actionType) {
    case "lido_claim": {
      const id = BigInt(action.params.requestId ?? "-1");
      const [st] = (await client.readContract({ address: LIDO.withdrawalQueue, abi: withdrawalQueueAbi, functionName: "getWithdrawalStatus", args: [[id]] })) as ReadonlyArray<{
        amountOfStETH: bigint;
        owner: string;
        isFinalized: boolean;
        isClaimed: boolean;
      }>;
      if (!st || st.owner.toLowerCase() !== owner.toLowerCase() || !st.isFinalized || st.isClaimed) {
        throw new PlanError("action_not_available", "The withdrawal request is not finalized, already claimed, or not owned by this address.");
      }
      steps = [
        {
          kind: "call",
          to: LIDO.withdrawalQueue,
          data: encodeFunctionData({ abi: withdrawalQueueAbi, functionName: "claimWithdrawal", args: [id] }),
          value: "0",
          description: `Claim Lido withdrawal #${id} (${formatTokenAmount(st.amountOfStETH.toString(), 18, { maxFractionDigits: 4 })} stETH requested) as ETH to the owner.`,
        },
      ];
      summary = `Claim the ETH from Lido withdrawal request #${id}.`;
      source = "lido.withdrawalQueue";
      break;
    }
    case "ethena_unstake": {
      const [end, amount] = (await client.readContract({ address: ETHENA.sUSDe, abi: sUSDeAbi, functionName: "cooldowns", args: [owner] })) as readonly [bigint, bigint];
      const block = await client.getBlock();
      if (amount === 0n || end > block.timestamp) throw new PlanError("action_not_available", "The sUSDe cooldown has not finished.");
      steps = [
        {
          kind: "call",
          to: ETHENA.sUSDe,
          data: encodeFunctionData({ abi: sUSDeAbi, functionName: "unstake", args: [owner] }),
          value: "0",
          description: `Claim ${formatTokenAmount(amount.toString(), 18, { maxFractionDigits: 2 })} USDe from the finished sUSDe cooldown to the owner.`,
        },
      ];
      summary = "Claim the USDe whose sUSDe cooldown has finished.";
      source = "susde.cooldowns";
      break;
    }
    case "pendle_redeem": {
      const pt = action.params.pt as `0x${string}`;
      const balance = (await client.readContract({ address: pt, abi: erc20Abi, functionName: "balanceOf", args: [owner] })) as bigint;
      if (balance === 0n) throw new PlanError("action_not_available", "This address no longer holds the PT.");
      const market = (await fetchPendleMarkets()).find((m) => m.address.toLowerCase() === action.params.market);
      const out = market?.underlyingAsset?.split("-")[1];
      if (!market || !out) throw new PlanError("upstream_error", "Pendle market metadata is unavailable.");
      const res = await getJson<{
        action: string;
        requiredApprovals?: Array<{ token: string; amount: string }>;
        routes: Array<{ tx: { to: string; data: string; value: string }; outputs: Array<{ token: string; amount: string }> }>;
      }>(`${PENDLE_API}/v3/sdk/${MAINNET_CHAIN_ID}/convert`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ receiver: owner, slippage: 0.005, enableAggregator: false, inputs: [{ token: pt, amount: balance.toString() }], outputs: [out] }),
        timeoutMs: 20_000,
      });
      const route = res.routes[0];
      if (!route) throw new PlanError("upstream_error", "Pendle Convert returned no route.");
      const approvals: TxStep[] = [];
      for (const a of res.requiredApprovals ?? []) {
        const allowance = (await client.readContract({
          address: a.token as `0x${string}`,
          abi: [{ type: "function", name: "allowance", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }] }] as const,
          functionName: "allowance",
          args: [owner, route.tx.to as `0x${string}`],
        })) as bigint;
        if (allowance >= BigInt(a.amount)) continue;
        approvals.push({
          kind: "approval",
          to: a.token,
          data: encodeFunctionData({
            abi: [{ type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] }] as const,
            functionName: "approve",
            args: [route.tx.to as `0x${string}`, BigInt(a.amount)],
          }),
          value: "0",
          description: `Allow the Pendle router to spend exactly the PT being redeemed.`,
        });
      }
      steps = [
        ...approvals,
        { kind: "call", to: route.tx.to, data: route.tx.data, value: route.tx.value ?? "0", description: `Redeem PT-${market.name} for the underlying via Pendle (action: ${res.action}).` },
      ];
      summary = `Redeem matured PT-${market.name} through Pendle's Convert route.`;
      source = "pendle-hosted-sdk:convert";
      break;
    }
    case "cca_exit_bid":
    case "cca_claim": {
      const auction = action.params.auction as `0x${string}`;
      const bidId = BigInt(action.params.bidId ?? "-1");
      const isExit = action.actionType === "cca_exit_bid";
      steps = [
        {
          kind: "call",
          to: auction,
          data: isExit
            ? encodeFunctionData({ abi: ccaAuctionAbi, functionName: "exitBid", args: [bidId] })
            : encodeFunctionData({ abi: ccaAuctionAbi, functionName: "claimTokens", args: [bidId] }),
          value: "0",
          description: isExit
            ? `Exit CCA bid #${bidId} (refunds unspent currency; partially filled bids need checkpoint hints and are not handled here).`
            : `Claim the tokens bought with CCA bid #${bidId}.`,
        },
      ];
      summary = isExit ? `Exit bid #${bidId} in the Uniswap CCA auction.` : `Claim tokens for bid #${bidId} in the Uniswap CCA auction.`;
      source = "uniswap-cca";
      break;
    }
    case "aqua_dock": {
      // 循環 import を避けて遅延読み込み (aqua.ts は PlanError / TxStep を使う)
      const { buildAquaDockStep } = await import("./aqua");
      steps = [buildAquaDockStep(action.params.strategyHash ?? "")];
      summary = "Dock the Aqua USDC/USDe strategy.";
      source = "1inch-aqua-sdk";
      break;
    }
    default:
      throw new PlanError("unsupported_action", "This action has no transaction builder yet.");
  }

  const plan: ActionPlan = {
    eventId: event.id,
    actionType: action.actionType,
    chainId: MAINNET_CHAIN_ID,
    owner,
    target: executionTarget(),
    summary,
    steps,
    simulation: await simulate(owner, steps, client, where),
    builtAt: new Date().toISOString(),
    source,
    broadcast: false,
  };
  return ActionPlanSchema.parse(plan);
}
