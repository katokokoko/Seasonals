/**
 * evaluate-policy — UserPolicy の pure な制約評価 (Phase 8.29、§6.4)
 *
 * §6.4 の execution 制約項目を UserPolicy フィールドと 1:1 で判定する
 * (§32.2 "policy-aware execution" の実装担保)。決定的な純関数で、Mobile /
 * BFF / MCP が共有する ("same source of truth")。
 *
 * §4.5: USD 値 (max_tx_amount / min_tvl) は 8-dec string を compareUsd8 の
 * bigint 比較で扱う (Number 不使用)。risk_score は 0..1 比率で §4.5 適用外。
 *
 * NOTE: `max_daily_executions` は **ここでは判定しない**。実行時カウンタは
 * 状態を持つため BFF (autonomous.ts) が runtime で enforce する。本関数は
 * candidate 単体で決まる制約 (whitelist / 金額 / TVL / risk / lock) のみ。
 */

import { ApprovalMode, type PositionCategory } from "../types/enums";
import type { PolicyViolation, UserPolicy } from "../types/user-policy";
import { compareUsd8 } from "../utils/numeric";

/** policy 評価対象の候補 (1 つの deposit 候補) */
export interface PolicyCandidate {
  protocol: string;
  category: PositionCategory;
  asset: string;
  /** 投入予定額 (USD 8-dec string、§4.5) */
  amount_usd8: string;
  /** pool TVL (USD number、§3 display carve-out) */
  tvl_usd: number;
  /** 0..1 risk score */
  /**
   * 0..1。**高いほど安全** (TrustLevel S→0.9 … Untrusted→0.2 のマッピング —
   * autonomous.ts TRUST_RISK 参照)。名前に反して "risk" の高低ではない点に注意:
   * `risk_score < min_risk_score` で除外する現行ゲートはこの極性が前提。
   * 逆極性 (高い=危険) で produce すると安全ゲートが静かに反転する (8.38 F9)。
   */
  risk_score: number;
  /** lockup 日数 (0 = open-ended) */
  lock_days: number;
}

export interface PolicyEvaluation {
  allowed: boolean;
  /** 該当した全違反 (first-fail でなく集約) */
  violations: PolicyViolation[];
}

/** tvl_usd (number) を USD 8-dec string へ (境界で 1 度だけ、§4.5 carve-out) */
function tvlToUsd8(tvlUsd: number): string {
  const safe = Number.isFinite(tvlUsd) && tvlUsd > 0 ? tvlUsd : 0;
  return `${Math.round(safe)}.00000000`;
}

/**
 * candidate が policy を満たすか (§6.4)。全違反を集約して返す。
 */
export function evaluatePolicy(
  policy: UserPolicy,
  c: PolicyCandidate
): PolicyEvaluation {
  const violations: PolicyViolation[] = [];

  if (!policy.enabled_protocols.includes(c.protocol)) {
    violations.push("policy_violation_protocol_not_enabled");
  }
  if (!policy.enabled_categories.includes(c.category)) {
    violations.push("policy_violation_category_not_enabled");
  }
  if (!policy.enabled_assets.includes(c.asset)) {
    violations.push("policy_violation_asset_not_enabled");
  }
  // max_tx_amount: null = 無制限。amount > max なら違反
  if (
    policy.max_tx_amount !== null &&
    compareUsd8(c.amount_usd8, policy.max_tx_amount) > 0
  ) {
    violations.push("policy_violation_max_tx_amount");
  }
  // min_tvl: candidate TVL < min なら違反
  if (compareUsd8(tvlToUsd8(c.tvl_usd), policy.min_tvl) < 0) {
    violations.push("policy_violation_min_tvl");
  }
  if (c.risk_score < policy.min_risk_score) {
    violations.push("policy_violation_min_risk_score");
  }
  // max_lock_days: null = 無制限
  if (policy.max_lock_days !== null && c.lock_days > policy.max_lock_days) {
    violations.push("policy_violation_max_lock_days");
  }

  return { allowed: violations.length === 0, violations };
}

/**
 * approval_mode = auto かつ feature flag ON のときのみ無人実行可 (§11.6)。
 * manual_only / request_per_action / request_per_session は常に false。
 */
export function canAutoExecute(
  policy: UserPolicy,
  featureFlagOn: boolean
): boolean {
  return policy.approval_mode === ApprovalMode.Auto && featureFlagOn;
}
