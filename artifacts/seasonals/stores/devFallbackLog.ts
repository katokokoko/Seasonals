/**
 * devFallbackLog — Phase 5B.3
 *
 * api.ts の `tryHttpThenFixture` が fixture フォールバックした最後の発生を保持。
 * Settings → DEVELOPER section が読み取り、"Last fixture fallback: HH:MM:SS — <route>"
 * を表示する。production build では呼ばれない (api.ts 側で __DEV__ guard)。
 *
 * console.warn を使うと RN LogBox が persistent toast を出してしまうため、
 * 本 store + 受動的 UI 表示に置き換える (no floating overlay)。
 */

import { create } from "zustand";

export interface FallbackLogEntry {
  /** epoch ms */
  timestamp: number;
  /** BFF route (e.g. "/positions") */
  route: string;
  /** raw error message */
  message: string;
}

interface DevFallbackLogState {
  last: FallbackLogEntry | null;
  record: (route: string, message: string) => void;
  clear: () => void;
}

export const useDevFallbackLog = create<DevFallbackLogState>()((set) => ({
  last: null,
  record: (route, message) =>
    set({ last: { timestamp: Date.now(), route, message } }),
  clear: () => set({ last: null }),
}));

/** "HH:MM:SS" 形式 (本表示は日付不要、当 session 中の経過参照のみ) */
export function formatTimeOfDay(epochMs: number): string {
  const d = new Date(epochMs);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
