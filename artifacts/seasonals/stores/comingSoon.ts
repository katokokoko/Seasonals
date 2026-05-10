/**
 * comingSoon — global "Coming soon" toast の表示状態 (Phase 7.8)
 *
 * `useComingSoon.getState().show("message")` で任意の component から
 * bottom-center の glass toast を表示。auto-dismiss 2200ms、連続呼び出し時は
 * 既存 timeout を clear して新 message に差し替え。
 *
 * Toast 本体の visual は components/feedback/ComingSoonToast.tsx、
 * _layout.tsx で global mount される。
 */

import { create } from "zustand";

const AUTO_DISMISS_MS = 2200;

interface ComingSoonState {
  visible: boolean;
  message: string;
  show: (message: string) => void;
  hide: () => void;
}

let dismissTimer: ReturnType<typeof setTimeout> | null = null;

export const useComingSoon = create<ComingSoonState>()((set) => ({
  visible: false,
  message: "",

  show: (message: string) => {
    if (dismissTimer) {
      clearTimeout(dismissTimer);
      dismissTimer = null;
    }
    set({ visible: true, message });
    dismissTimer = setTimeout(() => {
      set({ visible: false });
      dismissTimer = null;
    }, AUTO_DISMISS_MS);
  },

  hide: () => {
    if (dismissTimer) {
      clearTimeout(dismissTimer);
      dismissTimer = null;
    }
    set({ visible: false });
  },
}));
