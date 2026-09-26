/**
 * Strategy Brief — Agent の戦略を人が読める形にする (英語)。
 *
 * - 数字はすべて BFF が実データから決定的に組む: holdings (on-chain 残高) + menu の利回り + 各 step の preview
 *   (builder が返した effects)。LLM は name / tagline / rationale だけを書く (数字を創作できない)
 * - before → after は effects を step 順に適用して作る。価格は prices.ts (Chainlink → 換算 → Llama)、
 *   Pendle は dashboard の評価額 → step の反対側からの暗黙単価 (approx) の順。取れないものは unpriced に列挙し、
 *   総額・APY から除外する (0 や推測で埋めない)
 * - 加重 APY の分母は価格のある全 line。APY 不明 (Aqua LP など) は 0 扱いで excluded に列挙 (数字を膨らませない)
 * - brief は proposal を止めない: 取得失敗は warnings に落とす (guard は preview 側で fail-closed)
 */
import type {
  EthPlanAsset,
  EthPortfolioLine,
  EthPortfolioSnapshot,
  EthProposalPreviewSlot,
  EthProposalStep,
  EthStrategyBrief,
  MenuHoldingsResponse,
  MenuProduct,
  TokenAmountView,
} from "@workspace/lib/types";
import { ETH_ASSET_ADDRESS, ETH_NATIVE_KEY } from "@workspace/lib/config/eth-assets";
import { bigIntToUsd8, formatPercentage, formatTokenAmount, formatUsd, toSmallestUnit, usd8ToBigInt } from "@workspace/lib/utils/numeric";
import { getEthMenu } from "./menu";
import { ETHENA_PRODUCT_ID, getMenuHoldings, LIDO_PRODUCT_ID } from "./holdings";
import { priceEthAssetsNow } from "./prices";
import { sanitizeError } from "./client";

export const AQUA_LINE_KEY = "aqua:usdc-usde";
const LIDO_QUEUE_DAYS = 5;

const K = {
  ETH: ETH_NATIVE_KEY,
  USDC: ETH_ASSET_ADDRESS.USDC.toLowerCase(),
  USDe: ETH_ASSET_ADDRESS.USDe.toLowerCase(),
  sUSDe: ETH_ASSET_ADDRESS.sUSDe.toLowerCase(),
  stETH: ETH_ASSET_ADDRESS.stETH.toLowerCase(),
  wstETH: ETH_ASSET_ADDRESS.wstETH.toLowerCase(),
} as const;
const WALLET_KEY_BY_SYMBOL: Record<string, string> = { ETH: K.ETH, USDC: K.USDC, USDe: K.USDe, WETH: ETH_ASSET_ADDRESS.WETH.toLowerCase(), USDT: ETH_ASSET_ADDRESS.USDT.toLowerCase() };

export interface BriefInputs {
  owner: string;
  name: string;
  tagline?: string;
  steps: EthProposalStep[];
  previews: EthProposalPreviewSlot[];
  holdings: MenuHoldingsResponse;
  products: MenuProduct[];
  /** key ("ETH" / 小文字 address / Pendle productId) → USD 8-dec 単価 */
  prices: Map<string, string>;
  now: Date;
  /** I/O 側で起きた失敗 (brief に載せる) */
  warnings?: string[];
}

/** 内部の可変 line (量は bigint) */
interface Line {
  key: string;
  label: string;
  productId?: string;
  symbol: string;
  decimals: number;
  amount: bigint;
  apy: number | null;
  apyLabel?: string;
  pending?: boolean;
  approx?: boolean;
  /** Aqua LP: 2 token を 1 行で持つ */
  aqua?: { usdc: bigint; usde: bigint };
}

const view = (symbol: string, decimals: number, amount: bigint): TokenAmountView => ({ value: amount.toString(), decimals, symbol });
const usdOf = (amount: bigint, decimals: number, price8: string): bigint => (amount * usd8ToBigInt(price8)) / 10n ** BigInt(decimals);
const isPendle = (key: string) => key.startsWith("ethereum:pendle:");

