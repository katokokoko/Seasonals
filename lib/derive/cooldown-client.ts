/**
 * Cooldown state の client 側規則 (docs/skr-r0-implementation.md §3「鮮度とcache」/ §5)
 *
 * Mobile (Seeker) が使う純粋関数。web 等の後続 client も同じ規則をなぞる。
 * - fresh = 今回の read 検証が成功した観測値。表示期限 300 秒、復帰 / 再取得失敗で stale
 * - scope (wallet / source / cluster) が違う応答・slot が後退した応答で上書きしない
 * - fresh を持っている時に unavailable / unsupported が来ても「取消済み」と解釈しない (旧値を stale で残す)
 * - 境界 retry: 終了予定に 1 回 + 15→30→60→120→300→600 秒、最大 6 回、境界から 20 分以内
 */

import {
  CooldownDataStatus,
  type CooldownSource,
  type CooldownStateResponse,
} from "../types/cooldown-position";

export const COOLDOWN_FRESH_WINDOW_MS = 300_000;
export const COOLDOWN_POLL_INTERVAL_MS = 300_000;
export const COOLDOWN_BOUNDARY_RETRY_DELAYS_S: readonly number[] = [15, 30, 60, 120, 300, 600];
export const COOLDOWN_BOUNDARY_RETRY_MAX = 6;
export const COOLDOWN_BOUNDARY_RETRY_WINDOW_MS = 20 * 60_000;

export type CooldownFreshness =
  | "loading"
  | "fresh"
  | "stale"
  | "unavailable"
  | "unsupported";

export interface CooldownFreshnessInput {
  /** 最後に受け入れた response (無ければ undefined) */
  state: CooldownStateResponse | undefined;
  /** state を受け入れた時刻 (ms)。0 = 未取得 */
  dataUpdatedAt: number;
  /** 最後に失敗した時刻 (ms)。0 = 失敗なし */
  errorUpdatedAt: number;
  /** 判定時刻 (ms) */
  nowMs: number;
  /** app が foreground に戻った時刻 (ms)。戻ってから再取得が終わるまでは stale */
  resumedAtMs?: number | null;
}

export function classifyCooldownFreshness(input: CooldownFreshnessInput): CooldownFreshness {
  const { state, dataUpdatedAt, errorUpdatedAt, nowMs, resumedAtMs } = input;
  if (!state) return errorUpdatedAt > 0 ? "unavailable" : "loading";
  if (state.data_status === CooldownDataStatus.Unavailable) return "unavailable";
  if (state.data_status === CooldownDataStatus.Unsupported) return "unsupported";
  if (errorUpdatedAt > dataUpdatedAt) return "stale";
  if (resumedAtMs != null && resumedAtMs > dataUpdatedAt) return "stale";
  if (nowMs - dataUpdatedAt > COOLDOWN_FRESH_WINDOW_MS) return "stale";
  return "fresh";
}

export interface CooldownRequestedScope {
  source: CooldownSource;
  cluster: string;
  wallet_address: string;
}

export type CooldownAcceptance =
  | { ok: true }
  | { ok: false; reason: "scope_mismatch" | "slot_regression" | "not_fresh" };

/**
 * 新しい response で cache を置き換えてよいか。
 * 拒否した場合、呼出側は旧 state を残したまま error にする (= stale 表示)。
 */
export function shouldAcceptCooldownResponse(
  prev: CooldownStateResponse | undefined,
  next: CooldownStateResponse,
  requested: CooldownRequestedScope
): CooldownAcceptance {
  if (
    next.wallet_address !== requested.wallet_address ||
    next.source !== requested.source ||
    next.cluster !== requested.cluster
  ) {
    return { ok: false, reason: "scope_mismatch" };
  }
  if (!prev) return { ok: true };
  const sameScope =
    prev.wallet_address === next.wallet_address &&
    prev.source === next.source &&
    prev.cluster === next.cluster;
  if (!sameScope) return { ok: true };
  if (prev.data_status === CooldownDataStatus.Fresh && next.data_status !== CooldownDataStatus.Fresh) {
    return { ok: false, reason: "not_fresh" };
  }
  if (prev.slot !== null && next.slot !== null && next.slot < prev.slot) {
    return { ok: false, reason: "slot_regression" };
  }
  return { ok: true };
}

/**
 * 境界 retry の次の待ち時間 (ms)。null = もう retry しない。
 * @param attempt 既に行った retry 回数 (境界ちょうどの 1 回は数えない)
 * @param elapsedSinceBoundaryMs 終了予定時刻からの経過
 */
export function nextBoundaryRetryDelayMs(
  attempt: number,
  elapsedSinceBoundaryMs: number
): number | null {
  if (attempt < 0 || attempt >= COOLDOWN_BOUNDARY_RETRY_MAX) return null;
  const delaySec = COOLDOWN_BOUNDARY_RETRY_DELAYS_S[attempt];
  if (delaySec === undefined) return null;
  const delayMs = delaySec * 1000;
  if (elapsedSinceBoundaryMs + delayMs > COOLDOWN_BOUNDARY_RETRY_WINDOW_MS) return null;
  return delayMs;
}
