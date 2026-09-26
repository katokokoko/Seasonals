/**
 * Menu から直接の deposit / withdraw (未署名プラン + fork 実行)。
 *
 * - 対象: Lido (stake / 出金申請)、Ethena (sUSDe deposit / cooldown 開始)。どちらも価格に依存しない
 *   (Lido submit は 1:1、sUSDe は ERC-4626 の on-chain レート)。Pendle 売買は価格依存なので guard 付きで別途
 * - 金額は人が入力した decimal string → toSmallestUnit → bigint。残高 / allowance / 上限は on-chain で読み直す
 *   (client の値を鵜呑みにしない)
 * - 返すのは ActionPlanSchema (plans.ts と同じ)。mainnet に eth_call して「送らずに」確かめる。署名・送信はしない
 */
import { encodeFunctionData, getAddress, type PublicClient } from "viem";
import { formatTokenAmount, toSmallestUnit } from "@workspace/lib/utils/numeric";
import { erc20Abi, erc20ApproveAbi, stETHAbi, sUSDeAbi, withdrawalQueueAbi, wstETHAbi } from "./abis";
import { executionTarget, getEthClient } from "./client";
import { ETHENA, LIDO, MAINNET_CHAIN_ID } from "./config";
import { ETHENA_PRODUCT_ID, LIDO_PRODUCT_ID } from "./holdings";
import { ActionPlanSchema, PlanError, simulate, type ActionPlan, type PlanOptions, type TxStep } from "./plans";

export type MenuAction = "deposit" | "withdraw";

export interface MenuPlanInput {
  owner: string;
  productId: string;
  action: MenuAction;
  /** 人が読む形の decimal string ("1.5") */
  amount: string;
  /** withdraw で出すトークン (Lido: "stETH" | "wstETH")。省略時は商品の既定 */
  token?: string;
}

type Addr = `0x${string}`;

/** "1.5" → smallest unit bigint。形式違反 / 桁あふれ / 0 は invalid_amount */
export function parseMenuAmount(amount: string, decimals: number): bigint {
  const s = amount.trim();
  let smallest: string;
  try {
    smallest = toSmallestUnit(s, decimals);
  } catch {
    throw new PlanError("invalid_amount", `Enter a positive number with at most ${decimals} decimals.`);
  }
  const v = BigInt(smallest);
  if (v === 0n) throw new PlanError("invalid_amount", "Enter an amount greater than zero.");
  return v;
}

/**
 * Lido の出金申請を 1 request あたりの上限 (MAX) で分割する。端数が MIN 未満なら直前の塊から借りる
 * (合計は変えない)。amount < MIN は申請できないので invalid_amount。
 */
export function splitWithdrawal(amount: bigint, min: bigint, max: bigint): bigint[] {
  if (amount < min) throw new PlanError("invalid_amount", `Lido accepts withdrawal requests of at least ${min} wei.`);
  const out: bigint[] = [];
  let rest = amount;
  while (rest > max) {
    out.push(max);
    rest -= max;
  }
  if (rest > 0n) {
    if (rest < min && out.length > 0) {
      out[out.length - 1] = out[out.length - 1]! - (min - rest);
      rest = min;
    }
    out.push(rest);
  }
  return out;
}

const fmt = (v: bigint, symbol: string, digits = 4) => `${formatTokenAmount(v.toString(), 18, { maxFractionDigits: digits })} ${symbol}`;

async function erc20Balance(client: PublicClient, token: string, owner: Addr): Promise<bigint> {
  return (await client.readContract({ address: token as Addr, abi: erc20Abi, functionName: "balanceOf", args: [owner] })) as bigint;
}

/** allowance が足りない時だけ exact amount の approve step を返す */
async function approvalStep(client: PublicClient, token: string, owner: Addr, spender: string, amount: bigint, description: string): Promise<TxStep[]> {
  const allowance = (await client.readContract({ address: token as Addr, abi: erc20ApproveAbi, functionName: "allowance", args: [owner, spender as Addr] })) as bigint;
  if (allowance >= amount) return [];
  return [{ kind: "approval", to: token, data: encodeFunctionData({ abi: erc20ApproveAbi, functionName: "approve", args: [spender as Addr, amount] }), value: "0", description }];
}

type Where = "mainnet" | "fork";