/** key → どの商品 / wallet token か (label と APY の出所) */
function describeKey(key: string, symbol: string, products: MenuProduct[], now: Date): Pick<Line, "label" | "productId" | "apy" | "apyLabel"> {
  const product = (id: string) => products.find((p) => p.id === id);
  if (isPendle(key)) {
    const p = product(key);
    const maturity = p?.maturity ? p.maturity.slice(0, 10) : null;
    // 満期済み PT は 1:1 で償還するだけで利回りは無い (Pendle の implied APY は見ない)
    if (maturity && Date.parse(p!.maturity!) <= now.getTime()) return { label: `${symbol} (Pendle, matured ${maturity})`, productId: key, apy: 0, apyLabel: "Matured" };
    return { label: `${symbol} (Pendle${maturity ? `, ${maturity}` : ""})`, productId: key, apy: p?.rate ? p.rate.value : null, ...(p?.rate ? { apyLabel: p.rate.label } : {}) };
  }
  if (key === K.stETH || key === K.wstETH) {
    const p = product(LIDO_PRODUCT_ID);
    return { label: `${symbol} (Lido)`, productId: LIDO_PRODUCT_ID, apy: p?.rate ? p.rate.value : null, ...(p?.rate ? { apyLabel: p.rate.label } : {}) };
  }
  if (key === K.sUSDe) {
    const p = product(ETHENA_PRODUCT_ID);
    return { label: `${symbol} (Ethena)`, productId: ETHENA_PRODUCT_ID, apy: p?.rate ? p.rate.value : null, ...(p?.rate ? { apyLabel: p.rate.label } : {}) };
  }
  if (Object.values(WALLET_KEY_BY_SYMBOL).includes(key)) return { label: `${symbol} (wallet)`, apy: 0, apyLabel: "Idle" };
  return { label: symbol, apy: null };
}

function beforeLines(h: MenuHoldingsResponse, products: MenuProduct[], now: Date): Line[] {
  const lines: Line[] = [];
  for (const s of h.spendable) {
    const key = WALLET_KEY_BY_SYMBOL[s.symbol];
    if (!key) continue;
    lines.push({ key, symbol: s.symbol, decimals: s.decimals, amount: BigInt(s.value), ...describeKey(key, s.symbol, products, now) });
  }
  for (const hold of h.holdings) {
    if (hold.productId === LIDO_PRODUCT_ID) {
      for (const a of hold.amounts) {
        const key = a.symbol === "wstETH" ? K.wstETH : K.stETH;
        lines.push({ key, symbol: a.symbol, decimals: a.decimals, amount: BigInt(a.value), ...describeKey(key, a.symbol, products, now) });
      }
    } else if (hold.productId === ETHENA_PRODUCT_ID) {
      for (const a of hold.amounts) lines.push({ key: K.sUSDe, symbol: a.symbol, decimals: a.decimals, amount: BigInt(a.value), ...describeKey(K.sUSDe, a.symbol, products, now) });
      if (hold.pending) {
        const p = hold.pending.amount;
        lines.push({ key: `pending:${K.USDe}`, label: "USDe cooling down (Ethena)", symbol: p.symbol, decimals: p.decimals, amount: BigInt(p.value), apy: 0, pending: true });
      }
    } else if (isPendle(hold.productId)) {
      for (const a of hold.amounts) lines.push({ key: hold.productId, symbol: a.symbol, decimals: a.decimals, amount: BigInt(a.value), ...describeKey(hold.productId, a.symbol, products, now) });
    }
  }
  return lines.filter((l) => l.amount > 0n);
}

