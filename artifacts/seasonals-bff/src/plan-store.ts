/**
 * plan-store — AgentPlan / ApprovalToken の store (Phase 8.28、永続化は 2026-10-06)
 *
 * §17 / §25 の本実装 (Redis + Postgres dual-write) の前段となる dev ストア。
 * MCP Server の plan lifecycle (compare → simulate → request_approval →
 * approve → execute → signatures) を実体化する。
 *
 * ## 永続化 (ETH agent-proposals.ts と同じ流儀)
 * plans / tokens / 署名待ち execution を `.data/agent-plans.json` に保存する
 * (`persistence.ts` の saveJson / loadJson、SEASONALS_DATA_DIR 未設定 = jest では no-op)。
 * load は遅延 (SEASONALS_DATA_DIR は index.ts の main() で設定されるため import 時には読まない)。
 * push token は端末再登録で戻るので in-memory のまま。
 *
 * ## 期限 (24h)
 * createPlan が `expires_at = created_at + 24h` を付ける。list / get / approval の
 * 読み出しで、終端 (broadcasted | failed | rejected | expired) 以外の期限超過 plan を
 * expired に更新して保存する (lazy — ETH proposal と同じ)。
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

import { AgentPlanStatus } from "@workspace/lib/types";
import type {
  AgentPlan,
  AgentPlanExecutionVia,
  ApprovalToken,
  ApprovalTokenValidation,
  IssueApprovalTokenInput,
} from "@workspace/lib/types";

import { loadJson, saveJson } from "./persistence";

/** plan の寿命 (作成から 24h、ETH agent proposal と同じ) */
export const PLAN_TTL_MS = 24 * 60 * 60 * 1000;
/** 期限から 7 日経った plan / token は保存ファイルから落とす (dry-run plan の堆積対策) */
const PRUNE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

const PERSIST_KEY = "agent-plans";

/** execute 済み・署名報告待ちの execution (plan が executing の間だけ存在) */
export interface PendingExecution {
  execution_id: string;
  /** unsigned_transactions の本数 (/signatures の本数検証に使う) */
  tx_count: number;
  via: AgentPlanExecutionVia;
  created_at: string;
}

interface PersistedPlanStore {
  plans: AgentPlan[];
  tokens: ApprovalToken[];
  executions: Record<string, PendingExecution>;
}

const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  AgentPlanStatus.Broadcasted,
  AgentPlanStatus.Failed,
  AgentPlanStatus.Rejected,
  AgentPlanStatus.Expired,
]);

export function isTerminalPlanStatus(status: string): boolean {
  return TERMINAL_STATUSES.has(status);
}

// ── stores ───────────────────────────────────────────────────────────────────

const plans = new Map<string, AgentPlan>();
const tokens = new Map<string, ApprovalToken>();
const latestTokenByPlan = new Map<string, string>();
const executions = new Map<string, PendingExecution>();
const pushTokens = new Set<string>();
let loaded = false;

function planExpiresAtMs(p: AgentPlan): number {
  return p.expires_at
    ? Date.parse(p.expires_at)
    : Date.parse(p.created_at) + PLAN_TTL_MS;
}

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  const saved = loadJson<PersistedPlanStore>(PERSIST_KEY);
  if (!saved) return;
  const now = Date.now();
  // token は発行順に積む (latestTokenByPlan が最後の発行を指すように)
  const sortedTokens = [...(saved.tokens ?? [])].sort(
    (a, b) => Date.parse(a.issued_at) - Date.parse(b.issued_at)
  );
  for (const p of saved.plans ?? []) {
    if (typeof p?.plan_id !== "string") continue;
    if (planExpiresAtMs(p) + PRUNE_AFTER_MS < now) continue;
    plans.set(p.plan_id, p);
  }
  for (const t of sortedTokens) {
    if (typeof t?.token_id !== "string") continue;
    if (Date.parse(t.expires_at) + PRUNE_AFTER_MS < now) continue;
    tokens.set(t.token_id, t);
    latestTokenByPlan.set(t.plan_id, t.token_id);
  }
  for (const [planId, e] of Object.entries(saved.executions ?? {})) {
    if (plans.get(planId)?.status === AgentPlanStatus.Executing) {
      executions.set(planId, e);
    }
  }
}

