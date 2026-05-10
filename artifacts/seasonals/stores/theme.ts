/**
 * theme — Theme Shop の active / owned state (Phase 5C.1)
 *
 * 永続化 (AsyncStorage):
 *   themes:owned  → JSON string[] (cream_soda は free / always owned のため記録不要)
 *   themes:active → string (default "cream_soda")
 *
 * Initial state (new user):
 *   - activeThemeId = "cream_soda" (free, default)
 *   - ownedThemeIds = []  (cream_soda は implicit に owned 扱い)
 *
 * 4 themes (cream_soda + 3 paid)。catalog は MVP fixture、後続で BFF / on-chain 化。
 */

import { useMemo } from "react";
import { StyleSheet } from "react-native";
import { create } from "zustand";
import AsyncStorage from "@react-native-async-storage/async-storage";

/** MelonSodaBackground 5-stop palette (top→bottom + pool radial shadow) */
export interface ThemeBgPalette {
  top: string;
  mid: string;
  deep: string;
  bottom: string;
  pool: string;
}

/** Seasonals logo (Pacifico) と一部 primary accent の theme 別カラー */
export interface ThemeAccent {
  logo: string;
  primary: string;
}

/**
 * Phase 7.9: lib/design-system.ts COLOR の theme-able subset。
 * useThemeColors() で active theme の ui を取得し、useThemedStyles() で
 * StyleSheet.create を theme 連動 re-create する。
 *
 * Cream Soda の値は lib/design-system.ts COLOR と完全一致 (regression なし)、
 * 他 theme は palette identity に沿った上書き。
 */
export interface ThemeColors {
  bgPrimary: string;
  bgSecondary: string;
  bgCard: string;
  textPrimary: string;
  textSubtitle: string;
  textMuted: string;
  textOnColor: string;
  border: string;
  borderStrong: string;
  divider: string;
  sodaText: string;
  melonText: string;
  sodaLight: string;
  melonLight: string;
  caramel: string;
  cherryDark: string;
}

export interface ThemeMeta {
  id: string;
  name: string;
  description: string;
  /** 3 色のスウォッチ (palette preview) — theme palette literal */
  swatches: [string, string, string];
  /** "free" or USD price ("$0.99") */
  price: string;
  /** Phase 7.8: MelonSodaBackground に適用される 5-stop palette */
  bgPalette: ThemeBgPalette;
  /** Phase 7.8: logo color など、theme で動的切替する accent */
  accent: ThemeAccent;
  /** Phase 7.9: cream 系 bg / Settings drawer / Portfolio などの theme-able UI 色 */
  ui: ThemeColors;
}

/**
 * Theme palette literals — Seasonals brand palette (DS.color.*) とは別軸の
 * "切替可能な theme" 用 catalog。CLAUDE.md §6 「色は DS.color.* token 経由」は
 * 現行 (Cream Soda) UI token 規約で、本値は alternative theme palette として
 * theme.ts 内に閉じ込める (domain-specific palette、theme 切替の対象 surface
 * は MelonSodaBackground と Home logo に限定)。
 */
