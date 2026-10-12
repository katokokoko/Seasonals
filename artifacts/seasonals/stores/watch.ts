/**
 * watch — watch-only address mode の永続 store (web の watchlist の移植)
 *
 * wallet を繋がず公開 address だけで portfolio / calendar を閲覧する。web の先例は
 * `artifacts/seasonals-web/src/state/session.ts` (`WatchEntry`、`MAX_WATCH = 6`)。
 *
 * - 中身は公開 address だけ (秘密は無い) なので AsyncStorage に置く
 *   (CLAUDE.md §5「永続化 (non-secret) → AsyncStorage」)。authorization は書かないので
 *   MWA / Seed Vault には一切届かない (署名は ActionModal が watch 中に止める)
 * - query cache は address key で共有するだけで、**権限には使わない**
 *   (接続状態 ≠ データ保持の原則。watch は本人認証ではない)
 * - jest で web3.js を載せないため walletStore は import しない
 *   (接続中かどうかの合成は services/active-address.ts の純関数が行う)
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import {
  createJSONStorage,
  persist,
  type StateStorage,
} from "zustand/middleware";

import { isSolanaAddress } from "@workspace/lib/config/chains";

export const WATCH_STORE_KEY = "seasonals.watch.v1";

/** watchlist の上限 (web の session.ts と同じ 6 件、MRU で古いものから落とす) */
export const MAX_WATCH = 6;

export const INVALID_WATCH_ADDRESS_ERROR = "Enter a valid Solana address.";

const asyncStorage: StateStorage = {
  getItem: async (key) => (await AsyncStorage.getItem(key)) ?? null,
  setItem: async (key, value) => {
    await AsyncStorage.setItem(key, value);
  },
  removeItem: async (key) => {
    await AsyncStorage.removeItem(key);
  },
};

/**
 * 貼り付けの空白 / 改行は trim。`solana:` 等の prefix は非対応 (不正として null)。
 * 判定は BFF /time-events/wallet と同じ base58 32..44 文字
 */
export function normalizeWatchAddress(raw: string): string | null {
  const v = raw.trim();
  return isSolanaAddress(v) ? v : null;
}

export type AddWatchResult =
  | { ok: true; address: string }
  | { ok: false; error: typeof INVALID_WATCH_ADDRESS_ERROR };

interface WatchState {
  /** 監視候補 (MRU、新しい順、最大 MAX_WATCH) */
  watchlist: string[];
  /** 今見ている address。null = 監視停止 (list は保持) */
  selected: string | null;
}

interface WatchActions {
  /** 正規化 → dedupe で先頭へ → select。MAX_WATCH 超は末尾を落とす */
  addWatch: (raw: string) => AddWatchResult;
  /** selected を消したら list の先頭 (無ければ null) に移る */
  removeWatch: (address: string) => void;
  /** list 内の address だけ選べる。null = 監視停止 */
  select: (address: string | null) => void;
  reset: () => void;
}

export type WatchStore = WatchState & WatchActions;

const INITIAL: WatchState = { watchlist: [], selected: null };

/** 永続値の検証 (不正 entry / 重複 / 上限超 / list 外の selected を落とす) */
export function sanitizeWatchState(persisted: unknown): WatchState {
  if (persisted === null || typeof persisted !== "object") return { ...INITIAL };
  const p = persisted as Partial<Record<keyof WatchState, unknown>>;
  const list: string[] = [];
  if (Array.isArray(p.watchlist)) {
    for (const entry of p.watchlist) {
      if (typeof entry !== "string") continue;
      const addr = normalizeWatchAddress(entry);
      if (addr !== null && !list.includes(addr)) list.push(addr);
    }
  }
  const watchlist = list.slice(0, MAX_WATCH);
  const selected =
    typeof p.selected === "string" && watchlist.includes(p.selected)
      ? p.selected
      : null;
  return { watchlist, selected };
}

export const useWatchStore = create<WatchStore>()(
  persist(
    (set, get) => ({
      ...INITIAL,

      addWatch: (raw) => {
        const address = normalizeWatchAddress(raw);
        if (address === null) {
          return { ok: false, error: INVALID_WATCH_ADDRESS_ERROR };
        }
        const rest = get().watchlist.filter((a) => a !== address);
        set({
          watchlist: [address, ...rest].slice(0, MAX_WATCH),
          selected: address,
        });
        return { ok: true, address };
      },

      removeWatch: (address) => {
        const { watchlist, selected } = get();
        const next = watchlist.filter((a) => a !== address);
        set({
          watchlist: next,
          selected: selected === address ? (next[0] ?? null) : selected,
        });
      },

      select: (address) => {
        if (address === null) {
          set({ selected: null });
          return;
        }
        if (!get().watchlist.includes(address)) return;
        set({ selected: address });
      },

      reset: () => set({ ...INITIAL }),
    }),
    {
      name: WATCH_STORE_KEY,
      storage: createJSONStorage(() => asyncStorage),
      partialize: (s) => ({ watchlist: s.watchlist, selected: s.selected }),
      merge: (persisted, current) => ({
        ...current,
        ...sanitizeWatchState(persisted),
      }),
    }
  )
);
