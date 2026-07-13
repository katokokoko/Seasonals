/**
 * autonomous fixtures (Phase 8.30)
 *
 * mobile / web の自律管制盤が IS_TEST_ENV / dev fallback で描画する
 * `AutonomousStatus` と `AutonomousExecutionRecord[]`。BFF `/autonomous/status`
 * `/autonomous/log` の shape に一致 (same source of truth)。
 *
 * status は「未 arm(feature flag OFF)」の安全既定を映す。log は
 * executed / dry_run / rejected の 3 decision を 1 つずつ持ち、UI の色分け・
 * violations 表示・tx_signature リンクの有無を全て test/dev で確認できる。
 */

import type {
  AutonomousExecutionRecord,
  AutonomousStatus,
} from "../types";

export const fixtureAutonomousStatus: AutonomousStatus = {
  enabled: false,
  feature_flag: false,
  devnet: true,
  killed: false,
  delegate_pubkey: null,
  daily_count: 0,
  daily_limit: 5,
  hard_caps: {
    max_tx_usd8: "20.00000000",
    max_daily: 5,
    max_lamports: "100000",
  },
};

export const fixtureAutonomousLog: AutonomousExecutionRecord[] = [
  {
    record_id: "auto_fixture_1",
    plan_id: "plan_mcp_fixture_1",
    delegate_pubkey: "De1egateDevnetPubkey11111111111111111111111",
    objective: "safety_first",
    protocol: "kamino",
    action_type: "deposit",
    asset: "USDC",
    amount_usd8: "20.00000000",
    lamports: "10000",
    decision: "executed",
    reason: null,
    violations: [],
    tx_signature: "SIGfixtureConfirmedDevnet1111111111111111111",
    network: "devnet",
    decision_source: "mainnet_menu_live",
    notified_at: "2026-07-13T09:00:00.000Z",
    created_at: "2026-07-13T09:00:00.000Z",
  },
  {
    record_id: "auto_fixture_2",
    plan_id: "plan_mcp_fixture_2",
    delegate_pubkey: "De1egateDevnetPubkey11111111111111111111111",
    objective: "max_yield",
    protocol: "jito",
    action_type: "deposit",
    asset: "SOL",
    amount_usd8: "20.00000000",
    lamports: "0",
    decision: "dry_run",
    reason: "dry_run",
    violations: [],
    tx_signature: null,
    network: "devnet",
    decision_source: "mainnet_menu_live",
    notified_at: null,
    created_at: "2026-07-13T08:00:00.000Z",
  },
  {
    record_id: "auto_fixture_3",
    plan_id: null,
    delegate_pubkey: null,
    objective: "safety_first",
    protocol: null,
    action_type: "deposit",
    asset: null,
    amount_usd8: "0.00000000",
    lamports: "0",
    decision: "rejected",
    reason: "no_candidate_passed_policy",
    violations: ["policy_violation_min_tvl"],
    tx_signature: null,
    network: "devnet",
    decision_source: "mainnet_menu_live",
    notified_at: null,
    created_at: "2026-07-13T07:00:00.000Z",
  },
];
