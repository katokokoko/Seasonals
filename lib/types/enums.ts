/**
 * Seasonals — Canonical Enums
 *
 * 仕様書 §4.4 命名規約 (canonical identifier conventions) に従う。
 * すべての enum は変更時に §32.2 整合性チェックの対象。
 *
 * - `as const` + literal union 型で TypeScript レベルの type safety を確保
 * - 値は snake_case (§4.4)
 * - source of truth は本ファイル。仕様書 / DB schema / MCP API はすべてこの enum を参照する
 */

// ─────────────────────────────────────────────────────────────────────────────
// TimeEventCategory (8 種) — 仕様書 §11.4 / §25.2 / §26
// ─────────────────────────────────────────────────────────────────────────────

export const TimeEventCategory = {
  Maturity: "maturity",
  Epoch: "epoch",
  Claim: "claim",
  Health: "health",
  VestingCliff: "vesting_cliff",
  VoteDeadline: "vote_deadline",
  LockupEnd: "lockup_end",
  ForecastMarker: "forecast_marker",
} as const;

export type TimeEventCategory =
  (typeof TimeEventCategory)[keyof typeof TimeEventCategory];

export const TIME_EVENT_CATEGORIES: readonly TimeEventCategory[] = [
  TimeEventCategory.Maturity,
  TimeEventCategory.Epoch,
  TimeEventCategory.Claim,
  TimeEventCategory.Health,
  TimeEventCategory.VestingCliff,
  TimeEventCategory.VoteDeadline,
  TimeEventCategory.LockupEnd,
  TimeEventCategory.ForecastMarker,
] as const;

// ─────────────────────────────────────────────────────────────────────────────
// PositionCategory (10 種) — 仕様書 §5.2 / §26
// ─────────────────────────────────────────────────────────────────────────────

export const PositionCategory = {
  Lending: "lending",
  Staking: "staking",
  Restaking: "restaking",
  LP: "lp",
  Vault: "vault",
  PTYT: "pt_yt",
  Stable: "stable",
  Vesting: "vesting",
  Governance: "governance",
  Other: "other",
} as const;

export type PositionCategory =
  (typeof PositionCategory)[keyof typeof PositionCategory];

export const POSITION_CATEGORIES: readonly PositionCategory[] = [
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
] as const;

// ─────────────────────────────────────────────────────────────────────────────
// Urgency (3 種) — 仕様書 §5.3 / §11.4
// ─────────────────────────────────────────────────────────────────────────────

export const Urgency = {
  Info: "info",
  Watch: "watch",
  Critical: "critical",
} as const;

export type Urgency = (typeof Urgency)[keyof typeof Urgency];

export const URGENCIES: readonly Urgency[] = [
  Urgency.Info,
  Urgency.Watch,
  Urgency.Critical,
] as const;

// ─────────────────────────────────────────────────────────────────────────────
// ApprovalMode (4 種) — 仕様書 §11.6
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Agent からの execute 承認方式。
 *
 * - `auto` — user_approval なしで execute 可能。MVP / Public Beta では
 *   feature flag (`feature.approval_mode_auto`) で無効化する。
 * - `request_per_action` — 毎回 `request_user_approval` が必須 (default、推奨)
 * - `request_per_session` — session 内なら追加承認不要 (Public Beta までは
 *   max_session_duration を 5 分に制限)
 * - `manual_only` — Agent からの execute 完全禁止 (read-only)
 */
export const ApprovalMode = {
  Auto: "auto",
  RequestPerAction: "request_per_action",
  RequestPerSession: "request_per_session",
  ManualOnly: "manual_only",
} as const;

export type ApprovalMode = (typeof ApprovalMode)[keyof typeof ApprovalMode];

export const APPROVAL_MODES: readonly ApprovalMode[] = [
  ApprovalMode.Auto,
  ApprovalMode.RequestPerAction,
  ApprovalMode.RequestPerSession,
  ApprovalMode.ManualOnly,
] as const;

