/**
 * useWallet — Mobile UI が wallet 状態を読む唯一の hook
 *
 * walletStore (Zustand) の thin selector。tree-shake 可能な単項 hook と
 * 集約 hook の両方を export。consumer は必要なものだけ subscribe する。
 *
 * @see ./walletStore.ts
 */

import { useWalletStore } from "./walletStore";

// ─────────────────────────────────────────────────────────────────────────────
// 単項 selector (re-render を最小化したい場合に使う)
// ─────────────────────────────────────────────────────────────────────────────

export const useWalletAuthorization = () =>
  useWalletStore((s) => s.authorization);

export const useWalletStatus = () => useWalletStore((s) => s.status);

export const useWalletError = () => useWalletStore((s) => s.error);

export const useIsWalletConnected = () =>
  useWalletStore((s) => s.status === "connected" && s.authorization !== null);

// ─────────────────────────────────────────────────────────────────────────────
// 集約 hook (一画面で全部使う場合の utility)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * wallet 接続状態 + actions を 1 つのオブジェクトで取得。
 * 頻繁に変わらない state を扱う UI で十分実用的 (低頻度 re-render)。
 */
export function useWallet() {
  const authorization = useWalletStore((s) => s.authorization);
  const status = useWalletStore((s) => s.status);
  const error = useWalletStore((s) => s.error);
  const connect = useWalletStore((s) => s.connect);
  const disconnect = useWalletStore((s) => s.disconnect);
  const reauthorize = useWalletStore((s) => s.reauthorize);

  return {
    authorization,
    status,
    error,
    isConnected: status === "connected" && authorization !== null,
    connect,
    disconnect,
    reauthorize,
  };
}
