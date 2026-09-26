/**
 * Menu から直接の deposit / withdraw (未署名プラン + fork 実行)。
 *
 * - 対象: Lido (stake / 出金申請)、Ethena (sUSDe deposit / cooldown 開始) は価格に依存しない
 *   (Lido submit は 1:1、sUSDe は ERC-4626 の on-chain レート)。
 *   Pendle PT / YT の購入・売却は価格依存なので pendle-guard.ts の TWAP 比較を必ず通す (fail-closed)
 * - 金額は人が入力した decimal string → toSmallestUnit → bigint。残高 / allowance / 上限は on-chain で読み直す
 *   (client の値を鵜呑みにしない)
 * - 返すのは ActionPlanSchema (plans.ts と同じ)。mainnet に eth_call して「送らずに」確かめる。署名・送信はしない
 */
import { encodeFunctionData, getAddress, type PublicClient } from "viem";
import { formatTokenAmount, toSmallestUnit } from "@workspace/lib/utils/numeric";
import { erc20Abi, erc20ApproveAbi, stETHAbi, sUSDeAbi, withdrawalQueueAbi, wstETHAbi } from "./abis";
import { executionTarget, getEthClient, getJson } from "./client";
import { ETHENA, LIDO, MAINNET_CHAIN_ID, PENDLE_API } from "./config";
import { checkPendlePrice } from "./pendle-guard";
import { fetchPendleMarkets, stripChainPrefix, type PendleMarket } from "./pendle";
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

function insufficientIn(have: bigint, want: bigint, symbol: string, decimals: number, where: Where): never {
  const who = where === "fork" ? "On the local fork, this address" : "This address";
  const f = (v: bigint) => formatTokenAmount(v.toString(), decimals, { maxFractionDigits: 4 });
  throw new PlanError("insufficient_balance", `${who} holds ${f(have)} ${symbol}, less than the ${f(want)} ${symbol} entered.`);
}

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

// ── Pendle PT / YT ────────────────────────────────────────────────────────

const PENDLE_ID = /^ethereum:pendle:(pt|yt):(0x[0-9a-f]{40})$/;

export interface PendleTradeContext {
  market: PendleMarket;
  kind: "pt" | "yt";
  matured: boolean;
  sy: Addr;
  py: Addr;
  /** 買う時に払う / 売る時に受け取るトークン (market の underlying を優先) */
  token: { address: Addr; symbol: string; decimals: number; balance: bigint };
  pyToken: { symbol: string; decimals: number; balance: bigint };
}

function pickToken(m: PendleMarket, list: string[] | undefined): Addr | null {
  const under = stripChainPrefix(m.underlyingAsset).toLowerCase();
  const cands = (list ?? []).map((t) => stripChainPrefix(t).toLowerCase());
  const t = cands.includes(under) ? under : cands[0];
  return t ? (getAddress(t) as Addr) : null;
}

export async function pendleTradeContext(client: PublicClient, owner: Addr, productId: string, action: MenuAction): Promise<PendleTradeContext> {
  const match = PENDLE_ID.exec(productId);
  if (!match) throw new PlanError("unsupported_action", "Unknown Pendle product.");
  const [, kind, marketAddr] = match as unknown as [string, "pt" | "yt", string];
  const market = (await fetchPendleMarkets()).find((m) => m.address.toLowerCase() === marketAddr);
  if (!market) throw new PlanError("upstream_error", "Pendle market metadata is unavailable.");
  const token = pickToken(market, action === "deposit" ? market.inputTokens : market.outputTokens);
  if (!token) throw new PlanError("unsupported_action", "Pendle lists no token to trade this market with.");
  const py = getAddress(stripChainPrefix(market[kind])) as Addr;
  const reads = await client.multicall({
    contracts: [
      { address: token, abi: erc20Abi, functionName: "symbol" },
      { address: token, abi: erc20Abi, functionName: "decimals" },
      { address: token, abi: erc20Abi, functionName: "balanceOf", args: [owner] },
      { address: py, abi: erc20Abi, functionName: "decimals" },
      { address: py, abi: erc20Abi, functionName: "balanceOf", args: [owner] },
    ],
    allowFailure: false,
  });
  const [symbol, decimals, balance, pyDecimals, pyBalance] = reads as unknown as [string, number, bigint, number, bigint];
  return {
    market,
    kind,
    matured: Date.parse(market.expiry) <= Date.now(),
    sy: getAddress(stripChainPrefix(market.sy)) as Addr,
    py,
    token: { address: token, symbol, decimals: Number(decimals), balance },
    pyToken: { symbol: `${kind.toUpperCase()}-${market.name}`, decimals: Number(pyDecimals), balance: pyBalance },
  };
}

interface ConvertResponse {
  action: string;
  requiredApprovals?: Array<{ token: string; amount: string }>;
  routes: Array<{ tx: { to: string; data: string; value?: string }; outputs: Array<{ token: string; amount: string }> }>;
}

