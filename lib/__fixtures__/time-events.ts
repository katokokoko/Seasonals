import type { UnifiedTimeEvent } from "../types/unified-time-event";
import { TimeEventCategory, Urgency } from "../types/enums";

/**
 * 8 カテゴリ全網羅の UnifiedTimeEvent fixture。
 *
 * §29.1 golden test の input として使える。
 * §32.2 整合性チェック「8 categories of time」をコード上で確認するための reference。
 */

// ─── 1. maturity ────────────────────────────────────────────────────────────
export const fixtureEventMaturity: UnifiedTimeEvent = {
  id: "evt_001",
  protocol: "kamino",
  category: TimeEventCategory.Maturity,
  triggerAt: new Date("2026-05-15T00:00:00.000Z"),
  urgency: Urgency.Watch,
  walletAddress: "7nZbHkQqXkr3eW8s2dKvHqBxNz9vC5jPpL2tF6mYrXaA",
  positionRef: "pos_001",
  actions: [
    {
      actionType: "withdraw",
      label: "Withdraw",
      requiresApproval: true,
      riskLevel: "low",
    },
    {
      actionType: "re_deposit_include_yield",
      label: "Re-deposit (include yield)",
      requiresApproval: true,
      riskLevel: "low",
    },
  ],
  agentReadable: true,
  metadata: { current_apy: 0.0842, days_until: 9 },
};

// ─── 2. epoch ───────────────────────────────────────────────────────────────
export const fixtureEventEpoch: UnifiedTimeEvent = {
  id: "evt_002",
  protocol: "jito",
  category: TimeEventCategory.Epoch,
  triggerAt: new Date("2026-05-08T18:30:00.000Z"),
  urgency: Urgency.Info,
  walletAddress: "9hQpJ4xRwY7nKsT2bGvCmHdEq6jPzN5fLrXk3aBoMyVc",
  positionRef: "pos_002",
  actions: [],
  agentReadable: true,
  metadata: { epoch: 723, expected_reward_lamports: "120000000" },
};

// ─── 3. claim ───────────────────────────────────────────────────────────────
export const fixtureEventClaim: UnifiedTimeEvent = {
  id: "evt_003",
  protocol: "marinade",
  category: TimeEventCategory.Claim,
  triggerAt: new Date("2026-05-09T00:00:00.000Z"),
  urgency: Urgency.Watch,
  walletAddress: "7nZbHkQqXkr3eW8s2dKvHqBxNz9vC5jPpL2tF6mYrXaA",
  positionRef: null,
  actions: [
    {
      actionType: "claim",
      label: "Claim rewards",
      requiresApproval: true,
      riskLevel: "low",
    },
  ],
  agentReadable: true,
  metadata: {
    claim_window_ends_at: "2026-05-23T00:00:00.000Z",
    claimable_amount: "5800000000", // 5.8 SOL in lamports
  },
};

// ─── 4. health ──────────────────────────────────────────────────────────────
export const fixtureEventHealth: UnifiedTimeEvent = {
  id: "evt_004",
  protocol: "kamino",
  category: TimeEventCategory.Health,
  triggerAt: new Date("2026-05-06T22:30:00.000Z"),
  urgency: Urgency.Critical,
  walletAddress: "7nZbHkQqXkr3eW8s2dKvHqBxNz9vC5jPpL2tF6mYrXaA",
  positionRef: "pos_003",
  actions: [
    {
      actionType: "repay",
      label: "Repay debt",
      requiresApproval: true,
      riskLevel: "high",
    },
    {
      actionType: "add_collateral",
      label: "Add collateral",
      requiresApproval: true,
      riskLevel: "medium",
    },
  ],
  agentReadable: true,
  metadata: {
    health_factor: 1.12, // 危険水準
    liquidation_threshold: 1.0,
    estimated_time_to_liquidation_hours: 12,
  },
};

// ─── 5. vesting_cliff ───────────────────────────────────────────────────────
export const fixtureEventVestingCliff: UnifiedTimeEvent = {
  id: "evt_005",
  protocol: "streamflow",
  category: TimeEventCategory.VestingCliff,
  triggerAt: new Date("2026-07-01T00:00:00.000Z"),
  urgency: Urgency.Info,
  walletAddress: "7nZbHkQqXkr3eW8s2dKvHqBxNz9vC5jPpL2tF6mYrXaA",
  positionRef: "pos_004",
  actions: [],
  agentReadable: true,
  metadata: {
    cliff_amount: "10000000000000", // 10000 SEAS
    linear_until: "2027-07-01T00:00:00.000Z",
  },
};

// ─── 6. vote_deadline ───────────────────────────────────────────────────────
export const fixtureEventVoteDeadline: UnifiedTimeEvent = {
  id: "evt_006",
  protocol: "marinade",
  category: TimeEventCategory.VoteDeadline,
  triggerAt: new Date("2026-05-12T23:59:59.000Z"),
  urgency: Urgency.Watch,
  walletAddress: "7nZbHkQqXkr3eW8s2dKvHqBxNz9vC5jPpL2tF6mYrXaA",
  positionRef: null,
  actions: [
    {
      actionType: "vote",
      label: "Vote",
      requiresApproval: true,
      riskLevel: "low",
    },
  ],
  agentReadable: true,
  metadata: {
    proposal_id: "MIP-024",
    proposal_title: "Marinade governance: validator set update",
  },
};

// ─── 7. lockup_end ──────────────────────────────────────────────────────────
export const fixtureEventLockupEnd: UnifiedTimeEvent = {
  id: "evt_007",
  protocol: "kamino",
  category: TimeEventCategory.LockupEnd,
  triggerAt: new Date("2026-06-06T00:00:00.000Z"),
  urgency: Urgency.Info,
  walletAddress: "7nZbHkQqXkr3eW8s2dKvHqBxNz9vC5jPpL2tF6mYrXaA",
  positionRef: "pos_001",
  actions: [
    {
      actionType: "withdraw",
      label: "Withdraw (lockup end)",
      requiresApproval: true,
      riskLevel: "low",
    },
  ],
  agentReadable: true,
  metadata: { unlock_amount: "1542300000" },
};

// ─── 8. forecast_marker ─────────────────────────────────────────────────────
export const fixtureEventForecastMarker: UnifiedTimeEvent = {
  id: "evt_008",
  protocol: "kamino",
  category: TimeEventCategory.ForecastMarker,
  triggerAt: new Date("2026-05-30T00:00:00.000Z"),
  urgency: Urgency.Info,
  walletAddress: "7nZbHkQqXkr3eW8s2dKvHqBxNz9vC5jPpL2tF6mYrXaA",
  positionRef: null, // forecast は position に紐付かない system event
  actions: [],
  agentReadable: false, // 予測は MCP では expose しない (Calendar UI のみ)
  metadata: {
    forecast_kind: "expected_yield_milestone",
    expected_value_usd: "1600.00000000",
  },
};

/**
 * 全 8 カテゴリの fixture (golden test 用)。
 * 配列順序は §11.4 / `enums.ts` の TIME_EVENT_CATEGORIES と同じ。
 */
export const fixtureUnifiedTimeEvents: UnifiedTimeEvent[] = [
  fixtureEventMaturity,
  fixtureEventEpoch,
  fixtureEventClaim,
  fixtureEventHealth,
  fixtureEventVestingCliff,
  fixtureEventVoteDeadline,
  fixtureEventLockupEnd,
  fixtureEventForecastMarker,
];
