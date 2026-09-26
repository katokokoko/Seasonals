/**
 * 1inch Aqua + SwapVM — LP sleeve (Ethereum v3 §3 1inch Aqua + SwapVM、§7 guardrails)
 *
 * - Path B: 既存の SwapVM opcode (SDK の AquaPeggedAmmStrategy) と deploy 済みの AquaSwapVMRouter。
 *   任意の SwapVM program は作らない。template は PEGGED_STABLE (USDC/USDe) のみ受け付け、
 *   parameter はアプリ側で検証する (帯域 0.1–2%、金額 > 0、保有残高以内、review 日は未来 ≤ 180 日)
 * - ship の前に Chainlink peg guard (±50 bps、fail-closed)。pegged 戦略は peg が崩れると LP が損をするため
 * - ship / dock は unsigned plan。実行は Anvil fork のみ (production の taker 経路は KYB 済み resolver 限定)
 * - ship 後に「strategy review」event (Agent が決めた日付) を作り、そこから dock できる
 * - SDK の ESM build は内部 import が壊れているため CJS で読む (2026-09-26、@1inch/swap-vm-sdk 0.4.4)
 */
import { randomBytes } from "node:crypto";
import { encodeFunctionData, parseAbi, type Hex } from "viem";
import type { TimelineEvent } from "@workspace/lib/types";
import { getEthClient } from "./client";
import { checkPeg, type PegCheck } from "./pricing";
import { PlanError, type TxStep } from "./plans";
import { assertForkEndpoint, forkClients, recordExecuted, sendStepsOnFork } from "./execute";
import { registerUserSource, _invalidateUser } from "./events";
import { baseEvent } from "./common";
import { loadJson, saveJson } from "../persistence";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const aquaSdk = require("@1inch/aqua-sdk") as typeof import("@1inch/aqua-sdk");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const vmSdk = require("@1inch/swap-vm-sdk") as typeof import("@1inch/swap-vm-sdk");

export const AQUA = {
  aqua: aquaSdk.AQUA_CONTRACT_ADDRESSES[1].toString(),
  router: vmSdk.AQUA_SWAP_VM_CONTRACT_ADDRESSES[1].toString(),
  USDC: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  USDe: "0x4c9EDD5852cd905f086C759E8383e09bff1E68B3",
} as const;

export const AQUA_TEMPLATES = ["PEGGED_STABLE"] as const;
export type AquaTemplate = (typeof AQUA_TEMPLATES)[number];

const erc20 = parseAbi([
  "function approve(address,uint256) returns (bool)",
  "function allowance(address,address) view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
]);

export interface AquaShipInput {
  maker: string;
  template: string;
  /** smallest unit (USDC 6 decimals) */
  usdcAmount: string;
  /** smallest unit (USDe 18 decimals) */
  usdeAmount: string;
  /** peg 帯域 (bps)。10–200 */
  bandBps: number;
  /** review 日 (ISO) */
  reviewAt: string;
  /** taker の入力 token に掛ける fee (bps)。1–30、既定 5 */
  feeBps?: number;
}

export interface AquaShipPlan {
  template: AquaTemplate;
  maker: string;
  peg: PegCheck;
  strategy: string;
  strategyHash: string;
  steps: TxStep[];
  reviewAt: string;
  broadcast: false;
  source: "1inch-aqua-sdk";
}

/** parameter 検証 (v3 §7: AI は template と parameter を選ぶだけ。アプリが検証する) */
export function validateAquaShip(input: AquaShipInput, now = Date.now()): string | null {
  if (!(AQUA_TEMPLATES as readonly string[]).includes(input.template)) return "Only the PEGGED_STABLE template is supported.";
  if (!/^[0-9]+$/.test(input.usdcAmount) || !/^[0-9]+$/.test(input.usdeAmount)) return "Amounts must be smallest-unit integers.";
  if (BigInt(input.usdcAmount) === 0n || BigInt(input.usdeAmount) === 0n) return "Both token amounts must be greater than 0.";
  if (!Number.isInteger(input.bandBps) || input.bandBps < 10 || input.bandBps > 200) return "The peg band must be between 10 and 200 bps.";
  if (input.feeBps !== undefined && (!Number.isInteger(input.feeBps) || input.feeBps < 1 || input.feeBps > 30)) return "The fee must be between 1 and 30 bps.";
  const t = Date.parse(input.reviewAt);
  if (!Number.isFinite(t) || t <= now || t > now + 180 * 86_400_000) return "The review date must be in the next 180 days.";
  return null;
}

