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

import { buildMenuPlan } from "./menu-actions";
import { buildUniswapSwapPlan, executeUniswapSwapOnFork } from "./uniswap";
import { buildActionPlan, PlanError } from "./plans";
import { assertForkEndpoint, executeMenuOnFork, executeOnFork } from "./execute";
import { registerUserSource } from "./events";
import { _resetAgentProposalsForTest, deriveProposalEvent, executeProposal, getProposal, rejectProposal, submitProposal, swapInput } from "./agent-proposals";

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

const swapThenDeposit = {
  owner: OWNER,
  title: "USDC → sUSDe",
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
  it("builds every step, defers only a later step's insufficient balance, and hashes the steps", async () => {
    (buildMenuPlan as jest.Mock).mockRejectedValueOnce(new PlanError("insufficient_balance", "This address holds 0 USDe."));
    const p = await submitProposal(swapThenDeposit);
    expect(p.status).toBe("pending");
    expect(p.previews[0]).toMatchObject({ ok: true, preview: { summary: expect.stringMatching(/Swap USDC/), amountOut: "99500000000000000000" } });
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
    expect(e).toMatchObject({ class: "user_plan", kind: "agent_proposal", at: p.createdAt, owner: OWNER, actions: [], source: "agent-proposals" });
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