function persist(): void {
  saveJson(PERSIST_KEY, {
    plans: [...plans.values()],
    tokens: [...tokens.values()],
    executions: Object.fromEntries(executions),
  } satisfies PersistedPlanStore);
}

/** test 用: 全 store クリア (disk は読まない) */
export function _clearPlanStoreForTest(): void {
  plans.clear();
  tokens.clear();
  latestTokenByPlan.clear();
  executions.clear();
  pushTokens.clear();
  loaded = true;
}

/** test 用: 次のアクセスで disk から読み直させる (再起動の再現) */
export function _reloadPlanStoreForTest(): void {
  _clearPlanStoreForTest();
  loaded = false;
}

/**
 * 期限超過の非終端 plan を expired にする。変更時は新しい object を返す
 * (呼び手が `next !== cur` で判定して persist)。
 */
function applyExpiry(p: AgentPlan, now: number): AgentPlan {
  if (isTerminalPlanStatus(p.status) || planExpiresAtMs(p) > now) return p;
  const next: AgentPlan = {
    ...p,
    status: AgentPlanStatus.Expired,
    updated_at: new Date(now).toISOString(),
  };
  plans.set(p.plan_id, next);
  executions.delete(p.plan_id);
  return next;
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
  ensureLoaded();
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  const plan: AgentPlan = {
    plan_id: `plan_mcp_${randomUUID()}`,
    user_id: input.user_id ?? "user_default",
    mcp_client_id: input.mcp_client_id ?? "mcp_client_unknown",
    objective: input.objective,
    constraints: input.constraints ?? {},
    candidate_actions: input.candidate_actions ?? [],
    selected_action: null,
    simulation_result: null,
    status: AgentPlanStatus.Draft,
    created_at: now,
    updated_at: now,
    expires_at: new Date(nowMs + PLAN_TTL_MS).toISOString(),
  };
  plans.set(plan.plan_id, plan);
  persist();
  return plan;
}

/** store plan を読む (期限超過なら expired に更新して保存) */
export function getStoredPlan(planId: string): AgentPlan | undefined {
  ensureLoaded();
  const cur = plans.get(planId);
  if (!cur) return undefined;
  const next = applyExpiry(cur, Date.now());
  if (next !== cur) persist();
  return next;
}

/** store plan 全件 (新しい順)。期限超過は expired に更新して保存 */
export function listStoredPlans(): AgentPlan[] {
  ensureLoaded();
  const now = Date.now();
  let changed = false;
  const out: AgentPlan[] = [];
  for (const p of plans.values()) {
    const next = applyExpiry(p, now);
    if (next !== p) changed = true;
    out.push(next);
  }
  if (changed) persist();
  return out.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
}

/** store plan の部分更新 (updated_at 自動更新)。存在しなければ undefined。 */
export function updatePlan(
  planId: string,
  patch: Partial<AgentPlan>
): AgentPlan | undefined {
  ensureLoaded();
  const cur = plans.get(planId);
  if (!cur) return undefined;
  const next: AgentPlan = {
    ...cur,
    ...patch,
    plan_id: cur.plan_id,
    updated_at: new Date().toISOString(),
  };
  plans.set(planId, next);
  if (next.status !== AgentPlanStatus.Executing) executions.delete(planId);
  persist();
  return next;
}

// ── pending executions (execute → signatures / failed) ──────────────────────

/** execute 成功時に記録し、plan を executing にする */
export function startPlanExecution(
  planId: string,
  exec: Omit<PendingExecution, "created_at">
): AgentPlan | undefined {
  ensureLoaded();
  if (!plans.has(planId)) return undefined;
  executions.set(planId, { ...exec, created_at: new Date().toISOString() });
  return updatePlan(planId, { status: AgentPlanStatus.Executing });
}