/**
 * PeggedSwap + Fee + Salt (v3 の template "PeggedSwap + Fee + Controls")。
 * Aqua の戦略は immutable で、同じ hash は dock 後も再 ship できない (fork で revert を確認) ため、
 * ship ごとに salt を付けて hash を一意にする。
 */
function buildOrder(maker: string, usdcAmount: bigint, usdeAmount: bigint, bandBps: number, feeBps: number, salt: bigint) {
  const program = vmSdk.AquaPeggedAmmStrategy.new({
    tokenA: { address: new vmSdk.Address(AQUA.USDC), decimals: 6, reserve: usdcAmount },
    tokenB: { address: new vmSdk.Address(AQUA.USDe), decimals: 18, reserve: usdeAmount },
    linearWidth: vmSdk.instructions.peggedSwap.linearWidthFromSymmetricRangePercent(bandBps / 100),
  })
    .withFeeTokenIn(feeBps)
    .withSalt(salt)
    .build();
  return vmSdk.Order.new({ maker: new vmSdk.Address(maker), program, traits: vmSdk.MakerTraits.default() });
}

export async function buildAquaShipPlan(input: AquaShipInput, opts: { stateClient?: ReturnType<typeof forkClients>["pub"] } = {}): Promise<AquaShipPlan> {
  const invalid = validateAquaShip(input);
  if (invalid) throw new PlanError("action_not_available", invalid);
  const peg = await checkPeg("USDe", "USDC", 50);
  if (!peg.ok) throw new PlanError("action_not_available", `Depeg guard refused the strategy: ${peg.reason}`);
  const client = opts.stateClient ?? getEthClient();
  if (!client) throw new PlanError("rpc_unavailable", "Ethereum RPC is not configured.");
  const maker = input.maker as Hex;
  const usdc = BigInt(input.usdcAmount);
  const usde = BigInt(input.usdeAmount);
  const [balUsdc, balUsde, alUsdc, alUsde] = (await Promise.all([
    client.readContract({ address: AQUA.USDC, abi: erc20, functionName: "balanceOf", args: [maker] }),
    client.readContract({ address: AQUA.USDe, abi: erc20, functionName: "balanceOf", args: [maker] }),
    client.readContract({ address: AQUA.USDC, abi: erc20, functionName: "allowance", args: [maker, AQUA.aqua as Hex] }),
    client.readContract({ address: AQUA.USDe, abi: erc20, functionName: "allowance", args: [maker, AQUA.aqua as Hex] }),
  ])) as bigint[];
  if (balUsdc! < usdc || balUsde! < usde) throw new PlanError("action_not_available", "The maker does not hold enough USDC / USDe for these amounts.");

  const feeBps = input.feeBps ?? 5;
  const salt = BigInt(`0x${randomBytes(8).toString("hex")}`);
  const order = buildOrder(input.maker, usdc, usde, input.bandBps, feeBps, salt);
  const strategy = order.encode().toString();
  const aqua = new aquaSdk.AquaProtocolContract(aquaSdk.AQUA_CONTRACT_ADDRESSES[1]);
  const ship = aqua.ship({
    app: new aquaSdk.Address(AQUA.router),
    strategy: new aquaSdk.HexString(strategy),
    amountsAndTokens: [
      { token: new aquaSdk.Address(AQUA.USDC), amount: usdc },
      { token: new aquaSdk.Address(AQUA.USDe), amount: usde },
    ],
  });
  const approve = (token: string, amount: bigint, sym: string): TxStep => ({
    kind: "approval",
    to: token,
    data: encodeFunctionData({ abi: erc20, functionName: "approve", args: [AQUA.aqua as Hex, amount] }),
    value: "0",
    description: `Allow Aqua to use exactly the ${sym} committed to this strategy (tokens stay in your wallet until a fill).`,
  });
  const steps: TxStep[] = [
    ...(alUsdc! < usdc ? [approve(AQUA.USDC, usdc, "USDC")] : []),
    ...(alUsde! < usde ? [approve(AQUA.USDe, usde, "USDe")] : []),
    {
      kind: "call",
      to: ship.to.toString(),
      data: ship.data.toString(),
      value: "0",
      description: `Ship a USDC/USDe pegged strategy (±${(input.bandBps / 100).toFixed(2)}% band, ${feeBps} bps fee) to the Aqua SwapVM router.`,
    },
  ];
  return {
    template: "PEGGED_STABLE",
    maker: input.maker,
    peg,
    strategy,
    strategyHash: aquaSdk.AquaProtocolContract.calculateStrategyHash(new aquaSdk.HexString(strategy)).toString(),
    steps,
    reviewAt: input.reviewAt,
    broadcast: false,
    source: "1inch-aqua-sdk",
  };
}

