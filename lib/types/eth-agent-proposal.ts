/**
 * Agent が提案する複数ステップのリバランス (Ethereum)。
 *
 * - Agent (MCP) は step を symbol + 人が読む decimal で書く。address / smallest unit への変換は BFF だけが行う
 * - BFF は提出時に各 step の未署名プランを組んで guard (peg / TWAP / 残高) を通し、bundleHash を付ける
 * - 実行は人の承認 (web の Agent ページ、または chat での明示的な yes) の後、Anvil fork 上でのみ。
 *   表示した内容と同じものだけ実行できるよう、execute は bundleHash の一致を要求する
 * - Agent は署名しない / mainnet に送る経路は無い (Ethereum v3 §9)
 */
import type { ForkTx, PlanSimulation } from "./eth-plan";

export const SWAP_SYMBOLS = ["USDC", "USDe"] as const;
export type SwapSymbol = (typeof SWAP_SYMBOLS)[number];

export type EthProposalStep =
  | {
      kind: "menu";
      /** `ethereum:lido:steth` / `ethereum:ethena:susde` / `ethereum:pendle:(pt|yt):<market>` */
      productId: string;
      action: "deposit" | "withdraw";
      /** 人が読む decimal ("100" / "1.5") */
      amount: string;
      /** withdraw で出すトークン (Lido: "stETH" | "wstETH") */
      token?: string;
    }
  | {
      kind: "uniswap_swap";
      tokenIn: SwapSymbol;
      tokenOut: SwapSymbol;
      /** tokenIn の decimal */
      amount: string;
    }
  | {
      kind: "event_action";
      /** list_events の event id */
      eventId: string;
      /** event の action (lido_claim / ethena_unstake / pendle_redeem / aqua_dock ...) */
      actionType: string;
    };

export const ETH_PROPOSAL_STATUSES = ["pending", "executing", "executed", "failed", "rejected", "expired"] as const;
export type EthProposalStatus = (typeof ETH_PROPOSAL_STATUSES)[number];

export type EthProposalApprovalVia = "web" | "chat";

export interface EthProposalStepPreview {
  summary: string;
  warnings: string[];
  simulation: PlanSimulation;
  /** swap の受取見込み (tokenOut の smallest unit)。次 step の金額を決める材料 */
  amountOut?: string;
}

/** 提出時のプラン。前 step の残高に依存する step は fork 実行時に検証するため preview を持たない */
export type EthProposalPreviewSlot = { ok: true; preview: EthProposalStepPreview } | { ok: false; note: string };

export interface EthProposalStepResult {
  index: number;
  ok: boolean;
  summary: string;
  txs: ForkTx[];
  error?: string;
}

export interface EthProposalExecution {
  startedAt: string;
  finishedAt?: string;
  via: EthProposalApprovalVia;
  steps: EthProposalStepResult[];
}

export interface EthAgentProposal {
  id: string;
  owner: string;
  title: string;
  /** Agent が書いた根拠 (人が承認前に読む) */
  rationale: string;
  steps: EthProposalStep[];
  previews: EthProposalPreviewSlot[];
  /** `{id, owner, steps}` の canonical JSON sha256。execute はこれの一致を要求する */
  bundleHash: string;
  status: EthProposalStatus;
  createdBy: "mcp";
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  execution?: EthProposalExecution;
}

// ── wire ────────────────────────────────────────────────────────────────────

export interface EthProposalSubmitRequest {
  owner: string;
  title: string;
  rationale: string;
  steps: EthProposalStep[];
}

export interface EthProposalPreviewRequest {
  owner: string;
  step: EthProposalStep;
}

export interface EthProposalExecuteRequest {
  approvedBy: "user";
  via: EthProposalApprovalVia;
  bundleHash: string;
}

export interface EthProposalListResponse {
  proposals: EthAgentProposal[];
}
