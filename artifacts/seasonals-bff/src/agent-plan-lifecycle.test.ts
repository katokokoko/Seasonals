/**
 * Agent plan lifecycle (compare → simulate → approve → execute → signatures) の BFF 側テスト。
 *
 * 2026-10-06 の契約: 人が承認する plan は web が approve → execute (unsigned tx) → 署名 →
 * 送信 → /signatures (or /failed) まで一気に行う。execute は lib の resolveSolanaRoute で
 * 13 route に解決し、人と同じ /protocols/* の tx builder で組む (agent-plan-executor.ts)。
 * plan は .data/agent-plans.json に永続、24h で expired。§29.3 セキュリティガードの回帰も兼ねる。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FastifyInstance } from "fastify";

import { AgentPlanStatus, type ActionSpec } from "@workspace/lib/types";

import { buildServer } from "./server";
import {
  _clearPlanStoreForTest,
  _reloadPlanStoreForTest,
  computeBundleHash,
  issueApprovalToken,
  updatePlan,
  validateAndConsumeToken,
} from "./plan-store";
import { _resetPolicyForTest } from "./policy-store";
import { _resetAutonomousForTest, getDailyCount } from "./autonomous";
import { txBuildRequestFor } from "./agent-plan-executor";
import { fetchSwapQuote, fetchSwapTransaction } from "./clients/jupiter-swap";
import { getOracleResult } from "./clients/oracle";
import { fetchLstSolValues } from "./clients/lst-rates";
import { getWalletBalanceSmallest } from "./clients/helius-rpc";
import {
  fetchKaminoDepositCaps,
  fetchKaminoDepositTx,
  fetchKaminoWithdrawTx,
} from "./clients/kamino-tx";

jest.mock("./clients/jupiter-swap");
// Phase 8.37: simulate / execute が実 oracle gate を通る (無 mock だと live Pyth を叩く)
jest.mock("./clients/oracle");
// Phase 8.75: ACTION は jito/SOL = jitoSOL market = 償還価値ガードの対象
jest.mock("./clients/lst-rates");
// 8.80: swap-earn builder の残高 gate (無 mock だと live RPC)
jest.mock("./clients/helius-rpc");
// Kamino route の builder (Kamino REST)
jest.mock("./clients/kamino-tx");

const mockQuote = fetchSwapQuote as jest.MockedFunction<typeof fetchSwapQuote>;
const mockSwapTx = fetchSwapTransaction as jest.MockedFunction<
  typeof fetchSwapTransaction
>;
const mockOracle = getOracleResult as jest.MockedFunction<typeof getOracleResult>;
const mockLstRates = fetchLstSolValues as jest.MockedFunction<
  typeof fetchLstSolValues
>;
const mockBalance = getWalletBalanceSmallest as jest.MockedFunction<
  typeof getWalletBalanceSmallest
>;
const mockKaminoDeposit = fetchKaminoDepositTx as jest.MockedFunction<
  typeof fetchKaminoDepositTx
>;
const mockKaminoWithdraw = fetchKaminoWithdrawTx as jest.MockedFunction<
  typeof fetchKaminoWithdrawTx
>;
const mockKaminoCaps = fetchKaminoDepositCaps as jest.MockedFunction<
  typeof fetchKaminoDepositCaps
>;

/** 実測相当 (2026-08-03) の jitoSOL レート */
const JITOSOL_LAMPORTS = 1_293_886_836n;
/** Kamino Main Market reserve (lib/config/kamino-markets.ts)。USDC は deposit_blocked_reason 付き */
const KAMINO_USDC_RESERVE = "D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59";
const KAMINO_SOL_RESERVE = "d4A2prbA2whesmvHaL88BH6Ewn5N4bTSU2Ze8P6Bc4Q";
/** base58 の 88 文字 signature (形式だけ正しい) */
const SIG_A = "5".repeat(88);
const SIG_B = "4".repeat(87);

