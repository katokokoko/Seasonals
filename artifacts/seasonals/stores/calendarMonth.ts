/**
 * calendarMonth — home screen の MonthGrid が表示する月 (Phase 5A.5)
 *
 * currentMonth は YYYY-MM string で持つ (Date を直接 store に置くと参照不一致で
 * memo 化が壊れがち)。Mobile only state、永続化なし。
 */

import { create } from "zustand";

/** YYYY-MM 形式 (例: "2026-04") */
export type YearMonth = string;

interface CalendarMonthState {
  currentMonth: YearMonth;
  setCurrentMonth: (ym: YearMonth) => void;
  shiftMonth: (delta: number) => void;
}

function fmt(d: Date): YearMonth {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function parse(ym: YearMonth): Date {
  const [y, m] = ym.split("-").map(Number);
  return new Date(y!, (m ?? 1) - 1, 1);
}

export function ymToDate(ym: YearMonth): Date {
  return parse(ym);
}

export function dateToYm(d: Date): YearMonth {
  return fmt(d);
}

// 8.55: 初期表示は実時刻の月 (旧 MOCK_TODAY=2026-05 固定はリアルタイム性を壊していた)
const initialMonth = fmt(new Date());

export const useCalendarMonthStore = create<CalendarMonthState>()((set) => ({
  currentMonth: initialMonth,
  setCurrentMonth: (ym) => set({ currentMonth: ym }),
  shiftMonth: (delta) =>
    set((s) => {
      const d = parse(s.currentMonth);
      d.setMonth(d.getMonth() + delta);
      return { currentMonth: fmt(d) };
    }),
}));
