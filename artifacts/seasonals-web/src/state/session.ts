/**
 * Session store — 閲覧対象 address と browser wallet 接続状態 (Zustand)。
 *
 * - watchlist: 署名権限なしの読み取り対象 (Solana / Ethereum、最大 6 件)
 * - connectedEvm: injected EIP-1193 wallet から eth_requestAccounts で取得した address。
 *   Seasonals は秘密鍵を保持しない (CLAUDE.md §5)。署名は wallet 側
 * localStorage 永続化は per-viewer の利便性のみ (失敗しても動く)。
 */
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { ChainId } from "@workspace/lib/config/chains";

export interface WatchEntry {
  chain: ChainId;
  address: string;
}
export interface ActiveAddress extends WatchEntry {
  connected: boolean;
}

export const MAX_WATCH = 6;

export interface SessionState {
  watchlist: WatchEntry[];
  connectedEvm: string | null;
  addWatch: (entry: WatchEntry) => void;
  removeWatch: (entry: WatchEntry) => void;
  setConnectedEvm: (address: string | null) => void;
}

const same = (a: WatchEntry, b: WatchEntry) => a.chain === b.chain && a.address.toLowerCase() === b.address.toLowerCase();

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
      watchlist: [],
      connectedEvm: null,
      addWatch: (entry) =>
        set((s) => (s.watchlist.some((w) => same(w, entry)) ? s : { watchlist: [...s.watchlist, entry].slice(-MAX_WATCH) })),
      removeWatch: (entry) => set((s) => ({ watchlist: s.watchlist.filter((w) => !same(w, entry)) })),
      setConnectedEvm: (address) => set({ connectedEvm: address }),
    }),
    { name: "seasonals-web-session-v2", storage: safeStorage, partialize: (s) => ({ watchlist: s.watchlist }) }
  )
);

/** 読み取り対象 (接続 wallet を先頭、watchlist と重複排除) */
export function activeAddresses(s: Pick<SessionState, "watchlist" | "connectedEvm">): ActiveAddress[] {
  const out: ActiveAddress[] = s.connectedEvm ? [{ chain: "ethereum", address: s.connectedEvm, connected: true }] : [];
  for (const w of s.watchlist) if (!out.some((o) => same(o, w))) out.push({ ...w, connected: false });
  return out;
}

export function useActiveAddresses(): ActiveAddress[] {
  const watchlist = useSession((s) => s.watchlist);
  const connectedEvm = useSession((s) => s.connectedEvm);
  return activeAddresses({ watchlist, connectedEvm });
}
