/**
 * Strategy Brief の純粋な合成: before → after、加重 APY、unpriced、Aqua sleeve、horizon、Markdown。
 * 入力は fixture (holdings / menu / 価格 / preview の effects)。I/O は無し
 */
import type { EthProposalPreviewSlot, EthProposalStep, MenuHoldingsResponse, MenuProduct } from "@workspace/lib/types";
import { ETH_ASSET_ADDRESS } from "@workspace/lib/config/eth-assets";
import { blendedApy, composeStrategyBrief, renderBriefMarkdown } from "./strategy-brief";

const OWNER = "0x28C6c06298d514Db089934071355E5743bf21d60";
const USDC = ETH_ASSET_ADDRESS.USDC.toLowerCase();
const USDe = ETH_ASSET_ADDRESS.USDe.toLowerCase();
const sUSDe = ETH_ASSET_ADDRESS.sUSDe.toLowerCase();
const stETH = ETH_ASSET_ADDRESS.stETH.toLowerCase();
const PT = "ethereum:pendle:pt:0xc5f938a8ef5f3bf9e72f5aa094baf5e03f4727d3";
const YT = "ethereum:pendle:yt:0xc5f938a8ef5f3bf9e72f5aa094baf5e03f4727d3";
const now = new Date("2026-09-26T12:00:00.000Z");

const product = (id: string, rate: number | null, extra: Partial<MenuProduct> = {}): MenuProduct => ({
  id,
  chain: "ethereum",
  protocolId: id.split(":")[1]!,
  protocolName: id.split(":")[1]!,
  name: id.split(":").at(-1)!,
  category: "stable" as MenuProduct["category"],
  rate: rate === null ? null : { label: "APY", value: rate, source: "test" },
  facts: [],
  observedAt: now.toISOString(),
  ...extra,
});
const products = [product("ethereum:lido:steth", 0.0225), product("ethereum:ethena:susde", 0.05), product(PT, 0.1459, { tokenKind: "pt", maturity: "2026-11-05T00:00:00.000Z" }), product(YT, -0.5, { tokenKind: "yt" })];
const prices = new Map([
  ["ETH", "3000.00000000"],
  [USDC, "1.00000000"],
  [USDe, "1.00000000"],
  [sUSDe, "1.25000000"],
  [stETH, "3000.00000000"],
]);
const holdings = (over: Partial<MenuHoldingsResponse> = {}): MenuHoldingsResponse => ({
  address: OWNER,
  holdings: [],
  extraProducts: [],
  spendable: [{ value: "1000000000", decimals: 6, symbol: "USDC" }],
  failed: [],
  observedAt: now.toISOString(),
  ...over,
});
const ok = (summary: string, effects?: EthProposalPreviewSlot extends infer _ ? NonNullable<Extract<EthProposalPreviewSlot, { ok: true }>["preview"]["effects"]> : never, warnings: string[] = []): EthProposalPreviewSlot => ({
  ok: true,
  preview: { summary, warnings, simulation: { ran: false, note: "t" }, ...(effects ? { effects } : {}) },
});
const swapStep: EthProposalStep = { kind: "uniswap_swap", tokenIn: "USDC", tokenOut: "USDe", amount: "100" };
const depositStep: EthProposalStep = { kind: "menu", productId: "ethereum:ethena:susde", action: "deposit", amount: "99" };
const swapFx = { in: [{ key: USDC, value: "100000000", decimals: 6, symbol: "USDC" }], out: [{ key: USDe, value: "99500000000000000000", decimals: 18, symbol: "USDe" }], approx: true };
const depositFx = { in: [{ key: USDe, value: "99000000000000000000", decimals: 18, symbol: "USDe" }], out: [{ key: sUSDe, value: "79200000000000000000", decimals: 18, symbol: "sUSDe" }] };

const compose = (steps: EthProposalStep[], previews: EthProposalPreviewSlot[], h = holdings(), extra: Partial<Parameters<typeof composeStrategyBrief>[0]> = {}) =>
  composeStrategyBrief({ owner: OWNER, name: "🍋 Lemon Ladder", tagline: "Idle USDC → sUSDe", steps, previews, holdings: h, products, prices, now, ...extra });

