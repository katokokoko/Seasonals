/**
 * Agent rebalance proposals (Ethereum) — MCP が提案し、人が承認し、fork で実行する。
 *
 * - 提出: 各 step の未署名プランを既存 builder で組み、guard (peg / TWAP / 残高 / 商品の有無) を fail-closed で通す。
 *   前 step の残高に依存する step だけは `insufficient_balance` を「fork 実行時に検証」として保留する
 * - 承認: web の Agent ページ (via:"web") か chat での明示的な yes (via:"chat")。どちらも同じ execute に来る。
 *   execute は提出時の bundleHash (`{id, owner, steps}` の canonical sha256) の一致を要求する
 * - 実行: fork のみ (assertForkEndpoint)。各 step は既存の executor (`executeMenuOnFork` / `executeUniswapSwapOnFork`
 *   / `executeOnFork`) をそのまま呼ぶ。executor 側が executed event を記録するので、ここでは記録しない
 * - Agent は署名しない / mainnet 送信経路なし (Ethereum v3 §9)。認証は v1 では無し (既存 /eth/execute と同水準)
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  EthAgentProposal,
  EthPlanEffects,
  EthProposalApprovalVia,
  EthProposalBriefResponse,
  EthProposalPreviewSlot,
  EthProposalStep,
  EthProposalStepResult,
  TimelineEvent,
} from "@workspace/lib/types";
import { PROPOSAL_NAME_MAX, PROPOSAL_TAGLINE_MAX, SWAP_SYMBOLS } from "@workspace/lib/types";
import { isEvmAddress } from "@workspace/lib/config/chains";
import { ETH_ASSET_ADDRESS, findEthAsset } from "@workspace/lib/config/eth-assets";
import { toSmallestUnit } from "@workspace/lib/utils/numeric";
import { computeBundleHash } from "../plan-store";
import { loadJson, saveJson } from "../persistence";
import { sanitizeError } from "./client";
import { baseEvent } from "./common";
import { registerUserSource, _invalidateUser } from "./events";
import { assertForkEndpoint, executeMenuOnFork, executeOnFork } from "./execute";
import { _invalidateHoldings } from "./holdings";
import { buildMenuPlan } from "./menu-actions";
import { buildActionPlan, PlanError } from "./plans";
import { buildAquaShipPlan, shipAquaOnFork, type AquaShipInput } from "./aqua";
import { buildStrategyBrief } from "./strategy-brief";
import { buildUniswapSwapPlan, executeUniswapSwapOnFork } from "./uniswap";

export const MAX_PROPOSAL_STEPS = 6;
const TTL_MS = 24 * 60 * 60_000;

const decimalAmount = z.string().regex(/^[0-9]+(\.[0-9]+)?$/, "amount must be a decimal string like \"100\" or \"1.5\"");
export const StepSchema: z.ZodType<EthProposalStep> = z
  .discriminatedUnion("kind", [
    z.object({
      kind: z.literal("menu"),
      productId: z.string().min(1),
      action: z.enum(["deposit", "withdraw"]),
      amount: decimalAmount,
      token: z.string().min(1).optional(),
    }),
    z.object({
      kind: z.literal("uniswap_swap"),
      tokenIn: z.enum(SWAP_SYMBOLS),
      tokenOut: z.enum(SWAP_SYMBOLS),
      amount: decimalAmount,
    }),
    z.object({
      kind: z.literal("event_action"),
      eventId: z.string().min(1),
      actionType: z.string().regex(/^[a-z_]+$/),
    }),
    z.object({
      kind: z.literal("aqua_ship"),
      usdc: decimalAmount,
      usde: decimalAmount,
      bandBps: z.number().int().min(10).max(200),
      reviewAt: z.string().datetime(),
      feeBps: z.number().int().min(1).max(30).optional(),
    }),
  ])
  .refine((s) => s.kind !== "uniswap_swap" || s.tokenIn !== s.tokenOut, { message: "tokenIn and tokenOut must differ" });
/** 戦略名: 絵文字 + 短い英語名 (code point で数える)。文字を 1 つは含む */
const nameSchema = z
  .string()
  .trim()
  .refine((s) => [...s].length >= 1 && [...s].length <= PROPOSAL_NAME_MAX, `name must be 1–${PROPOSAL_NAME_MAX} characters`)
  .refine((s) => /\p{L}/u.test(s), "name must contain at least one letter");
