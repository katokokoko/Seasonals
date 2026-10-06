/**
 * Session store — 閲覧対象 address と browser wallet 接続状態 (Zustand)。
 *
 * - watchlist: 署名権限なしの読み取り対象 (Solana / Ethereum、最大 6 件)
 * - connected: chain ごとに browser wallet から得た address。
 *   Ethereum は EIP-6963 (eth_requestAccounts)、Solana は Wallet Standard (standard:connect)。
 *   Seasonals は秘密鍵を保持しない (CLAUDE.md §5)。署名は wallet 側
 * - lastSolanaWallet: 前回接続した Solana wallet の名前。reload 後に silent connect で戻すためだけに残す
 * localStorage 永続化は per-viewer の利便性のみ (失敗しても動く)。
 */
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { SUPPORTED_CHAINS, type ChainId } from "@workspace/lib/config/chains";
import { safeStorage } from "./storage";

export interface WatchEntry {
  chain: ChainId;
  address: string;
}
export interface ActiveAddress extends WatchEntry {
  connected: boolean;
}

export const MAX_WATCH = 6;

/** 接続した wallet の表示情報 */
export interface ConnectedWallet {
  name: string;
  icon: string;
  /** wallet の識別子: Ethereum は EIP-6963 の rdns、Solana は Wallet Standard の name (rdns が無いため) */
  rdns: string;
}

export interface ConnectedAccount {
  address: string;
  wallet: ConnectedWallet;
}

export interface SessionState {
  watchlist: WatchEntry[];
  connected: Partial<Record<ChainId, ConnectedAccount>>;
  lastSolanaWallet: string | null;
  addWatch: (entry: WatchEntry) => void;
  removeWatch: (entry: WatchEntry) => void;
  /**
   * address = null で切断。wallet を省くと (accountsChanged / change event) 接続中の wallet のまま address だけ替える。
   * Solana を明示的に切断した時は lastSolanaWallet も消す (次回 silent 再接続しない)
   */
  setConnected: (chain: ChainId, address: string | null, wallet?: ConnectedWallet) => void;
}

/** Ethereum address は大文字小文字を区別しない。Solana (base58) は区別する */
export function sameAddress(chain: ChainId, a: string, b: string): boolean {
  return chain === "ethereum" ? a.toLowerCase() === b.toLowerCase() : a === b;
}
const same = (a: WatchEntry, b: WatchEntry) => a.chain === b.chain && sameAddress(a.chain, a.address, b.address);

export const useSession = create<SessionState>()(
  persist(
    (set) => ({
      watchlist: [],
      connected: {},
      lastSolanaWallet: null,
      addWatch: (entry) =>
        set((s) => (s.watchlist.some((w) => same(w, entry)) ? s : { watchlist: [...s.watchlist, entry].slice(-MAX_WATCH) })),
      removeWatch: (entry) => set((s) => ({ watchlist: s.watchlist.filter((w) => !same(w, entry)) })),
      setConnected: (chain, address, wallet) =>
        set((s) => {
          const connected = { ...s.connected };
          if (!address) {
            delete connected[chain];
            return { connected, ...(chain === "solana" ? { lastSolanaWallet: null } : {}) };
          }
          const w = wallet ?? s.connected[chain]?.wallet;
          if (!w) return s;
          connected[chain] = { address, wallet: w };
          return { connected, ...(chain === "solana" ? { lastSolanaWallet: w.rdns } : {}) };
        }),
    }),
    {
      name: "seasonals-web-session-v2",
      storage: safeStorage,
      // 接続そのものは保存しない (wallet 側の許可が正)。Solana は wallet 名だけ残して silent connect で戻す
      partialize: (s) => ({ watchlist: s.watchlist, lastSolanaWallet: s.lastSolanaWallet }),
    }
  )
);

/** 読み取り対象 (接続 wallet を SUPPORTED_CHAINS 順に先頭、watchlist と重複排除) */
export function activeAddresses(s: Pick<SessionState, "watchlist" | "connected">): ActiveAddress[] {
  const out: ActiveAddress[] = [];
  for (const c of SUPPORTED_CHAINS) {
    const acct = s.connected[c.id];
    if (acct) out.push({ chain: c.id, address: acct.address, connected: true });
  }
  for (const w of s.watchlist) if (!out.some((o) => same(o, w))) out.push({ ...w, connected: false });
  return out;
}

export function useActiveAddresses(): ActiveAddress[] {
  const watchlist = useSession((s) => s.watchlist);
  const connected = useSession((s) => s.connected);
  return activeAddresses({ watchlist, connected });
}

/** chain の接続 address (未接続なら null) */
export function useConnectedAddress(chain: ChainId): string | null {
  return useSession((s) => s.connected[chain]?.address ?? null);
}
