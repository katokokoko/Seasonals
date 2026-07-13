/**
 * autonomous — bounded 委任署名による自律実行サイクル (Phase 8.29)
 *
 * "AI が自分勝手に運用する" オプション。BFF が **devnet の bounded 委任 keypair**
 * (ユーザーが少額 pre-fund した自律サブアカウント) を持ち、ハード上限 + user
 * policy 内なら **人のタップなしで署名+broadcast** する。§6.5「制限付き委任
 * アカウント」/ §18 Phase 3 "bounded delegation token" の devnet スライス。
 *
 * ## 決定/実行の分離 (重要)
 * Jupiter/DeFi は devnet で動かないため:
 *   - 決定層 = 実 mainnet の live menu (/menu-listings) を read。objective で
 *     ランクし evaluatePolicy でフィルタ。
 *   - 実行層 = devnet で確定できる bounded SOL transfer + memo。sign→broadcast
 *     →confirm→record→notify を実 devnet 署名で実証する。
 * amount_usd8 (決定 notional) と lamports (実移動) は意図的に decouple。
 * mainnet 実 DeFi 実行はセキュリティ監査後 (§11.6 前提)。
 *
 * ## ガードレール (構造的に「無制限自動売買」を排除)
 *   - devnet 限定 (solana-devnet.ts の hard guard)
 *   - feature flag OFF デフォルト (FEATURE_APPROVAL_MODE_AUTO)
 *   - ハード上限は policy と独立 (AUTONOMOUS_MAX_TX_USD8 / _MAX_DAILY / _MAX_LAMPORTS)
 *   - kill switch / daily counter / dry_run
 *
 * §32.2: 委任鍵は **BFF のみ**。secret はログにも record にも載せない
 * (delegate_pubkey のみ)。mobile/lib の Keypair grep は 0 件維持。
 */

import { randomUUID } from "node:crypto";

import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
// bs58 4.x: default export に decode/encode
// eslint-disable-next-line @typescript-eslint/no-var-requires
const bs58 = require("bs58") as { decode(s: string): Uint8Array };

import {
  canAutoExecute,
  evaluatePolicy,
  type PolicyCandidate,
} from "@workspace/lib/policy/evaluate-policy";
import { compareUsd8 } from "@workspace/lib/utils/numeric";
import type {
  AutonomousExecutionRecord,
  AutonomousStatus,
  Objective,
  ProtocolMenuEntry,
  UserPolicy,
} from "@workspace/lib/types";
import { PositionCategory, TrustLevel } from "@workspace/lib/types";
import { fixtureProtocols } from "@workspace/lib/__fixtures__";

import {
  DevnetGuardError,
  isDevnetRpc,
  getDevnetConnection,
  sendAndConfirmDevnetTx,
} from "./clients/solana-devnet";
import {
  computeBundleHash,
  createPlan,
  issueApprovalToken,
  updatePlan,
  validateAndConsumeToken,
} from "./plan-store";
import { loadJson, saveJson } from "./persistence";

// ── ハード上限 (user policy と独立、超えられない) ────────────────────────────
export const AUTONOMOUS_MAX_TX_USD8 = "20.00000000"; // 決定 notional の絶対上限 $20
export const AUTONOMOUS_MAX_DAILY = 5; // 1 UTC 日あたり絶対実行上限
export const AUTONOMOUS_MAX_LAMPORTS = 100_000n; // 実 devnet transfer 上限 0.0001 SOL
const MEMO_PROGRAM_ID = new PublicKey(
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"
);

// ── module state (in-memory、再起動でリセット) ───────────────────────────────
let delegateCache: { keypair: Keypair; pubkey: string } | null = null;
let killed = false;
const records: AutonomousExecutionRecord[] = [];
let dailyDate = "";
let dailyCount = 0;

export function _resetAutonomousForTest(): void {
  delegateCache = null;
  killed = false;
  records.length = 0;
  dailyDate = "";
  dailyCount = 0;
}

// ── flags / guards ───────────────────────────────────────────────────────────

/** APPROVAL_MODE_AUTO_FEATURE_FLAG の runtime 実装 (env)。 */
export function isAutonomousFeatureEnabled(): boolean {
  return process.env.FEATURE_APPROVAL_MODE_AUTO === "true";
}

export function isKilled(): boolean {
  return killed;
}
export function kill(): void {
  killed = true;
}
export function resume(): void {
  killed = false;
}

export class AutonomousDisabledError extends Error {
  constructor(
    readonly code:
      | "feature_flag_off"
      | "not_devnet"
      | "kill_switch_active"
      | "no_delegate"
  ) {
    super(code);
    this.name = "AutonomousDisabledError";
  }
}

