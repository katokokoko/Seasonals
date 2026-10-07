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
import type { OracleSourceId } from "./oracle";
import type { ApprovalToken } from "./approval-token";

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
 * 見積りの出所 (2026-10-08、simulate の実値化)。
 * - quote: Jupiter の swap quote (swap-earn の share / underlying)
 * - exchange_rate: 交換レートで換算 (Kamino kVault shares / Save cToken / その逆)
 * - same_as_input: 受け取り量 = 入力量 (Kamino reserve。担保は underlying 建てで管理される)
 * - lp_position: 単一の受け取り量が無い (Meteora / Orca の LP position)
 * - pt_redeem: Exponent PT の償還 (換算値は出さない)
 * - none: 見積り不能。failure_reason が必ず付く
 */
export type SimulationEstimateKind =
  | "quote"
  | "exchange_rate"
  | "same_as_input"
  | "lp_position"
  | "pt_redeem"
  | "none";

/** simulate が見積りを出せなかった理由 */
export type SimulationFailureReason =
  | "unsupported_market"
  | "asset_mismatch"
  | "amount_required"
  | "quote_unavailable"
  | "rate_unavailable";

/**
 * oracle 以外の注意 (oracle の warning は `oracle.warnings`)。
 * simulate は情報提供なので止めない。実際の拒否は execute の tx builder が行う (§4.6)
 */
export type SimulationWarning =
  | "fair_value_deviation"
  | "fair_value_unavailable"
  | "deposit_unavailable";

/**
 * simulate_action の結果 (§24.9 outputSchema)
 *
 * 数値表現規約 (§4.5):
 * - estimated_out / min_out / estimated_fee は smallest unit string
 *
 * `estimate_kind` が無い結果は旧形式 (2026-10-08 より前の永続 plan と fixture)。
 * 旧形式の estimated_out / estimated_fee は入力 asset の単位で解釈する。
 */
export interface SimulationResult {
  /** simulation の一意 ID。simulate を再実行するごとに新規発行 */
  simulation_id: string;
  /** 見積りの出所。無ければ旧形式 */
  estimate_kind?: SimulationEstimateKind;
  /** 推定受け取り量 (smallest unit)。quote / exchange_rate / same_as_input の時だけ */
  estimated_out?: string;
  /** 受け取る token の mint (kVault shares のように SPL mint を持たない時は無い) */
  estimated_out_mint?: string;
  /** 受け取る token の表示名 (例: "jlUSDC", "Steakhouse USDC shares") */
  estimated_out_symbol?: string;
  /** estimated_out / min_out の decimals */
  estimated_out_decimals?: number;
  /** quote の最低受け取り量 (= Jupiter otherAmountThreshold)。quote の時だけ */
  min_out?: string;
  /** 推定手数料 (SOL lamports)。署名なしで正直な値が出せないため新形式の BFF は出さない */
  estimated_fee?: string;
  /** スリッページ (bps) */
  slippage_bps?: number;
  /** transaction bundle の hash (改ざん検出に使用、approval_token と紐付く) */
  bundle_hash: string;
  /** simulation 時点の oracle 価格情報 (§4.6) */
  oracle?: {
    primary: OracleSourceId;
    primary_age_seconds: number;
    divergence_pct?: number;
    warnings: string[]; // oracle_divergence_warning 等
  };
  /** oracle 以外の注意 (fair value の確認結果、預入停止中など) */
  warnings?: SimulationWarning[];
  /** 見積りを出せなかった理由 (estimate_kind "none" の時は必須) */
  failure_reason?: SimulationFailureReason;
  /** simulation の追加メタ */
  metadata?: Record<string, unknown>;
}

/**
 * AgentPlan — MCP execution flow の中核エンティティ
 *
 * status 遷移:
 *   draft → simulated → pending_user → approved → executing → broadcasted
 *                     ↘ (policy auto)  ↗           ↘ failed (wallet 拒否 / 送信失敗を web が報告)
 *   simulated | pending_user | approved → rejected
 *   終端 (broadcasted | failed | rejected | expired) 以外は expires_at (作成 + 24h) 超過で expired
 *
 * 人が承認する plan は web が approve → execute (unsigned tx) → 署名 → 送信 →
 * /signatures まで一気に行う (承認 = 実行)。Agent は署名済み tx を受け取らない (§6.5)。
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

  /** 24h 期限 (ISO)。超えたら expired (BFF が読み出し時に判定) */
  expires_at?: string;

  /** approve の主体。auto = policy の自動承認 (autonomous)、user = 人 (web / Seeker) */
  approved_by?: AgentPlanApprover;

  /** 署名・送信の結果 (web が POST /agent-plans/:id/signatures で報告) */
  execution?: AgentPlanExecution;

  /** 失敗 / 取り消しの理由 (user_cancelled / submit_failed / …) */
  failure_reason?: string;
}

/** approve の主体 (AgentPlan.approved_by) */
export type AgentPlanApprover = "user" | "auto";

/** 署名・送信を行った経路 */
export type AgentPlanExecutionVia = "web" | "autonomous";

/** 署名・送信の結果 (AgentPlan.execution) */
export interface AgentPlanExecution {
  execution_id: string;
  /** base58 の tx signature (unsigned_transactions の index 順) */
  signatures: string[];
  /** ISO 8601 */
  submitted_at: string;
  via: AgentPlanExecutionVia;
}

/** POST /agent-plans/:id/execute の unsigned tx 1 本 */
export interface AgentPlanUnsignedTransaction {
  index: number;
  label: string;
  /** base64 serialized (未署名、または ephemeral keypair の部分署名済み) */
  tx_base64: string;
}

/**
 * POST /agent-plans/:id/execute の成功応答。
 * 署名は呼び手 (web の接続 wallet) が行い、結果を /signatures か /failed で報告する。
 */
export interface AgentPlanExecuteResponse {
  execution_id: string;
  status: "awaiting_signature";
  plan: AgentPlan;
  unsigned_transactions: AgentPlanUnsignedTransaction[];
}

/**
 * GET /agent-plans/:id/approval の応答 (MCP request_user_approval の poll 先)。
 * approval_token は approved_by === "auto" かつ status === "approved" の時だけ含まれる
 * (人が承認した plan の token は web が approve 応答で直接受け取り、外には出さない)。
 */
export interface AgentPlanApprovalStatus {
  plan_id: string;
  status: AgentPlanStatus;
  approved_by: AgentPlanApprover | null;
  approval_token?: ApprovalToken;
  execution?: AgentPlanExecution;
  failure_reason?: string;
}

/** POST /agent-plans/:id/approve の応答 */
export type AgentPlanApproveResponse = AgentPlan & { approval_token: ApprovalToken };
