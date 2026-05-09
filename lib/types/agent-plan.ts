/**
 * AgentPlan — 仕様書 §11.7
 *
 * `compare_opportunities → simulate_action → request_user_approval → execute_approved_action`
 * という MCP execution flow の中核エンティティ。一連の流れを `plan_id` で繋ぐ。
 * 詳細は §24.10 シーケンス図参照。
 *
 * §32.2 整合性チェック:
 * - "agent end-to-end" → plan_id ベースの compare → simulate → approve → execute が一貫
 * - "auditable agent actions" → MCPAuditLog と AgentPlan が plan_id でリンク
 */

import type {
  ActionType,
  AgentPlanStatus,
  Objective,
  PositionCategory,
} from "./enums";

/**
 * compare_opportunities が呼ばれた際の制約条件 (§24.9 inputSchema)
 */
export interface AgentPlanConstraints {
  /** trusted protocol whitelist のみを対象とするか */
  trusted_only?: boolean;
  /** 最低 TVL 閾値 (USD) */
  min_tvl?: number;
  /** lockup 最大日数 */
  max_lock_days?: number;
}

/**
 * compare_opportunities の結果として返される候補の 1 件
 */
export interface CandidateAction {
  /** 候補の ID (compare 結果の中で一意) */
  candidate_id: string;
  /** 提案 protocol */
  protocol: string;
  /** 提案 category */
  category: PositionCategory;
  /** 推定利回り (APY) */
  estimated_apy?: number;
  /** rationale (Agent / User に提示する根拠) */
  rationale: string;
  /** 候補に紐付く action 仕様 */
  action_spec: ActionSpec;
}

/**
 * simulate_action / execute_approved_action に渡す action 仕様
 *
 * 数値表現規約 (§4.5):
 * - `amount` は smallest unit string ("1500000" 等)
 * - JavaScript native Number に変換しない
 */
export interface ActionSpec {
  /** どのウォレットから実行するか */
  wallet_id: string;
  /** 12 種の ActionType (§5.7 / §24.9) */
  action_type: ActionType;
  /** 対象 protocol */
  protocol: string;
  /** 対象 asset symbol */
  asset?: string;
  /** smallest unit の string (例: "1500000" = 1.5 USDC) */
  amount?: string;
  /** rotate 系で使う移転先 protocol */
  to_protocol?: string;
  /** 追加パラメータ (action_type 固有) */
  metadata?: Record<string, unknown>;
}

/**
 * simulate_action の結果 (§24.9 outputSchema)
 *
 * 数値表現規約 (§4.5):
 * - estimated_out / fee は smallest unit string または USD 8 decimals string
 */
export interface SimulationResult {
  /** simulation の一意 ID。simulate を再実行するごとに新規発行 */
  simulation_id: string;
  /** 推定 output amount (string) */
  estimated_out: string;
  /** 推定手数料 (string) */
  estimated_fee: string;
  /** スリッページ (bps) */
  slippage_bps?: number;
  /** transaction bundle の hash (改ざん検出に使用、approval_token と紐付く) */
  bundle_hash: string;
  /** simulation 時点の oracle 価格情報 (§4.6) */
  oracle?: {
    primary: "pyth" | "switchboard";
    primary_age_seconds: number;
    divergence_pct?: number;
    warnings: string[]; // oracle_divergence_warning 等
  };
  /** simulation 失敗時の理由 */
  failure_reason?: string;
  /** simulation の追加メタ */
  metadata?: Record<string, unknown>;
}

/**
 * AgentPlan — MCP execution flow の中核エンティティ
 *
 * status 遷移:
 *   draft → simulated → pending_user → approved → executing → signed → broadcasted
 *                                    ↘ rejected
 *                                    ↘ expired (approval_token TTL)
 *                                                ↘ failed (どこかで失敗)
 *
 * plan_id と simulation_id の関係:
 * - plan_id は AgentPlan への参照 (主キー)
 * - simulation_id は AgentPlan.simulation_result 内の simulation 結果へのポインタ
 * - simulate を再実行すると simulation_id は新規発行されるが、plan_id は維持される
 * - request_user_approval / execute_approved_action は plan_id ベースで動作する
 *   (simulation_id を直接渡してはならない)
 */
export interface AgentPlan {
  /** plan の一意 ID (主キー) */
  plan_id: string;

  /** 紐付く user_id */
  user_id: string;

  /** 作成元の MCP client ID */
  mcp_client_id: string;

  /** Policy preset (§6.4) */
  objective: Objective;

  /** compare 時に指定された制約条件 */
  constraints: AgentPlanConstraints;

  /** compare_opportunities の結果 */
  candidate_actions: CandidateAction[];

  /**
   * Agent または User が選んだ candidate。
   * simulate_action の引数 action_spec が **そのまま** ここに格納される (§11.7)。
   * request_user_approval 後は変更不可 (approval_token の bundle_hash で改ざん検出)。
   */
  selected_action: ActionSpec | null;

  /**
   * simulate_action の結果。simulation_id を含む。
   * simulate 再実行で上書きされる (同一 plan 内の試行錯誤を許容)。
   */
  simulation_result: SimulationResult | null;

  /** 10 種のいずれか (§11.7) */
  status: AgentPlanStatus;

  /** ISO 8601 */
  created_at: string;
  /** ISO 8601 */
  updated_at: string;
}
