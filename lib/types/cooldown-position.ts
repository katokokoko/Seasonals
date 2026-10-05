/**
 * Cooldown position — SKR staking R0 (docs/skr-r0-implementation.md §3 / §5)
 *
 * 解除待ち (unstake cooldown) を持つ staking position の読取専用 view と、
 * BFF `GET /protocols/skr-staking/state` の wire format。
 *
 * 設計 (R0):
 * - 既存 `Position` / `EarnPosition` とは **別の型**。元本 / 収益 / USD / SOL / 入金日は
 *   R0 では取得しないので literal `null` で持ち、`Position` へ構造的に代入できない
 *   (cast・ゼロ埋めで portfolio 合計や allocation に混入させない、§4)
 * - 金融値は smallest unit の 10 進 string (CLAUDE.md §3)。u128 shares も string
 * - event は既存 `UnifiedTimeEventDTO` をそのまま包む。revision は schedule_revision のみ
 * - runtime 検査は手書き guard (lib に zod は入れない)。Mobile が response 検査に使う
 */

import { isTimeEventCategory, isUrgency } from "./enums";
import type { UnifiedTimeEventDTO } from "./unified-time-event";
import { isValidTokenAmount } from "../utils/numeric";

export const COOLDOWN_SCHEMA_VERSION = 1 as const;

// ─────────────────────────────────────────────────────────────────────────────
// enum 群 (lib/types/enums.ts と同じ as const + union + ALL + guard)
// ─────────────────────────────────────────────────────────────────────────────

/** 解除待ちの状態。ready は同 batch の chain Clock だけで判定する (端末時刻を使わない) */
export const CooldownPendingStatus = {
  None: "none",
  CoolingDown: "cooling_down",
  Ready: "ready",
  /** pending > 0 だが unlock_at を計算できない (timestamp / cooldown が範囲外) */
  Unknown: "unknown",
} as const;
export type CooldownPendingStatus =
  (typeof CooldownPendingStatus)[keyof typeof CooldownPendingStatus];
export const COOLDOWN_PENDING_STATUSES: readonly CooldownPendingStatus[] = [
  CooldownPendingStatus.None,
  CooldownPendingStatus.CoolingDown,
  CooldownPendingStatus.Ready,
  CooldownPendingStatus.Unknown,
];

/** 今回の read の結果。fresh = 必須 account の検証まで成功した観測値 */
export const CooldownDataStatus = {
  Fresh: "fresh",
  /** RPC 失敗 / timeout */
  Unavailable: "unavailable",
  /** owner / PDA / layout / 参照の検証失敗 (偽の量や日付を作らない) */
  Unsupported: "unsupported",
} as const;
export type CooldownDataStatus =
  (typeof CooldownDataStatus)[keyof typeof CooldownDataStatus];
export const COOLDOWN_DATA_STATUSES: readonly CooldownDataStatus[] = [
  CooldownDataStatus.Fresh,
  CooldownDataStatus.Unavailable,
  CooldownDataStatus.Unsupported,
];

/** live = 実チェーン。demo = 録画用 fixture (UI は必ず demo と表示する) */
export const CooldownSource = {
  Live: "live",
  Demo: "demo",
} as const;
export type CooldownSource =
  (typeof CooldownSource)[keyof typeof CooldownSource];
export const COOLDOWN_SOURCES: readonly CooldownSource[] = [
  CooldownSource.Live,
  CooldownSource.Demo,
];

export function isCooldownPendingStatus(v: unknown): v is CooldownPendingStatus {
  return (
    typeof v === "string" &&
    (COOLDOWN_PENDING_STATUSES as readonly string[]).includes(v)
  );
}

export function isCooldownDataStatus(v: unknown): v is CooldownDataStatus {
  return (
    typeof v === "string" &&
    (COOLDOWN_DATA_STATUSES as readonly string[]).includes(v)
  );
}

