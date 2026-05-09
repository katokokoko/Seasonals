/**
 * ApprovalToken — 仕様書 §11.8
 *
 * `request_user_approval` 成功時に発行される単発使用トークン。
 * `execute_approved_action` を承認するための短命キー。
 *
 * §32.2 整合性チェック:
 * - "warning は素通りしない" → bundle_hash で simulate ↔ execute の改ざん検出
 * - "fail-closed safety" → consumed_at 検査で replay 攻撃防止
 *
 * ストレージ責務分離 (§25.1):
 * - Redis: hot lookup (TTL = expires_at)
 * - Postgres: 永続監査・consumed_at 管理
 */

/**
 * ApprovalToken — 単発使用 / 短命の承認証
 *
 * ライフサイクル:
 * 1. request_user_approval でユーザー承認 → 発行 (consumed_at = null)
 * 2. execute_approved_action で検証 → consumed_at をセット (以降同一トークン無効)
 * 3. expires_at 経過後 → 自動失効 (Redis から削除、Postgres は記録維持)
 */
export interface ApprovalToken {
  /** UUID v4 */
  token_id: string;

  /** 紐付く user_id */
  user_id: string;

  /** どの AgentPlan に対する承認か */
  plan_id: string;

  /** どの MCP client が要求したか */
  mcp_client_id: string;

  /**
   * 承認対象 bundle の hash。
   * execute 時に simulation_result.bundle_hash と一致しないと拒否 (§29.3)。
   * これにより selected_action / simulation_result の改ざん攻撃を防ぐ。
   */
  bundle_hash: string;

  /** ISO 8601 */
  issued_at: string;

  /** ISO 8601 — typical 5 分 */
  expires_at: string;

  /**
   * execute_approved_action で消費した時刻 (ISO 8601)。
   * null なら未使用、値があれば既消費 (replay 拒否)。
   */
  consumed_at: string | null;
}

/**
 * ApprovalToken を発行する際の入力 (Server 内部用)
 */
export interface IssueApprovalTokenInput {
  user_id: string;
  plan_id: string;
  mcp_client_id: string;
  bundle_hash: string;
  /** 有効期限 (秒)。default 300 = 5 分 */
  ttl_seconds?: number;
}

/**
 * ApprovalToken の検証結果 (Server 内部用)
 */
export type ApprovalTokenValidation =
  | { valid: true; token: ApprovalToken }
  | {
      valid: false;
      reason:
        | "not_found"
        | "expired"
        | "already_consumed"
        | "bundle_hash_mismatch"
        | "wrong_user"
        | "wrong_plan";
    };
