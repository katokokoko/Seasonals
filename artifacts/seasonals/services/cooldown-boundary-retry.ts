/**
 * 終了予定の境界 retry (docs/skr-r0-implementation.md §5、R0-09)
 *
 * - 終了予定に foreground なら 1 回再取得し、まだ ready でなければ 15→30→60→120→300→600 秒、
 *   最大 6 回 (境界から 20 分以内) の追加 retry。RPC 失敗も回数を使う
 * - 予定変更 (schedule_revision / id) や取消で旧 retry を止める。ready を観測したら止める
 * - 状態はメモリだけ。同じ app 起動中に同じ予定の retry は再開しない
 * - 観測時点で境界が既に過ぎていたら何もしない (cold start / 背景中の境界は通常の read / poll に任せる)
 */
import { nextBoundaryRetryDelayMs } from "@workspace/lib/derive/cooldown-client";
import { CooldownPendingStatus, type CooldownPendingStatus as PendingStatus } from "@workspace/lib/types";

export interface BoundaryTarget {
  scheduleKey: string;
  unlockAtMs: number;
  pendingStatus: PendingStatus;
}

export interface BoundaryRetryDeps {
  refetch: () => unknown;
  now: () => number;
  isForeground: () => boolean;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

export interface BoundaryRetryController {
  observe(target: BoundaryTarget | null): void;
  dispose(): void;
  /** test / 観測用: 境界 fetch + retry で refetch した回数 (現在の予定) */
  readonly attempts: number;
}

export function createBoundaryRetryController(deps: BoundaryRetryDeps): BoundaryRetryController {
  const consumed = new Set<string>();
  let currentKey: string | null = null;
  let timer: unknown = null;
  let attempts = 0;
  let boundaryAt = 0;
  let retryIndex = 0;

  const clear = () => {
    if (timer !== null) deps.clearTimeout(timer);
    timer = null;
  };

  const scheduleNextRetry = () => {
    const delay = nextBoundaryRetryDelayMs(retryIndex, deps.now() - boundaryAt);
    if (delay === null) {
      timer = null;
      return;
    }
    timer = deps.setTimeout(() => {
      timer = null;
      retryIndex += 1;
      attempts += 1;
      void deps.refetch();
      scheduleNextRetry();
    }, delay);
  };

  const onBoundary = () => {
    timer = null;
    if (!deps.isForeground()) return; // 背景中の境界は復帰時の read に任せる
    attempts += 1;
    void deps.refetch();
    retryIndex = 0;
    scheduleNextRetry();
  };

  return {
    observe(target) {
      // 取消 / 切断 / pending なし
      if (target === null || target.pendingStatus === CooldownPendingStatus.None) {
        clear();
        currentKey = null;
        return;
      }
      // 同じ予定で ready を観測 → 終了
      if (target.scheduleKey === currentKey) {
        if (target.pendingStatus === CooldownPendingStatus.Ready) clear();
        return;
      }
      // 予定が変わった: 旧 retry を止める
      clear();
      currentKey = target.scheduleKey;
      attempts = 0;
      retryIndex = 0;
      if (target.pendingStatus !== CooldownPendingStatus.CoolingDown) return;
      if (consumed.has(target.scheduleKey)) return; // 同じ起動中は再開しない
      const wait = target.unlockAtMs - deps.now();
      if (wait <= 0) return; // 過去の境界は復元しない
      consumed.add(target.scheduleKey);
      boundaryAt = target.unlockAtMs;
      timer = deps.setTimeout(onBoundary, wait);
    },
    dispose() {
      clear();
      currentKey = null;
    },
    get attempts() {
      return attempts;
    },
  };
}
