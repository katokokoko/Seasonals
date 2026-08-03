/**
 * Phase 8.28: MCP plan lifecycle (compare → simulate → approve → execute) の
 * BFF 側テスト。store plan の永続遷移 + §29.3 セキュリティガード + fixture 回帰。
 */
import type { FastifyInstance } from "fastify";

import type { ActionSpec } from "@workspace/lib/types";

import { buildServer } from "./server";
import {
  _clearPlanStoreForTest,
  computeBundleHash,
  issueApprovalToken,
  validateAndConsumeToken,
} from "./plan-store";
import { fetchSwapQuote, fetchSwapTransaction } from "./clients/jupiter-swap";
import { getOracleResult } from "./clients/oracle";
import { fetchLstSolValues } from "./clients/lst-rates";

jest.mock("./clients/jupiter-swap");
// Phase 8.37: simulate / execute が実 oracle gate を通るようになったため mock
// (無 mock だと live Pyth を叩く = テストが hermetic でなくなる)
jest.mock("./clients/oracle");
// Phase 8.75: execute にも償還価値ガードが入り、ACTION は jito/SOL = **jitoSOL market**
// = ガード対象そのもの。mock が無いと live RPC を叩き、失敗すれば fail-closed で 409 に
// なって既存テストが落ちる (swap-earn.test.ts と同じ 3 点 mock)
jest.mock("./clients/lst-rates");

const mockQuote = fetchSwapQuote as jest.MockedFunction<typeof fetchSwapQuote>;
const mockSwapTx = fetchSwapTransaction as jest.MockedFunction<
  typeof fetchSwapTransaction
>;
const mockOracle = getOracleResult as jest.MockedFunction<typeof getOracleResult>;
const mockLstRates = fetchLstSolValues as jest.MockedFunction<
  typeof fetchLstSolValues
>;

/** 実測相当 (2026-08-03) の jitoSOL レート */
const JITOSOL_LAMPORTS = 1_293_886_836n;

function okOracle(): Awaited<ReturnType<typeof getOracleResult>> {
  return {
    asset_symbol: "SOL",
    status: "ok",
    primary: "pyth",
    price_usd: "80.00000000",
    pyth: { available: true, price_usd: "80.00000000", age_seconds: 2 },
    switchboard: { available: true, price_usd: "80.10000000", age_seconds: 3 },
    divergence_pct: 0.12,
    warnings: [],
    block_reason: null,
  } as Awaited<ReturnType<typeof getOracleResult>>;
}

function blockedOracle(
  reason: string
): Awaited<ReturnType<typeof getOracleResult>> {
  return {
    ...okOracle(),
    status: "blocked",
    primary: null,
    price_usd: null,
    block_reason: reason,
  } as Awaited<ReturnType<typeof getOracleResult>>;
}

const WALLET = "WaLLet1111111111111111111111111111111111111";
const ACTION: ActionSpec = {
  wallet_id: WALLET,
  action_type: "deposit",
  protocol: "jito",
  asset: "SOL",
  amount: "100000000",
};

let app: FastifyInstance;

beforeEach(async () => {
  jest.clearAllMocks();
  _clearPlanStoreForTest();
  mockOracle.mockResolvedValue(okOracle());
  mockQuote.mockResolvedValue({
    inputMint: "in",
    outputMint: "out",
    inAmount: "100000000",
    outAmount: "95000000",
    otherAmountThreshold: "94000000",
    swapMode: "ExactIn",
    slippageBps: 50,
    priceImpactPct: "0",
    routePlan: [],
  });
  mockSwapTx.mockResolvedValue({
    swapTransaction: "UNSIGNED_TX_B64",
    lastValidBlockHeight: 1,
  });
  // 0.1 SOL の deposit なら fair な受取は約 77,286,510 jitoSOL。既定 quote の
  // out 95,000,000 はそれより多い = ユーザー有利なので通る (§ ガードは不利方向のみ)
  mockLstRates.mockResolvedValue(new Map([["jitoSOL", JITOSOL_LAMPORTS]]));
  app = await buildServer({ logger: false });
});
afterEach(async () => {
  await app.close();
});

async function post(url: string, body: Record<string, unknown> = {}) {
  return app.inject({ method: "POST", url, payload: body });
}

async function createSimulatedPlan(): Promise<string> {
  const created = await post("/agent-plans", {
    objective: "max_yield",
    mcp_client_id: "mcp_test",
  });
  expect(created.statusCode).toBe(201);
  const planId = created.json().plan_id as string;
  const sim = await post(`/agent-plans/${planId}/simulate`, {
    action_spec: ACTION,
  });
  expect(sim.statusCode).toBe(200);
  return planId;
}

