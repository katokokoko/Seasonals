/**
 * Session store — 閲覧対象 address と browser wallet 接続状態 (Zustand)。
 *
 * - watch address: 署名権限なし。読み取り (events / positions) のみ
 * - connected EVM address: injected EIP-1193 wallet から eth_requestAccounts で取得。
 *   Seasonals は秘密鍵を保持しない (CLAUDE.md §5)。署名は wallet 側
 * localStorage 永続化は per-viewer の利便性のみ (失敗しても動く)。
 */
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { ChainId } from "@workspace/lib/config/chains";

export interface SessionState {
  watch: Partial<Record<ChainId, string>>;
  connectedEvm: string | null;
  setWatch: (chain: ChainId, address: string | null) => void;
  setConnectedEvm: (address: string | null) => void;
}

const safeStorage = createJSONStorage(() => {
  try {
    const k = "__seasonals_probe__";
    window.localStorage.setItem(k, "1");
    window.localStorage.removeItem(k);
    return window.localStorage;
  } catch {
    const mem = new Map<string, string>();
    return {
      getItem: (n: string) => mem.get(n) ?? null,
      setItem: (n: string, v: string) => void mem.set(n, v),
      removeItem: (n: string) => void mem.delete(n),
    };
  }
});

export const useSession = create<SessionState>()(
  persist(
    (set) => ({
      watch: {},
      connectedEvm: null,
      setWatch: (chain, address) =>
        set((s) => {
          const watch = { ...s.watch };
          if (address) watch[chain] = address;
          else delete watch[chain];
          return { watch };
        }),
      setConnectedEvm: (address) => set({ connectedEvm: address }),
    }),
    { name: "seasonals-web-session", storage: safeStorage, partialize: (s) => ({ watch: s.watch }) }
  )
);

/** 読み取り対象の address (接続 wallet 優先、無ければ watch) */
export function activeAddresses(s: Pick<SessionState, "watch" | "connectedEvm">): Partial<Record<ChainId, string>> {
  return {
    ...(s.watch.solana ? { solana: s.watch.solana } : {}),
    ...(s.connectedEvm ? { ethereum: s.connectedEvm } : s.watch.ethereum ? { ethereum: s.watch.ethereum } : {}),
  };
}

export function hasAnyWallet(s: Pick<SessionState, "watch" | "connectedEvm">): boolean {
  return Object.keys(activeAddresses(s)).length > 0;
}
