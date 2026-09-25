import { useEffect, useMemo, useState } from "react";

/**
 * 現在時刻。interval ごと + dep (データ更新) ごとに更新する。
 * status (upcoming / due / overdue) は render 時に導出するため (Ethereum v3 §4)、
 * mount 時刻で固定すると「今 claim できる」event が upcoming に見えてしまう。
 */
export function useNow(dep?: unknown, intervalMs = 30_000): Date {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => new Date(), [tick, dep]);
}
