/**
 * Agent rebalance proposals: 提出時の guard、bundleHash、fork 実行の順序 / 停止、承認の状態遷移。
 * builder / executor は mock (RPC 無し)。persistence は SEASONALS_DATA_DIR 未設定で no-op。
 */
jest.mock("./menu-actions", () => ({ buildMenuPlan: jest.fn() }));
jest.mock("./uniswap", () => ({ buildUniswapSwapPlan: jest.fn(), executeUniswapSwapOnFork: jest.fn(), UniswapError: class extends Error {} }));
jest.mock("./plans", () => ({ ...jest.requireActual("./plans"), buildActionPlan: jest.fn() }));
jest.mock("./execute", () => ({ assertForkEndpoint: jest.fn(), executeMenuOnFork: jest.fn(), executeOnFork: jest.fn() }));
jest.mock("./events", () => ({ registerUserSource: jest.fn(), _invalidateUser: jest.fn() }));
jest.mock("./holdings", () => ({ _invalidateHoldings: jest.fn() }));
jest.mock("./aqua", () => ({ buildAquaShipPlan: jest.fn(), shipAquaOnFork: jest.fn() }));
jest.mock("./strategy-brief", () => ({ buildStrategyBrief: jest.fn() }));

import { buildMenuPlan } from "./menu-actions";
import { buildUniswapSwapPlan, executeUniswapSwapOnFork } from "./uniswap";
import { buildActionPlan, PlanError } from "./plans";
import { assertForkEndpoint, executeMenuOnFork, executeOnFork } from "./execute";
import { registerUserSource } from "./events";
import { buildAquaShipPlan, shipAquaOnFork } from "./aqua";
import { buildStrategyBrief } from "./strategy-brief";
import { _resetAgentProposalsForTest, aquaInput, deriveProposalEvent, executeProposal, getProposal, previewProposal, rejectProposal, submitProposal, swapInput } from "./agent-proposals";

const OWNER = "0x0cA88aeB92357A00CDFAC815d5e11C4eEEefc2b5";
// module 読み込み時に登録される (beforeEach の clearAllMocks より前に取っておく)
const registeredSource = (registerUserSource as jest.Mock).mock.calls[0]?.[0] as ((owner: string) => { name: string; run: (t: string) => Promise<{ id: string }[]> }) | undefined;
const plan = (summary: string, steps = 1) => ({
  eventId: "e",
  actionType: "x",
  chainId: 1,
  owner: OWNER,
  target: "fork" as const,
  summary,
  steps: Array.from({ length: steps }, (_, i) => ({ kind: "call" as const, to: OWNER, data: "0x", value: "0", description: `${summary} #${i + 1}` })),
  simulation: { ran: true, ok: true, note: "ok" },
  builtAt: "",
  source: "test",
  broadcast: false as const,
});
const swapPlan = (amountOut: string | null, deviationBps = 0) => ({
  routing: "CLASSIC",
  amountIn: "100000000",
  amountOut,
  peg: { ok: true, deviationBps, bandBps: 50, reason: deviationBps ? `USDe/USDC off peg by ${deviationBps} bps (within ±50 bps).` : "on peg", prices: [] },
  steps: [
    { kind: "approval" as const, to: OWNER, data: "0x", value: "0", description: "Approve Permit2 to spend USDC." },
    { kind: "call" as const, to: OWNER, data: "0x", value: "0", description: "Swap USDC → USDe through Uniswap (CLASSIC)." },
  ],
  simulation: { ran: false, note: "checked on the fork" },
  broadcast: false as const,
  source: "uniswap-trading-api" as const,
});
const tx = (status: "success" | "reverted", description: string) => ({ hash: "0xabc", status, blockNumber: "1", gasUsed: "1", description });
const executedEvent = {} as never;

