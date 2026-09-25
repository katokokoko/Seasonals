/**
 * EventDetailCard の開閉状態 (Home / Calendar workspace で共有、同時に 1 枚だけ)。
 */
import { create } from "zustand";

export type DetailTarget = { kind: "event"; eventId: string } | { kind: "day"; day: string };

interface DetailState {
  target: DetailTarget | null;
  /** 開いた要素 (anchor 配置と close 時の focus 復帰に使う) */
  trigger: HTMLElement | null;
  open: (target: DetailTarget, trigger: HTMLElement | null) => void;
  swap: (target: DetailTarget) => void;
  close: () => void;
}

export const useDetail = create<DetailState>((set) => ({
  target: null,
  trigger: null,
  open: (target, trigger) => set({ target, trigger }),
  swap: (target) => set({ target }),
  close: () => set({ target: null }),
}));

/** WalletControl を開かせる (詳細カードの Connect wallet から) */
export const OPEN_WALLET_EVENT = "seasonals:open-wallet";
export function requestOpenWallet() {
  window.dispatchEvent(new Event(OPEN_WALLET_EVENT));
}