async function pendlePlan(client: PublicClient, owner: Addr, input: MenuPlanInput, where: Where): Promise<Built> {
  const ctx = await pendleTradeContext(client, owner, input.productId, input.action);
  const label = ctx.pyToken.symbol;
  if (ctx.matured) {
    if (input.action === "deposit") throw new PlanError("action_not_available", `${label} has matured and can no longer be bought.`);
    throw new PlanError(
      "action_not_available",
      ctx.kind === "pt" ? `${label} has matured. Redeem it 1:1 from its calendar event instead of selling.` : `${label} has matured and is worth 0; there is nothing to sell.`
    );
  }
  const buy = input.action === "deposit";
  const amount = parseMenuAmount(input.amount, buy ? ctx.token.decimals : ctx.pyToken.decimals);
  if (buy && ctx.token.balance < amount) insufficientIn(ctx.token.balance, amount, ctx.token.symbol, ctx.token.decimals, where);
  if (!buy && ctx.pyToken.balance < amount) insufficientIn(ctx.pyToken.balance, amount, label, ctx.pyToken.decimals, where);

  const inToken = buy ? ctx.token.address : ctx.py;
  const outToken = buy ? ctx.py : ctx.token.address;
  let res: ConvertResponse;
  try {
    res = await getJson<ConvertResponse>(`${PENDLE_API}/v3/sdk/${MAINNET_CHAIN_ID}/convert`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ receiver: owner, slippage: 0.005, enableAggregator: false, inputs: [{ token: inToken, amount: amount.toString() }], outputs: [outToken] }),
      timeoutMs: 20_000,
    });
  } catch {
    throw new PlanError("upstream_error", "Pendle's Convert service did not return a quote.");
  }
  const route = res.routes[0];
  const out = route?.outputs.find((o) => o.token.toLowerCase() === outToken.toLowerCase()) ?? route?.outputs[0];
  if (!route || !out || !/^[0-9]+$/.test(out.amount)) throw new PlanError("upstream_error", "Pendle Convert returned no usable route.");
  const outAmount = BigInt(out.amount);

  // 価格 guard は mainnet の TWAP と比べる (fork 実行時も価格の正は mainnet)
  const guard = await checkPendlePrice((getEthClient() ?? client) as PublicClient, {
    market: ctx.market.address,
    sy: ctx.sy,
    token: ctx.token.address,
    kind: ctx.kind,
    side: buy ? "buy" : "sell",
    tokenAmount: buy ? amount : outAmount,
    pyAmount: buy ? outAmount : amount,
    label,
  });
  if (where === "fork" && guard.level === "block") throw new PlanError("oracle_divergence_too_large", guard.message);

  const approvals: TxStep[] = [];
  for (const a of res.requiredApprovals ?? []) {
    if (!/^[0-9]+$/.test(a.amount)) continue;
    approvals.push(...(await approvalStep(client, a.token, owner, route.tx.to, BigInt(a.amount), `Allow the Pendle router to spend exactly what this trade needs.`)));
  }
  const inLabel = buy ? ctx.token.symbol : label;
  const outLabel = buy ? label : ctx.token.symbol;
  const inDec = buy ? ctx.token.decimals : ctx.pyToken.decimals;
  const outDec = buy ? ctx.pyToken.decimals : ctx.token.decimals;
  const f = (v: bigint, d: number) => formatTokenAmount(v.toString(), d, { maxFractionDigits: 4 });
  const warnings = [guard.message];
  if (buy && ctx.kind === "yt") warnings.push(`${label} earns the underlying yield until ${ctx.market.expiry.slice(0, 10)} and is worth 0 after maturity.`);
  if (buy && ctx.kind === "pt") warnings.push(`${label} redeems 1:1 for the underlying at maturity (${ctx.market.expiry.slice(0, 10)}); selling earlier depends on market price.`);
  return {
    steps: [
      ...approvals,
      {
        kind: "call",
        to: route.tx.to,
        data: route.tx.data,
        value: route.tx.value && /^[0-9]+$/.test(route.tx.value) ? route.tx.value : "0",
        description: `${buy ? "Buy" : "Sell"} via Pendle: ${f(amount, inDec)} ${inLabel} → about ${f(outAmount, outDec)} ${outLabel} (0.5% max slippage, action: ${res.action}).`,
      },
    ],
    summary: `${buy ? "Buy" : "Sell"} ${buy ? `${label} with ${f(amount, inDec)} ${inLabel}` : `${f(amount, inDec)} ${label}`} on Pendle.`,
    source: "pendle-hosted-sdk:convert",
    actionType: `pendle_${buy ? "buy" : "sell"}_${ctx.kind}`,
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
  else if (PENDLE_ID.test(input.productId)) built = await pendlePlan(client, owner, input, where);
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
