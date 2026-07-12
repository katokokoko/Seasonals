/**
 * Phase 8.29: evaluatePolicy / canAutoExecute の pure test (§6.4 / §11.6)。
 */
import { ApprovalMode, PositionCategory } from "../types/enums";
import {
  fixtureUserPolicyDefault,
  fixtureUserPolicyManualOnly,
  fixtureUserPolicyTight,
} from "../__fixtures__/user-policies";
import {
  canAutoExecute,
  evaluatePolicy,
  type PolicyCandidate,
} from "./evaluate-policy";

function candidate(partial: Partial<PolicyCandidate> = {}): PolicyCandidate {
  return {
    protocol: "kamino",
    category: PositionCategory.Lending,
    asset: "USDC",
    amount_usd8: "100.00000000",
    tvl_usd: 100_000_000,
    risk_score: 0.9,
    lock_days: 0,
    ...partial,
  };
}

describe("evaluatePolicy — §6.4 制約 1:1", () => {
  it("default policy を満たす候補は allowed", () => {
    expect(evaluatePolicy(fixtureUserPolicyDefault, candidate())).toEqual({
      allowed: true,
      violations: [],
    });
  });

  it("whitelist 3 種 (protocol / category / asset)", () => {
    const r = evaluatePolicy(
      fixtureUserPolicyDefault,
      candidate({ protocol: "unknown", category: PositionCategory.PTYT, asset: "WIF" })
    );
    expect(r.allowed).toBe(false);
    // PTYT は default の enabled_categories に含まれる → asset/protocol のみ違反
    expect(r.violations).toContain("policy_violation_protocol_not_enabled");
    expect(r.violations).toContain("policy_violation_asset_not_enabled");
    expect(r.violations).not.toContain("policy_violation_category_not_enabled");
  });

  it("max_tx_amount: null は無制限 / tight は $500 超で違反", () => {
    expect(
      evaluatePolicy(fixtureUserPolicyDefault, candidate({ amount_usd8: "999999.00000000" }))
        .violations
    ).not.toContain("policy_violation_max_tx_amount");
    // tight ($500): 境界ちょうどは OK、+1e-8 で違反
    expect(
      evaluatePolicy(fixtureUserPolicyTight, candidate({ amount_usd8: "500.00000000" }))
        .violations
    ).not.toContain("policy_violation_max_tx_amount");
    expect(
      evaluatePolicy(fixtureUserPolicyTight, candidate({ amount_usd8: "500.00000001" }))
        .violations
    ).toContain("policy_violation_max_tx_amount");
  });

  it("min_tvl: 下回ると違反 (default 10M)", () => {
    expect(
      evaluatePolicy(fixtureUserPolicyDefault, candidate({ tvl_usd: 9_999_999 }))
        .violations
    ).toContain("policy_violation_min_tvl");
    expect(
      evaluatePolicy(fixtureUserPolicyDefault, candidate({ tvl_usd: 10_000_000 }))
        .violations
    ).not.toContain("policy_violation_min_tvl");
  });

  it("min_risk_score / max_lock_days", () => {
    expect(
      evaluatePolicy(fixtureUserPolicyTight, candidate({ risk_score: 0.79 })).violations
    ).toContain("policy_violation_min_risk_score");
    expect(
      evaluatePolicy(fixtureUserPolicyTight, candidate({ lock_days: 91 })).violations
    ).toContain("policy_violation_max_lock_days");
    expect(
      evaluatePolicy(fixtureUserPolicyDefault, candidate({ lock_days: 9999 })).violations
    ).not.toContain("policy_violation_max_lock_days"); // default null = 無制限
  });

  it("複数違反を集約する (first-fail でない)", () => {
    const r = evaluatePolicy(
      fixtureUserPolicyTight,
      candidate({
        protocol: "unknown",
        amount_usd8: "9999.00000000",
        tvl_usd: 1,
        risk_score: 0.1,
      })
    );
    expect(r.violations.length).toBeGreaterThanOrEqual(4);
  });

  it("max_daily_executions は engine では判定しない (BFF runtime 側)", () => {
    // tight は max_daily 3 だが、engine の violations には出ない
    const r = evaluatePolicy(fixtureUserPolicyTight, candidate({ risk_score: 0.9 }));
    expect(r.violations).not.toContain("policy_violation_max_daily_executions");
  });
});

describe("canAutoExecute — §11.6", () => {
  it("auto かつ flag ON のみ true", () => {
    const auto = { ...fixtureUserPolicyDefault, approval_mode: ApprovalMode.Auto };
    expect(canAutoExecute(auto, true)).toBe(true);
    expect(canAutoExecute(auto, false)).toBe(false); // flag OFF
    expect(canAutoExecute(fixtureUserPolicyDefault, true)).toBe(false); // request_per_action
    expect(canAutoExecute(fixtureUserPolicyManualOnly, true)).toBe(false); // manual_only
  });
});