export const SubmitSchema = z.object({
  owner: z.string().refine(isEvmAddress, "owner must be a 0x-prefixed 20-byte address"),
  name: nameSchema,
  tagline: z.string().trim().min(1).max(PROPOSAL_TAGLINE_MAX).optional(),
  rationale: z.string().trim().min(1).max(2000),
  steps: z.array(StepSchema).min(1).max(MAX_PROPOSAL_STEPS),
});

export class ProposalError extends Error {
  constructor(
    public readonly code: "invalid_argument" | "not_found" | "invalid_status" | "bundle_hash_mismatch" | "expired" | "already_executing",
    message: string,
    public readonly status: 400 | 404 | 409
  ) {
    super(message);
  }
}

// ── store (aqua.ts と同じ遅延 load + 原子的 save) ─────────────────────────────

const STORE = "eth-agent-proposals";
let proposals: EthAgentProposal[] | null = null;
function store(): EthAgentProposal[] {
  if (!proposals) {
    // brief の無い旧形式 (title のみ) は読まない (dev データ)
    proposals = (loadJson<EthAgentProposal[]>(STORE) ?? []).filter((p) => typeof p.name === "string" && p.brief);
    // 実行中にプロセスが落ちた proposal はロックが残らないよう failed にする
    for (const p of proposals) {
      if (p.status === "executing") {
        p.status = "failed";
        p.updatedAt = new Date().toISOString();
        if (p.execution) p.execution.finishedAt ??= p.updatedAt;
      }
    }
  }
  return proposals;
}
const persist = () => saveJson(STORE, store());

const executing = new Set<string>();

export function _resetAgentProposalsForTest() {
  proposals = [];
  executing.clear();
}

/** pending のまま期限を過ぎた proposal は expired に (読む側で lazy に適用) */
function applyExpiry(p: EthAgentProposal, now: number): EthAgentProposal {
  if (p.status === "pending" && Date.parse(p.expiresAt) <= now) {
    p.status = "expired";
    p.updatedAt = new Date(now).toISOString();
    persist();
  }
  return p;
}

