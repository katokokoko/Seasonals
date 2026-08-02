/**
 * walletStore — wallet 接続状態の global store (Zustand + SecureStore persist)
 *
 * CLAUDE.md §5:
 *   - global state: Zustand (Jotai 可)
 *   - 秘密鍵は保持しない (MWA 経由)
 *   - 永続化 (non-secret): AsyncStorage
 *
 * authToken は厳密には秘密鍵ではないが「再認可をスキップする証」であり機微度が高い
 * ため、`expo-secure-store` (iOS Keychain / Android Keystore 経由) で保存する。
 *
 * persist は authorization のみ partialize。status / error は session-only。
 *
 * @see ./mwa.ts (MWA wrapper、connect / reauthorize / disconnect の実装)
 */

import * as SecureStore from "expo-secure-store";
import { create } from "zustand";
import {
  createJSONStorage,
  persist,
  type StateStorage,
} from "zustand/middleware";

import {
  connectWallet,
  disconnectWallet,
  reauthorizeWallet,
  type ConnectOptions,
  type ConnectedAuthorization,
} from "./mwa";
import { USE_ONCHAIN } from "./config";

// ─────────────────────────────────────────────────────────────────────────────
// Storage 層 — expo-secure-store の StateStorage adapter
// ─────────────────────────────────────────────────────────────────────────────

const SECURE_STORE_KEY = "seasonals.wallet.v1";

const secureStorage: StateStorage = {
  getItem: async (key) => (await SecureStore.getItemAsync(key)) ?? null,
  setItem: async (key, value) => {
    await SecureStore.setItemAsync(key, value);
  },
  removeItem: async (key) => {
    await SecureStore.deleteItemAsync(key);
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Store 型
// ─────────────────────────────────────────────────────────────────────────────

export type WalletStatus = "idle" | "connecting" | "connected" | "error";

export interface WalletStoreState {
  authorization: ConnectedAuthorization | null;
  status: WalletStatus;
  error: string | null;
}

export interface WalletStoreActions {
  /** 新規接続。失敗時は status='error' + error 文字列を埋めて throw */
  connect: (opts?: ConnectOptions) => Promise<void>;
  /** 接続解除。authToken を MWA 側で revoke */
  disconnect: () => Promise<void>;
  /** 永続化された authorization で sile re-auth (cold start 用) */
  reauthorize: () => Promise<void>;
  /** state を初期化 (テスト / fatal error 後の清掃用) */
  reset: () => void;
}

export type WalletStore = WalletStoreState & WalletStoreActions;

// ─────────────────────────────────────────────────────────────────────────────
// Store 実装
// ─────────────────────────────────────────────────────────────────────────────

export const useWalletStore = create<WalletStore>()(
  persist(
    (set, get) => ({
      authorization: null,
      status: "idle",
      error: null,

      connect: async (opts) => {
        set({ status: "connecting", error: null });
        try {
          // Phase 8.5: onchain variant は mainnet wallet を要求 (Jupiter Lend deposit
          // を mainnet で実行するため)。default variant は devnet (Phase 5 round-trip 用)。
          // opts.chain を caller が明示している場合はそれを優先。
          // Phase 8.5.2: MWA 1.0 spec の chain identifier は "solana:mainnet" (固定)。
          // Phantom mobile はこの値で mainnet auth_token を発行する。
          const chain =
            opts?.chain ??
            (USE_ONCHAIN ? "solana:mainnet" : "solana:devnet");
          const authorization = await connectWallet({ ...opts, chain });
          set({ authorization, status: "connected", error: null });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          set({ status: "error", error: message });
          throw err;
        }
      },

      disconnect: async () => {
        const { authorization } = get();
        if (authorization) {
          // deauthorize は best-effort。失敗しても local 状態は clear する。
          await disconnectWallet(authorization).catch(() => undefined);
        }
        set({ authorization: null, status: "idle", error: null });
      },

      reauthorize: async () => {
        const { authorization } = get();
        if (!authorization) return;
        set({ status: "connecting", error: null });
        try {
          const refreshed = await reauthorizeWallet(authorization);
          set({ authorization: refreshed, status: "connected", error: null });
        } catch (err) {
          // reauth 失敗 = wallet 側で auth が revoke 済 → local も clear
          const message = err instanceof Error ? err.message : String(err);
          set({ authorization: null, status: "error", error: message });
        }
      },

      reset: () => set({ authorization: null, status: "idle", error: null }),
    }),
    {
      name: SECURE_STORE_KEY,
      storage: createJSONStorage(() => secureStorage),
      // persist 対象は authorization のみ。status / error は session-only。
      partialize: (state) => ({ authorization: state.authorization }),
      /**
       * 8.67: 復元後に status を戻す。
       *
       * これが無いと再起動後 `status='idle'` のまま authorization だけが戻り、
       * **接続状態の判定が画面ごとに割れる**:
       *   - authorization を見る側 (portfolio / WalletPopover) → 接続済
       *   - isConnected を見る側 (Settings / ActionModal) → 未接続
       * 実害は表示だけでなく、ActionModal の on-chain CTA が無効になり
       * **起動のたびに deposit / withdraw が実行できなくなる**こと。
       *
       * MWA に「セッション」は無く、authToken は wallet 側で revoke される
       * まで有効なので「token を保持している = connected」で意味が通る。
       * 起動時の `reauthorize()` は採らない — transact() 経由で wallet アプリ
       * が毎回立ち上がるため。revoke 済だった場合は次の署名で失敗する。
       */
      onRehydrateStorage: () => (state) => {
        // state を直接書き換えず setState (subscriber に通知させる)
        if (state?.authorization) {
          useWalletStore.setState({ status: "connected" });
        }
      },
    }
  )
);