/**
 * env の base58 or JSON-array secret から委任 keypair を load (devnet-guard)。
 * secret はここから外に出さない (pubkey のみ公開)。
 */
export function getDelegate(): { keypair: Keypair; pubkey: string } | null {
  if (delegateCache) return delegateCache;
  const secret = process.env.AUTONOMOUS_DELEGATE_SECRET;
  if (!secret) return null;
  if (!isDevnetRpc()) throw new DevnetGuardError(process.env.SOLANA_RPC_URL ?? "");
  let bytes: Uint8Array;
  const trimmed = secret.trim();
  if (trimmed.startsWith("[")) {
    bytes = Uint8Array.from(JSON.parse(trimmed) as number[]);
  } else {
    bytes = bs58.decode(trimmed);
  }
  const keypair = Keypair.fromSecretKey(bytes);
  delegateCache = { keypair, pubkey: keypair.publicKey.toBase58() };
  return delegateCache;
}

/** kill/flag は dry_run 含め全ブロック。devnet/delegate は実行時のみ必須。 */
export function assertAutonomousEnabled(opts: { dryRun: boolean }): void {
  if (killed) throw new AutonomousDisabledError("kill_switch_active");
  if (!isAutonomousFeatureEnabled()) {
    throw new AutonomousDisabledError("feature_flag_off");
  }
  if (!opts.dryRun) {
    if (!isDevnetRpc()) throw new AutonomousDisabledError("not_devnet");
    if (!getDelegate()) throw new AutonomousDisabledError("no_delegate");
  }
}

// ── daily counter (UTC 日次) ─────────────────────────────────────────────────
function today(): string {
  return new Date().toISOString().slice(0, 10);
}
export function getDailyCount(): number {
  return dailyDate === today() ? dailyCount : 0;
}
function incrementDaily(): void {
  const d = today();
  if (dailyDate !== d) {
    dailyDate = d;
    dailyCount = 0;
  }
  dailyCount += 1;
}

// ── risk score (fixtureProtocols trust_level 由来) ───────────────────────────
const TRUST_RISK: Record<string, number> = {
  [TrustLevel.S]: 0.9,
  [TrustLevel.A]: 0.75,
  [TrustLevel.B]: 0.6,
  [TrustLevel.Untrusted]: 0.2,
};
export function riskScoreForProtocol(protocolId: string): number {
  const p = fixtureProtocols.find((x) => x.protocol_id === protocolId);
  return p ? (TRUST_RISK[p.trust_level] ?? 0.5) : 0.5;
}

// ── record store ─────────────────────────────────────────────────────────────
export function listExecutionRecords(): AutonomousExecutionRecord[] {
  return [...records].reverse(); // newest-first
}

const RECORDS_PERSIST_KEY = "autonomous-log";

/** record を push しつつ永続化 (Phase 8.30、SEASONALS_DATA_DIR 未設定なら no-op) */
function pushRecord(rec: AutonomousExecutionRecord): void {
  records.push(rec);
  saveJson(RECORDS_PERSIST_KEY, records);
}

/**
 * 起動時に永続化された監査ログをロード (Phase 8.30)。index.ts から呼ぶ。
 * SEASONALS_DATA_DIR 未設定時は no-op (loadJson が null)。
 */
export function loadPersistedRecords(): void {
  const saved = loadJson<AutonomousExecutionRecord[]>(RECORDS_PERSIST_KEY);
  if (saved) {
    records.length = 0;
    records.push(...saved);
  }
}

export function getAutonomousStatus(): AutonomousStatus {
  let delegatePubkey: string | null = null;
  try {
    delegatePubkey = getDelegate()?.pubkey ?? null;
  } catch {
    delegatePubkey = null; // 非 devnet 等
  }
  const devnet = isDevnetRpc();
  const flag = isAutonomousFeatureEnabled();
  return {
    enabled: flag && devnet && !killed && delegatePubkey !== null,
    feature_flag: flag,
    devnet,
    killed,
    delegate_pubkey: delegatePubkey,
    daily_count: getDailyCount(),
    daily_limit: AUTONOMOUS_MAX_DAILY,
    hard_caps: {
      max_tx_usd8: AUTONOMOUS_MAX_TX_USD8,
      max_daily: AUTONOMOUS_MAX_DAILY,
      max_lamports: AUTONOMOUS_MAX_LAMPORTS.toString(),
    },
  };
}

// ── cycle ─────────────────────────────────────────────────────────────────────

export interface ExecutionPushPayload {
  type: "execution";
  record_id: string;
  plan_id: string | null;
  protocol: string | null;
  action_type: string;
  amount_usd8: string;
  tx_signature: string | null;
  status: "executed" | "failed";
}

