/**
 * useWalletQuerySync — wallet の接続遷移に合わせて wallet 系クエリを取り直す / 消す
 * (Phase 8.77 → API 効率化計画 §4.0 で再設計)
 *
 * 8.77 の問題: 再接続 (disconnect → 同じ wallet で connect) は query key が元に戻る
 * だけなので、staleTime の間はキャッシュがそのまま返り「再接続してもグラフと
 * カレンダーが変わらない」。8.77 はこれを prefix (`["positions"]` 等) の invalidate で
 * 直したが、**他 wallet の cache と fixture key まで**、しかも切断時にも取り直していた。
 *
 * §4.0 (接続状態とデータ保持の分離) での挙動:
 *   - 接続 / 別 wallet への切替 / 同 wallet の再接続 → **その address の key だけ** invalidate
 *     (cache を即表示しつつ裏で 1 回取り直す。mount 時の取得が既に走っていれば相乗りする)
 *   - 切断 (address → null) → 何もしない。cache は保持され、表示は enabled: false で消える
 *   - cold start の復元 → 何もしない (永続 cache を即表示、staleTime に任せる)
 *   - recentWallets (MRU 5) から外れた wallet → その wallet の cache と端末の日次履歴を削除
 *
 * 判定は wallet-query-sync.ts の純関数。
 */

import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { useWalletStore } from "./walletStore";
import {
  evictedAddresses,
  isWalletKeyOf,
  resyncTargets,
  WALLET_SCOPED_QUERY_KEYS,
  type RecentWallet,
  type WalletSyncState,
} from "./wallet-query-sync";
import { usePortfolioHistoryStore } from "../stores/portfolioHistory";

export { WALLET_SCOPED_QUERY_KEYS, resyncTargets };

/** walletStore の SecureStore 復元が終わったか (終わる前の状態は遷移の基準にしない) */
function useWalletStoreHydrated(): boolean {
  const [hydrated, setHydrated] = useState(() =>
    useWalletStore.persist.hasHydrated()
  );
  useEffect(() => {
    if (hydrated) return;
    const unsub = useWalletStore.persist.onFinishHydration(() =>
      setHydrated(true)
    );
    // subscribe 前に終わっていた場合
    if (useWalletStore.persist.hasHydrated()) setHydrated(true);
    return unsub;
  }, [hydrated]);
  return hydrated;
}

/** home で 1 回だけ呼ぶ。初回 mount は基準を記録するだけ (cold start に invalidate しない) */
export function useWalletQuerySync(): void {
  const address = useWalletStore((s) => s.authorization?.address ?? null);
  const status = useWalletStore((s) => s.status);
  const recentWallets = useWalletStore((s) => s.recentWallets);
  const hydrated = useWalletStoreHydrated();
  const queryClient = useQueryClient();
  const prev = useRef<WalletSyncState | null>(null);
  const prevRecent = useRef<readonly RecentWallet[] | null>(null);

  useEffect(() => {
    const next: WalletSyncState = { address, status, hydrated };
    const before = prev.current;
    prev.current = next;
    if (before === null) return; // 初回 mount
    const target = resyncTargets(before, next);
    if (target === null) return;
    // cancelRefetch: false — 新 key の observer が mount 時の取得を既に始めていれば
    // それに相乗りする (取り消して撃ち直すと 1 遷移で同じ GET が 2 本になる)
    void queryClient.invalidateQueries(
      { predicate: (q) => isWalletKeyOf(q.queryKey, target) },
      { cancelRefetch: false }
    );
  }, [address, status, hydrated, queryClient]);

  useEffect(() => {
    const before = prevRecent.current;
    prevRecent.current = recentWallets;
    if (before === null || !hydrated) return;
    for (const evicted of evictedAddresses(before, recentWallets)) {
      queryClient.removeQueries({
        predicate: (q) => isWalletKeyOf(q.queryKey, evicted),
      });
      usePortfolioHistoryStore.getState().forget(evicted);
    }
  }, [recentWallets, hydrated, queryClient]);
}