/** 単価 map を補う: Pendle は dashboard 評価額 ÷ 量、step は反対側の USD ÷ 量 (approx) */
function enrichPrices(prices: Map<string, string>, h: MenuHoldingsResponse, previews: EthProposalPreviewSlot[]): { prices: Map<string, string>; approx: Set<string> } {
  const out = new Map(prices);
  const approx = new Set<string>();
  for (const hold of h.holdings) {
    const a = hold.amounts[0];
    if (!isPendle(hold.productId) || !hold.usd || !a || BigInt(a.value) === 0n || out.has(hold.productId)) continue;
    out.set(hold.productId, bigIntToUsd8((usd8ToBigInt(hold.usd) * 10n ** BigInt(a.decimals)) / BigInt(a.value)));
  }
  const implied = (known: EthPlanAsset[], unknown: EthPlanAsset[]) => {
    let usd = 0n;
    for (const k of known) {
      const p = out.get(k.key);
      if (!p) return;
      usd += usdOf(BigInt(k.value), k.decimals, p);
    }
    for (const u of unknown) {
      if (out.has(u.key) || BigInt(u.value) === 0n) continue;
      out.set(u.key, bigIntToUsd8((usd * 10n ** BigInt(u.decimals)) / BigInt(u.value)));
      approx.add(u.key);
    }
  };
  for (const slot of previews) {
    const e = slot.ok ? slot.preview.effects : undefined;
    if (!e || e.in.length === 0 || e.out.length === 0) continue;
    if (e.in.every((a) => out.has(a.key))) implied(e.in, e.out);
    else if (e.out.every((a) => out.has(a.key))) implied(e.out, e.in);
  }
  return { prices: out, approx };
}

function applyEffects(lines: Line[], steps: EthProposalStep[], previews: EthProposalPreviewSlot[], products: MenuProduct[], now: Date, warnings: string[]): Line[] {
  const next = lines.map((l) => ({ ...l }));
  const find = (key: string) => next.find((l) => l.key === key);
  const add = (a: EthPlanAsset, extra: Partial<Line> = {}) => {
    const l = find(a.key);
    if (l) l.amount += BigInt(a.value);
    else next.push({ key: a.key, symbol: a.symbol, decimals: a.decimals, amount: BigInt(a.value), ...describeKey(a.key, a.symbol, products, now), ...extra });
  };
  const sub = (a: EthPlanAsset, stepNo: number) => {
    const l = find(a.key);
    const v = BigInt(a.value);
    if (!l || l.amount < v) {
      warnings.push(`Step ${stepNo} spends more ${a.symbol} than the snapshot shows; the after view clamps it at 0.`);
      if (l) l.amount = 0n;
      return;
    }
    l.amount -= v;
  };
  steps.forEach((step, i) => {
    const n = i + 1;
    const slot = previews[i];
    if (step.kind === "aqua_ship") {
      const usdc = BigInt(toSmallestUnit(step.usdc, 6));
      const usde = BigInt(toSmallestUnit(step.usde, 18));
      sub({ key: K.USDC, value: usdc.toString(), decimals: 6, symbol: "USDC" }, n);
      sub({ key: K.USDe, value: usde.toString(), decimals: 18, symbol: "USDe" }, n);
      const lp = find(AQUA_LINE_KEY);
      if (lp?.aqua) {
        lp.aqua.usdc += usdc;
        lp.aqua.usde += usde;
      } else next.push({ key: AQUA_LINE_KEY, label: "Aqua USDC/USDe LP (1inch)", symbol: "LP", decimals: 0, amount: 1n, apy: null, apyLabel: "Fees (not counted)", aqua: { usdc, usde } });
      return;
    }
    if (!slot || !slot.ok) {
      warnings.push(`Step ${n} is checked on the fork when it runs; its result is not reflected in the after view.`);
      return;
    }
    const e = slot.preview.effects;
    if (!e) {
      warnings.push(`Step ${n} (${step.kind === "event_action" ? step.actionType : step.kind}) is not modeled in the after view.`);
      return;
    }
    for (const a of e.in) sub(a, n);
    for (const a of e.out) add(a, e.approx ? { approx: true } : {});
    for (const a of e.pending ?? []) {
      add({ ...a, key: `pending:${a.key}` }, { label: `${a.symbol} arriving later`, apy: 0, pending: true, ...(e.approx ? { approx: true } : {}) });
    }
  });
  return next.filter((l) => l.amount > 0n);
}