// ── shipped strategies (review event の source) ──────────────────────────────

interface ShippedStrategy {
  maker: string;
  strategy: string;
  strategyHash: string;
  bandBps: number;
  usdcAmount: string;
  usdeAmount: string;
  reviewAt: string;
  shippedAt: string;
  docked: boolean;
}
const STORE = "aqua-strategies";
let shipped: ShippedStrategy[] | null = null;
const store = () => (shipped ??= loadJson<ShippedStrategy[]>(STORE) ?? []);
const persist = () => saveJson(STORE, store());

export function deriveStrategyReviewEvent(s: ShippedStrategy, observedAt: string): TimelineEvent {
  return baseEvent({
    id: `ethereum:aqua:strategy_review:${s.strategyHash.toLowerCase()}`,
    class: "user_plan",
    kind: "strategy_review",
    protocol: "aqua",
    protocolName: "1inch Aqua",
    title: s.docked ? "Aqua USDC/USDe strategy docked" : "Review Aqua USDC/USDe strategy",
    asset: "USDC/USDe pegged LP (fork)",
    at: s.reviewAt,
    owner: s.maker,
    settled: s.docked,
    etaNote: "Review date set when the strategy was shipped. Aqua strategies are immutable: to change one, dock it and ship a new one.",
    metrics: [
      { label: "Committed USDC", kind: "token", value: { value: s.usdcAmount, decimals: 6, symbol: "USDC" } },
      { label: "Committed USDe", kind: "token", value: { value: s.usdeAmount, decimals: 18, symbol: "USDe" } },
      { label: "Peg band", kind: "text", value: `±${(s.bandBps / 100).toFixed(2)}%` },
      { label: "Environment", kind: "text", value: "Shipped on the local Anvil fork" },
    ],
    actions: [
      {
        actionType: "aqua_dock",
        label: "Dock strategy",
        requiresWallet: true,
        availability: s.docked ? "not_yet" : "available",
        ...(s.docked ? { reason: "Already docked." } : {}),
        params: { strategyHash: s.strategyHash },
      },
    ],
    source: "aqua:shipped-strategies",
    observedAt,
  });
}

registerUserSource((owner) => ({
  name: "aqua:strategies",
  needsRpc: false,
  run: async (t) => store().filter((s) => s.maker.toLowerCase() === owner.toLowerCase()).map((s) => deriveStrategyReviewEvent(s, t)),
}));

export function buildAquaDockStep(strategyHash: string): TxStep {
  const aqua = new aquaSdk.AquaProtocolContract(aquaSdk.AQUA_CONTRACT_ADDRESSES[1]);
  const dock = aqua.dock({
    app: new aquaSdk.Address(AQUA.router),
    strategyHash: new aquaSdk.HexString(strategyHash),
    tokens: [new aquaSdk.Address(AQUA.USDC), new aquaSdk.Address(AQUA.USDe)],
  });
  return { kind: "call", to: dock.to.toString(), data: dock.data.toString(), value: "0", description: "Dock the Aqua strategy: removes its virtual balances so no further fills can use your tokens." };
}

