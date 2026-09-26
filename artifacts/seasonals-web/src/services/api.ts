/**
 * BFF API client — Web の通信はすべてここを経由する (CLAUDE.md §5)。
 * `/api/*` は Vite dev proxy / 本番 reverse proxy で BFF へ転送される。
 * API key / RPC URL は BFF 側にしか無い。
 */
import type { ChainId } from "@workspace/lib/config/chains";
import type {
  EarnPositionsResponse,
  MenuHoldingsResponse,
  MenuProduct,
  PortfolioHistoryResponse,
  PortfolioHoldingsResponse,
  ProtocolMenuEntry,
  TokenAmountView,
  TimelineEventsResponse,
  UnifiedTimeEventDTO,
} from "@workspace/lib/types";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly path: string,
    message: string
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const BASE = "/api";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(BASE + path, {
      ...init,
      headers: { accept: "application/json", ...(init?.body ? { "content-type": "application/json" } : {}), ...init?.headers },
    });
  } catch (e) {
    throw new ApiError(0, path, "Seasonals server is not reachable.");
  }
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { error?: string; message?: string };
      msg = body.message ?? body.error ?? msg;
    } catch {
      /* non-JSON */
    }
    throw new ApiError(res.status, path, msg);
  }
  return (await res.json()) as T;
}

export const api = {
  health: () => request<{ status: string }>("/health"),
  solanaWalletEvents: (wallet: string) =>
    request<UnifiedTimeEventDTO[]>(`/time-events/wallet?wallet=${encodeURIComponent(wallet)}`),
  menuListings: () => request<ProtocolMenuEntry[]>("/menu-listings"),
  ethPublicEvents: () => request<TimelineEventsResponse>("/eth/public-events"),
  ethEvents: (address: string) => request<TimelineEventsResponse>(`/eth/events?address=${encodeURIComponent(address)}`),
  ethStatus: () => request<EthStatus>("/eth/status"),
  ethMenu: () => request<MenuProduct[]>("/eth/menu"),
  ethHoldings: (address: string) => request<MenuHoldingsResponse>(`/eth/holdings?address=${encodeURIComponent(address)}`),
  solanaEarnPositions: (wallet: string) => request<EarnPositionsResponse>(`/positions/earn?wallet=${encodeURIComponent(wallet)}`),
  /** 評価額の履歴 (Solana: /portfolio/history、Ethereum: /eth/portfolio/history、同じ応答形) */
  portfolioHistory: (chain: ChainId, address: string, days: number) =>
    request<PortfolioHistoryResponse>(
      chain === "ethereum"
        ? `/eth/portfolio/history?address=${encodeURIComponent(address)}&days=${days}`
        : `/portfolio/history?wallet=${encodeURIComponent(address)}&days=${days}`
    ),
  /** 現在の保有 (category 付き、Allocation donut 用) */
  portfolioHoldings: (chain: ChainId, address: string) =>
    request<PortfolioHoldingsResponse>(
      chain === "ethereum"
        ? `/eth/portfolio/holdings?address=${encodeURIComponent(address)}`
        : `/portfolio/holdings?wallet=${encodeURIComponent(address)}`
    ),
  ethAave: (address: string) => request<{ positions: AavePositionView[] }>(`/eth/aave?address=${encodeURIComponent(address)}`),
  uniswapExecuteOnFork: (swapper: string, tokenIn: string, tokenOut: string, amount: string) =>
    request<{ target: "fork"; plan: UniswapSwapPlan; txs: ForkExecution["txs"] }>("/eth/uniswap/execute", {
      method: "POST",
      body: JSON.stringify({ swapper, tokenIn, tokenOut, amount, approvedBy: "user" }),
    }),
  aquaShipPlan: (input: AquaShipInput) => request<AquaShipPlan>("/eth/aqua/ship-plan", { method: "POST", body: JSON.stringify(input) }),
  aquaShipOnFork: (input: AquaShipInput) =>
    request<{ plan: AquaShipPlan; txs: ForkExecution["txs"] }>("/eth/aqua/ship", { method: "POST", body: JSON.stringify({ ...input, approvedBy: "user" }) }),
  aquaFillOnFork: (strategyHash: string, taker: string, usdcIn: string) =>
    request<{ txs: ForkExecution["txs"]; usdeOut: string }>("/eth/aqua/fill", {
      method: "POST",
      body: JSON.stringify({ strategyHash, taker, usdcIn, approvedBy: "user" }),
    }),
  uniswapQuote: (swapper: string, tokenIn: string, tokenOut: string, amount: string) =>
    request<UniswapPreview>("/eth/uniswap/quote", { method: "POST", body: JSON.stringify({ swapper, tokenIn, tokenOut, amount }) }),
  ethProposal: (address: string, eventId: string) =>
    request<Proposal>(`/eth/proposal?address=${encodeURIComponent(address)}&eventId=${encodeURIComponent(eventId)}`),
  /** fork 実行 (ユーザーがボタンで承認した時だけ呼ぶ)。mainnet には送らない */
  ethExecuteOnFork: (owner: string, eventId: string, actionType: string) =>
    request<ForkExecution>("/eth/execute", { method: "POST", body: JSON.stringify({ owner, eventId, actionType, approvedBy: "user" }) }),
  /** Menu の deposit / withdraw: 未署名プラン (送信しない) */
  /** Pendle 売買パネル用の文脈 (払う / 受け取るトークンと残高、満期、オラクル準備) */
  ethMenuContext: (address: string, productId: string, action: "deposit" | "withdraw") =>
    request<PendleTradeContext>(
      `/eth/menu/context?address=${encodeURIComponent(address)}&productId=${encodeURIComponent(productId)}&action=${action}`
    ),
  /** state: "fork" = fork の状態で確かめる (fork 上の swap の続きなど) */
  ethMenuPlan: (input: MenuPlanRequest & { state?: "fork" }) => request<ActionPlan>("/eth/menu/plan", { method: "POST", body: JSON.stringify(input) }),
  /** Menu の deposit / withdraw を fork で実行 (ユーザーがボタンで承認した時だけ) */
  ethMenuExecuteOnFork: (input: MenuPlanRequest) =>
    request<ForkExecution>("/eth/menu/execute", { method: "POST", body: JSON.stringify({ ...input, approvedBy: "user" }) }),
  ethBuildAction: (owner: string, eventId: string, actionType: string) =>
    request<ActionPlan>("/eth/build-action", { method: "POST", body: JSON.stringify({ owner, eventId, actionType }) }),
};

