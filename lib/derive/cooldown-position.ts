/**
 * Cooldown position の純粋導出 (docs/skr-r0-implementation.md §3「状態」「schedule_revision」)
 *
 * BFF が chain から decode した値 (10 進 string) を受け取り、
 * `CooldownPositionView` / `lockup_end` event / `schedule_revision` を組み立てる。
 * BFF / MCP / Mobile の test fixture も同じ関数で作るので、3 者の event が一致する。
 *
 * 規則:
 * - pending = 解除待ち token 量 > 0。active (shares) とは独立
 * - unlock_at = unstake_timestamp + cooldown_seconds (config から毎回読んだ値)
 * - ready は **同 batch の chain Clock** >= unlock_at の時だけ。端末時刻・サーバ時刻を使わない
 * - config 不明時に 48 時間や share_price=1 で補わない (呼出側が unsupported にする)
 * - event は現在の pending につき 1 件。pending=0 / unlock_at 不明なら 0 件
 * - event id は時刻を含めない (次の解除でも同じ id)。予定の変化は schedule_revision で表す
 * - metadata は source / observed_at / slot / pending_status だけ (量・価格・raw account を入れない)
 *
 * Node 専用 API (Buffer 等) は使わない (Mobile からも import される)。
 */

import {
  COOLDOWN_SCHEMA_VERSION,
  CooldownDataStatus,
  CooldownPendingStatus,
  type CooldownEventDTO,
  type CooldownLiquidView,
  type CooldownPositionView,
  type CooldownSource,
  type CooldownStateResponse,
} from "../types/cooldown-position";
import { TimeEventCategory, Urgency } from "../types/enums";
import type { UnifiedTimeEventDTO } from "../types/unified-time-event";
import { fromBigInt, toBigInt } from "../utils/numeric";
import { proximityUrgency } from "./derive-time-events";

// ─────────────────────────────────────────────────────────────────────────────
// 整数範囲 (on-chain の u64 / u128 / i64 を string のまま検査する)
// ─────────────────────────────────────────────────────────────────────────────

export const U64_MAX = (1n << 64n) - 1n;
export const U128_MAX = (1n << 128n) - 1n;
export const I64_MIN = -(1n << 63n);
export const I64_MAX = (1n << 63n) - 1n;

/** JS Date で表せる最大秒 (±8.64e15 ms) */
const MAX_DATE_SECONDS = 8_640_000_000_000n;

function assertUnsignedInRange(v: string, max: bigint, label: string): bigint {
  const n = toBigInt(v); // ^[0-9]+$ でなければ InvalidAmountError
  if (n > max) throw new RangeError(`${label} out of range: ${v}`);
  return n;
}

export function assertU64String(v: string): bigint {
  return assertUnsignedInRange(v, U64_MAX, "u64");
}

export function assertU128String(v: string): bigint {
  return assertUnsignedInRange(v, U128_MAX, "u128");
}

export function assertI64String(v: string): bigint {
  if (!/^-?[0-9]+$/.test(v)) throw new RangeError(`i64 invalid: ${v}`);
  const n = BigInt(v);
  if (n < I64_MIN || n > I64_MAX) throw new RangeError(`i64 out of range: ${v}`);
  return n;
}

// ─────────────────────────────────────────────────────────────────────────────
// 識別子 / 予定キー
// ─────────────────────────────────────────────────────────────────────────────

/** `lockup_end:<cluster>:<protocol_id>:<wallet>:<position_account>` (時刻を含めない) */
export function cooldownEventId(
  cluster: string,
  protocolId: string,
  wallet: string,
  positionAccount: string
): string {
  return `${TimeEventCategory.LockupEnd}:${cluster}:${protocolId}:${wallet}:${positionAccount}`;
}

/**
 * `"v1:" + unstake_timestamp + ":" + cooldown_seconds`。
 * 他人の操作 (vault 残高 / pool 総 shares / share_price) や Clock の進行では変わらず、
 * 本人の追加解除 (timestamp 更新) か適用 cooldown の変更でだけ変わる。
 */
export function scheduleRevision(unstakeTimestamp: string, cooldownSeconds: string): string {
  return `v1:${assertI64String(unstakeTimestamp).toString()}:${assertU64String(cooldownSeconds).toString()}`;
}

export interface CooldownScopeIdentity {
  source: CooldownSource;
  cluster: string;
  wallet_address: string;
}

