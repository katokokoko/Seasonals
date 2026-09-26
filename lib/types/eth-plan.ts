/**
 * Ethereum の未署名プラン / fork 実行結果の wire 型 (Ethereum v3 §5 ExecutableAction、§8 fork execution)。
 * BFF の zod (`ethereum/plans.ts` ActionPlanSchema) と web の表示が同じ形を共有する (CLAUDE.md §1)。
 * 金額 (`value`) は wei の整数 string (§4.5)。
 */
import type { TimelineEvent, TokenAmountView } from "./timeline";

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

/** プランが動かす token。`key` は "ETH" (native) / 小文字 address / Pendle の productId (PT・YT) */
export interface EthPlanAsset extends TokenAmountView {
  key: string;
}

/**
 * プランの効果 (Strategy Brief の before → after 用)。builder が組んだ時点で分かる量だけを入れる。
 * `pending` は後で届く分 (Lido queue の ETH / Ethena cooldown の USDe)。`approx` は quote / slippage 由来の概算
 */
export interface EthPlanEffects {
  in: EthPlanAsset[];
  out: EthPlanAsset[];
  pending?: EthPlanAsset[];
  availableAt?: string;
  approx?: boolean;
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
  /** Menu の deposit / withdraw が付ける (event action は未対応) */
  effects?: EthPlanEffects;
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
