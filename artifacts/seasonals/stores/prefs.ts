/**
 * prefs — UI 設定の永続 store (Phase 8.36)
 *
 * theme.ts と同型の zustand + AsyncStorage パターン。SettingsDrawer の
 * APPEARANCE section が編集する。
 *
 * 8.41: liquidEffect boolean → backgroundMode 3 択に拡張。
 *   "liquid" = GlassLayer (傾き液体演出)
 *   "static" = MelonSodaBackground static (緑グラデーションのみ、動きなし)
 *   "none"   = 背景装飾なし (うす緑も出さない素の背景)
 * 旧キー prefs:liquidEffect は hydrate 時に移行 (on→liquid / off→static)。
 */

import { create } from "zustand";
import AsyncStorage from "@react-native-async-storage/async-storage";

const BG_KEY = "prefs:backgroundMode";
const LEGACY_LIQUID_KEY = "prefs:liquidEffect";

export type BackgroundMode = "liquid" | "static" | "none";

function isBackgroundMode(v: string): v is BackgroundMode {
  return v === "liquid" || v === "static" || v === "none";
}

interface PrefsState {
  /** 背景装飾 (8.41)。liquid = GlassLayer / static = 静的ソーダ / none = 無し */
  backgroundMode: BackgroundMode;
  /** AsyncStorage から復元 (起動時 1 回、_layout で呼ぶ) */
  hydrate: () => Promise<void>;
  setBackgroundMode: (mode: BackgroundMode) => void;
}

export const usePrefsStore = create<PrefsState>()((set) => ({
  backgroundMode: "liquid",

  hydrate: async () => {
    try {
      const [bg, legacyLiquid] = await Promise.all([
        AsyncStorage.getItem(BG_KEY),
        AsyncStorage.getItem(LEGACY_LIQUID_KEY),
      ]);
      const next: Partial<Pick<PrefsState, "backgroundMode">> = {};
      if (bg !== null && isBackgroundMode(bg)) {
        next.backgroundMode = bg;
      } else if (legacyLiquid !== null) {
        // 8.41 移行: 旧 boolean の off は「静的背景に退避」と同義だった
        next.backgroundMode = legacyLiquid === "1" ? "liquid" : "static";
      }
      set(next);
    } catch {
      /* noop — 永続化失敗は無害 (default liquid) */
    }
  },

  setBackgroundMode: (mode) => {
    set({ backgroundMode: mode });
    AsyncStorage.setItem(BG_KEY, mode).catch(() => {});
  },
}));