function valueLines(lines: Line[], prices: Map<string, string>, approxKeys: Set<string>, unpriced: Set<string>): EthPortfolioSnapshot {
  let total = 0n;
  const valued = lines.map((l) => {
    let usd: bigint | null = null;
    if (l.aqua) {
      const pu = prices.get(K.USDC);
      const pe = prices.get(K.USDe);
      usd = pu && pe ? usdOf(l.aqua.usdc, 6, pu) + usdOf(l.aqua.usde, 18, pe) : null;
    } else {
      const priceKey = l.key.startsWith("pending:") ? l.key.slice("pending:".length) : l.key;
      const p = prices.get(priceKey);
      usd = p ? usdOf(l.amount, l.decimals, p) : null;
      if (p && approxKeys.has(priceKey)) l.approx = true;
    }
    if (usd === null) unpriced.add(l.symbol === "LP" ? l.label : l.symbol);
    else total += usd;
    return { l, usd };
  });
  const anyPriced = valued.some((v) => v.usd !== null);
  return {
    totalUsd: anyPriced ? bigIntToUsd8(total) : null,
    lines: valued.map(({ l, usd }): EthPortfolioLine => ({
      key: l.key,
      label: l.label,
      ...(l.productId ? { productId: l.productId } : {}),
      amounts: l.aqua ? [view("USDC", 6, l.aqua.usdc), view("USDe", 18, l.aqua.usde)] : [view(l.symbol, l.decimals, l.amount)],
      usd: usd === null ? null : bigIntToUsd8(usd),
      share: usd === null || total === 0n ? null : Number((usd * 10_000n) / total) / 10_000,
      apy: l.apy,
      ...(l.apyLabel ? { apyLabel: l.apyLabel } : {}),
      ...(l.approx ? { approx: true } : {}),
      ...(l.pending ? { pending: true } : {}),
    })),
  };
}

/** USD 加重平均 APY (0..1)。APY 不明は 0 として分母に含める。価格の無い line は除外。分母 0 なら null */
export function blendedApy(lines: EthPortfolioLine[]): { value: number | null; excluded: string[] } {
  let den = 0n;
  let num = 0n;
  const excluded: string[] = [];
  for (const l of lines) {
    if (l.usd === null) continue;
    const usd = usd8ToBigInt(l.usd);
    den += usd;
    if (l.apy === null) excluded.push(l.label);
    else num += usd * BigInt(Math.round(l.apy * 1e8));
  }
  return { value: den === 0n ? null : Number(num / den) / 1e8, excluded };
}

function horizon(after: EthPortfolioSnapshot, steps: EthProposalStep[], previews: EthProposalPreviewSlot[], h: MenuHoldingsResponse, products: MenuProduct[], now: Date) {
  const out: EthStrategyBrief["horizon"] = [];
  for (const l of after.lines) {
    const p = l.productId ? products.find((x) => x.id === l.productId) : undefined;
    if (p?.maturity) out.push({ at: p.maturity, label: `${l.amounts[0]?.symbol ?? p.name} matures (Pendle)` });
  }
  for (const hold of h.holdings) if (hold.pending) out.push({ at: hold.pending.endsAt, label: "USDe cooldown ends (Ethena)" });
  steps.forEach((step, i) => {
    const slot = previews[i];
    if (step.kind === "aqua_ship") out.push({ at: step.reviewAt, label: "Review the Aqua USDC/USDe strategy" });
    const e = slot?.ok ? slot.preview.effects : undefined;
    if (!e?.pending?.length) return;
    if (e.availableAt) out.push({ at: e.availableAt, label: `${e.pending[0]!.symbol} cooldown ends (Ethena)` });
    else out.push({ at: new Date(now.getTime() + LIDO_QUEUE_DAYS * 86_400_000).toISOString(), label: "Lido withdrawal claimable (queue, ≈ 1–5 days)", approx: true });
  });
  // 過去の日付 (満期済み PT など) は「この後の予定」ではないので出さない
  const seen = new Set<string>();
  return out
    .filter((x) => Number.isFinite(Date.parse(x.at)) && Date.parse(x.at) > now.getTime() && !seen.has(`${x.at}|${x.label}`) && seen.add(`${x.at}|${x.label}`))
    .sort((a, b) => a.at.localeCompare(b.at));
}

const pct = (r: number | null) => (r === null ? "—" : formatPercentage(r));
const pts = (d: number | null) => (d === null ? "" : ` (${formatPercentage(d, { signDisplay: "always" })} pts)`);
const amt = (a: TokenAmountView) => `${formatTokenAmount(a.value, a.decimals, { maxFractionDigits: 4 })} ${a.symbol}`;
const money = (usd: string | null, approx?: boolean) => (usd === null ? "not priced" : `${approx ? "≈" : ""}${formatUsd(usd)}`);

