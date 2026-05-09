/**
 * wallet — active wallet 選択状態 (Phase 5A.8.4)
 *
 * `useWallets()` (TanStack Query) が返す Wallet[] のうちどれを "active" にするかの
 * UI 選択状態のみを保持。実 wallet の MWA 接続セッションは services/walletStore.ts が
 * 管理。本 store は portfolio クエリのキー (active wallet) を切替えるための軸。
 *
 * 切替時は home が `queryClient.invalidateQueries(['positions'])` 等を発火させて
 * 新 active wallet で再 fetch する想定 (TanStack Query 経由)。
 */

import { create } from "zustand";

interface WalletSelectionState {
  /** 現在 active な wallet の wallet_id (lib/types/position.ts Wallet.wallet_id) */
  activeWalletId: string | null;
  setActiveWalletId: (id: string | null) => void;
  /** session reset 用 */
  reset: () => void;
}

// MVP デフォルト: fixture の wal_001 (Main wallet) を active にしておくことで
// drink button の status dot が初期表示される (Phase 5A.4 spec)。
const DEFAULT_ACTIVE_WALLET_ID = "wal_001";

export const useWalletSelectionStore = create<WalletSelectionState>()((set) => ({
  activeWalletId: DEFAULT_ACTIVE_WALLET_ID,
  setActiveWalletId: (id) => set({ activeWalletId: id }),
  reset: () => set({ activeWalletId: DEFAULT_ACTIVE_WALLET_ID }),
}));
