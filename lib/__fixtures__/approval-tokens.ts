import type { ApprovalToken } from "../types/approval-token";

/**
 * Active approval token — まだ使われておらず、有効期限内
 */
export const fixtureApprovalTokenActive: ApprovalToken = {
  token_id: "tok_active_001",
  user_id: "user_001",
  plan_id: "plan_003",
  mcp_client_id: "mcp_client_claude_desktop_001",
  bundle_hash: "0xabc123def456...",
  issued_at: "2026-05-06T10:02:00.000Z",
  expires_at: "2026-05-06T10:07:00.000Z", // 5 分後
  consumed_at: null,
};

/**
 * Consumed token — execute_approved_action で使用済み (replay 拒否される)
 */
export const fixtureApprovalTokenConsumed: ApprovalToken = {
  token_id: "tok_consumed_001",
  user_id: "user_001",
  plan_id: "plan_004",
  mcp_client_id: "mcp_client_claude_desktop_001",
  bundle_hash: "0xdef456abc789...",
  issued_at: "2026-05-06T09:55:00.000Z",
  expires_at: "2026-05-06T10:00:00.000Z",
  consumed_at: "2026-05-06T09:58:30.000Z",
};

/**
 * Expired token — TTL 切れ (`oracle_token_expired` を返す)
 */
export const fixtureApprovalTokenExpired: ApprovalToken = {
  token_id: "tok_expired_001",
  user_id: "user_001",
  plan_id: "plan_005",
  mcp_client_id: "mcp_client_claude_desktop_001",
  bundle_hash: "0x999888777666...",
  issued_at: "2026-05-06T08:00:00.000Z",
  expires_at: "2026-05-06T08:05:00.000Z",
  consumed_at: null,
};

export const fixtureApprovalTokens: ApprovalToken[] = [
  fixtureApprovalTokenActive,
  fixtureApprovalTokenConsumed,
  fixtureApprovalTokenExpired,
];