function insufficient(have: bigint, want: bigint, symbol: string, where: Where): never {
  const who = where === "fork" ? "On the local fork, this address" : "This address";
  throw new PlanError("insufficient_balance", `${who} holds ${fmt(have, symbol)}, less than the ${fmt(want, symbol)} entered.`);
}

interface Built {
  steps: TxStep[];
  summary: string;
  source: string;
  actionType: string;
  warnings: string[];
}

async function lidoPlan(client: PublicClient, owner: Addr, input: MenuPlanInput, where: Where): Promise<Built> {
  const amount = parseMenuAmount(input.amount, 18);
  if (input.action === "deposit") {
    const eth = await client.getBalance({ address: owner });
    if (eth < amount) insufficient(eth, amount, "ETH", where);
    return {
      steps: [
        {
          kind: "call",
          to: LIDO.stETH,
          data: encodeFunctionData({ abi: stETHAbi, functionName: "submit", args: ["0x0000000000000000000000000000000000000000"] }),
          value: amount.toString(),
          description: `Stake ${fmt(amount, "ETH")} with Lido and receive about the same amount of stETH.`,
        },
      ],
      summary: `Stake ${fmt(amount, "ETH")} with Lido.`,
      source: "lido.stETH.submit",
      actionType: "lido_stake",
      warnings: eth - amount < 10n ** 15n ? ["Almost all of this address's ETH would be staked; keep some for gas."] : [],
    };
  }
  const token = input.token === "wstETH" ? "wstETH" : "stETH";
  const tokenAddr = token === "wstETH" ? LIDO.wstETH : LIDO.stETH;
  const have = await erc20Balance(client, tokenAddr, owner);
  if (have < amount) insufficient(have, amount, token, where);
  const [min, max] = (await Promise.all([
    client.readContract({ address: LIDO.withdrawalQueue, abi: withdrawalQueueAbi, functionName: "MIN_STETH_WITHDRAWAL_AMOUNT" }),
    client.readContract({ address: LIDO.withdrawalQueue, abi: withdrawalQueueAbi, functionName: "MAX_STETH_WITHDRAWAL_AMOUNT" }),
  ])) as [bigint, bigint];
  // 上限は stETH 建て。wstETH は同じ上限を wstETH 量に換算して分割する
  const [minT, maxT] =
    token === "wstETH"
      ? ((await Promise.all([
          client.readContract({ address: LIDO.wstETH, abi: wstETHAbi, functionName: "getWstETHByStETH", args: [min] }),
          client.readContract({ address: LIDO.wstETH, abi: wstETHAbi, functionName: "getWstETHByStETH", args: [max] }),
        ])) as [bigint, bigint])
      : [min, max];
  // wstETH 換算の MIN は切り捨てで下回りうるので +1
  const parts = splitWithdrawal(amount, token === "wstETH" ? minT + 1n : minT, maxT);
  const fn = token === "wstETH" ? "requestWithdrawalsWstETH" : "requestWithdrawals";
  return {
    steps: [
      ...(await approvalStep(client, tokenAddr, owner, LIDO.withdrawalQueue, amount, `Allow the Lido withdrawal queue to take exactly ${fmt(amount, token)}.`)),
      {
        kind: "call",
        to: LIDO.withdrawalQueue,
        data: encodeFunctionData({ abi: withdrawalQueueAbi, functionName: fn, args: [parts, owner] }),
        value: "0",
        description: `Request a Lido withdrawal of ${fmt(amount, token)}${parts.length > 1 ? ` as ${parts.length} requests (Lido caps each request)` : ""}. ETH becomes claimable once Lido finalizes it.`,
      },
    ],
    summary: `Request a withdrawal of ${fmt(amount, token)} from Lido.`,
    source: `lido.withdrawalQueue.${fn}`,
    actionType: "lido_request_withdrawal",
    warnings: ["Lido finalizes withdrawals in a queue (typically 1–5 days). The claim then appears on your calendar."],
  };
}