// ─────────────────────────────────────────────────────────────────────────────
// AgentPlanStatus (10 種) — 仕様書 §11.7
// ─────────────────────────────────────────────────────────────────────────────

/**
 * AgentPlan の status 遷移:
 *
 *   draft         → compare_opportunities 完了直後
 *   simulated     → simulate_action 完了
 *   pending_user  → request_user_approval 発行、ユーザー承認待ち
 *   approved      → ユーザー承認、approval_token 発行済
 *   rejected      → ユーザー拒否 / timeout
 *   executing     → execute_approved_action 呼び出し、unsigned tx を mobile に push
 *   signed        → mobile が MWA 署名し POST /actions/execute 投入
 *   broadcasted   → on-chain ブロードキャスト完了
 *   failed        → いずれかのステップで失敗
 *   expired       → approval_token TTL 切れ
 */
export const AgentPlanStatus = {
  Draft: "draft",
  Simulated: "simulated",
  PendingUser: "pending_user",
  Approved: "approved",
  Rejected: "rejected",
  Executing: "executing",
  Signed: "signed",
  Broadcasted: "broadcasted",
  Failed: "failed",
  Expired: "expired",
} as const;

export type AgentPlanStatus =
  (typeof AgentPlanStatus)[keyof typeof AgentPlanStatus];

export const AGENT_PLAN_STATUSES: readonly AgentPlanStatus[] = [
  AgentPlanStatus.Draft,
  AgentPlanStatus.Simulated,
  AgentPlanStatus.PendingUser,
  AgentPlanStatus.Approved,
  AgentPlanStatus.Rejected,
  AgentPlanStatus.Executing,
  AgentPlanStatus.Signed,
  AgentPlanStatus.Broadcasted,
  AgentPlanStatus.Failed,
  AgentPlanStatus.Expired,
] as const;

// ─────────────────────────────────────────────────────────────────────────────
// ExecutionJobStatus (7 種) — 仕様書 §25.2
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 1 つの AgentPlan が承認された後の broadcast 試行の物理的履歴 status。
 * 1 plan : N execution_jobs の関係。retry / 分割実行 / chain confirmation の追跡に使用。
 *
 * AgentPlanStatus と混同しないこと:
 * - AgentPlan = 計画 / 進行状態 (論理的)
 * - ExecutionJob = broadcast の物理的試行履歴
 */
export const ExecutionJobStatus = {
  PendingSignature: "pending_signature",
  SignedReceived: "signed_received",
  BroadcastSubmitted: "broadcast_submitted",
  Confirmed: "confirmed",
  BroadcastFailed: "broadcast_failed",
  SignatureTimeout: "signature_timeout",
  Cancelled: "cancelled",
} as const;

export type ExecutionJobStatus =
  (typeof ExecutionJobStatus)[keyof typeof ExecutionJobStatus];

export const EXECUTION_JOB_STATUSES: readonly ExecutionJobStatus[] = [
  ExecutionJobStatus.PendingSignature,
  ExecutionJobStatus.SignedReceived,
  ExecutionJobStatus.BroadcastSubmitted,
  ExecutionJobStatus.Confirmed,
  ExecutionJobStatus.BroadcastFailed,
  ExecutionJobStatus.SignatureTimeout,
  ExecutionJobStatus.Cancelled,
] as const;

// ─────────────────────────────────────────────────────────────────────────────
// ActionType (12 種) — 仕様書 §5.7 / §24.7 / §24.9 simulate_action
// ─────────────────────────────────────────────────────────────────────────────

/**
 * simulate_action / execute_approved_action で扱う on-chain action の種別。
 * §5.7 / §24.7 / §24.9 で同一の canonical 12 種。
 *
 * UI 表示用ラベル ("Re-deposit (include yield)" 等) は presentation layer で
 * `display_label` として保持し、API/DB の値とは独立させる。
 */
