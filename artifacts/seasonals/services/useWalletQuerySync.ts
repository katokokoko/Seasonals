/**
 * useWalletQuerySync — wallet の接続状態が変わったら wallet 系クエリを取り直す
 * (Phase 8.77)
 *
 * 問題: `invalidateQueries` を呼んでいたのは tx 成功後の ActionModal だけで、
 * **connect / disconnect では何も起きていなかった**。TanStack Query の key は
 * address を含むので「別の wallet に繋ぎ替える」までは追従するが、
 *
 *   disconnect → 同じ wallet で reconnect
 *
 * だと key が元に戻るだけなので、`staleTime` の間はキャッシュがそのまま返る。
 * `usePortfolioHistory` は staleTime 5 分なので、**承認が成功してもグラフが
 * 5 分間変わらない**。カレンダー (wallet time events) も 30 秒間同じ。
 * 実機で「再接続してもグラフとカレンダーが反映されない」と報告された症状がこれ。
 *
 * `stores/wallet.ts` の冒頭コメントが「切替時は home が invalidateQueries を
 * 発火させる」と書いていた責務の、実装。判定は wallet-query-sync.ts の純関数。
 */

import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { useWalletStore } from "./walletStore";
import {
  shouldResyncWallet,
  WALLET_SCOPED_QUERY_KEYS,
  type WalletSyncState,
} from "./wallet-query-sync";

export { WALLET_SCOPED_QUERY_KEYS, shouldResyncWallet };

/**
 * home で 1 回だけ呼ぶ。初回 mount では何もしない — cold start は
 * そもそもキャッシュが無く、invalidate すると二重取得になるだけ。
 */
export function useWalletQuerySync(): void {
  const address = useWalletStore((s) => s.authorization?.address ?? null);
  const status = useWalletStore((s) => s.status);
  const queryClient = useQueryClient();
  const prev = useRef<WalletSyncState | null>(null);

  useEffect(() => {
    const next: WalletSyncState = { address, status };
    const before = prev.current;
    prev.current = next;
    if (before === null) return; // 初回 mount
    if (!shouldResyncWallet(before, next)) return;
    for (const key of WALLET_SCOPED_QUERY_KEYS) {
      queryClient.invalidateQueries({ queryKey: [key] });
    }
  }, [address, status, queryClient]);
}
