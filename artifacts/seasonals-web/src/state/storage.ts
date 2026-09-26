/**
 * localStorage を使う Zustand persist 用 storage。
 * private window / site data blocked で localStorage が throw する環境では in-memory に
 * 落とす (per-viewer の利便性のみなので、保存できなくても画面は動く)。
 */
import { createJSONStorage } from "zustand/middleware";

export const safeStorage = createJSONStorage(() => {
  try {
    const k = "__seasonals_probe__";
    window.localStorage.setItem(k, "1");
    window.localStorage.removeItem(k);
    return window.localStorage;
  } catch {
    const mem = new Map<string, string>();
    return {
      getItem: (n: string) => mem.get(n) ?? null,
      setItem: (n: string, v: string) => void mem.set(n, v),
      removeItem: (n: string) => void mem.delete(n),
    };
  }
});