export function markDocked(strategyHash: string) {
  const s = store().find((x) => x.strategyHash.toLowerCase() === strategyHash.toLowerCase());
  if (s) {
    s.docked = true;
    persist();
    _invalidateUser(s.maker);
  }
}

export async function shipAquaOnFork(input: AquaShipInput) {
  await assertForkEndpoint();
  const { pub } = forkClients();
  const plan = await buildAquaShipPlan(input, { stateClient: pub });
  const txs = await sendStepsOnFork(input.maker as Hex, plan.steps);
  const ok = txs.length === plan.steps.length && txs.every((t) => t.status === "success");
  if (ok) {
    // 同じ maker・同じ parameter の戦略は hash が同じ。dock 後に再 ship した場合は記録を置き換える
    shipped = store().filter((x) => x.strategyHash.toLowerCase() !== plan.strategyHash.toLowerCase());
    store().push({
      maker: input.maker,
      strategy: plan.strategy,
      strategyHash: plan.strategyHash,
      bandBps: input.bandBps,
      usdcAmount: input.usdcAmount,
      usdeAmount: input.usdeAmount,
      reviewAt: input.reviewAt,
      shippedAt: new Date().toISOString(),
      docked: false,
    });
    persist();
    _invalidateUser(input.maker);
  }
  const executedEvent = await recordExecuted({ owner: input.maker, title: "Shipped USDC/USDe pegged strategy on Aqua", protocol: "aqua", protocolName: "1inch Aqua", txs, ok });
  return { target: "fork" as const, plan, txs, executedEvent };
}

/**
 * fork 上で 1 回 fill する (v3: production の taker は KYB 済み resolver 限定のため fork で見せる)。
 * taker は fork 上で USDC を持つ実 address を impersonate する。
 */
export async function fillAquaOnFork(input: { strategyHash: string; taker: string; usdcIn: string }) {
  await assertForkEndpoint();
  const s = [...store()].reverse().find((x) => x.strategyHash.toLowerCase() === input.strategyHash.toLowerCase() && !x.docked);
  if (!s) throw new PlanError("event_not_found", "No live shipped strategy with this hash.");
  if (!/^[0-9]+$/.test(input.usdcIn) || BigInt(input.usdcIn) === 0n) throw new PlanError("action_not_available", "usdcIn must be a positive smallest-unit integer.");
  const order = vmSdk.Order.decode(new vmSdk.HexString(s.strategy));
  const swapVM = new vmSdk.SwapVMContract(vmSdk.AQUA_SWAP_VM_CONTRACT_ADDRESSES[1]);
  const params = { order, amount: BigInt(input.usdcIn), takerTraits: vmSdk.TakerTraits.default(), tokenIn: new vmSdk.Address(AQUA.USDC), tokenOut: new vmSdk.Address(AQUA.USDe) };
  const swap = swapVM.swap(params);
  const steps: TxStep[] = [
    {
      kind: "approval",
      to: AQUA.USDC,
      data: encodeFunctionData({ abi: erc20, functionName: "approve", args: [AQUA.router as Hex, BigInt(input.usdcIn)] }),
      value: "0",
      description: "Taker allows the Aqua SwapVM router to take the USDC for this fill.",
    },
    { kind: "call", to: swap.to.toString(), data: swap.data.toString(), value: "0", description: "Taker fills the strategy: USDC → USDe." },
  ];
  const { pub } = forkClients();
  const before = (await pub.readContract({ address: AQUA.USDe, abi: erc20, functionName: "balanceOf", args: [input.taker as Hex] })) as bigint;
  const txs = await sendStepsOnFork(input.taker as Hex, steps);
  const after = (await pub.readContract({ address: AQUA.USDe, abi: erc20, functionName: "balanceOf", args: [input.taker as Hex] })) as bigint;
  return { target: "fork" as const, txs, usdeOut: (after - before).toString() };
}

export function _resetAquaForTest() {
  shipped = [];
}
