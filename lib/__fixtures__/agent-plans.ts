import type { AgentPlan } from "../types/agent-plan";
import { AgentPlanStatus, ActionType, Objective } from "../types/enums";

/**
 * AgentPlan fixture — status の代表的な値で複数個用意。
 *
 * MCP execution flow テストや UI mock dev で使う:
 * - draft: compare_opportunities 直後
 * - simulated: simulate_action 完了
 * - pending_user: request_user_approval 発行、ユーザー承認待ち (MCP Approval Push の表示時)
 * - executing: execute_approved_action 呼び出し中
 */

const candidateKamino = {
  candidate_id: "cand_001",
  protocol: "kamino",
  category: "lending" as const,
  estimated_apy: 0.0842,
  rationale: "Kamino USDC main reserve は TVL $250M 超、Tier S protocol で安定運用中",
  action_spec: {
    wallet_id: "wal_001",
    action_type: ActionType.ReDepositIncludeYield,
    protocol: "kamino",
    asset: "USDC",
    amount: "1542300000", // 1542.3 USDC (smallest unit)
  },
};

const candidateMarinade = {
  candidate_id: "cand_002",
  protocol: "marinade",
  category: "staking" as const,
  estimated_apy: 0.071,
  rationale: "Marinade mSOL は Tier A、流動性が高く LST swap が容易",
  action_spec: {
    wallet_id: "wal_001",
    action_type: ActionType.Rotate,
    protocol: "kamino",
    to_protocol: "marinade",
    asset: "USDC",
    amount: "1542300000",
  },
};

export const fixtureAgentPlanDraft: AgentPlan = {
  plan_id: "plan_001",
  user_id: "user_001",
  mcp_client_id: "mcp_client_claude_desktop_001",
  objective: Objective.SafetyFirst,
  constraints: { trusted_only: true, min_tvl: 50000000 },
  candidate_actions: [candidateKamino, candidateMarinade],
  selected_action: null,
  simulation_result: null,
  status: AgentPlanStatus.Draft,
  created_at: "2026-05-06T10:00:00.000Z",
  updated_at: "2026-05-06T10:00:00.000Z",
};

export const fixtureAgentPlanSimulated: AgentPlan = {
  plan_id: "plan_002",
  user_id: "user_001",
  mcp_client_id: "mcp_client_claude_desktop_001",
  objective: Objective.MaxYield,
  constraints: { trusted_only: true },
  candidate_actions: [candidateKamino, candidateMarinade],
  selected_action: candidateKamino.action_spec,
  simulation_result: {
    simulation_id: "sim_001",
    estimated_out: "1672450000", // 1672.45 USDC after 30d at 8.42% APY
    estimated_fee: "120000", // 0.12 USDC fee
    slippage_bps: 0, // lending は slippage なし
    bundle_hash: "0xabc123def456...",
    oracle: {
      primary: "pyth",
      primary_age_seconds: 4,
      divergence_pct: 0.3,
      warnings: [],
    },
  },
  status: AgentPlanStatus.Simulated,
  created_at: "2026-05-06T10:00:00.000Z",
  updated_at: "2026-05-06T10:01:30.000Z",
};

export const fixtureAgentPlanPendingUser: AgentPlan = {
  ...fixtureAgentPlanSimulated,
  plan_id: "plan_003",
  status: AgentPlanStatus.PendingUser,
  updated_at: "2026-05-06T10:02:00.000Z",
};

export const fixtureAgentPlanExecuting: AgentPlan = {
  ...fixtureAgentPlanSimulated,
  plan_id: "plan_004",
  status: AgentPlanStatus.Executing,
  updated_at: "2026-05-06T10:03:00.000Z",
};

/**
 * oracle warning 付きの simulated plan (WarningArea 表示テスト用)
 */
export const fixtureAgentPlanSimulatedWithWarning: AgentPlan = {
  ...fixtureAgentPlanSimulated,
  plan_id: "plan_005",
  simulation_result: {
    ...fixtureAgentPlanSimulated.simulation_result!,
    simulation_id: "sim_002",
    oracle: {
      primary: "pyth",
      primary_age_seconds: 8,
      divergence_pct: 3.4, // 2-5% warning
      warnings: ["oracle_divergence_warning"],
    },
  },
};

export const fixtureAgentPlans: AgentPlan[] = [
  fixtureAgentPlanDraft,
  fixtureAgentPlanSimulated,
  fixtureAgentPlanPendingUser,
  fixtureAgentPlanExecuting,
  fixtureAgentPlanSimulatedWithWarning,
];