/** BFF src/ethereum/plans.ts ActionPlanSchema と同形 (unsigned、broadcast しない) */
export interface ActionPlan {
  eventId: string;
  actionType: string;
  chainId: number;
  owner: string;
  target: "fork" | "mainnet";
  summary: string;
  steps: Array<{ kind: "approval" | "call"; to: string; data: string; value: string; description: string }>;
  simulation: { ran: boolean; ok?: boolean; error?: string; note: string };
  /** 実行前に知っておくべきこと (cooldown の再スタート、価格 guard の乖離など) */
  warnings?: string[];
  builtAt: string;
  source: string;
  broadcast: false;
}

/** BFF src/ethereum/menu-actions.ts MenuPlanInput と同形 (amount は人が入力した decimal string) */
export interface MenuPlanRequest {
  owner: string;
  productId: string;
  action: "deposit" | "withdraw";
  amount: string;
  token?: string;
}

/** BFF GET /eth/menu/context と同形 */
export interface PendleTradeContext {
  oracleReady: boolean;
  matured: boolean;
  maturity: string;
  /** 買う時に払う / 売る時に受け取るトークン (残高付き) */
  token: TokenAmountView;
  /** PT / YT 自体 (残高付き) */
  pyToken: TokenAmountView;
}

/** BFF src/ethereum/proposals.ts ProposalSchema と同形 */
export interface Proposal {
  eventId: string;
  generator: "rule-based";
  summary: string;
  facts: string[];
  assumptions: string[];
  options: Array<{
    id: string;
    label: string;
    currentYield: number | null;
    yieldSource: string | null;
    liquidityClass: "instant" | "cooldown" | "queue" | "dated";
    durationDays: number | null;
    risks: string[];
    firstAction: string | null;
  }>;
  recommendedOptionId: string;
  reason: string;
  builtAt: string;
}

/** /eth/status — 各 integration の設定有無のみ (値は返さない) */
export interface EthStatus {
  rpcConfigured: boolean;
  uniswapConfigured: boolean;
  llmConfigured: boolean;
  executionTarget: "fork" | "mainnet";
  forkReachable: boolean;
  chainId: number | null;
  latestBlock: string | null;
}

export interface ForkExecution {
  target: "fork";
  plan: ActionPlan;
  txs: Array<{ hash: string; status: "success" | "reverted"; blockNumber: string; gasUsed: string; description: string }>;
}

/** BFF src/ethereum/uniswap.ts UniswapPreview と同形 (quote のみ、実行不可) */
export interface UniswapPreview {
  routing: string;
  amountIn: string;
  amountOut: string | null;
  approvalRequired: boolean;
  permitSignatureRequired: boolean;
  gasFeeUsd: string | null;
  executable: false;
  nextStep: string;
  requestId: string | null;
  quotedAt: string;
  source: "uniswap-trading-api";
}

export interface UniswapSwapPlan {
  routing: string;
  amountIn: string;
  amountOut: string | null;
  peg: { ok: boolean; deviationBps: number | null; bandBps: number; reason: string };
  steps: ActionPlan["steps"];
  broadcast: false;
}

export interface AquaShipInput {
  maker: string;
  template: "PEGGED_STABLE";
  usdcAmount: string;
  usdeAmount: string;
  bandBps: number;
  reviewAt: string;
}
export interface AquaShipPlan {
  template: "PEGGED_STABLE";
  maker: string;
  peg: { ok: boolean; deviationBps: number | null; bandBps: number; reason: string };
  strategyHash: string;
  steps: ActionPlan["steps"];
  reviewAt: string;
  broadcast: false;
}

/** BFF src/ethereum/aave.ts AavePositionView と同形 (Aave V4、context のみ) */
export interface AavePositionView {
  spokeName: string;
  spokeAddress: string;
  totalSuppliedUsd: string | null;
  totalDebtUsd: string | null;
  netBalanceUsd: string | null;
  healthFactor: string | null;
  netApy: number | null;
  source: "aavekit";
  observedAt: string;
}
