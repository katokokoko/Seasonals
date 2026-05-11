/**
 * jupiter-swap — Jupiter Swap public API client (Phase 8.5)
 *
 * Public REST API (no auth) で USDC → jlUSDC 等の deposit を含む任意 token swap の
 * quote + serialized transaction を取得する。Seasonals 本番 deposit flow の primitive。
 *
 * 1) quote: GET /swap/v1/quote
 * 2) tx:    POST /swap/v1/swap  body: { quoteResponse, userPublicKey, ... }
 *
 * Returns base64 versioned transaction → Mobile 側で deserialize → MWA sign + send。
 *
 * 規約 (CLAUDE.md §4.5):
 *   - amount は smallest unit string、parse はしない (passthrough)
 *   - outAmount / priceImpactPct は string でそのまま保持
 */

const JUP_BASE = "https://lite-api.jup.ag";

export interface JupSwapQuote {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  priceImpactPct: string;
  routePlan: unknown[];
  contextSlot?: number;
  timeTaken?: number;
}

export interface JupSwapTxResponse {
  swapTransaction: string;
  lastValidBlockHeight: number;
  prioritizationFeeLamports?: number;
}

export async function fetchSwapQuote(params: {
  inputMint: string;
  outputMint: string;
  amount: string;
  slippageBps?: number;
}): Promise<JupSwapQuote> {
  const slippage = params.slippageBps ?? 50;
  const url = `${JUP_BASE}/swap/v1/quote?inputMint=${encodeURIComponent(
    params.inputMint
  )}&outputMint=${encodeURIComponent(params.outputMint)}&amount=${encodeURIComponent(
    params.amount
  )}&slippageBps=${slippage}`;
  const res = await fetch(url, {
    method: "GET",
    headers: { accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(
      `Jupiter swap quote HTTP ${res.status}: ${await res.text().catch(() => "")}`
    );
  }
  return (await res.json()) as JupSwapQuote;
}

export async function fetchSwapTransaction(params: {
  quoteResponse: JupSwapQuote;
  userPublicKey: string;
  prioritizationFeeLamports?: number | "auto";
  dynamicComputeUnitLimit?: boolean;
}): Promise<JupSwapTxResponse> {
  const res = await fetch(`${JUP_BASE}/swap/v1/swap`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      quoteResponse: params.quoteResponse,
      userPublicKey: params.userPublicKey,
      dynamicComputeUnitLimit: params.dynamicComputeUnitLimit ?? true,
      prioritizationFeeLamports: params.prioritizationFeeLamports ?? "auto",
    }),
  });
  if (!res.ok) {
    throw new Error(
      `Jupiter swap tx HTTP ${res.status}: ${await res.text().catch(() => "")}`
    );
  }
  return (await res.json()) as JupSwapTxResponse;
}
