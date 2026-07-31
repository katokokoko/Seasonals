/**
 * prefs — UI 設定の永続 store (Phase 8.36)
 *
 * theme.ts と同型の zustand + AsyncStorage パターン。初の永続 UI 設定は
 * 液体演出 (GlassLayer) の on/off (ハンドオフ §2.4「演出全体を設定でオフに
 * できること」)。SettingsDrawer の APPEARANCE section が編集する。
 *
 * 8.40: glassHighlights を追加 — 液体・泡は残したまま、グラス見立ての
 * ハイライト (白い縦筋) だけを個別に消せるようにする。
 */

import { create } from "zustand";
import AsyncStorage from "@react-native-async-storage/async-storage";

const LIQUID_KEY = "prefs:liquidEffect";
const GLASS_HI_KEY = "prefs:glassHighlights";

interface PrefsState {
  /** 液体演出 (GlassLayer)。false で MelonSodaBackground static へ退避 */
  liquidEffect: boolean;
  /** グラスのハイライト (GlassLayer の白い縦筋)。液体演出 on のときのみ効く */
  glassHighlights: boolean;
  /** AsyncStorage から復元 (起動時 1 回、_layout で呼ぶ) */
  hydrate: () => Promise<void>;
  setLiquidEffect: (on: boolean) => void;
  setGlassHighlights: (on: boolean) => void;
}

export const usePrefsStore = create<PrefsState>()((set) => ({
  liquidEffect: true,
  glassHighlights: true,

  hydrate: async () => {
    try {
      const [liquid, glassHi] = await Promise.all([
        AsyncStorage.getItem(LIQUID_KEY),
        AsyncStorage.getItem(GLASS_HI_KEY),
      ]);
      const next: Partial<
        Pick<PrefsState, "liquidEffect" | "glassHighlights">
      > = {};
      if (liquid !== null) next.liquidEffect = liquid === "1";
      if (glassHi !== null) next.glassHighlights = glassHi === "1";
      set(next);
    } catch {
      /* noop — 永続化失敗は無害 (default on) */
    }
  },

  setLiquidEffect: (on) => {
    set({ liquidEffect: on });
    AsyncStorage.setItem(LIQUID_KEY, on ? "1" : "0").catch(() => {});
  },

  setGlassHighlights: (on) => {
    set({ glassHighlights: on });
    AsyncStorage.setItem(GLASS_HI_KEY, on ? "1" : "0").catch(() => {});
  },
}));