const brief = { name: "🍋 Lemon Ladder", before: { totalUsd: null, lines: [] }, after: { totalUsd: null, lines: [] }, blendedApy: { before: null, after: null, delta: null, excluded: [] }, horizon: [], unpriced: [], warnings: [], markdown: "# 🍋 Lemon Ladder", builtAt: "" };
const aquaPlan = {
  template: "PEGGED_STABLE",
  maker: OWNER,
  peg: { ok: true, deviationBps: 1, bandBps: 50, reason: "Within 50 bps (1 bps).", prices: [] },
  strategy: "0x",
  strategyHash: "0xabc",
  steps: [
    { kind: "approval" as const, to: OWNER, data: "0x", value: "0", description: "Approve Aqua to take USDC." },
    { kind: "call" as const, to: OWNER, data: "0x", value: "0", description: "Ship the Aqua USDC/USDe strategy." },
  ],
  reviewAt: "2026-10-10T00:00:00.000Z",
  broadcast: false as const,
  source: "1inch-aqua-sdk" as const,
};
const aquaStep = { kind: "aqua_ship", usdc: "100", usde: "100", bandBps: 50, reviewAt: "2026-10-10T00:00:00.000Z" };

const swapThenDeposit = {
  owner: OWNER,
  name: "🍋 Lemon Ladder",
  tagline: "Idle USDC → sUSDe",
  rationale: "sUSDe yields more than idle USDC.",
  steps: [
    { kind: "uniswap_swap", tokenIn: "USDC", tokenOut: "USDe", amount: "100" },
    { kind: "menu", productId: "ethereum:ethena:susde", action: "deposit", amount: "99" },
  ],
};

beforeEach(() => {
  _resetAgentProposalsForTest();
  jest.clearAllMocks();
  (buildUniswapSwapPlan as jest.Mock).mockResolvedValue(swapPlan("99500000000000000000"));
  (buildMenuPlan as jest.Mock).mockResolvedValue(plan("Deposit 99 USDe into sUSDe."));
  (buildActionPlan as jest.Mock).mockResolvedValue(plan("Claim Lido withdrawal."));
  (buildAquaShipPlan as jest.Mock).mockResolvedValue(aquaPlan);
  (buildStrategyBrief as jest.Mock).mockResolvedValue(brief);
});

describe("swapInput (symbol + decimal → address + smallest unit, only here)", () => {
  it("converts USDC with 6 decimals and USDe with 18", () => {
    expect(swapInput(OWNER, { kind: "uniswap_swap", tokenIn: "USDC", tokenOut: "USDe", amount: "100" })).toMatchObject({
      swapper: OWNER,
      tokenIn: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      tokenOut: "0x4c9EDD5852cd905f086C759E8383e09bff1E68B3",
      amount: "100000000",
    });
    expect(swapInput(OWNER, { kind: "uniswap_swap", tokenIn: "USDe", tokenOut: "USDC", amount: "1.5" }).amount).toBe("1500000000000000000");
  });
  it("rejects zero and too many decimals as invalid_amount", () => {
    expect(() => swapInput(OWNER, { kind: "uniswap_swap", tokenIn: "USDC", tokenOut: "USDe", amount: "0" })).toThrow(PlanError);
    expect(() => swapInput(OWNER, { kind: "uniswap_swap", tokenIn: "USDC", tokenOut: "USDe", amount: "1.1234567" })).toThrow(/decimals/);
  });
});