export interface AutonomousDeps {
  fetchMenu: () => Promise<ProtocolMenuEntry[]>;
  getPolicy: () => UserPolicy;
  sendExecutionPush: (payload: ExecutionPushPayload) => Promise<void>;
}

export interface RunAutonomousOpts {
  objective: Objective;
  asset?: string;
  dry_run?: boolean;
}

/** USD 8-dec の小さい方 (ハードクランプ用、§4.5 helper で bigint 比較) */
function minUsd8(a: string, b: string): string {
  return compareUsd8(a, b) <= 0 ? a : b;
}

/** menu の pool を PolicyCandidate に (notional を第1クランプ) */
function toCandidate(
  entry: ProtocolMenuEntry,
  pool: ProtocolMenuEntry["pools"][number],
  policyMaxTx: string | null
): PolicyCandidate {
  const notional = minUsd8(
    policyMaxTx ?? AUTONOMOUS_MAX_TX_USD8,
    AUTONOMOUS_MAX_TX_USD8
  );
  return {
    protocol: entry.protocol_id,
    category: pool.category,
    asset: pool.deposit_asset ?? pool.asset,
    amount_usd8: notional,
    tvl_usd: pool.tvl_usd,
    risk_score: riskScoreForProtocol(entry.protocol_id),
    lock_days: 0,
  };
}

function baseRecord(
  objective: Objective,
  delegatePubkey: string | null
): AutonomousExecutionRecord {
  return {
    record_id: `auto_${randomUUID()}`,
    plan_id: null,
    delegate_pubkey: delegatePubkey,
    objective,
    protocol: null,
    action_type: "deposit",
    asset: null,
    amount_usd8: "0.00000000",
    lamports: "0",
    decision: "rejected",
    reason: null,
    violations: [],
    tx_signature: null,
    network: "devnet",
    decision_source: "mainnet_menu_live",
    notified_at: null,
    created_at: new Date().toISOString(),
  };
}

/**
 * 1 サイクル: fetchMenu → policy filter → (dry_run/reject) or 委任署名+broadcast。
 * throw する例外は AutonomousDisabledError のみ (呼び手が HTTP status にマップ)。
 * それ以外の decision (rejected 含む) は record として返る。
 *
 * dry_run の既定は **true** (fail-closed / 誤爆防止)。実 broadcast は呼び手が
 * dry_run:false を明示した時のみ (MCP tool は .default(true)、scheduler は
 * AUTONOMOUS_LOOP_DRY_RUN=false で opt-in)。
 */
