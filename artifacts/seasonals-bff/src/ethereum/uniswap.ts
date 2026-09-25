/**
 * Uniswap Trading API proxy (Ethereum v3 §3 Uniswap Trading API)
 *
 * - server 側のみ: UNISWAP_API_KEY を x-api-key header に付ける。key は client に渡さない
 * - 仕様: trade-api.gateway.uniswap.org/v1 OpenAPI (api.json, 2026-09-26 確認)
 *   /check_approval {walletAddress, token, amount, chainId} → /quote {type, amount, tokenInChainId,
 *   tokenOutChainId, tokenIn, tokenOut, swapper, slippageTolerance} → routing で分岐
 *   (CLASSIC/WRAP/UNWRAP/BRIDGE → /swap、DUTCH_V2/V3/PRIORITY → /order、CHAINED → MVP では拒否)
 * - preview (quote + 承認要否) と、USDC ⇄ USDe に限った swap plan。swap は価格依存の action なので
 *   Chainlink の peg guard (鮮度・乖離、fail-closed) を通った時だけ plan を作り、実行は Anvil fork のみ (WORKLOG #11)
 */
import { MAINNET_CHAIN_ID } from "./config";
import { sanitizeError, undiciFetch } from "./client";
import { checkPeg, type PegCheck } from "./pricing";
import type { TxStep } from "./plans";
import { assertForkEndpoint, forkClients, recordExecuted, sendStepsOnFork } from "./execute";

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
        ? "Continues with /swap as an unsigned transaction. Execution is price-dependent: it runs only after the Chainlink peg guard passes (USDC ⇄ USDe), and only on the local fork."
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

// ── swap plan (unsigned) — 価格依存なので fail-closed の peg guard を先に通す ──────────

const STABLE_PAIRS: Record<string, { in: "USDC" | "USDe"; out: "USDC" | "USDe" }> = {
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48>0x4c9edd5852cd905f086c759e8383e09bff1e68b3": { in: "USDC", out: "USDe" },
  "0x4c9edd5852cd905f086c759e8383e09bff1e68b3>0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": { in: "USDe", out: "USDC" },
};
export const SWAP_PEG_BAND_BPS = 50;

export interface UniswapSwapPlan {
  routing: string;
  amountIn: string;
  amountOut: string | null;
  peg: PegCheck;
  steps: TxStep[];
  simulation: { ran: boolean; ok?: boolean; error?: string; note: string };
  broadcast: false;
  source: "uniswap-trading-api";
}

interface TxLike {
  to: string;
  data: string;
  value?: string;
}

/**
 * USDC ⇄ USDe の unsigned swap plan。
 * 1) Chainlink peg guard (±50 bps、stale / 欠損は refuse) 2) /check_approval の approval tx
 * 3) /quote (generatePermitAsTransaction: true → Permit2 の許可も通常 tx として返る = 署名不要)
 * 4) /swap。CLASSIC 系 routing 以外は拒否。
 */
export async function buildUniswapSwapPlan(
  input: { swapper: string; tokenIn: string; tokenOut: string; amount: string },
  opts: { deadlineSec?: number } = {}
): Promise<UniswapSwapPlan> {
  const pair = STABLE_PAIRS[`${input.tokenIn.toLowerCase()}>${input.tokenOut.toLowerCase()}`];
  if (!pair) throw new UniswapError(409, "Only USDC ⇄ USDe swaps are supported (they have a Chainlink peg guard).");
  const peg = await checkPeg(pair.in, pair.out, SWAP_PEG_BAND_BPS);
  if (!peg.ok) throw new UniswapError(409, `Price guard refused the swap: ${peg.reason}`);

  const approval = await post<{ approval?: TxLike | null }>("/check_approval", {
    walletAddress: input.swapper,
    token: input.tokenIn,
    amount: input.amount,
    chainId: MAINNET_CHAIN_ID,
  });
  const q = await post<QuoteResponse & { permitTransaction?: TxLike | null }>("/quote", {
    type: "EXACT_INPUT",
    amount: input.amount,
    tokenInChainId: MAINNET_CHAIN_ID,
    tokenOutChainId: MAINNET_CHAIN_ID,
    tokenIn: input.tokenIn,
    tokenOut: input.tokenOut,
    swapper: input.swapper,
    slippageTolerance: 0.5,
    generatePermitAsTransaction: true,
  });
  if (!["CLASSIC", "WRAP", "UNWRAP"].includes(q.routing)) throw new UniswapError(409, `Routing ${q.routing} is not supported for execution in this MVP.`);
  if (q.permitData != null) throw new UniswapError(409, "The quote needs an off-chain Permit2 signature; this MVP only executes transaction-based permits.");
  // fork は時間送り後に実時間より進んでいることがあるため、fork 実行時は fork の時刻基準の deadline を渡す
  const swap = await post<{ swap: TxLike }>("/swap", { quote: q.quote, ...(opts.deadlineSec ? { deadline: opts.deadlineSec } : {}) });
  const tx = (t: TxLike, kind: TxStep["kind"], description: string): TxStep => ({
    kind,
    to: t.to,
    data: t.data,
    value: t.value && /^0x/.test(t.value) ? BigInt(t.value).toString() : (t.value ?? "0"),
    description,
  });
  const steps: TxStep[] = [
    ...(approval.approval ? [tx(approval.approval, "approval", `Approve Permit2 to spend ${pair.in}.`)] : []),
    ...(q.permitTransaction ? [tx(q.permitTransaction, "approval", "Allow the Uniswap router through Permit2 (as a transaction, no signature).")] : []),
    tx(swap.swap, "call", `Swap ${pair.in} → ${pair.out} through Uniswap (${q.routing}).`),
  ];
  const summary = summarizeQuote(q, input.amount, Boolean(approval.approval));
  return {
    routing: q.routing,
    amountIn: input.amount,
    amountOut: summary.amountOut,
    peg,
    steps,
    simulation: { ran: false, note: "Swap steps depend on each other (approve → permit → swap); checked by executing on the fork." },
    broadcast: false,
    source: "uniswap-trading-api",
  };
}

export async function executeUniswapSwapOnFork(input: { swapper: string; tokenIn: string; tokenOut: string; amount: string }) {
  await assertForkEndpoint();
  const forkBlock = await forkClients().pub.getBlock();
  const plan = await buildUniswapSwapPlan(input, { deadlineSec: Number(forkBlock.timestamp) + 1_800 });
  const txs = await sendStepsOnFork(input.swapper as `0x${string}`, plan.steps);
  const ok = txs.length === plan.steps.length && txs.every((t) => t.status === "success");
  const executedEvent = await recordExecuted({
    owner: input.swapper,
    title: plan.steps[plan.steps.length - 1]!.description,
    protocol: "uniswap",
    protocolName: "Uniswap",
    txs,
    ok,
  });
  return { target: "fork" as const, plan, txs, executedEvent };
}
