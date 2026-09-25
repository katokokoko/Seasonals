/**
 * Uniswap Trading API proxy (Ethereum v3 §3 Uniswap Trading API)
 *
 * - server 側のみ: UNISWAP_API_KEY を x-api-key header に付ける。key は client に渡さない
 * - 仕様: trade-api.gateway.uniswap.org/v1 OpenAPI (api.json, 2026-09-26 確認)
 *   /check_approval {walletAddress, token, amount, chainId} → /quote {type, amount, tokenInChainId,
 *   tokenOutChainId, tokenIn, tokenOut, swapper, slippageTolerance} → routing で分岐
 *   (CLASSIC/WRAP/UNWRAP/BRIDGE → /swap、DUTCH_V2/V3/PRIORITY → /order、CHAINED → MVP では拒否)
 * - ここでは quote と承認要否の preview のみ。swap は価格依存の action なので、fail-closed の
 *   価格ガード (Chainlink の鮮度・乖離) を入れるまで実行経路を作らない (WORKLOG #11)
 */
import { MAINNET_CHAIN_ID } from "./config";
import { sanitizeError, undiciFetch } from "./client";

const TRADE_API = "https://trade-api.gateway.uniswap.org/v1";

export class UniswapError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
  }
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const key = process.env.UNISWAP_API_KEY?.trim();
  if (!key) throw new UniswapError(503, "Uniswap Trading API key is not configured on this server.");
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const res = await undiciFetch()(`${TRADE_API}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", "x-api-key": key },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const json = (await res.json().catch(() => null)) as (T & { errorCode?: string; detail?: string }) | null;
    if (!res.ok) throw new UniswapError(res.status, `Uniswap ${path} → HTTP ${res.status}${json?.errorCode ? ` ${json.errorCode}` : ""}${json?.detail ? `: ${json.detail}` : ""}`);
    return json as T;
  } catch (e) {
    if (e instanceof UniswapError) throw e;
    throw new UniswapError(502, sanitizeError(e));
  } finally {
    clearTimeout(t);
  }
}

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

interface ApprovalResponse {
  approval?: unknown | null;
  cancel?: unknown | null;
}
interface QuoteResponse {
  requestId?: string;
  routing: string;
  quote: {
    input?: { amount?: string };
    output?: { amount?: string };
    gasFeeUSD?: string;
    orderInfo?: { outputs?: Array<{ startAmount?: string }> };
  };
  permitData?: unknown | null;
}

export function summarizeQuote(q: QuoteResponse, amountIn: string, approvalRequired: boolean): UniswapPreview {
  const amountOut = q.quote.output?.amount ?? q.quote.orderInfo?.outputs?.[0]?.startAmount ?? null;
  const classic = ["CLASSIC", "WRAP", "UNWRAP", "BRIDGE"].includes(q.routing);
  const order = ["DUTCH_V2", "DUTCH_V3", "PRIORITY"].includes(q.routing);
  return {
    routing: q.routing,
    amountIn,
    amountOut: amountOut && /^[0-9]+$/.test(amountOut) ? amountOut : null,
    approvalRequired,
    permitSignatureRequired: q.permitData != null,
    gasFeeUsd: typeof q.quote.gasFeeUSD === "string" ? q.quote.gasFeeUSD : null,
    executable: false,
    nextStep: q.routing === "CHAINED"
      ? "Multi-step route: not supported in this MVP."
      : classic
        ? "Would continue with /swap (unsigned transaction). Not wired: a swap is price-dependent and needs the fail-closed price guard first."
        : order
          ? "UniswapX order route: would sign an order and POST /order. Not wired in this MVP."
          : "Unknown routing; not executable.",
    requestId: q.requestId ?? null,
    quotedAt: new Date().toISOString(),
    source: "uniswap-trading-api",
  };
}

export async function uniswapPreview(input: { swapper: string; tokenIn: string; tokenOut: string; amount: string }): Promise<UniswapPreview> {
  const approval = await post<ApprovalResponse>("/check_approval", {
    walletAddress: input.swapper,
    token: input.tokenIn,
    amount: input.amount,
    chainId: MAINNET_CHAIN_ID,
  });
  const q = await post<QuoteResponse>("/quote", {
    type: "EXACT_INPUT",
    amount: input.amount,
    tokenInChainId: MAINNET_CHAIN_ID,
    tokenOutChainId: MAINNET_CHAIN_ID,
    tokenIn: input.tokenIn,
    tokenOut: input.tokenOut,
    swapper: input.swapper,
    slippageTolerance: 0.5,
  });
  return summarizeQuote(q, input.amount, approval.approval != null);
}