export function isCooldownSource(v: unknown): v is CooldownSource {
  return (
    typeof v === "string" && (COOLDOWN_SOURCES as readonly string[]).includes(v)
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// view / response
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 解除待ちを持つ staking position の読取専用 view (§3 CooldownPositionView)。
 * 取得できない量は null。`available_actions` は R0 では常に空。
 */
export interface CooldownPositionView {
  kind: "cooldown_position";

  // ── scope 識別子 ──
  source: CooldownSource;
  cluster: string;
  wallet_address: string;
  protocol_id: string;
  /** UserStake 等の position account (PDA) */
  position_account: string;
  /** 対象 pool (SKR は Guardian Delegation Pool) */
  pool: string;

  // ── asset ──
  asset_mint: string;
  asset_symbol: string;
  asset_decimals: number;

  // ── 量 (smallest unit / raw 整数の 10 進 string) ──
  /** 本人の shares (u128) */
  shares: string | null;
  /** 観測時点の share price (u128、scale は share_price_scale) */
  share_price: string | null;
  share_price_scale: string;
  /** floor(shares × share_price / scale)。推定値 (UI は「推定」と表示する) */
  active_amount_estimate: string | null;
  /** 解除待ちの token 量 (smallest unit)。pending が無ければ "0" */
  pending_amount: string | null;

  // ── 時刻 ──
  /** 解除開始の unix 秒 (signed、10 進 string) */
  unstake_timestamp: string | null;
  /** 適用 cooldown 秒 (config から毎回読む) */
  cooldown_seconds: string | null;
  /** 解除終了予定 (UTC ISO 8601) */
  unlock_at: string | null;
  pending_status: CooldownPendingStatus;

  // ── 観測 ──
  data_status: CooldownDataStatus;
  observed_at: string | null;
  /** 同 batch の Clock.unix_timestamp (signed 秒の 10 進 string) */
  chain_time: string | null;
  slot: number | null;

  // ── R0 では取得しない (literal null。Position へ代入させないための型上の壁でもある) ──
  principal_amount: null;
  accrued_yield_amount: null;
  unit_price_usd: null;
  unit_price_sol: null;
  deposited_at: null;
  available_actions: readonly [];
}

/** wallet が直接持つ (stake していない) token の合算。staking 判定とは独立 */
export interface CooldownLiquidView {
  amount: string | null;
  slot: number | null;
  observed_at: string | null;
  data_status: CooldownDataStatus;
}

/**
 * 現在の pending に対応する lockup_end event と、その予定キー。
 * schedule_revision は BFF が生成し、Mobile は再計算せず比較だけする (§3)。
 */
export interface CooldownEventDTO {
  event: UnifiedTimeEventDTO;
  schedule_revision: string;
}

/** `GET /protocols/skr-staking/state` の body (§3「APIのdata部分」) */
export interface CooldownStateResponse {
  schema_version: typeof COOLDOWN_SCHEMA_VERSION;
  source: CooldownSource;
  cluster: string;
  wallet_address: string;
  protocol_id: string;
  position_account: string;
  pool: string;
  commitment: "confirmed";
  observed_at: string | null;
  slot: number | null;
  chain_time: string | null;
  data_status: CooldownDataStatus;
  coverage: "configured_pool_only";
  position: CooldownPositionView | null;
  liquid: CooldownLiquidView;
  events: CooldownEventDTO[];
}

// ─────────────────────────────────────────────────────────────────────────────
// 端末確認通知 payload (§5)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 確認通知の data。金額 / ready / 外部 URL / plan / token を **含めない**。
 * tap 時は scope を照合してから BFF を再取得するだけ (署名・wallet 操作はしない)。
 */
export interface CooldownReminderPayload {
  type: "cooldown_reminder";
  schema_version: typeof COOLDOWN_SCHEMA_VERSION;
  source: CooldownSource;
  cluster: string;
  wallet_address: string;
  protocol_id: string;
  position_account: string;
  event_id: string;
  schedule_revision: string;
}

/** payload の全 key (test で「余計な欄が無い」ことの検査に使う) */
export const COOLDOWN_REMINDER_PAYLOAD_KEYS: readonly (keyof CooldownReminderPayload)[] = [
  "type",
  "schema_version",
  "source",
  "cluster",
  "wallet_address",
  "protocol_id",
  "position_account",
  "event_id",
  "schedule_revision",
];

// ─────────────────────────────────────────────────────────────────────────────
// runtime guards
// ─────────────────────────────────────────────────────────────────────────────

type Rec = Record<string, unknown>;

function isRecord(v: unknown): v is Rec {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function isStringOrNull(v: unknown): v is string | null {
  return v === null || typeof v === "string";
}

function isAmountOrNull(v: unknown): v is string | null {
  return v === null || (typeof v === "string" && isValidTokenAmount(v));
}

function isSignedIntStringOrNull(v: unknown): v is string | null {
  return v === null || (typeof v === "string" && /^-?[0-9]+$/.test(v));
}

function isSlotOrNull(v: unknown): v is number | null {
  return (
    v === null || (typeof v === "number" && Number.isSafeInteger(v) && v >= 0)
  );
}

function isIsoOrNull(v: unknown): v is string | null {
  return v === null || (typeof v === "string" && !Number.isNaN(Date.parse(v)));
}

function isUnifiedTimeEventDTOShape(v: unknown): v is UnifiedTimeEventDTO {
  if (!isRecord(v)) return false;
  return (
    isNonEmptyString(v.id) &&
    isNonEmptyString(v.protocol) &&
    isTimeEventCategory(v.category) &&
    typeof v.triggerAt === "string" &&
    !Number.isNaN(Date.parse(v.triggerAt)) &&
    isUrgency(v.urgency) &&
    isNonEmptyString(v.walletAddress) &&
    isStringOrNull(v.positionRef) &&
    Array.isArray(v.actions) &&
    typeof v.agentReadable === "boolean" &&
    isRecord(v.metadata)
  );
}

export function isCooldownEventDTO(v: unknown): v is CooldownEventDTO {
  return (
    isRecord(v) &&
    isUnifiedTimeEventDTOShape(v.event) &&
    isNonEmptyString(v.schedule_revision)
  );
}

export function isCooldownPositionView(v: unknown): v is CooldownPositionView {
  if (!isRecord(v)) return false;
  return (
    v.kind === "cooldown_position" &&
    isCooldownSource(v.source) &&
    isNonEmptyString(v.cluster) &&
    isNonEmptyString(v.wallet_address) &&
    isNonEmptyString(v.protocol_id) &&
    isNonEmptyString(v.position_account) &&
    isNonEmptyString(v.pool) &&
    isNonEmptyString(v.asset_mint) &&
    isNonEmptyString(v.asset_symbol) &&
    typeof v.asset_decimals === "number" &&
    Number.isInteger(v.asset_decimals) &&
    isAmountOrNull(v.shares) &&
    isAmountOrNull(v.share_price) &&
    typeof v.share_price_scale === "string" &&
    isValidTokenAmount(v.share_price_scale) &&
    isAmountOrNull(v.active_amount_estimate) &&
    isAmountOrNull(v.pending_amount) &&
    isSignedIntStringOrNull(v.unstake_timestamp) &&
    isAmountOrNull(v.cooldown_seconds) &&
    isIsoOrNull(v.unlock_at) &&
    isCooldownPendingStatus(v.pending_status) &&
    isCooldownDataStatus(v.data_status) &&
    isIsoOrNull(v.observed_at) &&
    isSignedIntStringOrNull(v.chain_time) &&
    isSlotOrNull(v.slot) &&
    v.principal_amount === null &&
    v.accrued_yield_amount === null &&
    v.unit_price_usd === null &&
    v.unit_price_sol === null &&
    v.deposited_at === null &&
    Array.isArray(v.available_actions) &&
    v.available_actions.length === 0
  );
}

function isCooldownLiquidView(v: unknown): v is CooldownLiquidView {
  return (
    isRecord(v) &&
    isAmountOrNull(v.amount) &&
    isSlotOrNull(v.slot) &&
    isIsoOrNull(v.observed_at) &&
    isCooldownDataStatus(v.data_status)
  );
}

/** BFF response の runtime 検査 (Mobile は不合格を error 扱いにし、旧データを stale で残す) */
export function isCooldownStateResponse(v: unknown): v is CooldownStateResponse {
  if (!isRecord(v)) return false;
  return (
    v.schema_version === COOLDOWN_SCHEMA_VERSION &&
    isCooldownSource(v.source) &&
    isNonEmptyString(v.cluster) &&
    isNonEmptyString(v.wallet_address) &&
    isNonEmptyString(v.protocol_id) &&
    isNonEmptyString(v.position_account) &&
    isNonEmptyString(v.pool) &&
    v.commitment === "confirmed" &&
    isIsoOrNull(v.observed_at) &&
    isSlotOrNull(v.slot) &&
    isSignedIntStringOrNull(v.chain_time) &&
    isCooldownDataStatus(v.data_status) &&
    v.coverage === "configured_pool_only" &&
    (v.position === null || isCooldownPositionView(v.position)) &&
    isCooldownLiquidView(v.liquid) &&
    Array.isArray(v.events) &&
    v.events.every(isCooldownEventDTO)
  );
}

/** 通知 tap の data 検査。必須欄が全部そろい、型が正しい時だけ true */
export function isCooldownReminderPayload(
  v: unknown
): v is CooldownReminderPayload {
  if (!isRecord(v)) return false;
  return (
    v.type === "cooldown_reminder" &&
    v.schema_version === COOLDOWN_SCHEMA_VERSION &&
    isCooldownSource(v.source) &&
    isNonEmptyString(v.cluster) &&
    isNonEmptyString(v.wallet_address) &&
    isNonEmptyString(v.protocol_id) &&
    isNonEmptyString(v.position_account) &&
    isNonEmptyString(v.event_id) &&
    isNonEmptyString(v.schedule_revision)
  );
}
