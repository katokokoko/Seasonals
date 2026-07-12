/**
 * plan-store — AgentPlan / ApprovalToken の in-memory store (Phase 8.28)
 *
 * §17 / §25 の本実装 (Redis + Postgres dual-write) の前段となる dev ストア。
 * MCP Server の plan lifecycle (compare → simulate → request_approval →
 * execute) を実体化する。プロセス再起動で消える (永続化は v2)。
 *
 * §29.3 セキュリティガードをここで実装:
 *   - ApprovalToken は single-use (consumed_at セット後は already_consumed)
 *   - TTL 失効 (expires_at 経過で expired)
 *   - bundle_hash 不一致 / plan 不一致の execute 拒否
 *
 * §11.7 改ざんガード: bundle_hash は selected_action の canonical JSON の
 * sha256 (決定的)。simulate 時に算出し、approve で発行する token に埋め、
 * execute 時に再計算値と照合する。
 */

import { createHash, randomUUID } from "node:crypto";

import type {
  ActionSpec,
  AgentPlan,
  ApprovalToken,
  ApprovalTokenValidation,
  IssueApprovalTokenInput,
} from "@workspace/lib/types";

// ── stores ───────────────────────────────────────────────────────────────────

const plans = new Map<string, AgentPlan>();
const tokens = new Map<string, ApprovalToken>();
const latestTokenByPlan = new Map<string, string>();
const pushTokens = new Set<string>();

/** test 用: 全 store クリア */
export function _clearPlanStoreForTest(): void {
  plans.clear();
  tokens.clear();
  latestTokenByPlan.clear();
  pushTokens.clear();
}

// ── plans ────────────────────────────────────────────────────────────────────

export function createPlan(
  input: Pick<AgentPlan, "objective"> &
    Partial<
      Pick<
        AgentPlan,
        "user_id" | "mcp_client_id" | "constraints" | "candidate_actions"
      >
    >
): AgentPlan {
  const now = new Date().toISOString();
  const plan: AgentPlan = {
    plan_id: `plan_mcp_${randomUUID()}`,
    user_id: input.user_id ?? "user_default",
    mcp_client_id: input.mcp_client_id ?? "mcp_client_unknown",
    objective: input.objective,
    constraints: input.constraints ?? {},
    candidate_actions: input.candidate_actions ?? [],
    selected_action: null,
    simulation_result: null,
    status: "draft",
    created_at: now,
    updated_at: now,
  };
  plans.set(plan.plan_id, plan);
  return plan;
}

export function getStoredPlan(planId: string): AgentPlan | undefined {
  return plans.get(planId);
}

export function listStoredPlans(): AgentPlan[] {
  return [...plans.values()];
}

/** store plan の部分更新 (updated_at 自動更新)。存在しなければ undefined。 */
export function updatePlan(
  planId: string,
  patch: Partial<AgentPlan>
): AgentPlan | undefined {
  const cur = plans.get(planId);
  if (!cur) return undefined;
  const next: AgentPlan = {
    ...cur,
    ...patch,
    plan_id: cur.plan_id,
    updated_at: new Date().toISOString(),
  };
  plans.set(planId, next);
  return next;
}

// ── bundle hash (§11.7) ──────────────────────────────────────────────────────

/**
 * selected_action の canonical JSON (キーをソート) の sha256。
 * 同じ action には常に同じ hash (決定的) — 改ざん検出の実体。
 */
export function computeBundleHash(action: ActionSpec): string {
  const canonical = JSON.stringify(action, Object.keys(action).sort());
  return `0x${createHash("sha256").update(canonical).digest("hex")}`;
}

// ── approval tokens (§11.8 / §29.3) ─────────────────────────────────────────

export function issueApprovalToken(input: IssueApprovalTokenInput): ApprovalToken {
  const now = Date.now();
  const ttl = (input.ttl_seconds ?? 300) * 1000;
  const token: ApprovalToken = {
    token_id: randomUUID(),
    user_id: input.user_id,
    plan_id: input.plan_id,
    mcp_client_id: input.mcp_client_id,
    bundle_hash: input.bundle_hash,
    issued_at: new Date(now).toISOString(),
    expires_at: new Date(now + ttl).toISOString(),
    consumed_at: null,
  };
  tokens.set(token.token_id, token);
  latestTokenByPlan.set(token.plan_id, token.token_id);
  return token;
}

export function getStoredToken(tokenId: string): ApprovalToken | undefined {
  return tokens.get(tokenId);
}

/**
 * plan に対して最後に発行された token (§24.9 request_user_approval が承認後に
 * agent へ返すため)。v1 は client 認証が無い dev 環境前提 (README 明記)。
 */
export function getLatestTokenForPlan(
  planId: string
): ApprovalToken | undefined {
  const id = latestTokenByPlan.get(planId);
  return id ? tokens.get(id) : undefined;
}

/**
 * §29.3: 検証と消費を単一操作で行う (成功時に consumed_at をセット —
 * 同一 token の再利用は already_consumed で拒否)。
 */
export function validateAndConsumeToken(
  tokenId: string,
  expect: { plan_id?: string; bundle_hash?: string }
): ApprovalTokenValidation {
  const token = tokens.get(tokenId);
  if (!token) return { valid: false, reason: "not_found" };
  if (token.consumed_at !== null) {
    return { valid: false, reason: "already_consumed" };
  }
  if (new Date(token.expires_at).getTime() < Date.now()) {
    return { valid: false, reason: "expired" };
  }
  if (expect.plan_id !== undefined && token.plan_id !== expect.plan_id) {
    return { valid: false, reason: "wrong_plan" };
  }
  if (
    expect.bundle_hash !== undefined &&
    token.bundle_hash !== expect.bundle_hash
  ) {
    return { valid: false, reason: "bundle_hash_mismatch" };
  }
  const consumed: ApprovalToken = {
    ...token,
    consumed_at: new Date().toISOString(),
  };
  tokens.set(tokenId, consumed);
  return { valid: true, token: consumed };
}

// ── push tokens ──────────────────────────────────────────────────────────────

export function registerPushToken(token: string): void {
  pushTokens.add(token);
}

export function listPushTokens(): string[] {
  return [...pushTokens];
}
