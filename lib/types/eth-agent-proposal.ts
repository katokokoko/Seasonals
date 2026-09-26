/**
 * Agent が提案する複数ステップのリバランス (Ethereum)。
 *
 * - Agent (MCP) は step を symbol + 人が読む decimal で書く。address / smallest unit への変換は BFF だけが行う
 * - BFF は提出時に各 step の未署名プランを組んで guard (peg / TWAP / 残高) を通し、bundleHash を付ける
 * - 実行は人の承認 (web の Agent ページ、または chat での明示的な yes) の後、Anvil fork 上でのみ。
 *   表示した内容と同じものだけ実行できるよう、execute は bundleHash の一致を要求する
 * - Agent は署名しない / mainnet に送る経路は無い (Ethereum v3 §9)
 */
import type { EthPlanEffects, ForkTx, PlanSimulation } from "./eth-plan";
import type { TokenAmountView } from "./timeline";

export const SWAP_SYMBOLS = ["USDC", "USDe"] as const;
export type SwapSymbol = (typeof SWAP_SYMBOLS)[number];

/** 戦略名 (絵文字 + 短い英語名、code point 数) / tagline の上限 */
export const PROPOSAL_NAME_MAX = 40;
export const PROPOSAL_TAGLINE_MAX = 140;

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
    }
  | {
      /** 1inch Aqua PEGGED_STABLE (USDC/USDe) の LP sleeve を ship する */
      kind: "aqua_ship";
      /** USDC の decimal */
      usdc: string;
      /** USDe の decimal */
      usde: string;
      /** peg 帯域 (bps、10–200) */
      bandBps: number;
      /** review 日 (ISO、≤ 180 日先) */
      reviewAt: string;
      /** taker fee (bps、1–30、既定 5) */
      feeBps?: number;
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
  /** builder が分かる範囲の in / out (Strategy Brief の after を組む材料) */
  effects?: EthPlanEffects;
}

// ── Strategy Brief (BFF が実データから決定的に組む。LLM は name / tagline / rationale だけ) ──

export interface EthPortfolioLine {
  /** "ETH" / 小文字 address / Pendle productId / "aqua:usdc-usde" / "pending:<key>" */
  key: string;
  label: string;
  productId?: string;
  amounts: TokenAmountView[];
  /** 8 decimals。価格が取れなければ null (総額・APY から除外) */
  usd: string | null;
  /** 0..1、usd がある line のみ */
  share: number | null;
  /** 0..1。idle の wallet token は 0、Aqua LP は null (fee は数えない) */
  apy: number | null;
  apyLabel?: string;
  /** quote / slippage 由来の概算 */
  approx?: boolean;
  /** 後で届く分 (Lido queue / Ethena cooldown) */
  pending?: boolean;
  /** DeFi で運用中 (Lido / Ethena / Pendle / Aqua)。wallet の idle 資産と pending は false */
  deployed: boolean;
}

/** USD 加重平均 APY (0..1) の before → after */
export interface EthApyChange {
  before: number | null;
  after: number | null;
  delta: number | null;
}

export interface EthPortfolioSnapshot {
  totalUsd: string | null;
  lines: EthPortfolioLine[];
}

export interface EthStrategyBrief {
  name: string;
  tagline?: string;
  before: EthPortfolioSnapshot;
  after: EthPortfolioSnapshot;
  /**
   * wallet の idle 資産はどちらの分母にも入れない。
   * - moved: この提案が動かす資金。減る側 (source) の APY → 増える側 (destination) の APY、USD 加重
   * - deployed: DeFi で運用中の資金 (Lido / Ethena / Pendle / Aqua) だけの before → after
   * APY 不明の line (Aqua LP など) は 0 として分母に含め `excluded` に列挙 (数字を膨らませない)
   */
  blendedApy: {
    moved: EthApyChange & { usd: string };
    deployed: EthApyChange & { usdBefore: string; usdAfter: string };
    excluded: string[];
  };
  aqua?: { usdc: TokenAmountView; usde: TokenAmountView; bandBps: number; feeBps: number; reviewAt: string; peg: string };
  /** この戦略の後にカレンダーに来る予定 (PT 満期 / Aqua review / cooldown 終了 / Lido queue) */
  horizon: Array<{ at: string; label: string; approx?: boolean }>;
  unpriced: string[];
  warnings: string[];
  /** 英語 Markdown (BFF が描画。Claude はそのまま見せる) */
  markdown: string;
  builtAt: string;
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
  /** 戦略名 (絵文字 + 短い英語名、LLM が命名) */
  name: string;
  tagline?: string;
  /** Agent が書いた根拠 (人が承認前に読む) */
  rationale: string;
  steps: EthProposalStep[];
  previews: EthProposalPreviewSlot[];
  brief: EthStrategyBrief;
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
  name: string;
  tagline?: string;
  rationale: string;
  steps: EthProposalStep[];
}

/** dry run (`POST /eth/agent-proposals/brief`): previews + brief だけ返し、保存しない */
export interface EthProposalBriefResponse {
  owner: string;
  name: string;
  tagline?: string;
  rationale: string;
  steps: EthProposalStep[];
  previews: EthProposalPreviewSlot[];
  brief: EthStrategyBrief;
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
