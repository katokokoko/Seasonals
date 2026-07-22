/**
 * prefs — UI 設定の永続 store (Phase 8.36)
 *
 * theme.ts と同型の zustand + AsyncStorage パターン。初の永続 UI 設定は
 * 液体演出 (GlassLayer) の on/off (ハンドオフ §2.4「演出全体を設定でオフに
 * できること」)。SettingsDrawer の APPEARANCE section が編集する。
 */

import { create } from "zustand";
import AsyncStorage from "@react-native-async-storage/async-storage";

const LIQUID_KEY = "prefs:liquidEffect";

interface PrefsState {
  /** 液体演出 (GlassLayer)。false で MelonSodaBackground static へ退避 */
  liquidEffect: boolean;
  /** AsyncStorage から復元 (起動時 1 回、_layout で呼ぶ) */
  hydrate: () => Promise<void>;
  setLiquidEffect: (on: boolean) => void;
}

export const usePrefsStore = create<PrefsState>()((set) => ({
  liquidEffect: true,

  hydrate: async () => {
    try {
      const raw = await AsyncStorage.getItem(LIQUID_KEY);
      if (raw !== null) set({ liquidEffect: raw === "1" });
    } catch {
      /* noop — 永続化失敗は無害 (default on) */
    }
  },

  setLiquidEffect: (on) => {
    set({ liquidEffect: on });
    AsyncStorage.setItem(LIQUID_KEY, on ? "1" : "0").catch(() => {});
  },
}));