export function renderBriefMarkdown(b: Omit<EthStrategyBrief, "markdown">, steps: EthProposalStep[], previews: EthProposalPreviewSlot[]): string {
  const keys = [...new Set([...b.before.lines, ...b.after.lines].map((l) => l.key))];
  const rows = keys.map((k) => {
    const before = b.before.lines.find((l) => l.key === k);
    const after = b.after.lines.find((l) => l.key === k);
    const l = (after ?? before)!;
    const cell = (x: EthPortfolioLine | undefined) => (x ? `${x.amounts.map(amt).join(" + ")} · ${money(x.usd, x.approx)}` : "—");
    return `| ${l.label} | ${cell(before)} | ${cell(after)} | ${l.apy === null ? (l.apyLabel ?? "—") : pct(l.apy)} |`;
  });
  const lines = [
    `# ${b.name}`,
    ...(b.tagline ? [`_${b.tagline}_`] : []),
    "",
    "## Before → After",
    "| Position | Before | After | APY |",
    "|---|---|---|---|",
    ...rows,
    `| **Total** | ${money(b.before.totalUsd)} | ${money(b.after.totalUsd)} | |`,
    "",
    `**Blended APY:** ${pct(b.blendedApy.before)} → ${pct(b.blendedApy.after)}${pts(b.blendedApy.delta)}`,
    ...(b.blendedApy.excluded.length ? [`_Not counted in the blend (no rate): ${b.blendedApy.excluded.join(", ")}._`] : []),
    "",
    "## Steps",
    ...steps.map((s, i) => {
      const slot = previews[i];
      return `${i + 1}. ${slot?.ok ? slot.preview.summary : `${describeStepShort(s)} — ${slot?.note ?? "checked on the fork"}`}`;
    }),
  ];
  if (b.aqua) {
    lines.push("", "## 1inch Aqua LP sleeve", `${amt(b.aqua.usdc)} + ${amt(b.aqua.usde)} · PEGGED_STABLE · ±${(b.aqua.bandBps / 100).toFixed(2)}% band · ${b.aqua.feeBps} bps fee · review on ${b.aqua.reviewAt.slice(0, 10)}`, `Price guard: ${b.aqua.peg}`);
  }
  if (b.horizon.length) lines.push("", "## On your calendar after this", ...b.horizon.map((h) => `- ${h.at.slice(0, 10)}${h.approx ? " (≈)" : ""} — ${h.label}`));
  if (b.unpriced.length) lines.push("", `**Not priced (excluded from totals):** ${b.unpriced.join(", ")}`);
  if (b.warnings.length) lines.push("", "## Warnings", ...b.warnings.map((w) => `- ${w}`));
  lines.push("", "_Nothing runs until you approve (web Agent page or chat). Execution happens only on the local fork; the Agent never signs._");
  return lines.join("\n");
}

function describeStepShort(s: EthProposalStep): string {
  switch (s.kind) {
    case "menu":
      return `${s.action === "deposit" ? "Deposit" : "Withdraw"} ${s.amount} · ${s.productId}`;
    case "uniswap_swap":
      return `Swap ${s.amount} ${s.tokenIn} → ${s.tokenOut}`;
    case "event_action":
      return `${s.actionType} · ${s.eventId}`;
    case "aqua_ship":
      return `Ship Aqua USDC/USDe LP (${s.usdc} USDC + ${s.usde} USDe)`;
  }
}

