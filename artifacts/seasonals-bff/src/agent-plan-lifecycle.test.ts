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

jest.mock("./clients/jupiter-swap");

const mockQuote = fetchSwapQuote as jest.MockedFunction<typeof fetchSwapQuote>;
const mockSwapTx = fetchSwapTransaction as jest.MockedFunction<
  typeof fetchSwapTransaction
>;

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