export const THEME_CATALOG: readonly ThemeMeta[] = [
  {
    id: "cream_soda",
    name: "Cream Soda",
    description: "The original Seasonals palette — vanilla, soda teal, melon.",
    swatches: ["#FFF8E7", "#26C6DA", "#56C596"],
    price: "free",
    bgPalette: {
      top: "#B4F0C8",
      mid: "#7DE1AF",
      deep: "#3CC382",
      bottom: "#0F6E4B",
      pool: "#084632",
    },
    accent: { logo: "#00ACC1", primary: "#2E9968" },
    ui: {
      bgPrimary: "#FFF8E7",
      bgSecondary: "#F5F0E0",
      bgCard: "rgba(255, 255, 255, 0.35)",
      textPrimary: "#3E2723",
      textSubtitle: "#5D4E47",
      textMuted: "#8D7E76",
      textOnColor: "#FFFFFF",
      border: "rgba(62, 39, 35, 0.10)",
      borderStrong: "rgba(62, 39, 35, 0.25)",
      divider: "rgba(62, 39, 35, 0.08)",
      sodaText: "#00ACC1",
      melonText: "#2E9968",
      sodaLight: "#E0F7FA",
      melonLight: "#A8E6CF",
      caramel: "#C4956A",
      cherryDark: "#D32F2F",
    },
  },
  {
    id: "midnight_orchard",
    name: "Midnight Orchard",
    description: "A deep plum night sky with lantern gold accents.",
    swatches: ["#1E1130", "#E2B33E", "#C9A1E1"],
    price: "$0.99",
    bgPalette: {
      top: "#C9B6F5",
      mid: "#9070D5",
      deep: "#5A3A9F",
      bottom: "#2D1A5C",
      pool: "#160B33",
    },
    accent: { logo: "#A78CE8", primary: "#6F4FC0" },
    ui: {
      bgPrimary: "#1E1130",
      bgSecondary: "#2A1A42",
      bgCard: "rgba(255, 255, 255, 0.10)",
      textPrimary: "#F5EAFB",
      textSubtitle: "#C9A1E1",
      textMuted: "#9070D5",
      textOnColor: "#FFFFFF",
      border: "rgba(255, 255, 255, 0.12)",
      borderStrong: "rgba(255, 255, 255, 0.25)",
      divider: "rgba(255, 255, 255, 0.08)",
      sodaText: "#A78CE8",
      melonText: "#E2B33E",
      sodaLight: "#2D1A5C",
      melonLight: "rgba(226, 179, 62, 0.18)",
      caramel: "#E2B33E",
      cherryDark: "#FF6B6B",
    },
  },
  {
    id: "berry_fizz",
    name: "Berry Fizz",
    description: "Strawberry soda pop with raspberry foam.",
    swatches: ["#F8DCEA", "#D54E84", "#812B53"],
    price: "$0.99",
    bgPalette: {
      top: "#FFC4D8",
      mid: "#FF8FA8",
      deep: "#E55C7A",
      bottom: "#8C2540",
      pool: "#4A0E22",
    },
    accent: { logo: "#FF6B8A", primary: "#D44767" },
    ui: {
      bgPrimary: "#F8DCEA",
      bgSecondary: "#F0CADD",
      bgCard: "rgba(255, 255, 255, 0.45)",
      textPrimary: "#4B1A2E",
      textSubtitle: "#7B2A4E",
      textMuted: "#A05C7E",
      textOnColor: "#FFFFFF",
      border: "rgba(213, 78, 132, 0.18)",
      borderStrong: "rgba(213, 78, 132, 0.35)",
      divider: "rgba(213, 78, 132, 0.10)",
      sodaText: "#D54E84",
      melonText: "#812B53",
      sodaLight: "#FFC4D8",
      melonLight: "rgba(213, 78, 132, 0.18)",
      caramel: "#D54E84",
      cherryDark: "#B82347",
    },
  },
  {
    id: "lemon_grove",
    name: "Lemon Grove",
    description: "Sun-bleached citrus with sage shadows.",
    swatches: ["#FFFAD9", "#B89E2C", "#5E7E4C"],
    price: "$0.99",
    bgPalette: {
      top: "#FFEFA8",
      mid: "#FFCC4D",
      deep: "#E89E00",
      bottom: "#8A5A00",
      pool: "#4A2F00",
    },
    accent: { logo: "#FF9F1C", primary: "#D38A0A" },
    ui: {
      bgPrimary: "#FFFAD9",
      bgSecondary: "#FFF1B8",
      bgCard: "rgba(255, 255, 255, 0.45)",
      textPrimary: "#3C3500",
      textSubtitle: "#5E7E4C",
      textMuted: "#8A8060",
      textOnColor: "#FFFFFF",
      border: "rgba(184, 158, 44, 0.20)",
      borderStrong: "rgba(184, 158, 44, 0.40)",
      divider: "rgba(184, 158, 44, 0.12)",
      sodaText: "#B89E2C",
      melonText: "#5E7E4C",
      sodaLight: "#FFEFA8",
      melonLight: "rgba(94, 126, 76, 0.18)",
      caramel: "#B89E2C",
      cherryDark: "#C44539",
    },
  },
] as const;

export const DEFAULT_THEME_ID = "cream_soda";

const OWNED_KEY = "themes:owned";
const ACTIVE_KEY = "themes:active";

