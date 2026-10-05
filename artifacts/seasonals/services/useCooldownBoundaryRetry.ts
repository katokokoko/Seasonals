/**
 * useCooldownBoundaryRetry — 表示中の SKR 予定に境界 retry を付ける (docs/skr-r0-implementation.md §5)
 * controller は HomeScreen の mount 中だけ生きる (メモリのみ、永続化しない)。
 */
import { useEffect, useMemo, useRef } from "react";
import { AppState } from "react-native";

import { cooldownScheduleKey } from "@workspace/lib/derive/cooldown-position";
import { CooldownDataStatus } from "@workspace/lib/types";

import { createBoundaryRetryController, type BoundaryTarget } from "./cooldown-boundary-retry";
import type { SkrStakingView } from "./useSkrStakingView";

export function boundaryTargetOf(view: SkrStakingView): BoundaryTarget | null {
  const { scope, state } = view;
  if (!scope || !state || state.data_status !== CooldownDataStatus.Fresh) return null;
  const e = state.events[0];
  const status = state.position?.pending_status;
  if (!e || !status) return null;
  const unlockAtMs = Date.parse(e.event.triggerAt);
  if (!Number.isFinite(unlockAtMs)) return null;
  return {
    scheduleKey: cooldownScheduleKey(scope, e.event.id, e.schedule_revision),
    unlockAtMs,
    pendingStatus: status,
  };
}

export function useCooldownBoundaryRetry(view: SkrStakingView): void {
  const refetchRef = useRef(view.refetch);
  refetchRef.current = view.refetch;

  const controller = useMemo(
    () =>
      createBoundaryRetryController({
        refetch: () => refetchRef.current(),
        now: () => Date.now(),
        isForeground: () => AppState.currentState === "active",
        setTimeout: (fn, ms) => setTimeout(fn, ms),
        clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      }),
    []
  );

  useEffect(() => () => controller.dispose(), [controller]);

  const target = boundaryTargetOf(view);
  const key = target?.scheduleKey ?? null;
  const unlockAtMs = target?.unlockAtMs ?? null;
  const status = target?.pendingStatus ?? null;
  useEffect(() => {
    controller.observe(
      key !== null && unlockAtMs !== null && status !== null
        ? { scheduleKey: key, unlockAtMs, pendingStatus: status }
        : null
    );
  }, [controller, key, unlockAtMs, status]);
}