describe("submitProposal", () => {
  it("builds every step, defers only a later step's insufficient balance, hashes the steps, and attaches the brief", async () => {
    (buildMenuPlan as jest.Mock).mockRejectedValueOnce(new PlanError("insufficient_balance", "This address holds 0 USDe."));
    const p = await submitProposal(swapThenDeposit);
    expect(p.status).toBe("pending");
    expect(p).toMatchObject({ name: "🍋 Lemon Ladder", tagline: "Idle USDC → sUSDe", brief: { markdown: "# 🍋 Lemon Ladder" } });
    expect(buildStrategyBrief).toHaveBeenCalledWith(expect.objectContaining({ owner: OWNER, name: "🍋 Lemon Ladder", steps: swapThenDeposit.steps }));
    // swap の preview は effects (in USDC / out USDe、address key) を持つ
    expect(p.previews[0]).toMatchObject({
      ok: true,
      preview: {
        summary: expect.stringMatching(/Swap USDC/),
        amountOut: "99500000000000000000",
        effects: {
          in: [{ key: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", value: "100000000", decimals: 6, symbol: "USDC" }],
          out: [{ key: "0x4c9edd5852cd905f086c759e8383e09bff1e68b3", value: "99500000000000000000", decimals: 18, symbol: "USDe" }],
          approx: true,
        },
      },
    });
    expect(p.previews[1]).toMatchObject({ ok: false, note: expect.stringMatching(/earlier step.*0 USDe/) });
    expect(p.bundleHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(buildUniswapSwapPlan).toHaveBeenCalledWith(expect.objectContaining({ amount: "100000000" }));
    expect(buildMenuPlan).toHaveBeenCalledWith({ owner: OWNER, productId: "ethereum:ethena:susde", action: "deposit", amount: "99" });
    // 同じ steps でも id が hash に入るので別 proposal の hash は違う
    const q = await submitProposal(swapThenDeposit);
    expect(q.bundleHash).not.toBe(p.bundleHash);
  });
  it("does not defer a first-step balance problem or any other builder error (fail-closed)", async () => {
    (buildUniswapSwapPlan as jest.Mock).mockRejectedValueOnce(new PlanError("insufficient_balance", "0 USDC"));
    await expect(submitProposal(swapThenDeposit)).rejects.toMatchObject({ code: "insufficient_balance" });
    (buildMenuPlan as jest.Mock).mockRejectedValueOnce(new PlanError("unsupported_action", "Unknown product."));
    await expect(submitProposal(swapThenDeposit)).rejects.toMatchObject({ code: "unsupported_action" });
  });
  it("surfaces the peg deviation as a warning and validates the shape", async () => {
    (buildUniswapSwapPlan as jest.Mock).mockResolvedValueOnce(swapPlan("1", 12));
    const p = await submitProposal({ ...swapThenDeposit, steps: [swapThenDeposit.steps[0]] });
    expect(p.previews[0]).toMatchObject({ ok: true, preview: { warnings: [expect.stringMatching(/12 bps/)] } });
    await expect(submitProposal({ ...swapThenDeposit, owner: "nope" })).rejects.toMatchObject({ code: "invalid_argument", status: 400 });
    await expect(submitProposal({ ...swapThenDeposit, steps: Array(7).fill(swapThenDeposit.steps[0]) })).rejects.toMatchObject({ code: "invalid_argument" });
    await expect(submitProposal({ ...swapThenDeposit, steps: [{ kind: "uniswap_swap", tokenIn: "USDC", tokenOut: "USDC", amount: "1" }] })).rejects.toThrow(/differ/);
    await expect(submitProposal({ ...swapThenDeposit, steps: [{ kind: "menu", productId: "ethereum:lido:steth", action: "deposit", amount: "1e3" }] })).rejects.toThrow(/decimal/);
  });
  it("validates the strategy name (≤ 40 code points, at least one letter) and the tagline length", async () => {
    await expect(submitProposal({ ...swapThenDeposit, name: "🍋".repeat(41) })).rejects.toThrow(/1–40 characters/);
    await expect(submitProposal({ ...swapThenDeposit, name: "🍋🍋🍋" })).rejects.toThrow(/at least one letter/);
    await expect(submitProposal({ ...swapThenDeposit, tagline: "x".repeat(141) })).rejects.toMatchObject({ code: "invalid_argument" });
    const p = await submitProposal({ ...swapThenDeposit, name: "🍋".repeat(38) + "Ok" });
    expect(p.name).toBe("🍋".repeat(38) + "Ok");
  });
  it("aqua_ship: previews through buildAquaShipPlan with smallest units and the peg reason, and defers a balance shortfall only after step 1", async () => {
    const p = await submitProposal({ ...swapThenDeposit, steps: [aquaStep] });
    expect(buildAquaShipPlan).toHaveBeenCalledWith({ maker: OWNER, template: "PEGGED_STABLE", usdcAmount: "100000000", usdeAmount: "100000000000000000000", bandBps: 50, reviewAt: aquaStep.reviewAt });
    expect(p.previews[0]).toMatchObject({ ok: true, preview: { summary: "Ship the Aqua USDC/USDe strategy.", warnings: ["Price guard: Within 50 bps (1 bps)."] } });

    (buildAquaShipPlan as jest.Mock).mockRejectedValueOnce(new PlanError("insufficient_balance", "The maker does not hold enough USDC / USDe for these amounts."));
    await expect(submitProposal({ ...swapThenDeposit, steps: [aquaStep] })).rejects.toMatchObject({ code: "insufficient_balance" });
    (buildAquaShipPlan as jest.Mock).mockRejectedValueOnce(new PlanError("insufficient_balance", "The maker does not hold enough USDC / USDe for these amounts."));
    const q = await submitProposal({ ...swapThenDeposit, steps: [swapThenDeposit.steps[0], aquaStep] });
    expect(q.previews[1]).toMatchObject({ ok: false, note: expect.stringMatching(/earlier step/) });
    expect(() => aquaInput(OWNER, { ...aquaStep, kind: "aqua_ship", usdc: "0" })).toThrow(/greater than zero/);
  });
  it("previewProposal (dry run) returns previews + brief without storing anything", async () => {
    const r = await previewProposal(swapThenDeposit);
    expect(r).toMatchObject({ owner: OWNER, name: "🍋 Lemon Ladder", brief: { markdown: "# 🍋 Lemon Ladder" } });
    expect(r.previews).toHaveLength(2);
    expect(() => getProposal("anything")).toThrow(/No proposal/);
    const source = registeredSource!(OWNER);
    expect(await source.run("t")).toEqual([]);
  });
});

describe("executeProposal", () => {
  const menuOk = { target: "fork", plan: plan("Deposit 99 USDe into sUSDe."), txs: [tx("success", "deposit")], executedEvent };
  const swapOk = { target: "fork", plan: swapPlan("1"), txs: [tx("success", "approve"), tx("success", "swap")], executedEvent };

  it("requires the bundle hash that was shown, then runs steps in order on the fork", async () => {
    const p = await submitProposal(swapThenDeposit);
    await expect(executeProposal(p.id, { bundleHash: "0xdead", via: "web" })).rejects.toMatchObject({ code: "bundle_hash_mismatch", status: 409 });
    expect(assertForkEndpoint).not.toHaveBeenCalled();

    (executeUniswapSwapOnFork as jest.Mock).mockResolvedValueOnce(swapOk);
    (executeMenuOnFork as jest.Mock).mockResolvedValueOnce(menuOk);
    const done = await executeProposal(p.id, { bundleHash: p.bundleHash, via: "web" });
    expect(assertForkEndpoint).toHaveBeenCalled();
    expect(done.status).toBe("executed");
    expect(done.execution).toMatchObject({ via: "web", steps: [{ index: 0, ok: true, txs: swapOk.txs }, { index: 1, ok: true, summary: "Deposit 99 USDe into sUSDe." }] });
    expect(done.execution!.finishedAt).toBeDefined();
    expect(executeMenuOnFork).toHaveBeenCalledWith({ owner: OWNER, productId: "ethereum:ethena:susde", action: "deposit", amount: "99" });
    // 実行済みはもう実行できない
    await expect(executeProposal(p.id, { bundleHash: p.bundleHash, via: "chat" })).rejects.toMatchObject({ code: "invalid_status" });
  });
  it("stops at the first reverted or throwing step and marks the proposal failed", async () => {
    const p = await submitProposal(swapThenDeposit);
    (executeUniswapSwapOnFork as jest.Mock).mockResolvedValueOnce({ ...swapOk, txs: [tx("success", "approve"), tx("reverted", "swap")] });
    const failed = await executeProposal(p.id, { bundleHash: p.bundleHash, via: "chat" });
    expect(failed.status).toBe("failed");
    expect(failed.execution!.steps).toHaveLength(1);
    expect(failed.execution!.steps[0]).toMatchObject({ ok: false, error: expect.stringMatching(/reverted/) });
    expect(executeMenuOnFork).not.toHaveBeenCalled();

    const q = await submitProposal(swapThenDeposit);
    (executeUniswapSwapOnFork as jest.Mock).mockRejectedValueOnce(new PlanError("oracle_unavailable", "Price unavailable — refusing (fail-closed)."));
    const thrown = await executeProposal(q.id, { bundleHash: q.bundleHash, via: "web" });
    expect(thrown.status).toBe("failed");
    expect(thrown.execution!.steps[0]).toMatchObject({ ok: false, error: expect.stringMatching(/fail-closed/) });
  });
  it("refuses rejected, expired and concurrently executing proposals", async () => {
    const p = await submitProposal(swapThenDeposit);
    rejectProposal(p.id);
    await expect(executeProposal(p.id, { bundleHash: p.bundleHash, via: "web" })).rejects.toMatchObject({ code: "invalid_status" });
    expect(() => rejectProposal(p.id)).toThrow(/rejected/);

    const q = await submitProposal(swapThenDeposit);
    q.expiresAt = new Date(Date.now() - 1000).toISOString();
    expect(getProposal(q.id).status).toBe("expired");
    await expect(executeProposal(q.id, { bundleHash: q.bundleHash, via: "web" })).rejects.toMatchObject({ code: "expired" });

    const r = await submitProposal({ ...swapThenDeposit, steps: [swapThenDeposit.steps[0]] });
    let release!: () => void;
    (executeUniswapSwapOnFork as jest.Mock).mockImplementationOnce(() => new Promise<typeof swapOk>((resolve) => (release = () => resolve(swapOk))));
    const first = executeProposal(r.id, { bundleHash: r.bundleHash, via: "web" });
    await new Promise((res) => setImmediate(res));
    await expect(executeProposal(r.id, { bundleHash: r.bundleHash, via: "chat" })).rejects.toMatchObject({ code: expect.stringMatching(/already_executing|invalid_status/) });
    release();
    expect((await first).status).toBe("executed");
    expect(() => getProposal("nope")).toThrow(/No proposal/);
  });
  it("ships an Aqua step through shipAquaOnFork with smallest units", async () => {
    const p = await submitProposal({ ...swapThenDeposit, steps: [aquaStep] });
    (shipAquaOnFork as jest.Mock).mockResolvedValueOnce({ target: "fork", plan: aquaPlan, txs: [tx("success", "approve"), tx("success", "ship")], executedEvent });
    const done = await executeProposal(p.id, { bundleHash: p.bundleHash, via: "web" });
    expect(shipAquaOnFork).toHaveBeenCalledWith(expect.objectContaining({ maker: OWNER, usdcAmount: "100000000", usdeAmount: "100000000000000000000" }));
    expect(done.status).toBe("executed");
    expect(done.execution!.steps[0]).toMatchObject({ ok: true, summary: "Ship the Aqua USDC/USDe strategy." });
  });
  it("runs event actions through executeOnFork", async () => {
    const p = await submitProposal({ ...swapThenDeposit, steps: [{ kind: "event_action", eventId: "ethereum:lido:withdrawal:1", actionType: "lido_claim" }] });
    (executeOnFork as jest.Mock).mockResolvedValueOnce({ target: "fork", plan: plan("Claim Lido withdrawal."), txs: [tx("success", "claim")], executedEvent });
    const done = await executeProposal(p.id, { bundleHash: p.bundleHash, via: "chat" });
    expect(executeOnFork).toHaveBeenCalledWith({ owner: OWNER, eventId: "ethereum:lido:withdrawal:1", actionType: "lido_claim" });
    expect(done.status).toBe("executed");
  });
});

describe("calendar source", () => {
  it("shows pending / executing proposals as a user plan without actions, and registers as a user source", async () => {
    const p = await submitProposal(swapThenDeposit);
    const e = deriveProposalEvent(p, "2026-09-26T00:00:00.000Z");
    expect(e).toMatchObject({ class: "user_plan", kind: "agent_proposal", title: "Agent proposal: 🍋 Lemon Ladder", at: p.createdAt, owner: OWNER, actions: [], source: "agent-proposals" });
    expect(e.links[0]!.url).toBe("/agent");
    expect(e.metrics[0]).toMatchObject({ label: "Steps", value: expect.stringMatching(/Swap 100 USDC → USDe.*Deposit 99/) });

    expect(registeredSource).toBeDefined();
    const source = registeredSource!(OWNER);
    expect(source.name).toBe("agent:proposals");
    expect((await source.run("t")).map((x) => x.id)).toEqual([`ethereum:agent:proposal:${p.id}`]);
    rejectProposal(p.id);
    expect(await source.run("t")).toEqual([]);
  });
});