export function listProposals(owner: string): EthAgentProposal[] {
  const now = Date.now();
  return store()
    .filter((p) => p.owner.toLowerCase() === owner.toLowerCase())
    .map((p) => applyExpiry(p, now))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function getProposal(id: string): EthAgentProposal {
  const p = store().find((x) => x.id === id);
  if (!p) throw new ProposalError("not_found", "No proposal with that id.", 404);
  return applyExpiry(p, Date.now());
}

// ── step → 既存 builder の入力 ────────────────────────────────────────────────

/** symbol + decimal → Uniswap route の address + smallest unit (変換はここだけ、CLAUDE.md §3) */
export function swapInput(owner: string, step: Extract<EthProposalStep, { kind: "uniswap_swap" }>) {
  const tokenIn = ETH_ASSET_ADDRESS[step.tokenIn];
  const tokenOut = ETH_ASSET_ADDRESS[step.tokenOut];
  const decimals = findEthAsset(tokenIn.toLowerCase())?.decimals;
  if (decimals === undefined) throw new PlanError("unsupported_action", `${step.tokenIn} is not in the asset registry.`);
  let amount: string;
  try {
    amount = toSmallestUnit(step.amount, decimals);
  } catch {
    throw new PlanError("invalid_amount", `Enter a positive ${step.tokenIn} amount with at most ${decimals} decimals.`);
  }
  if (BigInt(amount) === 0n) throw new PlanError("invalid_amount", "Enter an amount greater than zero.");
  return { swapper: owner, tokenIn, tokenOut, amount };
}

/** Aqua ship の decimal → AquaShipInput (smallest unit)。変換はここだけ */
export function aquaInput(owner: string, step: Extract<EthProposalStep, { kind: "aqua_ship" }>): AquaShipInput {
  const conv = (v: string, decimals: number, symbol: string) => {
    let out: string;
    try {
      out = toSmallestUnit(v, decimals);
    } catch {
      throw new PlanError("invalid_amount", `Enter a positive ${symbol} amount with at most ${decimals} decimals.`);
    }
    if (BigInt(out) === 0n) throw new PlanError("invalid_amount", `Enter a ${symbol} amount greater than zero.`);
    return out;
  };
  return {
    maker: owner,
    template: "PEGGED_STABLE",
    usdcAmount: conv(step.usdc, 6, "USDC"),
    usdeAmount: conv(step.usde, 18, "USDe"),
    bandBps: step.bandBps,
    reviewAt: step.reviewAt,
    ...(step.feeBps !== undefined ? { feeBps: step.feeBps } : {}),
  };
}

function describeStep(step: EthProposalStep): string {
  switch (step.kind) {
    case "menu":
      return `${step.action === "deposit" ? "Deposit" : "Withdraw"} ${step.amount}${step.token ? ` ${step.token}` : ""} — ${step.productId}`;
    case "uniswap_swap":
      return `Swap ${step.amount} ${step.tokenIn} → ${step.tokenOut} (Uniswap)`;
    case "event_action":
      return `${step.actionType} on ${step.eventId}`;
    case "aqua_ship":
      return `Ship Aqua USDC/USDe LP (${step.usdc} USDC + ${step.usde} USDe, ±${(step.bandBps / 100).toFixed(2)}%)`;
  }
}

const SWAP_DECIMALS: Record<string, number> = { USDC: 6, USDe: 18 };

/**
 * 1 step の未署名プランを組んで preview にする (mainnet 状態)。
 * index > 0 で残高不足の時だけ「前 step の残高を使う」として保留する。他のエラーは fail-closed で propagate
 */
export async function previewStep(owner: string, step: EthProposalStep, index: number): Promise<EthProposalPreviewSlot> {
  try {
    switch (step.kind) {
      case "menu": {
        const plan = await buildMenuPlan({ owner, productId: step.productId, action: step.action, amount: step.amount, ...(step.token ? { token: step.token } : {}) });
        return { ok: true, preview: { summary: plan.summary, warnings: plan.warnings ?? [], simulation: plan.simulation, ...(plan.effects ? { effects: plan.effects } : {}) } };
      }
      case "uniswap_swap": {
        const input = swapInput(owner, step);
        const plan = await buildUniswapSwapPlan(input);
        const last = plan.steps[plan.steps.length - 1]!;
        const warnings = plan.peg.deviationBps !== null && plan.peg.deviationBps !== 0 ? [`Price guard: ${plan.peg.reason}`] : [];
        const effects: EthPlanEffects | undefined = plan.amountOut
          ? {
              in: [{ key: input.tokenIn.toLowerCase(), value: input.amount, decimals: SWAP_DECIMALS[step.tokenIn]!, symbol: step.tokenIn }],
              out: [{ key: input.tokenOut.toLowerCase(), value: plan.amountOut, decimals: SWAP_DECIMALS[step.tokenOut]!, symbol: step.tokenOut }],
              approx: true,
            }
          : undefined;
        return {
          ok: true,
          preview: { summary: last.description, warnings, simulation: plan.simulation, ...(plan.amountOut ? { amountOut: plan.amountOut } : {}), ...(effects ? { effects } : {}) },
        };
      }
      case "event_action": {
        const plan = await buildActionPlan({ owner, eventId: step.eventId, actionType: step.actionType });
        return { ok: true, preview: { summary: plan.summary, warnings: plan.warnings ?? [], simulation: plan.simulation } };
      }
      case "aqua_ship": {
        const plan = await buildAquaShipPlan(aquaInput(owner, step));
        const last = plan.steps[plan.steps.length - 1]!;
        const warnings = [`Price guard: ${plan.peg.reason}`];
        return { ok: true, preview: { summary: last.description, warnings, simulation: { ran: false, note: "Approve → ship depend on each other; checked by executing on the fork." } } };
      }
    }
  } catch (e) {
    if (index > 0 && e instanceof PlanError && e.code === "insufficient_balance") {
      return { ok: false, note: `Uses balances produced by an earlier step; checked on the fork when it runs. (${e.message})` };
    }
    throw e;
  }
}

// ── submit / reject / execute ───────────────────────────────────────────────

/** validate → 各 step の preview (guard は fail-closed) → Strategy Brief。保存はしない */
export async function prepareProposal(input: unknown): Promise<EthProposalBriefResponse> {
  const parsed = SubmitSchema.safeParse(input);
  if (!parsed.success) throw new ProposalError("invalid_argument", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "), 400);
  const { owner, name, tagline, rationale, steps } = parsed.data;
  const previews: EthProposalPreviewSlot[] = [];
  for (const [i, step] of steps.entries()) previews.push(await previewStep(owner, step, i));
  const brief = await buildStrategyBrief({ owner, name, ...(tagline ? { tagline } : {}), steps, previews });
  return { owner, name, ...(tagline ? { tagline } : {}), rationale, steps, previews, brief };
}

/** dry run (`POST /eth/agent-proposals/brief`): Agent が brief を見て練り直すため。何も保存しない */
export const previewProposal = prepareProposal;

export async function submitProposal(input: unknown): Promise<EthAgentProposal> {
  const { owner, name, tagline, rationale, steps, previews, brief } = await prepareProposal(input);
  const now = new Date();
  const id = `ethprop_${randomUUID()}`;
  const proposal: EthAgentProposal = {
    id,
    owner,
    name,
    ...(tagline ? { tagline } : {}),
    rationale,
    steps,
    previews,
    brief,
    bundleHash: computeBundleHash({ id, owner: owner.toLowerCase(), steps }),
    status: "pending",
    createdBy: "mcp",
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + TTL_MS).toISOString(),
  };
  store().push(proposal);
  persist();
  _invalidateUser(owner);
  return proposal;
}

export function rejectProposal(id: string): EthAgentProposal {
  const p = getProposal(id);
  if (p.status !== "pending") throw new ProposalError("invalid_status", `This proposal is ${p.status}; only pending proposals can be rejected.`, 409);
  p.status = "rejected";
  p.updatedAt = new Date().toISOString();
  persist();
  _invalidateUser(p.owner);
  return p;
}

async function runStep(owner: string, step: EthProposalStep): Promise<{ summary: string; txs: EthProposalStepResult["txs"]; ok: boolean }> {
  switch (step.kind) {
    case "menu": {
      const r = await executeMenuOnFork({ owner, productId: step.productId, action: step.action, amount: step.amount, ...(step.token ? { token: step.token } : {}) });
      return { summary: r.plan.summary, txs: r.txs, ok: r.txs.length === r.plan.steps.length && r.txs.every((t) => t.status === "success") };
    }
    case "uniswap_swap": {
      const r = await executeUniswapSwapOnFork(swapInput(owner, step));
      return {
        summary: r.plan.steps[r.plan.steps.length - 1]!.description,
        txs: r.txs,
        ok: r.txs.length === r.plan.steps.length && r.txs.every((t) => t.status === "success"),
      };
    }
    case "event_action": {
      const r = await executeOnFork({ owner, eventId: step.eventId, actionType: step.actionType });
      return { summary: r.plan.summary, txs: r.txs, ok: r.txs.length === r.plan.steps.length && r.txs.every((t) => t.status === "success") };
    }
    case "aqua_ship": {
      const r = await shipAquaOnFork(aquaInput(owner, step));
      return {
        summary: r.plan.steps[r.plan.steps.length - 1]!.description,
        txs: r.txs,
        ok: r.txs.length === r.plan.steps.length && r.txs.every((t) => t.status === "success"),
      };
    }
  }
}

/**
 * 人が承認した proposal を fork で順に実行する。最初に失敗した step で止める (後続は走らせない)。
 * 呼び出し側 (route) が approvedBy:"user" を確認済み。ここでは bundleHash / status / 期限 / 二重実行を検査する
 */
export async function executeProposal(id: string, input: { bundleHash: string; via: EthProposalApprovalVia }): Promise<EthAgentProposal> {
  const p = getProposal(id);
  if (p.status === "expired") throw new ProposalError("expired", "This proposal has expired. Ask the Agent to propose again.", 409);
  if (p.status !== "pending") throw new ProposalError("invalid_status", `This proposal is ${p.status}; only pending proposals can be executed.`, 409);
  if (p.bundleHash !== input.bundleHash) {
    throw new ProposalError("bundle_hash_mismatch", "The approval does not match the proposal that was shown. Re-read the proposal and approve again.", 409);
  }
  await assertForkEndpoint();
  if (executing.has(id)) throw new ProposalError("already_executing", "This proposal is already being executed.", 409);
  executing.add(id);
  try {
    p.status = "executing";
    p.execution = { startedAt: new Date().toISOString(), via: input.via, steps: [] };
    p.updatedAt = p.execution.startedAt;
    persist();
    for (const [index, step] of p.steps.entries()) {
      let result: EthProposalStepResult;
      try {
        const r = await runStep(p.owner, step);
        result = { index, ok: r.ok, summary: r.summary, txs: r.txs, ...(r.ok ? {} : { error: "A transaction reverted on the fork." }) };
      } catch (e) {
        result = { index, ok: false, summary: describeStep(step), txs: [], error: sanitizeError(e) };
      }
      p.execution.steps.push(result);
      persist();
      if (!result.ok) break;
    }
    p.status = p.execution.steps.length === p.steps.length && p.execution.steps.every((s) => s.ok) ? "executed" : "failed";
    p.execution.finishedAt = new Date().toISOString();
    p.updatedAt = p.execution.finishedAt;
    persist();
    _invalidateHoldings(p.owner);
    _invalidateUser(p.owner);
    return p;
  } finally {
    executing.delete(id);
  }
}

// ── calendar (承認待ちの proposal を user_plan として見せる) ───────────────────

export function deriveProposalEvent(p: EthAgentProposal, observedAt: string): TimelineEvent {
  return baseEvent({
    id: `ethereum:agent:proposal:${p.id}`,
    class: "user_plan",
    kind: "agent_proposal",
    protocol: null,
    protocolName: null,
    title: `Agent proposal: ${p.name}`,
    at: p.createdAt,
    owner: p.owner,
    settled: false,
    etaNote: p.status === "executing" ? "Running on the local fork now." : `Waiting for your approval until ${p.expiresAt.slice(0, 10)}.`,
    metrics: [
      { label: "Steps", kind: "text", value: p.steps.map(describeStep).join(" → ") },
      { label: "Status", kind: "text", value: p.status },
    ],
    actions: [],
    links: [{ label: "Review on the Agent page", url: "/agent" }],
    source: "agent-proposals",
    observedAt,
  });
}

registerUserSource((owner) => ({
  name: "agent:proposals",
  needsRpc: false,
  run: async (t) =>
    listProposals(owner)
      .filter((p) => p.status === "pending" || p.status === "executing")
      .map((p) => deriveProposalEvent(p, t)),
}));