interface ThemeState {
  activeThemeId: string;
  ownedThemeIds: string[];
  /** AsyncStorage から復元 (起動時 1 回呼ぶ) */
  hydrate: () => Promise<void>;
  setActive: (id: string) => Promise<void>;
  /** Purchase フロー — 既に owned なら no-op、新規なら append + 永続化 */
  purchase: (id: string) => Promise<void>;
  /** Dev reset — themes:owned を clear、active も default に戻す */
  reset: () => Promise<void>;
  /** id が "owned" 扱いか (cream_soda は implicit owned) */
  isOwned: (id: string) => boolean;
}

export const useThemeStore = create<ThemeState>()((set, get) => ({
  activeThemeId: DEFAULT_THEME_ID,
  ownedThemeIds: [],

  hydrate: async () => {
    try {
      const [ownedRaw, activeRaw] = await Promise.all([
        AsyncStorage.getItem(OWNED_KEY),
        AsyncStorage.getItem(ACTIVE_KEY),
      ]);
      const owned: string[] = ownedRaw ? safeParse(ownedRaw) : [];
      const active = activeRaw && typeof activeRaw === "string"
        ? activeRaw
        : DEFAULT_THEME_ID;
      set({ ownedThemeIds: owned, activeThemeId: active });
    } catch {
      /* noop — 永続化失敗は無害 */
    }
  },

  setActive: async (id) => {
    set({ activeThemeId: id });
    AsyncStorage.setItem(ACTIVE_KEY, id).catch(() => {});
  },

  purchase: async (id) => {
    const cur = get().ownedThemeIds;
    if (cur.includes(id) || id === DEFAULT_THEME_ID) return;
    const next = [...cur, id];
    set({ ownedThemeIds: next });
    AsyncStorage.setItem(OWNED_KEY, JSON.stringify(next)).catch(() => {});
  },

  reset: async () => {
    set({ ownedThemeIds: [], activeThemeId: DEFAULT_THEME_ID });
    await Promise.all([
      AsyncStorage.removeItem(OWNED_KEY).catch(() => {}),
      AsyncStorage.setItem(ACTIVE_KEY, DEFAULT_THEME_ID).catch(() => {}),
    ]);
  },

  isOwned: (id) => {
    if (id === DEFAULT_THEME_ID) return true;
    return get().ownedThemeIds.includes(id);
  },
}));

function safeParse(s: string): string[] {
  try {
    const v = JSON.parse(s);
    if (Array.isArray(v) && v.every((x) => typeof x === "string")) return v;
    return [];
  } catch {
    return [];
  }
}

/**
 * Phase 7.8: active theme の meta 全体を返す selector hook。
 * MelonSodaBackground / Home logo など theme 連動 surface で使用。
 * 不正な activeThemeId (将来削除された theme 等) の場合は Cream Soda を fallback。
 */
export function useActiveTheme(): ThemeMeta {
  const activeId = useThemeStore((s) => s.activeThemeId);
  return (
    THEME_CATALOG.find((t) => t.id === activeId) ??
    THEME_CATALOG[0]
  );
}

/**
 * Phase 7.9: active theme の ui colors を返す。useThemedStyles と合わせて
 * StyleSheet.create を theme 連動で再生成するのが標準パターン。
 */
export function useThemeColors(): ThemeColors {
  return useActiveTheme().ui;
}

/**
 * Phase 7.9: theme 連動 styles helper。
 * 既存の
 *   const styles = StyleSheet.create({ x: { color: COLOR.textPrimary } });
 * を
 *   const styles = useThemedStyles((c) =>
 *     StyleSheet.create({ x: { color: c.textPrimary } })
 *   );
 * に置換するだけで theme 切替に追従。useMemo で active theme 不変時は同 instance。
 */
export function useThemedStyles<T extends StyleSheet.NamedStyles<T>>(
  factory: (colors: ThemeColors) => T
): T {
  const colors = useThemeColors();
  // factory は inline arrow で毎 render identity が変わるので意図的に dep から除外。
  // colors は theme.id 変更時のみ identity が変わる (THEME_CATALOG エントリ参照)。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => factory(colors), [colors]);
}
