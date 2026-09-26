/**
 * Ethereum の未署名プラン / fork 実行結果の wire 型 (Ethereum v3 §5 ExecutableAction、§8 fork execution)。
 * BFF の zod (`ethereum/plans.ts` ActionPlanSchema) と web の表示が同じ形を共有する (CLAUDE.md §1)。
 * 金額 (`value`) は wei の整数 string (§4.5)。
 */
import type { TimelineEvent } from "./timeline";

export interface TxStep {
  kind: "approval" | "call";
  to: string;
  data: string;
  /** wei、整数 string */
  value: string;
  description: string;
}

export interface PlanSimulation {
  ran: boolean;
  ok?: boolean;
  error?: string;
  note: string;
}

export interface ActionPlan {
  eventId: string;
  actionType: string;
  chainId: number;
  owner: string;
  target: "fork" | "mainnet";
  summary: string;
  steps: TxStep[];
  simulation: PlanSimulation;
  /** 実行前に人が知っておくべきこと (cooldown の再スタート、価格 guard の乖離など) */
  warnings?: string[];
  builtAt: string;
  source: string;
  broadcast: false;
}

export interface ForkTx {
  hash: string;
  status: "success" | "reverted";
  blockNumber: string;
  gasUsed: string;
  description: string;
}

export interface ForkExecution {
  target: "fork";
  plan: ActionPlan;
  txs: ForkTx[];
  executedEvent: TimelineEvent;
}