export const ActionType = {
  Deposit: "deposit",
  Withdraw: "withdraw",
  ReDeposit: "re_deposit",
  ReDepositIncludeYield: "re_deposit_include_yield",
  ReDepositExcludeYield: "re_deposit_exclude_yield",
  Rotate: "rotate",
  Claim: "claim",
  Vote: "vote",
  Repay: "repay",
  AddCollateral: "add_collateral",
  Unstake: "unstake",
  Cancel: "cancel",
} as const;

export type ActionType = (typeof ActionType)[keyof typeof ActionType];

export const ACTION_TYPES: readonly ActionType[] = [
  ActionType.Deposit,
  ActionType.Withdraw,
  ActionType.ReDeposit,
  ActionType.ReDepositIncludeYield,
  ActionType.ReDepositExcludeYield,
  ActionType.Rotate,
  ActionType.Claim,
  ActionType.Vote,
  ActionType.Repay,
  ActionType.AddCollateral,
  ActionType.Unstake,
  ActionType.Cancel,
] as const;

// ─────────────────────────────────────────────────────────────────────────────
// Objective (7 種) — 仕様書 §6.4 Policy preset / §24.9 compare_opportunities
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Agent が `compare_opportunities` を呼ぶ際の目的指定。Policy preset。
 *
 * UserPolicy (§11.6) とは独立で、execute 時に AND で評価される
 * (preset の制約 ∧ UserPolicy の制約)。
 */
export const Objective = {
  SafetyFirst: "safety_first",
  MaxYield: "max_yield",
  StableOnly: "stable_only",
  SolAccumulation: "sol_accumulation",
  LiquidityPriority: "liquidity_priority",
  DurationLimited: "duration_limited",
  LiquidationAvoidance: "liquidation_avoidance",
} as const;

export type Objective = (typeof Objective)[keyof typeof Objective];

export const OBJECTIVES: readonly Objective[] = [
  Objective.SafetyFirst,
  Objective.MaxYield,
  Objective.StableOnly,
  Objective.SolAccumulation,
  Objective.LiquidityPriority,
  Objective.DurationLimited,
  Objective.LiquidationAvoidance,
] as const;

// ─────────────────────────────────────────────────────────────────────────────
// TrustLevel — 仕様書 §11.2 / §13.2 trusted protocol registry
// ─────────────────────────────────────────────────────────────────────────────

export const TrustLevel = {
  S: "S", // Tier S (Kamino / Jito / Streamflow 等の MVP 対応)
  A: "A",
  B: "B",
  Untrusted: "untrusted",
} as const;

export type TrustLevel = (typeof TrustLevel)[keyof typeof TrustLevel];

// ─────────────────────────────────────────────────────────────────────────────
// Type guards (任意 — runtime validation 用)
// ─────────────────────────────────────────────────────────────────────────────

export function isTimeEventCategory(v: unknown): v is TimeEventCategory {
  return (
    typeof v === "string" &&
    (TIME_EVENT_CATEGORIES as readonly string[]).includes(v)
  );
}

export function isPositionCategory(v: unknown): v is PositionCategory {
  return (
    typeof v === "string" &&
    (POSITION_CATEGORIES as readonly string[]).includes(v)
  );
}

export function isUrgency(v: unknown): v is Urgency {
  return typeof v === "string" && (URGENCIES as readonly string[]).includes(v);
}

export function isApprovalMode(v: unknown): v is ApprovalMode {
  return (
    typeof v === "string" && (APPROVAL_MODES as readonly string[]).includes(v)
  );
}

export function isAgentPlanStatus(v: unknown): v is AgentPlanStatus {
  return (
    typeof v === "string" &&
    (AGENT_PLAN_STATUSES as readonly string[]).includes(v)
  );
}

export function isExecutionJobStatus(v: unknown): v is ExecutionJobStatus {
  return (
    typeof v === "string" &&
    (EXECUTION_JOB_STATUSES as readonly string[]).includes(v)
  );
}

export function isActionType(v: unknown): v is ActionType {
  return (
    typeof v === "string" && (ACTION_TYPES as readonly string[]).includes(v)
  );
}

export function isObjective(v: unknown): v is Objective {
  return typeof v === "string" && (OBJECTIVES as readonly string[]).includes(v);
}
