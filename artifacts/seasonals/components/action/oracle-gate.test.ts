/**
 * Phase 8.14: oracle-gate 純粋ヘルパーの検証 (RN render 不要)。
 */
import type { AgentPlan } from "@workspace/lib/types";
import {
  JUPITER_UNDERLYING_MINTS,
  oracleBlockLabel,
  resolveOracleMint,
} from "./oracle-gate";

type Action = AgentPlan["selected_action"];

function action(partial: Partial<NonNullable<Action>>): Action {
  return {
    action_type: "deposit",
    protocol: "jupiter_lend",
    asset: "SOL",
    amount: "1000000000",
    ...partial,
  } as NonNullable<Action>;
}

describe("resolveOracleMint", () => {
  it("Jupiter Lend deposit (SOL) → SOL mint", () => {
    expect(resolveOracleMint(action({ asset: "SOL" }))).toBe(
      JUPITER_UNDERLYING_MINTS.SOL
    );
  });

  it("Jupiter Lend withdraw (USDC) → USDC mint", () => {
    expect(
      resolveOracleMint(action({ action_type: "withdraw", asset: "USDC" }))
    ).toBe(JUPITER_UNDERLYING_MINTS.USDC);
  });

  it("protocol 'jupiter' alias も解決する", () => {
    expect(resolveOracleMint(action({ protocol: "jupiter", asset: "USDT" }))).toBe(
      JUPITER_UNDERLYING_MINTS.USDT
    );
  });

  it("非 Jupiter protocol は null (oracle gate 対象外)", () => {
    expect(resolveOracleMint(action({ protocol: "kamino", asset: "SOL" }))).toBeNull();
  });

  it("未知 asset は null", () => {
    expect(resolveOracleMint(action({ asset: "WIF" }))).toBeNull();
  });

  it("action undefined は null", () => {
    expect(resolveOracleMint(undefined)).toBeNull();
  });
});

describe("oracleBlockLabel", () => {
  it("各 block reason に専用ラベル", () => {
    expect(oracleBlockLabel("oracle_both_stale")).toMatch(/stale/i);
    expect(oracleBlockLabel("oracle_divergence_too_large")).toMatch(/>5%/);
    expect(oracleBlockLabel("oracle_unavailable")).toMatch(/取得できません/);
  });

  it("null / 未知は generic ラベル", () => {
    expect(oracleBlockLabel(null)).toBe("oracle check failed");
  });
});
