/**
 * useCooldownReminderSync — SKR 確認通知の予約を表示中の state に合わせる (docs/skr-r0-implementation.md §5)
 *
 * - fresh な state が来るたびに予約を同期 (同じ予定なら何もしない)
 * - 切断 (接続していた wallet が null になった時) は旧予約を取消す。
 *   cold start で wallet 復元前の null は切断ではないので取消さない
 * - 通知 tap (cold start / warm) は scope が一致すれば BFF を再取得
 */
import { useEffect, useRef } from "react";

import {
  handleCooldownReminderTap,
  onCooldownReminderTap,
  setActiveCooldownScope,
  syncCooldownReminder,
} from "./cooldown-reminder";
import type { SkrStakingView } from "./useSkrStakingView";

export function useCooldownReminderSync(view: SkrStakingView): void {
  const { scope, state, freshness, refetch } = view;
  const hadScope = useRef(false);

  useEffect(() => {
    setActiveCooldownScope(scope);
  }, [scope]);

  useEffect(() => {
    if (scope) {
      hadScope.current = true;
      void syncCooldownReminder({ scope, state, freshness, nowMs: Date.now() }).catch(() => undefined);
    } else if (hadScope.current) {
      hadScope.current = false;
      void syncCooldownReminder({ scope: null, state: undefined, freshness, nowMs: Date.now() }).catch(
        () => undefined
      );
    }
  }, [scope, state, freshness]);

  useEffect(
    () =>
      onCooldownReminderTap((payload) => {
        handleCooldownReminderTap(payload, scope, refetch);
      }),
    [scope, refetch]
  );
}