function okOracle(): Awaited<ReturnType<typeof getOracleResult>> {
  return {
    asset_symbol: "SOL",
    status: "ok",
    primary: "pyth",
    price_usd: "80.00000000",
    pyth: { available: true, price_usd: "80.00000000", age_seconds: 2 },
    secondary: { source: "redstone", available: true, price_usd: "80.10000000", age_seconds: 3 },
    tier: "A",
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
const OTHER_WALLET = "OtherWaLLet11111111111111111111111111111111";
const ACTION: ActionSpec = {
  wallet_id: WALLET,
  action_type: "deposit",
  protocol: "jito",
  asset: "SOL",
  amount: "100000000",
};
const KAMINO_DEPOSIT: ActionSpec = {
  wallet_id: WALLET,
  action_type: "deposit",
  protocol: "kamino",
  asset: "SOL",
  amount: "2500000000", // 2.5 SOL
};
const KAMINO_WITHDRAW: ActionSpec = {
  wallet_id: WALLET,
  action_type: "withdraw",
  protocol: "kamino",
  asset: "USDC",
  amount: "1000000",
  metadata: { share_mint: KAMINO_USDC_RESERVE },
};

let app: FastifyInstance;

beforeEach(async () => {
  jest.clearAllMocks();
  _clearPlanStoreForTest();
  _resetPolicyForTest();
  _resetAutonomousForTest();
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
  mockBalance.mockResolvedValue(null); // 残高不明 = UX gate は素通し
  mockKaminoDeposit.mockResolvedValue({ transaction: "KAMINO_DEP_TX" });
  mockKaminoWithdraw.mockResolvedValue({ transaction: "KAMINO_WD_TX" });
  mockKaminoCaps.mockResolvedValue([]);
  app = await buildServer({ logger: false });
});
afterEach(async () => {
  await app.close();
});

async function post(url: string, body?: Record<string, unknown>) {
  return app.inject({
    method: "POST",
    url,
    ...(body === undefined ? {} : { payload: body }),
  });
}
async function get(url: string) {
  return app.inject({ method: "GET", url });
}

async function createSimulatedPlan(action: ActionSpec = ACTION): Promise<string> {
  const created = await post("/agent-plans", {
    objective: "max_yield",
    mcp_client_id: "mcp_test",
  });
  expect(created.statusCode).toBe(201);
  const planId = created.json().plan_id as string;
  const sim = await post(`/agent-plans/${planId}/simulate`, {
    action_spec: action,
  });
  expect(sim.statusCode).toBe(200);
  return planId;
}

/** simulate → request-approval → approve (人)。token_id を返す */
async function approvedPlan(
  action: ActionSpec = ACTION
): Promise<{ planId: string; tokenId: string }> {
  const planId = await createSimulatedPlan(action);
  expect((await post(`/agent-plans/${planId}/request-approval`)).json().status).toBe(
    "pending_user"
  );
  const approved = await post(`/agent-plans/${planId}/approve`);
  expect(approved.statusCode).toBe(200);
  return { planId, tokenId: approved.json().approval_token.token_id as string };
}

/** approve → execute まで。execute 応答を返す */
async function executingPlan(action: ActionSpec = ACTION) {
  const { planId, tokenId } = await approvedPlan(action);
  const exec = await post(`/agent-plans/${planId}/execute`, {
    approval_token: tokenId,
    via: "web",
  });
  expect(exec.statusCode).toBe(200);
  return { planId, tokenId, exec: exec.json() };
}

describe("simulate / bundle_hash", () => {
  it("draft 作成 → simulate が selected_action/simulation_result を永続 (§11.7)、expires_at = 作成 + 24h", async () => {
    const planId = await createSimulatedPlan();
    const plan = (await get(`/agent-plans/${planId}`)).json();
    expect(plan.status).toBe("simulated");
    expect(plan.selected_action).toEqual(ACTION);
    expect(plan.simulation_result.bundle_hash).toBe(computeBundleHash(ACTION));
    expect(Date.parse(plan.expires_at) - Date.parse(plan.created_at)).toBe(
      24 * 60 * 60 * 1000
    );
  });

  it("8.37 (B11): bundle_hash はネスト field も含み、キー順に依らない", () => {
    const a = { ...ACTION, metadata: { share_mint: "M1", pool_id: "P1" } } as ActionSpec;
    const b = { ...ACTION, metadata: { pool_id: "P1", share_mint: "M1" } } as ActionSpec;
    const c = { ...ACTION, metadata: { share_mint: "M2", pool_id: "P1" } } as ActionSpec;
    expect(computeBundleHash(a)).toBe(computeBundleHash(b));
    // 旧実装 (replacer 配列) はネスト field を落とすため a と c が同 hash になっていた
    expect(computeBundleHash(a)).not.toBe(computeBundleHash(c));
  });

  it("bundle_hash は決定的 (同じ action → 同じ hash)", async () => {
    const a = await createSimulatedPlan();
    const b = await createSimulatedPlan();
    const [pa, pb] = await Promise.all([
      get(`/agent-plans/${a}`),
      get(`/agent-plans/${b}`),
    ]);
    expect(pa.json().simulation_result.bundle_hash).toBe(
      pb.json().simulation_result.bundle_hash
    );
  });

  it("8.37 (B2): simulate の oracle は実 getOracleResult の値を透過する", async () => {
    const planId = await createSimulatedPlan();
    const oracle = (await get(`/agent-plans/${planId}`)).json().simulation_result.oracle;
    expect(oracle).toEqual({
      primary: "pyth",
      primary_age_seconds: 2, // mock の age をそのまま反映 (捏造 stub でない)
      divergence_pct: 0.12,
      warnings: [],
    });
  });

  it("8.37 (B2): 両 stale は simulate も 409 oracle_blocked (§4.6 表)", async () => {
    mockOracle.mockResolvedValue(blockedOracle("oracle_both_stale"));
    const planId = (await post("/agent-plans", { objective: "max_yield" })).json().plan_id;
    const sim = await post(`/agent-plans/${planId}/simulate`, { action_spec: ACTION });
    expect(sim.statusCode).toBe(409);
    expect(sim.json().error).toBe("oracle_blocked");
  });

  it("8.37 (B2): >5% 乖離は simulate 通過 + 強警告 (execute 側で拒否する)", async () => {
    mockOracle.mockResolvedValue(blockedOracle("oracle_divergence_too_large"));
    const planId = (await post("/agent-plans", { objective: "max_yield" })).json().plan_id;
    const sim = await post(`/agent-plans/${planId}/simulate`, { action_spec: ACTION });
    expect(sim.statusCode).toBe(200);
  });

  it("executing 以降の plan は再 simulate で巻き戻せない (409)", async () => {
    const { planId } = await executingPlan();
    const sim = await post(`/agent-plans/${planId}/simulate`, { action_spec: ACTION });
    expect(sim.statusCode).toBe(409);
    expect((await get(`/agent-plans/${planId}`)).json().status).toBe("executing");
  });
});

describe("approve → execute (unsigned tx を web が署名する)", () => {
  it("approve は body 不要、approved_by=user + token。execute は awaiting_signature + unsigned tx (swap-earn)", async () => {
    const planId = await createSimulatedPlan();
    await post(`/agent-plans/${planId}/request-approval`);
    const approved = await post(`/agent-plans/${planId}/approve`);
    expect(approved.statusCode).toBe(200);
    const body = approved.json();
    expect(body.status).toBe("approved");
    expect(body.approved_by).toBe("user");
    expect(body.approval_token.consumed_at).toBeNull();
    expect(body.tx).toBeUndefined(); // memo stub は廃止
    // token は GET /approval-tokens でも引ける (mobile カード互換)
    expect((await get(`/approval-tokens/${body.approval_token.token_id}`)).statusCode).toBe(200);

    const dailyBefore = getDailyCount();
    const exec = await post(`/agent-plans/${planId}/execute`, {
      approval_token: body.approval_token.token_id,
      via: "web",
    });
    expect(exec.statusCode).toBe(200);
    const out = exec.json();
    expect(out.status).toBe("awaiting_signature");
    expect(out.execution_id).toMatch(/^exec_/);
    expect(out.plan.status).toBe("executing");
    expect(out.unsigned_transactions).toEqual([
      { index: 0, label: "deposit SOL on jito", tx_base64: "UNSIGNED_TX_B64" },
    ]);
    // 人と同じ swap-earn builder (slippage 50bps、wallet が user)
    expect(mockQuote).toHaveBeenCalledWith(
      expect.objectContaining({ amount: "100000000", slippageBps: 50 })
    );
    expect(mockSwapTx).toHaveBeenCalledWith(
      expect.objectContaining({ userPublicKey: WALLET })
    );
    // max_daily_executions を数える
    expect(getDailyCount()).toBe(dailyBefore + 1);
    // token は消費済み
    expect(validateAndConsumeToken(body.approval_token.token_id, {})).toEqual({
      valid: false,
      reason: "already_consumed",
    });
  });

  it("Kamino reserve deposit: resolveSolanaRoute → Kamino builder (human 単位に変換)", async () => {
    const { exec } = await executingPlan(KAMINO_DEPOSIT);
    expect(exec.unsigned_transactions).toEqual([
      { index: 0, label: "deposit SOL on kamino", tx_base64: "KAMINO_DEP_TX" },
    ]);
    expect(mockKaminoDeposit).toHaveBeenCalledWith(
      expect.objectContaining({ wallet: WALLET, reserve: KAMINO_SOL_RESERVE, amount: "2.5" })
    );
    expect(mockSwapTx).not.toHaveBeenCalled();
  });

  it("Kamino reserve withdraw: share_mint (= reserve) で解決", async () => {
    const { exec } = await executingPlan(KAMINO_WITHDRAW);
    expect(exec.unsigned_transactions[0].tx_base64).toBe("KAMINO_WD_TX");
    expect(mockKaminoWithdraw).toHaveBeenCalledWith(
      expect.objectContaining({ reserve: KAMINO_USDC_RESERVE, amount: "1" })
    );
  });

  it("builder が止めた時 (Kamino 預入停止 409) は status と body を透過、plan は approved・token 未消費", async () => {
    mockKaminoCaps.mockResolvedValue([{ reserve: KAMINO_SOL_RESERVE, limit: 0n }] as never);
    const { planId, tokenId } = await approvedPlan(KAMINO_DEPOSIT);
    const exec = await post(`/agent-plans/${planId}/execute`, { approval_token: tokenId });
    expect(exec.statusCode).toBe(409);
    expect(exec.json().error).toBe("deposit_cap_reached");
    expect((await get(`/agent-plans/${planId}`)).json().status).toBe("approved");
    mockKaminoCaps.mockResolvedValue([]);
    const retry = await post(`/agent-plans/${planId}/execute`, { approval_token: tokenId });
    expect(retry.statusCode).toBe(200);
  });

  it("registry が預入を塞いだ reserve (Kamino USDC) も builder の 409 をそのまま返す", async () => {
    const { planId, tokenId } = await approvedPlan({ ...KAMINO_DEPOSIT, asset: "USDC", amount: "1000000" });
    const exec = await post(`/agent-plans/${planId}/execute`, { approval_token: tokenId });
    expect(exec.statusCode).toBe(409);
    expect(exec.json()).toMatchObject({ error: "deposit_unavailable", route: "kamino_deposit" });
    expect(mockKaminoDeposit).not.toHaveBeenCalled();
  });

  it("route に解決できない action は 422 unsupported_market (token 未消費)", async () => {
    const { planId, tokenId } = await approvedPlan({
      ...ACTION,
      protocol: "nowhere_protocol",
      asset: "XYZ",
    });
    const exec = await post(`/agent-plans/${planId}/execute`, { approval_token: tokenId });
    expect(exec.statusCode).toBe(422);
    expect(exec.json().error).toBe("unsupported_market");
    expect(validateAndConsumeToken(tokenId, {}).valid).toBe(true); // 未消費だった
  });

  it("via は web | autonomous のみ", async () => {
    const { planId, tokenId } = await approvedPlan();
    const bad = await post(`/agent-plans/${planId}/execute`, {
      approval_token: tokenId,
      via: "mobile",
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe("invalid_via");
  });

  it("8.37 (B1): execute は oracle blocked で 409、token は消費されない", async () => {
    const { planId, tokenId } = await approvedPlan();
    mockOracle.mockResolvedValue(blockedOracle("oracle_both_stale"));
    const exec = await post(`/agent-plans/${planId}/execute`, { approval_token: tokenId });
    expect(exec.statusCode).toBe(409);
    expect(exec.json().error).toBe("oracle_blocked");
    expect(mockSwapTx).not.toHaveBeenCalled(); // 署名可能 tx を作らない

    // token は未消費 — oracle 回復後に同じ token で execute できる (§29.3)
    mockOracle.mockResolvedValue(okOracle());
    const retry = await post(`/agent-plans/${planId}/execute`, { approval_token: tokenId });
    expect(retry.statusCode).toBe(200);
  });

  it("§4.6: execute は >5% 乖離 (oracle_divergence_too_large) で拒否", async () => {
    const { planId, tokenId } = await approvedPlan();
    mockOracle.mockResolvedValue(blockedOracle("oracle_divergence_too_large"));
    const exec = await post(`/agent-plans/${planId}/execute`, { approval_token: tokenId });
    expect(exec.statusCode).toBe(409);
    expect(exec.json().block_reason).toBe("oracle_divergence_too_large");
    expect(mockSwapTx).not.toHaveBeenCalled();
  });

  /**
   * Phase 8.75: 償還価値ガードは agent 経路にも掛かる (409 + token 温存)。
   */
  it("8.75: execute は fair value blocked で 409、token は消費されない", async () => {
    const { planId, tokenId } = await approvedPlan();
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
    const exec = await post(`/agent-plans/${planId}/execute`, { approval_token: tokenId });
    expect(exec.statusCode).toBe(409);
    const body = exec.json();
    expect(body.error).toBe("fair_value_blocked");
    expect(body.reason).toBe("fair_value_deviation");
    expect(body.deviation_bps).toBeGreaterThan(body.guard_bps);
    // 生 code でなく人が読める 1 文が届く (8.74 と同じ扱い)
    expect(body.message).toMatch(/jitoSOL redemption value/);
    expect(mockSwapTx).not.toHaveBeenCalled();

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
    const retry = await post(`/agent-plans/${planId}/execute`, { approval_token: tokenId });
    expect(retry.statusCode).toBe(200);
  });

  it("8.75: 参照レートを持たない market (jlUSDC) は素通りする", async () => {
    const { planId, tokenId } = await approvedPlan({
      ...ACTION,
      protocol: "jupiter_lend",
      asset: "USDC",
      amount: "1000000",
    });
    const exec = await post(`/agent-plans/${planId}/execute`, { approval_token: tokenId });
    expect(exec.statusCode).toBe(200);
    // 参照を持たない market ではレート取得自体を試みない (無駄な I/O を増やさない)
    expect(mockLstRates).not.toHaveBeenCalled();
  });
});

describe("§29.3 security", () => {
  it("token 再利用は拒否 (executing では status guard、token 自体も already_consumed)", async () => {
    const { planId, tokenId } = await executingPlan();
    const second = await post(`/agent-plans/${planId}/execute`, { approval_token: tokenId });
    expect(second.statusCode).toBe(409);
    expect(validateAndConsumeToken(tokenId, {})).toEqual({
      valid: false,
      reason: "already_consumed",
    });
  });

  it("partial fill (2 本中 1 本で失敗 → /failed) の後、同じ token で再実行できない", async () => {
    const { planId, tokenId, exec } = await executingPlan();
    const failed = await post(`/agent-plans/${planId}/failed`, {
      execution_id: exec.execution_id,
      reason: "submit_failed",
    });
    expect(failed.json().status).toBe("failed");
    const reuse = await post(`/agent-plans/${planId}/execute`, { approval_token: tokenId });
    expect(reuse.statusCode).toBe(409);
    // 承認からやり直すこともできない (failed は終端)
    expect((await post(`/agent-plans/${planId}/approve`)).statusCode).toBe(409);
  });

  it("bundle_hash 不一致の token は 403 (tx を組む前に拒否)", async () => {
    const { planId } = await approvedPlan();
    const forged = issueApprovalToken({
      user_id: "u",
      plan_id: planId,
      mcp_client_id: "m",
      bundle_hash: computeBundleHash({ ...ACTION, amount: "999999999999" }),
    });
    const exec = await post(`/agent-plans/${planId}/execute`, {
      approval_token: forged.token_id,
    });
    expect(exec.statusCode).toBe(403);
    expect(exec.json().reason).toBe("bundle_hash_mismatch");
    expect(mockSwapTx).not.toHaveBeenCalled();
  });

  it("人が承認した approved plan は /approve で token を再発行できる (Seeker 承認 → web 署名)、auto 承認は 409", async () => {
    const { planId, tokenId } = await approvedPlan();
    const again = await post(`/agent-plans/${planId}/approve`);
    expect(again.statusCode).toBe(200);
    expect(again.json().status).toBe("approved");
    expect(again.json().approved_by).toBe("user");
    const fresh = again.json().approval_token.token_id as string;
    expect(fresh).not.toBe(tokenId);
    // 新 token で execute → executing。古い token はもう status guard で使えない
    const exec = await post(`/agent-plans/${planId}/execute`, { approval_token: fresh, via: "web" });
    expect(exec.statusCode).toBe(200);
    expect((await post(`/agent-plans/${planId}/execute`, { approval_token: tokenId })).statusCode).toBe(409);
    // auto 承認の plan は人が触れない
    const autoId = await createSimulatedPlan();
    updatePlan(autoId, { status: AgentPlanStatus.Approved, approved_by: "auto" });
    const denied = await post(`/agent-plans/${autoId}/approve`);
    expect(denied.statusCode).toBe(409);
    expect(denied.json().error).toBe("invalid_status_transition");
  });

  it("未知 token / simulate 前 approve / 未承認 execute の拒否", async () => {
    const { planId } = await approvedPlan();
    const bad = await post(`/agent-plans/${planId}/execute`, { approval_token: "nope" });
    expect(bad.statusCode).toBe(403);
    expect(bad.json().reason).toBe("not_found");

    // simulate 無し (draft) の approve は status guard で 409
    const draftId = (await post("/agent-plans", { objective: "max_yield" })).json().plan_id;
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

  it("期限切れ / bundle_hash 不一致 / wrong_plan (store 単体)", () => {
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
    expect(validateAndConsumeToken(t.token_id, { bundle_hash: "0xdef" })).toEqual({
      valid: false,
      reason: "bundle_hash_mismatch",
    });
    expect(validateAndConsumeToken(t.token_id, { plan_id: "other" })).toEqual({
      valid: false,
      reason: "wrong_plan",
    });
    // ガード違反では消費されない → 正しい条件なら通る
    expect(validateAndConsumeToken(t.token_id, { plan_id: "p", bundle_hash: "0xabc" }).valid).toBe(
      true
    );
  });
});

describe("/signatures と /failed (web の報告)", () => {
  it("/signatures: 本数・形式が合えば broadcasted + execution を保存、/approval にも出る", async () => {
    const { planId, exec } = await executingPlan();
    const res = await post(`/agent-plans/${planId}/signatures`, {
      execution_id: exec.execution_id,
      signatures: [SIG_A],
    });
    expect(res.statusCode).toBe(200);
    const plan = res.json();
    expect(plan.status).toBe("broadcasted");
    expect(plan.execution).toEqual({
      execution_id: exec.execution_id,
      signatures: [SIG_A],
      submitted_at: expect.any(String),
      via: "web",
    });
    const appr = (await get(`/agent-plans/${planId}/approval`)).json();
    expect(appr.status).toBe("broadcasted");
    expect(appr.execution.signatures).toEqual([SIG_A]);
    expect(appr.approval_token).toBeUndefined();
    // 終端なので二重報告は 409
    const again = await post(`/agent-plans/${planId}/signatures`, {
      execution_id: exec.execution_id,
      signatures: [SIG_A],
    });
    expect(again.statusCode).toBe(409);
  });

  it("/signatures: 本数違い / 形式違い / execution_id 違いは 409、plan は executing のまま", async () => {
    const { planId, exec } = await executingPlan();
    const count = await post(`/agent-plans/${planId}/signatures`, {
      execution_id: exec.execution_id,
      signatures: [SIG_A, SIG_B],
    });
    expect(count.statusCode).toBe(409);
    expect(count.json()).toMatchObject({ error: "signature_count_mismatch", expected: 1, got: 2 });

    const format = await post(`/agent-plans/${planId}/signatures`, {
      execution_id: exec.execution_id,
      signatures: ["0OIl-not-base58"],
    });
    expect(format.statusCode).toBe(409);
    expect(format.json().error).toBe("invalid_signature_format");

    const wrongId = await post(`/agent-plans/${planId}/signatures`, {
      execution_id: "exec_other",
      signatures: [SIG_A],
    });
    expect(wrongId.statusCode).toBe(409);
    expect(wrongId.json().error).toBe("execution_id_mismatch");

    const missing = await post(`/agent-plans/${planId}/signatures`, { signatures: [SIG_A] });
    expect(missing.statusCode).toBe(400);

    expect((await get(`/agent-plans/${planId}`)).json().status).toBe("executing");
  });

  it("/signatures は executing 以外 (approved) では 409", async () => {
    const { planId } = await approvedPlan();
    const res = await post(`/agent-plans/${planId}/signatures`, {
      execution_id: "exec_x",
      signatures: [SIG_A],
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("invalid_status");
  });

  it("/failed: executing → failed + failure_reason、/approval にも出る", async () => {
    const { planId, exec } = await executingPlan();
    const wrong = await post(`/agent-plans/${planId}/failed`, {
      execution_id: "exec_other",
      reason: "user_cancelled",
    });
    expect(wrong.statusCode).toBe(409);
    const res = await post(`/agent-plans/${planId}/failed`, {
      execution_id: exec.execution_id,
      reason: "user_cancelled",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "failed", failure_reason: "user_cancelled" });
    const appr = (await get(`/agent-plans/${planId}/approval`)).json();
    expect(appr).toMatchObject({ status: "failed", failure_reason: "user_cancelled" });
  });
});

describe("reject guard / expiry / wallet filter / /approval", () => {
  it("reject は simulated | pending_user | approved から。executing 以降と draft は 409", async () => {
    const planId = await createSimulatedPlan();
    await post(`/agent-plans/${planId}/request-approval`);
    await post(`/agent-plans/${planId}/request-approval`); // idempotent
    const rejected = await post(`/agent-plans/${planId}/reject`, { reason: "user_declined" });
    expect(rejected.json()).toMatchObject({ status: "rejected", failure_reason: "user_declined" });
    expect((await get(`/agent-plans/${planId}`)).json().status).toBe("rejected"); // 永続
    // rejected (終端) から再 reject も 409
    expect((await post(`/agent-plans/${planId}/reject`)).statusCode).toBe(409);

    const { planId: approvedId } = await approvedPlan();
    expect((await post(`/agent-plans/${approvedId}/reject`)).json().status).toBe("rejected");

    const { planId: execId } = await executingPlan();
    const blocked = await post(`/agent-plans/${execId}/reject`);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error).toBe("invalid_status");

    const draftId = (await post("/agent-plans", { objective: "max_yield" })).json().plan_id;
    expect((await post(`/agent-plans/${draftId}/reject`)).statusCode).toBe(409);
  });

  it("24h を過ぎた非終端 plan は読み出しで expired (approve も不可)、終端 plan はそのまま", async () => {
    const planId = await createSimulatedPlan();
    const past = new Date(Date.now() - 1000).toISOString();
    updatePlan(planId, { expires_at: past });
    expect((await get(`/agent-plans/${planId}`)).json().status).toBe("expired");
    expect((await post(`/agent-plans/${planId}/approve`)).statusCode).toBe(409);

    const pending = await createSimulatedPlan();
    await post(`/agent-plans/${pending}/request-approval`);
    updatePlan(pending, { expires_at: past });
    const list = (await get(`/agent-plans?wallet=${WALLET}`)).json() as {
      plan_id: string;
      status: string;
    }[];
    expect(list.find((p) => p.plan_id === pending)?.status).toBe("expired");
    expect((await get(`/agent-plans/${pending}/approval`)).json().status).toBe("expired");

    const { planId: doneId, exec } = await executingPlan();
    await post(`/agent-plans/${doneId}/signatures`, {
      execution_id: exec.execution_id,
      signatures: [SIG_A],
    });
    updatePlan(doneId, { expires_at: past });
    expect((await get(`/agent-plans/${doneId}`)).json().status).toBe("broadcasted");
  });

  it("GET /agent-plans?wallet= は selected_action.wallet_id で絞る (fixture も同条件)", async () => {
    const mine = await createSimulatedPlan();
    const theirs = await createSimulatedPlan({ ...ACTION, wallet_id: OTHER_WALLET });
    const draft = (await post("/agent-plans", { objective: "max_yield" })).json().plan_id;

    const ids = (url: string) =>
      get(url).then((r) => (r.json() as { plan_id: string }[]).map((p) => p.plan_id));
    const filtered = await ids(`/agent-plans?wallet=${WALLET}`);
    expect(filtered).toEqual([mine]);
    const all = await ids("/agent-plans");
    expect(all).toEqual(expect.arrayContaining([mine, theirs, draft, "plan_002"]));
  });

  it("fixture plan は NODE_ENV=test の時だけ見える", async () => {
    const saved = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";
    try {
      const list = (await get("/agent-plans")).json() as { plan_id: string }[];
      expect(list.some((p) => p.plan_id === "plan_002")).toBe(false);
      expect((await get("/agent-plans/plan_002")).statusCode).toBe(404);
    } finally {
      process.env.NODE_ENV = saved;
    }
    expect((await get("/agent-plans/plan_002")).statusCode).toBe(200);
  });

  it("/approval は人が承認した plan の token を出さない (approved_by=user)", async () => {
    const { planId } = await approvedPlan();
    const appr = (await get(`/agent-plans/${planId}/approval`)).json();
    expect(appr).toEqual({ plan_id: planId, status: "approved", approved_by: "user" });
  });

  it("/approval は policy の自動承認 (approved_by=auto) の時だけ token を出す", async () => {
    const savedFlag = process.env.FEATURE_APPROVAL_MODE_AUTO;
    process.env.FEATURE_APPROVAL_MODE_AUTO = "true";
    try {
      await app.inject({
        method: "PATCH",
        url: "/user-policy",
        payload: { approval_mode: "auto" },
      });
      const planId = await createSimulatedPlan();
      const req = await post(`/agent-plans/${planId}/request-approval`);
      expect(req.json()).toMatchObject({ status: "approved", approved_by: "auto" });
      const appr = (await get(`/agent-plans/${planId}/approval`)).json();
      expect(appr.approved_by).toBe("auto");
      expect(appr.approval_token.token_id).toEqual(expect.any(String));

      // auto 承認は request-approval で日次枠を消費済み → execute で二重に数えない
      const dailyBefore = getDailyCount();
      const exec = await post(`/agent-plans/${planId}/execute`, {
        approval_token: appr.approval_token.token_id,
      });
      expect(exec.statusCode).toBe(200);
      expect(getDailyCount()).toBe(dailyBefore);
      expect(exec.json().plan.status).toBe("executing");
    } finally {
      if (savedFlag === undefined) delete process.env.FEATURE_APPROVAL_MODE_AUTO;
      else process.env.FEATURE_APPROVAL_MODE_AUTO = savedFlag;
    }
  });

  it("fixture plan (test のみ) の approve / reject は非永続", async () => {
    const a1 = await post("/agent-plans/plan_002/approve");
    expect(a1.statusCode).toBe(200);
    expect(a1.json().approved_by).toBe("user");
    const a2 = await post("/agent-plans/plan_002/approve");
    expect(a2.statusCode).toBe(200);
  });
});

describe("persistence (.data/agent-plans.json)", () => {
  const savedDir = process.env.SEASONALS_DATA_DIR;
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "seasonals-agent-plans-"));
    process.env.SEASONALS_DATA_DIR = dir;
  });
  afterEach(() => {
    if (savedDir === undefined) delete process.env.SEASONALS_DATA_DIR;
    else process.env.SEASONALS_DATA_DIR = savedDir;
    rmSync(dir, { recursive: true, force: true });
  });

  it("再起動 (store 再読込) 後も plan / token / 署名待ち execution が残る", async () => {
    const { planId, exec } = await executingPlan();
    _reloadPlanStoreForTest(); // プロセス再起動の再現 (memory を捨てて disk から読む)
    expect((await get(`/agent-plans/${planId}`)).json().status).toBe("executing");
    const res = await post(`/agent-plans/${planId}/signatures`, {
      execution_id: exec.execution_id,
      signatures: [SIG_A],
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("broadcasted");
  });
});

describe("agent-plan-executor: route → builder endpoint (13 route)", () => {
  it.each([
    [{ kind: "swap_earn_deposit", shareMint: "S" }, "/protocols/swap-earn/deposit-tx", { shareMint: "S", slippageBps: 50 }, "swapTransaction"],
    [{ kind: "swap_earn_withdraw", shareMint: "S" }, "/protocols/swap-earn/withdraw-tx", { shareMint: "S", slippageBps: 50 }, "swapTransaction"],
    [{ kind: "kamino_deposit", reserve: "R" }, "/protocols/kamino/deposit-tx", { reserve: "R" }, "transaction"],
    [{ kind: "kamino_withdraw", reserve: "R" }, "/protocols/kamino/withdraw-tx", { reserve: "R" }, "transaction"],
    [{ kind: "kamino_vault_deposit", vault: "V" }, "/protocols/kamino/vault-deposit-tx", { vault: "V" }, "transaction"],
    [{ kind: "kamino_vault_withdraw", vault: "V" }, "/protocols/kamino/vault-withdraw-tx", { vault: "V" }, "transaction"],
    [{ kind: "meteora_deposit", poolKey: "P" }, "/protocols/meteora/deposit-tx", { poolKey: "P" }, "transactions"],
    [{ kind: "meteora_withdraw", position: "X" }, "/protocols/meteora/withdraw-tx", { position: "X" }, "transactions"],
    [{ kind: "orca_deposit", poolKey: "P" }, "/protocols/orca/deposit-tx", { poolKey: "P" }, "transactions"],
    [{ kind: "orca_withdraw", position: "X" }, "/protocols/orca/withdraw-tx", { position: "X" }, "transactions"],
    [{ kind: "save_deposit", reserve: "R" }, "/protocols/save/deposit-tx", { reserve: "R" }, "transactions"],
    [{ kind: "save_withdraw", ctokenMint: "C" }, "/protocols/save/withdraw-tx", { ctokenMint: "C" }, "transactions"],
    [{ kind: "exponent_redeem", ptMint: "PT" }, "/protocols/exponent/redeem-tx", { ptMint: "PT" }, "transaction"],
  ] as const)("%o → %s", (route, url, extra, key) => {
    const req = txBuildRequestFor(route as never, WALLET, "123");
    expect(req.url).toBe(url);
    expect(req.payload).toEqual({ user: WALLET, amount: "123", ...extra });
    expect(req.responseKey).toBe(key);
  });
});