/** 純粋: I/O 済みの入力から brief を組む */
export function composeStrategyBrief(i: BriefInputs): EthStrategyBrief {
  const warnings = [...(i.warnings ?? [])];
  for (const f of i.holdings.failed) warnings.push(`Holdings source "${f}" was unavailable; the before view may be incomplete.`);
  const products = [...i.products, ...i.holdings.extraProducts];
  const { prices, approx } = enrichPrices(i.prices, i.holdings, i.previews);
  const unpriced = new Set<string>();
  const beforeL = beforeLines(i.holdings, products, i.now);
  const afterL = applyEffects(beforeL, i.steps, i.previews, products, i.now, warnings);
  const before = valueLines(beforeL, prices, approx, unpriced);
  const after = valueLines(afterL, prices, approx, unpriced);
  for (const l of [...before.lines, ...after.lines]) {
    if (l.apy === null && l.usd !== null && !l.key.startsWith("aqua:") && !warnings.some((w) => w.includes(l.label))) warnings.push(`No rate is listed for ${l.label}; it counts as 0% in the blend.`);
  }
  const bBefore = blendedApy(before.lines);
  const bAfter = blendedApy(after.lines);
  const aquaStep = i.steps.find((s): s is Extract<EthProposalStep, { kind: "aqua_ship" }> => s.kind === "aqua_ship");
  const aquaSlot = aquaStep && i.previews[i.steps.indexOf(aquaStep)];
  const body: Omit<EthStrategyBrief, "markdown"> = {
    name: i.name,
    ...(i.tagline ? { tagline: i.tagline } : {}),
    before,
    after,
    blendedApy: {
      before: bBefore.value,
      after: bAfter.value,
      delta: bBefore.value === null || bAfter.value === null ? null : Math.round((bAfter.value - bBefore.value) * 1e8) / 1e8,
      excluded: [...new Set([...bBefore.excluded, ...bAfter.excluded])],
    },
    ...(aquaStep
      ? {
          aqua: {
            usdc: { value: toSmallestUnit(aquaStep.usdc, 6), decimals: 6, symbol: "USDC" },
            usde: { value: toSmallestUnit(aquaStep.usde, 18), decimals: 18, symbol: "USDe" },
            bandBps: aquaStep.bandBps,
            feeBps: aquaStep.feeBps ?? 5,
            reviewAt: aquaStep.reviewAt,
            peg: aquaSlot?.ok ? (aquaSlot.preview.warnings.find((w) => /peg|Price guard/i.test(w))?.replace(/^Price guard:\s*/, "") ?? "Within band") : "checked on the fork",
          },
        }
      : {}),
    horizon: horizon(after, i.steps, i.previews, i.holdings, products, i.now),
    unpriced: [...unpriced],
    warnings,
    builtAt: i.now.toISOString(),
  };
  return { ...body, markdown: renderBriefMarkdown(body, i.steps, i.previews) };
}

/** I/O: holdings / menu / 価格を集めて compose する。取得失敗は warnings に落とし、brief は必ず返す */
export async function buildStrategyBrief(args: { owner: string; name: string; tagline?: string; steps: EthProposalStep[]; previews: EthProposalPreviewSlot[] }): Promise<EthStrategyBrief> {
  const warnings: string[] = [];
  const now = new Date();
  let holdings: MenuHoldingsResponse = { address: args.owner, holdings: [], extraProducts: [], spendable: [], failed: [], observedAt: now.toISOString() };
  let products: MenuProduct[] = [];
  let prices = new Map<string, string>();
  try {
    holdings = await getMenuHoldings(args.owner);
  } catch (e) {
    warnings.push(`Holdings could not be read (${sanitizeError(e)}); the before view is empty.`);
  }
  try {
    products = await getEthMenu();
  } catch (e) {
    warnings.push(`The yield menu could not be read (${sanitizeError(e)}); rates are missing.`);
  }
  const keys = new Set<string>([K.ETH, K.USDC, K.USDe, K.sUSDe, K.stETH, K.wstETH]);
  for (const slot of args.previews) {
    const e = slot.ok ? slot.preview.effects : undefined;
    for (const a of [...(e?.in ?? []), ...(e?.out ?? []), ...(e?.pending ?? [])]) keys.add(a.key);
  }
  for (const h of holdings.holdings) if (isPendle(h.productId)) keys.add(h.productId);
  try {
    // Pendle productId は Llama に無いので address 側だけ問い合わせる (productId の単価は dashboard / 暗黙単価で補う)
    prices = await priceEthAssetsNow([...keys].filter((k) => !isPendle(k)));
  } catch (e) {
    warnings.push(`Prices could not be read (${sanitizeError(e)}).`);
  }
  return composeStrategyBrief({ ...args, holdings, products, prices, now, warnings });
}