export function getPendingExecution(planId: string): PendingExecution | undefined {
  ensureLoaded();
  return executions.get(planId);
}

// ── bundle hash (§11.7) ──────────────────────────────────────────────────────

/**
 * 全階層のキーを再帰ソートした canonical JSON (Phase 8.37 B11)。
 * 旧実装の `JSON.stringify(obj, Object.keys(obj).sort())` は **replacer 配列が
 * 全ネスト階層のキーを許可リストとして絞る**ため、トップレベルに無い名前の
 * ネスト field が hash から抜け落ちる改ざん検出穴があった。
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const body = keys
    .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
    .map(
      (k) =>
        `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`
    )
    .join(",");
  return `{${body}}`;
}

/**
 * selected_action (Solana) や agent proposal の `{id, owner, steps}` (Ethereum) の
 * canonical JSON (再帰キーソート) の sha256。同じ入力には常に同じ hash (決定的) — 改ざん検出の実体。
 */
export function computeBundleHash(value: unknown): string {
  return `0x${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

// ── approval tokens (§11.8 / §29.3) ─────────────────────────────────────────

export function issueApprovalToken(input: IssueApprovalTokenInput): ApprovalToken {
  ensureLoaded();
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
  persist();
  return token;
}

export function getStoredToken(tokenId: string): ApprovalToken | undefined {
  ensureLoaded();
  return tokens.get(tokenId);
}

/**
 * plan に対して最後に発行された token (§24.9 request_user_approval が auto 承認後に
 * agent へ返すため)。v1 は client 認証が無い dev 環境前提 (README 明記)。
 */
export function getLatestTokenForPlan(
  planId: string
): ApprovalToken | undefined {
  ensureLoaded();
  const id = latestTokenByPlan.get(planId);
  return id ? tokens.get(id) : undefined;
}

type TokenExpect = { plan_id?: string; bundle_hash?: string };

function checkToken(
  token: ApprovalToken | undefined,
  expect: TokenExpect
): ApprovalTokenValidation {
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
  return { valid: true, token };
}

/**
 * 消費せずに検証する (execute が tx を組む前の早期拒否用)。
 * 最終判定は必ず validateAndConsumeToken で行う (TOCTOU は consume 側が塞ぐ)。
 */
export function peekApprovalToken(
  tokenId: string,
  expect: TokenExpect
): ApprovalTokenValidation {
  ensureLoaded();
  return checkToken(tokens.get(tokenId), expect);
}

/**
 * §29.3: 検証と消費を単一操作で行う (成功時に consumed_at をセット —
 * 同一 token の再利用は already_consumed で拒否)。
 */
export function validateAndConsumeToken(
  tokenId: string,
  expect: TokenExpect
): ApprovalTokenValidation {
  ensureLoaded();
  const checked = checkToken(tokens.get(tokenId), expect);
  if (!checked.valid) return checked;
  const consumed: ApprovalToken = {
    ...checked.token,
    consumed_at: new Date().toISOString(),
  };
  tokens.set(tokenId, consumed);
  persist();
  return { valid: true, token: consumed };
}

// ── push tokens (in-memory) ─────────────────────────────────────────────────

/** 公開 BFF で無制限に溜めない上限 (in-memory)。超えたら最古から捨てる */
export const MAX_PUSH_TOKENS = 200;

export function registerPushToken(token: string): void {
  // 再登録は「最新」に付け直す (Set は挿入順なので delete → add)
  pushTokens.delete(token);
  pushTokens.add(token);
  while (pushTokens.size > MAX_PUSH_TOKENS) {
    const oldest = pushTokens.values().next().value;
    if (oldest === undefined) break;
    pushTokens.delete(oldest);
  }
}

export function listPushTokens(): string[] {
  return [...pushTokens];
}
