import type { UserPolicy } from "../types/user-policy";
import { ApprovalMode, PositionCategory } from "../types/enums";

/**
 * Default UserPolicy — ウォレット接続直後の初期値 (§11.6)
 *
 * §11.6 / USER_POLICY_DEFAULTS と整合させること:
 * - max_tx_amount / max_daily_executions / max_lock_days は null (無制限)
 * - approval_mode は request_per_action (推奨デフォルト)
 * - min_tvl 10M USD、min_risk_score 0.5
 */
export const fixtureUserPolicyDefault: UserPolicy = {
  user_id: "user_001",
  base_currency: "USD",
  enabled_protocols: ["kamino", "jito", "streamflow", "marinade"],
  enabled_categories: [
    PositionCategory.Lending,
    PositionCategory.Staking,
    PositionCategory.Restaking,
    PositionCategory.LP,
    PositionCategory.Vault,
    PositionCategory.PTYT,
    PositionCategory.Stable,
    PositionCategory.Vesting,
    PositionCategory.Governance,
    PositionCategory.Other,
  ],
  enabled_assets: ["USDC", "USDT", "SOL", "mSOL", "jitoSOL", "bSOL", "SEAS"],
  max_tx_amount: null,
  max_daily_executions: null,
  max_lock_days: null,
  min_tvl: "10000000.00000000",
  min_risk_score: 0.5,
  approval_mode: ApprovalMode.RequestPerAction,
  created_at: "2026-04-01T00:00:00.000Z",
  updated_at: "2026-04-01T00:00:00.000Z",
};

/**
 * Tight UserPolicy — 慎重なユーザー設定例
 * - 1 回 $500 まで、1 日 3 回まで
 * - lockup 90 日まで
 * - lending / staking のみ
 * - min_tvl 50M USD
 */
export const fixtureUserPolicyTight: UserPolicy = {
  ...fixtureUserPolicyDefault,
  user_id: "user_002",
  enabled_protocols: ["kamino", "jito"],
  enabled_categories: [PositionCategory.Lending, PositionCategory.Staking],
  enabled_assets: ["USDC", "USDT", "SOL", "jitoSOL"],
  max_tx_amount: "500.00000000",
  max_daily_executions: 3,
  max_lock_days: 90,
  min_tvl: "50000000.00000000",
  min_risk_score: 0.8,
  approval_mode: ApprovalMode.RequestPerAction,
};

/**
 * Read-only UserPolicy — Agent からの execute を完全禁止
 * Agent は提案のみ可能、実行は手動 UI で
 */
export const fixtureUserPolicyManualOnly: UserPolicy = {
  ...fixtureUserPolicyDefault,
  user_id: "user_003",
  approval_mode: ApprovalMode.ManualOnly,
};

export const fixtureUserPolicies: UserPolicy[] = [
  fixtureUserPolicyDefault,
  fixtureUserPolicyTight,
  fixtureUserPolicyManualOnly,
];
