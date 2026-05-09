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

import { create } from "zustand";
import AsyncStorage from "@react-native-async-storage/async-storage";

export interface ThemeMeta {
  id: string;
  name: string;
  description: string;
  /** 3 色のスウォッチ (palette preview) — theme palette literal */
  swatches: [string, string, string];
  /** "free" or USD price ("$0.99") */
  price: string;
}

/**
 * Theme palette literals — Seasonals brand palette (DS.color.*) とは別軸の
 * "切替可能な theme" 用 catalog。CLAUDE.md §6 「色は DS.color.* token 経由」は
 * 現行 (Cream Soda) UI token 規約で、本値は alternative theme palette として
 * theme.ts 内に閉じ込める (UI 内では使われず Theme Shop 表示のみで参照)。
 */
export const THEME_CATALOG: readonly ThemeMeta[] = [
  {
    id: "cream_soda",
    name: "Cream Soda",
    description: "The original Seasonals palette — vanilla, soda teal, melon.",
    // bgPrimary cream / sodaText cyan / melonText green
    swatches: ["#FFF8E7", "#26C6DA", "#56C596"],
    price: "free",
  },
  {
    id: "midnight_orchard",
    name: "Midnight Orchard",
    description: "A deep plum night sky with lantern gold accents.",
    swatches: ["#1E1130", "#E2B33E", "#C9A1E1"],
    price: "$0.99",
  },
  {
    id: "berry_fizz",
    name: "Berry Fizz",
    description: "Strawberry soda pop with raspberry foam.",
    swatches: ["#F8DCEA", "#D54E84", "#812B53"],
    price: "$0.99",
  },
  {
    id: "lemon_grove",
    name: "Lemon Grove",
    description: "Sun-bleached citrus with sage shadows.",
    swatches: ["#FFFAD9", "#B89E2C", "#5E7E4C"],
    price: "$0.99",
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