describe("plan lifecycle (compare → simulate → approve → execute)", () => {
  it("draft 作成 → simulate が selected_action/simulation_result を永続 (§11.7)", async () => {
    const planId = await createSimulatedPlan();
    const got = await app.inject({ method: "GET", url: `/agent-plans/${planId}` });
    const plan = got.json();
    expect(plan.status).toBe("simulated");
    expect(plan.selected_action).toEqual(ACTION);
    expect(plan.simulation_result.bundle_hash).toBe(computeBundleHash(ACTION));
  });

  it("8.37 (B11): bundle_hash はネスト field も含み、キー順に依らない", () => {
    const a = {
      ...ACTION,
      metadata: { share_mint: "M1", pool_id: "P1" },
    } as ActionSpec;
    const b = {
      ...ACTION,
      metadata: { pool_id: "P1", share_mint: "M1" }, // 同値・順序違い
    } as ActionSpec;
    const c = {
      ...ACTION,
      metadata: { share_mint: "M2", pool_id: "P1" }, // ネスト値の改ざん
    } as ActionSpec;
    expect(computeBundleHash(a)).toBe(computeBundleHash(b));
    // 旧実装 (replacer 配列) はネスト field を落とすため a と c が同 hash になっていた
    expect(computeBundleHash(a)).not.toBe(computeBundleHash(c));
  });

  it("bundle_hash は決定的 (同じ action → 同じ hash)", async () => {
    const a = await createSimulatedPlan();
    const b = await createSimulatedPlan();
    const [pa, pb] = await Promise.all([
      app.inject({ method: "GET", url: `/agent-plans/${a}` }),
      app.inject({ method: "GET", url: `/agent-plans/${b}` }),
    ]);
    expect(pa.json().simulation_result.bundle_hash).toBe(
      pb.json().simulation_result.bundle_hash
    );
  });

  it("request-approval → pending_user、approve → approved + token 発行 → execute 成功", async () => {
    const planId = await createSimulatedPlan();
    const pending = await post(`/agent-plans/${planId}/request-approval`);
    expect(pending.json().status).toBe("pending_user");

    const approved = await post(`/agent-plans/${planId}/approve`);
    expect(approved.statusCode).toBe(200);
    const token = approved.json().approval_token;
    expect(token.token_id).toBeDefined();
    expect(token.consumed_at).toBeNull();
    // token は GET /approval-tokens でも引ける (mobile カード互換)
    const tokRes = await app.inject({
      method: "GET",
      url: `/approval-tokens/${token.token_id}`,
    });
    expect(tokRes.statusCode).toBe(200);

    const exec = await post(`/agent-plans/${planId}/execute`, {
      approval_token: token.token_id,
    });
    expect(exec.statusCode).toBe(200);
    const body = exec.json();
    expect(body.status).toBe("pushed_to_mobile");
    expect(body.unsigned_transactions[0].tx_base64).toBe("UNSIGNED_TX_B64");
    expect(body.plan.status).toBe("executing");
  });

  it("8.37 (B2): simulate の oracle は実 getOracleResult の値を透過する", async () => {
    const planId = await createSimulatedPlan();
    const got = await app.inject({ method: "GET", url: `/agent-plans/${planId}` });
    const oracle = got.json().simulation_result.oracle;
    expect(oracle).toEqual({
      primary: "pyth",
      primary_age_seconds: 2, // mock の age をそのまま反映 (捏造 stub でない)
      divergence_pct: 0.12,
      warnings: [],
    });
  });

  it("8.37 (B2): 両 stale は simulate も 409 oracle_blocked (§4.6 表)", async () => {
    mockOracle.mockResolvedValue(blockedOracle("oracle_both_stale"));
    const created = await post("/agent-plans", { objective: "max_yield" });
    const planId = created.json().plan_id as string;
    const sim = await post(`/agent-plans/${planId}/simulate`, {
      action_spec: ACTION,
    });
    expect(sim.statusCode).toBe(409);
    expect(sim.json().error).toBe("oracle_blocked");
  });

  it("8.37 (B2): >5% 乖離は simulate 通過 + 強警告 (execute 側で拒否する)", async () => {
    mockOracle.mockResolvedValue(blockedOracle("oracle_divergence_too_large"));
    const created = await post("/agent-plans", { objective: "max_yield" });
    const planId = created.json().plan_id as string;
    const sim = await post(`/agent-plans/${planId}/simulate`, {
      action_spec: ACTION,
    });
    expect(sim.statusCode).toBe(200);
  });

  it("8.37 (B1): execute は oracle blocked で 409、token は消費されない", async () => {
    const planId = await createSimulatedPlan();
    await post(`/agent-plans/${planId}/request-approval`);
    const token = (await post(`/agent-plans/${planId}/approve`)).json()
      .approval_token;

    mockOracle.mockResolvedValue(blockedOracle("oracle_both_stale"));
    const exec = await post(`/agent-plans/${planId}/execute`, {
      approval_token: token.token_id,
    });
    expect(exec.statusCode).toBe(409);
    expect(exec.json().error).toBe("oracle_blocked");
    expect(mockSwapTx).not.toHaveBeenCalled(); // 署名可能 tx を作らない

    // token は未消費 — oracle 回復後に同じ token で execute できる (§29.3)
    mockOracle.mockResolvedValue(okOracle());
    const retry = await post(`/agent-plans/${planId}/execute`, {
      approval_token: token.token_id,
    });
    expect(retry.statusCode).toBe(200);
  });

  /**
   * Phase 8.75: 8.72 の償還価値ガードは human 経路 (buildSwapEarnTx) にしか
   * 掛かっておらず、agent 経路が素通りしていた。oracle で 8.37 (B1) が直したのと
   * 同じ drift を、同じ形 (409 + token 温存) で塞いだことを固定する。
   */
  it("8.75: execute は fair value blocked で 409、token は消費されない", async () => {
    const planId = await createSimulatedPlan();
    await post(`/agent-plans/${planId}/request-approval`);
    const token = (await post(`/agent-plans/${planId}/approve`)).json()
      .approval_token;

    // fair = 約 77,286,510 に対し 70,000,000 しか受け取れない quote (約 942bps 不利)
    mockQuote.mockResolvedValue({
      inputMint: "in",
      outputMint: "out",
      inAmount: "100000000",
      outAmount: "70000000",
      otherAmountThreshold: "69000000",
      swapMode: "ExactIn",
      slippageBps: 50,
      priceImpactPct: "0",
      routePlan: [],
    });
    const exec = await post(`/agent-plans/${planId}/execute`, {
      approval_token: token.token_id,
    });
    expect(exec.statusCode).toBe(409);
    const body = exec.json();
    expect(body.error).toBe("fair_value_blocked");
    expect(body.reason).toBe("fair_value_deviation");
    expect(body.deviation_bps).toBeGreaterThan(body.guard_bps);
    // 生 code でなく人が読める 1 文が Agent にも届く (8.74 と同じ扱い)
    expect(body.message).toMatch(/jitoSOL redemption value/);
    expect(mockSwapTx).not.toHaveBeenCalled(); // 署名可能 tx を作らない

    // token は未消費 — 乖離が戻れば同じ token で execute できる (§29.3)
    mockQuote.mockResolvedValue({
      inputMint: "in",
      outputMint: "out",
      inAmount: "100000000",
      outAmount: "77200000", // fair 比 -11bps。平常の流動性プレミアム相当
      otherAmountThreshold: "77000000",
      swapMode: "ExactIn",
      slippageBps: 50,
      priceImpactPct: "0",
      routePlan: [],
    });
    const retry = await post(`/agent-plans/${planId}/execute`, {
      approval_token: token.token_id,
    });
    expect(retry.statusCode).toBe(200);
  });

  it("8.75: 参照レートを持たない market (jlUSDC) は素通りする", async () => {
    const created = await post("/agent-plans", { objective: "max_yield" });
    const planId = created.json().plan_id as string;
    // jupiter_lend/USDC → share_symbol "jlUSDC"。LST でないので償還価値の参照が無い
    const action: ActionSpec = {
      ...ACTION,
      protocol: "jupiter_lend",
      asset: "USDC",
      amount: "1000000",
    };
    expect(
      (await post(`/agent-plans/${planId}/simulate`, { action_spec: action }))
        .statusCode
    ).toBe(200);
    await post(`/agent-plans/${planId}/request-approval`);
    const token = (await post(`/agent-plans/${planId}/approve`)).json()
      .approval_token;

    const exec = await post(`/agent-plans/${planId}/execute`, {
      approval_token: token.token_id,
    });
    expect(exec.statusCode).toBe(200);
    // 参照を持たない market ではレート取得自体を試みない (無駄な I/O を増やさない)
    expect(mockLstRates).not.toHaveBeenCalled();
  });

  it("§29.3: token 再利用は already_consumed で拒否", async () => {
    const planId = await createSimulatedPlan();
    await post(`/agent-plans/${planId}/request-approval`);
    const token = (await post(`/agent-plans/${planId}/approve`)).json()
      .approval_token;
    const first = await post(`/agent-plans/${planId}/execute`, {
      approval_token: token.token_id,
    });
    expect(first.statusCode).toBe(200);
    // executing 状態での再実行は 409 (status guard が先に効く)
    const second = await post(`/agent-plans/${planId}/execute`, {
      approval_token: token.token_id,
    });
    expect(second.statusCode).toBe(409);
    // token 自体も消費済み (validateAndConsume 単体で確認)
    const v = validateAndConsumeToken(token.token_id, {});
    expect(v).toEqual({ valid: false, reason: "already_consumed" });
  });

  it("§29.3: 未知 token / simulate 前 approve / 未承認 execute の拒否", async () => {
    const planId = await createSimulatedPlan();
    await post(`/agent-plans/${planId}/request-approval`);
    await post(`/agent-plans/${planId}/approve`);
    const bad = await post(`/agent-plans/${planId}/execute`, {
      approval_token: "nope",
    });
    expect(bad.statusCode).toBe(403);
    expect(bad.json().reason).toBe("not_found");

    // simulate 無し (draft) の approve は status guard で 409
    const draft = await post("/agent-plans", { objective: "max_yield" });
    const draftId = draft.json().plan_id;
    const res = await post(`/agent-plans/${draftId}/approve`);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("invalid_status_transition");

    // 未承認 (simulated のまま) の execute は 409
    const p2 = await createSimulatedPlan();
    const t = issueApprovalToken({
      user_id: "u",
      plan_id: p2,
      mcp_client_id: "m",
      bundle_hash: computeBundleHash(ACTION),
    });
    const notApproved = await post(`/agent-plans/${p2}/execute`, {
      approval_token: t.token_id,
    });
    expect(notApproved.statusCode).toBe(409);
  });

  it("§29.3: 期限切れ / bundle_hash 不一致 / wrong_plan (store 単体)", () => {
    const expired = issueApprovalToken({
      user_id: "u",
      plan_id: "p",
      mcp_client_id: "m",
      bundle_hash: "0xabc",
      ttl_seconds: -1,
    });
    expect(validateAndConsumeToken(expired.token_id, {})).toEqual({
      valid: false,
      reason: "expired",
    });
    const t = issueApprovalToken({
      user_id: "u",
      plan_id: "p",
      mcp_client_id: "m",
      bundle_hash: "0xabc",
    });
    expect(
      validateAndConsumeToken(t.token_id, { bundle_hash: "0xdef" })
    ).toEqual({ valid: false, reason: "bundle_hash_mismatch" });
    expect(validateAndConsumeToken(t.token_id, { plan_id: "other" })).toEqual({
      valid: false,
      reason: "wrong_plan",
    });
    // ガード違反では消費されない → 正しい条件なら通る
    const ok = validateAndConsumeToken(t.token_id, {
      plan_id: "p",
      bundle_hash: "0xabc",
    });
    expect(ok.valid).toBe(true);
  });

  it("reject は永続、idempotent な request-approval は push を再送しない", async () => {
    const planId = await createSimulatedPlan();
    await post(`/agent-plans/${planId}/request-approval`);
    await post(`/agent-plans/${planId}/request-approval`); // idempotent
    const rejected = await post(`/agent-plans/${planId}/reject`, {
      reason: "user_declined",
    });
    expect(rejected.json().status).toBe("rejected");
    const got = await app.inject({ method: "GET", url: `/agent-plans/${planId}` });
    expect(got.json().status).toBe("rejected"); // 永続
  });

  it("fixture plan の既存挙動は不変 (回帰)", async () => {
    const list = await app.inject({ method: "GET", url: "/agent-plans" });
    const plans = list.json();
    expect(plans.some((p: { plan_id: string }) => p.plan_id === "plan_002")).toBe(
      true
    );
    // fixture の approve は非永続 (2 回目も同じ元 status から遷移できる)
    const a1 = await post("/agent-plans/plan_002/approve");
    expect(a1.statusCode).toBe(200);
    const a2 = await post("/agent-plans/plan_002/approve");
    expect(a2.statusCode).toBe(200);
  });
});
