/**
 * useSkrStakingView — SKR cooldown の表示用 state (docs/skr-r0-implementation.md §3「鮮度とcache」)
 *
 * HomeScreen が 1 つだけ持ち、Calendar の event / Staking row / 確認通知 / 境界 retry に渡す。
 * - freshness は lib/derive/cooldown-client.ts の規則 (300 秒、復帰 / 再取得失敗で stale)
 * - 30 秒 tick で 300 秒境界を表示に反映する
 * - app が foreground に戻った時刻を記録し、再取得が終わるまで stale にする
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { AppState, type AppStateStatus } from "react-native";

import { SKR_STAKING_CLUSTER } from "@workspace/lib/config/skr-staking";
import {
  classifyCooldownFreshness,
  type CooldownFreshness,
} from "@workspace/lib/derive/cooldown-client";
import type { CooldownScopeIdentity } from "@workspace/lib/derive/cooldown-position";
import type { CooldownStateResponse } from "@workspace/lib/types";

import { SKR_SOURCE } from "./config";
import { useSkrStakingState } from "./queries";

export const SKR_VIEW_TICK_MS = 30_000;

export interface SkrStakingView {
  /** 読んでいる wallet (未接続なら null) */
  address: string | null;
  scope: CooldownScopeIdentity | null;
  /** 最後に受け入れた response (stale でも残る) */
  state: CooldownStateResponse | undefined;
  freshness: CooldownFreshness;
  /** state の観測時刻 (UTC ISO) */
  observedAt: string | null;
  isFetching: boolean;
  /** BFF を再取得する (tap / 手動 refresh / 境界 retry) */
  refetch: () => Promise<unknown>;
}

export function useSkrStakingView(address: string | null): SkrStakingView {
  const q = useSkrStakingState(address);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [resumedAtMs, setResumedAtMs] = useState<number | null>(null);

  useEffect(() => {
    if (!address) return;
    const id = setInterval(() => setNowMs(Date.now()), SKR_VIEW_TICK_MS);
    return () => clearInterval(id);
  }, [address]);

  useEffect(() => {
    let prev: AppStateStatus = AppState.currentState;
    const sub = AppState.addEventListener("change", (next) => {
      if (next === "active" && prev !== "active") {
        const t = Date.now();
        setResumedAtMs(t);
        setNowMs(t);
      }
      prev = next;
    });
    return () => sub.remove();
  }, []);

  const { refetch: queryRefetch } = q;
  const refetch = useCallback(() => queryRefetch(), [queryRefetch]);

  const scope = useMemo<CooldownScopeIdentity | null>(
    () =>
      address
        ? { source: SKR_SOURCE, cluster: SKR_STAKING_CLUSTER, wallet_address: address }
        : null,
    [address]
  );

  const state = address ? q.data : undefined;
  const freshness: CooldownFreshness = address
    ? classifyCooldownFreshness({
        state,
        dataUpdatedAt: q.dataUpdatedAt,
        errorUpdatedAt: q.errorUpdatedAt,
        nowMs: Math.max(nowMs, q.dataUpdatedAt),
        resumedAtMs,
      })
    : "loading";

  // PortfolioSummary (React.memo) の月送り再レンダー抑止 (8.84) を壊さないよう identity を保つ
  const isFetching = q.isFetching;
  return useMemo(
    () => ({
      address,
      scope,
      state,
      freshness,
      observedAt: state?.observed_at ?? null,
      isFetching,
      refetch,
    }),
    [address, scope, state, freshness, isFetching, refetch]
  );
}