/** wallet / source / cluster の切替判定用 */
export function cooldownScopeKey(scope: CooldownScopeIdentity): string {
  return `${scope.source}|${scope.cluster}|${scope.wallet_address}`;
}

/** 比較キー = source + cluster + wallet + event_id + schedule_revision (§3) */
export function cooldownScheduleKey(
  scope: CooldownScopeIdentity,
  eventId: string,
  revision: string
): string {
  return `${cooldownScopeKey(scope)}|${eventId}|${revision}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 状態
// ─────────────────────────────────────────────────────────────────────────────

/** unlock_at (秒)。範囲外・不正値なら null (呼出側は pending_status=unknown) */
export function computeUnlockAtSeconds(
  unstakeTimestamp: string,
  cooldownSeconds: string
): bigint | null {
  let ts: bigint;
  let cd: bigint;
  try {
    ts = assertI64String(unstakeTimestamp);
    cd = assertU64String(cooldownSeconds);
  } catch {
    return null;
  }
  if (ts <= 0n) return null; // pending があるのに解除時刻が無い = 読めない状態
  const unlock = ts + cd;
  if (unlock > MAX_DATE_SECONDS) return null;
  return unlock;
}

export function secondsToIso(seconds: bigint): string {
  // 秒 (時刻) は金融値ではない。Date 範囲は computeUnlockAtSeconds で検査済み
  return new Date(Number(seconds) * 1000).toISOString();
}

export function computePendingStatus(
  pendingAmount: bigint,
  unlockAtSeconds: bigint | null,
  chainTimeSeconds: bigint
): CooldownPendingStatus {
  if (pendingAmount === 0n) return CooldownPendingStatus.None;
  if (unlockAtSeconds === null) return CooldownPendingStatus.Unknown;
  return chainTimeSeconds >= unlockAtSeconds
    ? CooldownPendingStatus.Ready
    : CooldownPendingStatus.CoolingDown;
}

/** floor(shares × share_price / scale)。推定値 (bigint で計算、精度を落とさない) */
export function computeActiveAmountEstimate(
  shares: string,
  sharePrice: string,
  scale: string
): string {
  const s = assertU128String(shares);
  const p = assertU128String(sharePrice);
  const k = toBigInt(scale);
  if (k === 0n) throw new RangeError("share price scale must be > 0");
  return fromBigInt((s * p) / k);
}

// ─────────────────────────────────────────────────────────────────────────────
// view / event / response
// ─────────────────────────────────────────────────────────────────────────────

export interface CooldownScope extends CooldownScopeIdentity {
  protocol_id: string;
  position_account: string;
  pool: string;
}

export interface CooldownAsset {
  mint: string;
  symbol: string;
  decimals: number;
}

/** 本人 position の decode 済み値 (SKR では UserStake) */
export interface CooldownUserState {
  /** u128 */
  shares: string;
  /** u64、解除待ち token 量 */
  pending_amount: string;
  /** i64、解除開始の unix 秒 */
  unstake_timestamp: string;
}

export interface CooldownDeriveInput {
  scope: CooldownScope;
  asset: CooldownAsset;
  /** share price の scale (SKR は 1e9) */
  share_price_scale: string;
  /** config から読んだ現在値 */
  config: { cooldown_seconds: string; share_price: string };
  /** 同 batch の観測 */
  observed_at: string;
  slot: number;
  /** 同 batch の Clock.unix_timestamp */
  chain_time: string;
  /** null = 正常な account 不在 (stake したことが無い / close 済み) */
  user: CooldownUserState | null;
}

/** 本人 position の view。account 不在なら null (正常な空状態) */
export function deriveCooldownPosition(input: CooldownDeriveInput): CooldownPositionView | null {
  const { scope, asset, config, user } = input;
  if (user === null) return null;

  const pending = assertU64String(user.pending_amount);
  const chainTime = assertI64String(input.chain_time);
  const cooldown = assertU64String(config.cooldown_seconds);
  const unlockAt =
    pending > 0n ? computeUnlockAtSeconds(user.unstake_timestamp, config.cooldown_seconds) : null;
  const status = computePendingStatus(pending, unlockAt, chainTime);

  return {
    kind: "cooldown_position",
    source: scope.source,
    cluster: scope.cluster,
    wallet_address: scope.wallet_address,
    protocol_id: scope.protocol_id,
    position_account: scope.position_account,
    pool: scope.pool,
    asset_mint: asset.mint,
    asset_symbol: asset.symbol,
    asset_decimals: asset.decimals,
    shares: fromBigInt(assertU128String(user.shares)),
    share_price: fromBigInt(assertU128String(config.share_price)),
    share_price_scale: input.share_price_scale,
    active_amount_estimate: computeActiveAmountEstimate(
      user.shares,
      config.share_price,
      input.share_price_scale
    ),
    pending_amount: fromBigInt(pending),
    unstake_timestamp: pending > 0n ? assertI64String(user.unstake_timestamp).toString() : null,
    cooldown_seconds: cooldown.toString(),
    unlock_at: unlockAt === null ? null : secondsToIso(unlockAt),
    pending_status: status,
    data_status: CooldownDataStatus.Fresh,
    observed_at: input.observed_at,
    chain_time: chainTime.toString(),
    slot: input.slot,
    principal_amount: null,
    accrued_yield_amount: null,
    unit_price_usd: null,
    unit_price_sol: null,
    deposited_at: null,
    available_actions: [],
  };
}

/** 現在の pending に対応する lockup_end event (0 または 1 件) */
export function deriveCooldownEvents(view: CooldownPositionView | null): CooldownEventDTO[] {
  if (view === null) return [];
  if (
    view.pending_status !== CooldownPendingStatus.CoolingDown &&
    view.pending_status !== CooldownPendingStatus.Ready
  ) {
    return [];
  }
  if (view.unlock_at === null || view.unstake_timestamp === null || view.cooldown_seconds === null || view.chain_time === null) {
    return [];
  }

  const unlockAt = new Date(view.unlock_at);
  const chainNow = secondsToIso(assertI64String(view.chain_time));
  // ready は期限切れの Critical にしない (§4)。待機中は既存 lockup_end と同じ距離の閾値
  const urgency =
    view.pending_status === CooldownPendingStatus.Ready
      ? Urgency.Watch
      : proximityUrgency(unlockAt, new Date(chainNow));

  const event: UnifiedTimeEventDTO = {
    id: cooldownEventId(view.cluster, view.protocol_id, view.wallet_address, view.position_account),
    protocol: view.protocol_id,
    category: TimeEventCategory.LockupEnd,
    triggerAt: view.unlock_at,
    urgency,
    walletAddress: view.wallet_address,
    positionRef: null,
    actions: [],
    agentReadable: true,
    metadata: {
      source: view.source,
      observed_at: view.observed_at,
      slot: view.slot,
      pending_status: view.pending_status,
    },
  };
  return [
    {
      event,
      schedule_revision: scheduleRevision(view.unstake_timestamp, view.cooldown_seconds),
    },
  ];
}

function baseResponse(
  scope: CooldownScope,
  liquid: CooldownLiquidView
): Omit<CooldownStateResponse, "observed_at" | "slot" | "chain_time" | "data_status" | "position" | "events"> {
  return {
    schema_version: COOLDOWN_SCHEMA_VERSION,
    source: scope.source,
    cluster: scope.cluster,
    wallet_address: scope.wallet_address,
    protocol_id: scope.protocol_id,
    position_account: scope.position_account,
    pool: scope.pool,
    commitment: "confirmed",
    coverage: "configured_pool_only",
    liquid,
  };
}

/** 検証済み batch から fresh response を組む */
export function freshCooldownState(
  input: CooldownDeriveInput,
  liquid: CooldownLiquidView
): CooldownStateResponse {
  const position = deriveCooldownPosition(input);
  return {
    ...baseResponse(input.scope, liquid),
    observed_at: input.observed_at,
    slot: input.slot,
    chain_time: assertI64String(input.chain_time).toString(),
    data_status: CooldownDataStatus.Fresh,
    position,
    events: deriveCooldownEvents(position),
  };
}

/** 読取失敗 (unavailable) / 検証失敗 (unsupported)。偽の量・日付・event を作らない */
export function failedCooldownState(
  scope: CooldownScope,
  status: typeof CooldownDataStatus.Unavailable | typeof CooldownDataStatus.Unsupported,
  liquid: CooldownLiquidView
): CooldownStateResponse {
  return {
    ...baseResponse(scope, liquid),
    observed_at: null,
    slot: null,
    chain_time: null,
    data_status: status,
    position: null,
    events: [],
  };
}

export const LIQUID_UNAVAILABLE: CooldownLiquidView = {
  amount: null,
  slot: null,
  observed_at: null,
  data_status: CooldownDataStatus.Unavailable,
};