describe("composeStrategyBrief", () => {
  it("moves idle USDC into sUSDe: blended APY 0% → ~5%, value conserved within slippage", () => {
    const b = compose([swapStep, depositStep], [ok("Swap", swapFx), ok("Stake", depositFx)]);
    expect(b.before.lines.map((l) => [l.label, l.usd, l.apy])).toEqual([["USDC (wallet)", "1000.00000000", 0]]);
    expect(b.blendedApy.before).toBe(0);
    const after = Object.fromEntries(b.after.lines.map((l) => [l.label, l]));
    expect(after["USDC (wallet)"]!.usd).toBe("900.00000000");
    expect(after["USDe (wallet)"]!.usd).toBe("0.50000000");
    expect(after["sUSDe (Ethena)"]).toMatchObject({ usd: "99.00000000", apy: 0.05, productId: "ethereum:ethena:susde" });
    // 総額: 900 + 0.5 + 99 = 999.5 (0.5% slippage 分だけ減る)
    expect(b.after.totalUsd).toBe("999.50000000");
    expect(b.blendedApy.after).toBeCloseTo(0.05 * 99 / 999.5, 6);
    expect(b.blendedApy.delta).toBeCloseTo(b.blendedApy.after!, 6);
    expect(b.unpriced).toEqual([]);
    expect(b.horizon).toEqual([]);
    expect(b.markdown).toContain("# 🍋 Lemon Ladder");
    expect(b.markdown).toContain("_Idle USDC → sUSDe_");
    expect(b.markdown).toContain("**Blended APY:** 0.00% → 0.50% (+0.50% pts)");
    expect(b.markdown).toContain("Nothing runs until you approve");
  });

  it("aqua_ship moves USDC + USDe into an LP line that counts as 0% in the blend and adds the review date", () => {
    const steps: EthProposalStep[] = [{ kind: "aqua_ship", usdc: "40", usde: "40", bandBps: 50, reviewAt: "2026-10-10T00:00:00.000Z" }];
    const h = holdings({ spendable: [{ value: "100000000", decimals: 6, symbol: "USDC" }, { value: "100000000000000000000", decimals: 18, symbol: "USDe" }] });
    const b = compose(steps, [ok("Ship", undefined, ["Price guard: Within 50 bps (1 bps)."])], h);
    const lp = b.after.lines.find((l) => l.key === "aqua:usdc-usde")!;
    expect(lp).toMatchObject({ label: "Aqua USDC/USDe LP (1inch)", usd: "80.00000000", apy: null });
    expect(lp.amounts.map((a) => `${a.value} ${a.symbol}`)).toEqual(["40000000 USDC", "40000000000000000000 USDe"]);
    expect(b.after.totalUsd).toBe("200.00000000");
    expect(b.blendedApy.after).toBe(0);
    expect(b.blendedApy.excluded).toEqual(["Aqua USDC/USDe LP (1inch)"]);
    expect(b.aqua).toMatchObject({ bandBps: 50, feeBps: 5, reviewAt: "2026-10-10T00:00:00.000Z", peg: "Within 50 bps (1 bps)." });
    expect(b.horizon).toEqual([{ at: "2026-10-10T00:00:00.000Z", label: "Review the Aqua USDC/USDe strategy" }]);
    expect(b.markdown).toContain("## 1inch Aqua LP sleeve");
  });

  it("prices a held PT from the dashboard valuation, lists unpriced tokens, and lets a negative YT rate pull the blend down", () => {
    const h = holdings({
      spendable: [],
      holdings: [
        { productId: PT, amounts: [{ value: "100000000000000000000", decimals: 18, symbol: "PT-apyUSD" }], usd: "90.00000000" },
        { productId: YT, amounts: [{ value: "100000000000000000000", decimals: 18, symbol: "YT-apyUSD" }], usd: "10.00000000" },
        { productId: "ethereum:pendle:pt:0x0000000000000000000000000000000000000001", amounts: [{ value: "5000000000000000000", decimals: 18, symbol: "PT-mystery" }] },
      ],
    });
    const b = compose([], [], h);
    const byLabel = Object.fromEntries(b.before.lines.map((l) => [l.label, l]));
    expect(byLabel["PT-apyUSD (Pendle, 2026-11-05)"]).toMatchObject({ usd: "90.00000000", apy: 0.1459 });
    expect(byLabel["YT-apyUSD (Pendle)"]).toMatchObject({ usd: "10.00000000", apy: -0.5 });
    expect(byLabel["PT-mystery (Pendle)"]).toMatchObject({ usd: null, apy: null });
    expect(b.unpriced).toEqual(["PT-mystery"]);
    expect(b.before.totalUsd).toBe("100.00000000");
    // (90 × 14.59% + 10 × −50%) / 100 = 8.131%
    expect(b.blendedApy.before).toBeCloseTo(0.08131, 6);
    expect(b.horizon).toEqual([{ at: "2026-11-05T00:00:00.000Z", label: "PT-apyUSD matures (Pendle)" }]);
    expect(b.markdown).toContain("**Not priced (excluded from totals):** PT-mystery");
  });

  it("treats a matured PT as 0% (redeem 1:1) and keeps past maturities off the horizon", () => {
    const matured = "ethereum:pendle:pt:0x0000000000000000000000000000000000000002";
    const h = holdings({ spendable: [], holdings: [{ productId: matured, amounts: [{ value: "1000000000000000000", decimals: 18, symbol: "PT-old" }], usd: "1.00000000" }] });
    const b = composeStrategyBrief({
      owner: OWNER,
      name: "🍂 Old",
      steps: [],
      previews: [],
      holdings: h,
      products: [product(matured, -1, { tokenKind: "pt", maturity: "2025-04-10T00:00:00.000Z" })],
      prices,
      now,
    });
    expect(b.before.lines[0]).toMatchObject({ label: "PT-old (Pendle, matured 2025-04-10)", apy: 0, apyLabel: "Matured", usd: "1.00000000" });
    expect(b.blendedApy.before).toBe(0);
    expect(b.horizon).toEqual([]);
  });

  it("derives an implied PT price from the step's counter-leg when buying a PT nobody priced", () => {
    const buy: EthProposalStep = { kind: "menu", productId: PT, action: "deposit", amount: "100" };
    const fx = { in: [{ key: USDe, value: "100000000000000000000", decimals: 18, symbol: "USDe" }], out: [{ key: PT, value: "110000000000000000000", decimals: 18, symbol: "PT-apyUSD" }], approx: true };
    const h = holdings({ spendable: [{ value: "100000000000000000000", decimals: 18, symbol: "USDe" }] });
    const b = compose([buy], [ok("Buy PT", fx)], h);
    const pt = b.after.lines.find((l) => l.key === PT)!;
    // 単価は 8 桁に丸めるので 1e-6 USD 程度のずれは許容 (概算として approx が付く)
    expect(pt).toMatchObject({ approx: true, apy: 0.1459 });
    expect(Number(pt.usd)).toBeCloseTo(100, 5);
    expect(Number(b.after.totalUsd)).toBeCloseTo(100, 5);
  });

  it("keeps a deferred step out of the after view with a warning, and keeps value on a pending line for withdrawals", () => {
    const deferred: EthProposalPreviewSlot = { ok: false, note: "Uses balances produced by an earlier step; checked on the fork when it runs." };
    const b = compose([swapStep, depositStep], [ok("Swap", swapFx), deferred]);
    expect(b.after.lines.find((l) => l.key === sUSDe)).toBeUndefined();
    expect(b.warnings).toEqual(["Step 2 is checked on the fork when it runs; its result is not reflected in the after view."]);

    const lidoOut: EthProposalStep = { kind: "menu", productId: "ethereum:lido:steth", action: "withdraw", amount: "1" };
    const fx = { in: [{ key: stETH, value: "1000000000000000000", decimals: 18, symbol: "stETH" }], out: [], pending: [{ key: "ETH", value: "1000000000000000000", decimals: 18, symbol: "ETH" }], approx: true };
    const h = holdings({ spendable: [], holdings: [{ productId: "ethereum:lido:steth", amounts: [{ value: "2000000000000000000", decimals: 18, symbol: "stETH" }] }] });
    const c = compose([lidoOut], [ok("Withdraw", fx)], h);
    const pending = c.after.lines.find((l) => l.pending)!;
    expect(pending).toMatchObject({ key: "pending:ETH", label: "ETH arriving later", usd: "3000.00000000", apy: 0 });
    expect(c.after.totalUsd).toBe("6000.00000000");
    expect(c.blendedApy.after).toBeCloseTo(0.0225 / 2, 6);
    expect(c.horizon[0]).toMatchObject({ label: "Lido withdrawal claimable (queue, ≈ 1–5 days)", approx: true });
  });

  it("copies holdings failures and I/O warnings, and clamps overspend at 0", () => {
    const b = compose([swapStep], [ok("Swap", swapFx)], holdings({ spendable: [{ value: "50000000", decimals: 6, symbol: "USDC" }], failed: ["pendle"] }), { warnings: ["Prices could not be read (x)."] });
    expect(b.warnings).toEqual([
      "Prices could not be read (x).",
      'Holdings source "pendle" was unavailable; the before view may be incomplete.',
      "Step 1 spends more USDC than the snapshot shows; the after view clamps it at 0.",
    ]);
    expect(b.after.lines.find((l) => l.key === USDC)).toBeUndefined();
  });
});

describe("blendedApy", () => {
  it("weights by USD, counts unknown rates as 0 and lists them, ignores unpriced", () => {
    const r = blendedApy([
      { key: "a", label: "A", amounts: [], usd: "100.00000000", share: null, apy: 0.1 },
      { key: "b", label: "B", amounts: [], usd: "100.00000000", share: null, apy: null },
      { key: "c", label: "C", amounts: [], usd: null, share: null, apy: 0.9 },
    ]);
    expect(r).toEqual({ value: 0.05, excluded: ["B"] });
    expect(blendedApy([])).toEqual({ value: null, excluded: [] });
  });
});

test("renderBriefMarkdown lists deferred steps with their note", () => {
  const previews: EthProposalPreviewSlot[] = [ok("Swap USDC → USDe", swapFx), { ok: false, note: "later" }];
  const b = compose([swapStep, depositStep], previews);
  const md = renderBriefMarkdown(b, [swapStep, depositStep], previews);
  expect(md).toContain("1. Swap USDC → USDe");
  expect(md).toContain("2. Deposit 99 · ethereum:ethena:susde — later");
});