async function ethenaPlan(client: PublicClient, owner: Addr, input: MenuPlanInput, where: Where): Promise<Built> {
  const amount = parseMenuAmount(input.amount, 18);
  if (input.action === "deposit") {
    const usde = await erc20Balance(client, ETHENA.USDe, owner);
    if (usde < amount) insufficient(usde, amount, "USDe", where);
    const shares = (await client.readContract({ address: ETHENA.sUSDe, abi: sUSDeAbi, functionName: "previewDeposit", args: [amount] })) as bigint;
    return {
      steps: [
        ...(await approvalStep(client, ETHENA.USDe, owner, ETHENA.sUSDe, amount, `Allow sUSDe to take exactly ${fmt(amount, "USDe", 2)}.`)),
        {
          kind: "call",
          to: ETHENA.sUSDe,
          data: encodeFunctionData({ abi: sUSDeAbi, functionName: "deposit", args: [amount, owner] }),
          value: "0",
          description: `Stake ${fmt(amount, "USDe", 2)} for about ${fmt(shares, "sUSDe")} (on-chain preview).`,
        },
      ],
      summary: `Stake ${fmt(amount, "USDe", 2)} into sUSDe.`,
      source: "susde.deposit",
      actionType: "ethena_stake",
      warnings: [],
    };
  }
  const shares = await erc20Balance(client, ETHENA.sUSDe, owner);
  if (shares < amount) insufficient(shares, amount, "sUSDe", where);
  const [duration, cd, assets] = (await Promise.all([
    client.readContract({ address: ETHENA.sUSDe, abi: sUSDeAbi, functionName: "cooldownDuration" }),
    client.readContract({ address: ETHENA.sUSDe, abi: sUSDeAbi, functionName: "cooldowns", args: [owner] }),
    client.readContract({ address: ETHENA.sUSDe, abi: sUSDeAbi, functionName: "convertToAssets", args: [amount] }),
  ])) as [number, readonly [bigint, bigint], bigint];
  if (Number(duration) === 0) {
    return {
      steps: [
        {
          kind: "call",
          to: ETHENA.sUSDe,
          data: encodeFunctionData({ abi: sUSDeAbi, functionName: "redeem", args: [amount, owner, owner] }),
          value: "0",
          description: `Redeem ${fmt(amount, "sUSDe")} for about ${fmt(assets, "USDe", 2)} (no cooldown is set).`,
        },
      ],
      summary: `Redeem ${fmt(amount, "sUSDe")} for USDe.`,
      source: "susde.redeem",
      actionType: "ethena_redeem",
      warnings: [],
    };
  }
  const days = Math.round(Number(duration) / 86_400);
  const warnings = [`USDe is locked for ${days} day${days === 1 ? "" : "s"} (Ethena's cooldown), then you claim it. The claim date goes on your calendar.`];
  if (cd[1] > 0n) {
    warnings.push(`${fmt(cd[1], "USDe", 2)} is already cooling down. Starting another cooldown adds to it and restarts the timer for the whole amount.`);
  }
  return {
    steps: [
      {
        kind: "call",
        to: ETHENA.sUSDe,
        data: encodeFunctionData({ abi: sUSDeAbi, functionName: "cooldownShares", args: [amount] }),
        value: "0",
        description: `Start the cooldown for ${fmt(amount, "sUSDe")} (about ${fmt(assets, "USDe", 2)}).`,
      },
    ],
    summary: `Start withdrawing ${fmt(amount, "sUSDe")} from Ethena.`,
    source: "susde.cooldownShares",
    actionType: "ethena_cooldown",
    warnings,
  };
}

export async function buildMenuPlan(input: MenuPlanInput, opts: PlanOptions = {}): Promise<ActionPlan> {
  const client = (opts.client ?? getEthClient()) as PublicClient | null;
  if (!client) throw new PlanError("rpc_unavailable", "Ethereum RPC is not configured.");
  // 大文字小文字が checksum と合わない入力でも calldata を作れるよう正規化する
  const owner = getAddress(input.owner.toLowerCase());
  const where: Where = opts.where ?? "mainnet";
  let built: Built;
  if (input.productId === LIDO_PRODUCT_ID) built = await lidoPlan(client, owner, input, where);
  else if (input.productId === ETHENA_PRODUCT_ID) built = await ethenaPlan(client, owner, input, where);
  else throw new PlanError("unsupported_action", "Deposit and withdraw from the menu are not available for this product yet.");

  return ActionPlanSchema.parse({
    eventId: `menu:${input.productId}`,
    actionType: built.actionType,
    chainId: MAINNET_CHAIN_ID,
    owner: input.owner,
    target: executionTarget(),
    summary: built.summary,
    steps: built.steps,
    simulation: await simulate(input.owner, built.steps, client, where),
    ...(built.warnings.length ? { warnings: built.warnings } : {}),
    builtAt: new Date().toISOString(),
    source: built.source,
    broadcast: false,
  });
}