export async function runAutonomousCycle(
  opts: RunAutonomousOpts,
  deps: AutonomousDeps
): Promise<AutonomousExecutionRecord> {
  const dryRun = opts.dry_run ?? true;
  assertAutonomousEnabled({ dryRun });

  const policy = deps.getPolicy();
  const delegatePubkey = dryRun ? (safeDelegatePubkey()) : getDelegate()!.pubkey;
  const rec = baseRecord(opts.objective, delegatePubkey);

  // 決定層: live menu → candidate → policy filter
  const menu = await deps.fetchMenu();
  const candidates: { entry: ProtocolMenuEntry; pool: ProtocolMenuEntry["pools"][number]; c: PolicyCandidate }[] =
    [];
  for (const entry of menu) {
    for (const pool of entry.pools) {
      const asset = pool.deposit_asset ?? pool.asset;
      if (opts.asset && asset !== opts.asset) continue;
      candidates.push({ entry, pool, c: toCandidate(entry, pool, policy.max_tx_amount) });
    }
  }
  // rank: safety_first は TVL 優先、他は APY 優先
  candidates.sort((a, b) =>
    opts.objective === "safety_first"
      ? b.pool.tvl_usd - a.pool.tvl_usd
      : b.pool.apy - a.pool.apy
  );

  let chosen: (typeof candidates)[number] | null = null;
  let topViolations: string[] = [];
  for (const cand of candidates) {
    const ev = evaluatePolicy(policy, cand.c);
    if (ev.allowed) {
      chosen = cand;
      break;
    }
    if (topViolations.length === 0) topViolations = ev.violations;
  }
  if (!chosen) {
    rec.reason = "no_candidate_passed_policy";
    rec.violations = topViolations;
    pushRecord(rec);
    return rec;
  }

  rec.protocol = chosen.entry.protocol_id;
  rec.asset = chosen.c.asset;
  rec.amount_usd8 = chosen.c.amount_usd8;

  // runtime gate: daily (policy ∧ hard) / approval_mode
  const dailyLimit = Math.min(
    policy.max_daily_executions ?? AUTONOMOUS_MAX_DAILY,
    AUTONOMOUS_MAX_DAILY
  );
  if (getDailyCount() >= dailyLimit) {
    rec.reason = "daily_execution_cap_reached";
    rec.violations = ["policy_violation_max_daily_executions"];
    pushRecord(rec);
    return rec;
  }
  if (!canAutoExecute(policy, isAutonomousFeatureEnabled())) {
    rec.reason = "approval_mode_not_auto";
    rec.violations = ["policy_violation_approval_mode"];
    pushRecord(rec);
    return rec;
  }

  // plan lifecycle parity (監査のため 8.28 store を通す)
  const action = {
    wallet_id: delegatePubkey ?? "delegate",
    action_type: "deposit" as const,
    protocol: chosen.entry.protocol_id,
    asset: chosen.c.asset,
    amount: chosen.c.amount_usd8,
  };
  const plan = createPlan({
    objective: opts.objective,
    user_id: policy.user_id,
    mcp_client_id: "autonomous_v1",
  });
  rec.plan_id = plan.plan_id;
  const bundleHash = computeBundleHash(action);
  updatePlan(plan.plan_id, {
    selected_action: action,
    simulation_result: {
      simulation_id: `sim_${plan.plan_id}`,
      estimated_out: chosen.c.amount_usd8,
      estimated_fee: "0",
      bundle_hash: bundleHash,
    },
    status: "simulated",
  });

  if (dryRun) {
    rec.decision = "dry_run";
    rec.reason = "dry_run";
    pushRecord(rec);
    return rec;
  }

  // 本番: token 発行+消費 (監査 parity) → 委任署名 → broadcast
  const token = issueApprovalToken({
    user_id: policy.user_id,
    plan_id: plan.plan_id,
    mcp_client_id: "autonomous_v1",
    bundle_hash: bundleHash,
  });
  validateAndConsumeToken(token.token_id, { plan_id: plan.plan_id, bundle_hash: bundleHash });
  updatePlan(plan.plan_id, { status: "approved" });

  const delegate = getDelegate()!;
  // lamports を tx build 直前に第2クランプ (最終防衛線)
  const requested = BigInt(process.env.AUTONOMOUS_TRANSFER_LAMPORTS ?? "10000");
  const lamports = requested < AUTONOMOUS_MAX_LAMPORTS ? requested : AUTONOMOUS_MAX_LAMPORTS;
  const recipient = process.env.AUTONOMOUS_RECIPIENT
    ? new PublicKey(process.env.AUTONOMOUS_RECIPIENT)
    : delegate.keypair.publicKey;

  try {
    const tx = new Transaction()
      .add(
        SystemProgram.transfer({
          fromPubkey: delegate.keypair.publicKey,
          toPubkey: recipient,
          lamports,
        })
      )
      .add(
        new TransactionInstruction({
          keys: [],
          programId: MEMO_PROGRAM_ID,
          data: Buffer.from(
            `Seasonals auto ${rec.record_id} plan=${plan.plan_id} ${chosen.entry.protocol_id}/${chosen.c.asset} $${chosen.c.amount_usd8}`
          ),
        })
      );
    // touch connection early to surface devnet errors
    getDevnetConnection();
    const signature = await sendAndConfirmDevnetTx(tx, delegate.keypair);
    incrementDaily();
    updatePlan(plan.plan_id, { status: "executing" });
    rec.decision = "executed";
    rec.reason = null;
    rec.lamports = lamports.toString();
    rec.tx_signature = signature;
    pushRecord(rec);
    // funds-moved 通知 (best-effort)
    try {
      await deps.sendExecutionPush({
        type: "execution",
        record_id: rec.record_id,
        plan_id: plan.plan_id,
        protocol: rec.protocol,
        action_type: rec.action_type,
        amount_usd8: rec.amount_usd8,
        tx_signature: signature,
        status: "executed",
      });
      rec.notified_at = new Date().toISOString();
    } catch {
      // notify 失敗はサイクルを失敗にしない
    }
    return rec;
  } catch (err) {
    updatePlan(plan.plan_id, { status: "failed" });
    rec.decision = "rejected";
    rec.reason = `broadcast_failed: ${(err as Error).message}`;
    pushRecord(rec);
    return rec;
  }
}

function safeDelegatePubkey(): string | null {
  try {
    return getDelegate()?.pubkey ?? null;
  } catch {
    return null;
  }
}

/** opt-in scheduler。index.ts のみから呼ぶ (buildServer 外)。stop fn を返す。 */
export function startAutonomousLoop(
  deps: AutonomousDeps,
  intervalMs: number,
  opts: RunAutonomousOpts
): () => void {
  const timer = setInterval(() => {
    runAutonomousCycle(opts, deps).catch(() => {
      // loop はクラッシュさせない
    });
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
