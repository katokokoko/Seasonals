/**
 * calendarDay — DailyView で選択中の日 (Phase 5A.3)
 *
 * selectedDate は ISO YYYY-MM-DD string。Date object を store に置くと参照不一致で
 * memo 化が壊れるため string で保持し、UI 側で必要に応じて Date 化する。
 */

import { create } from "zustand";

/** ISO 8601 calendar date (YYYY-MM-DD) */
export type CalendarDate = string;

interface CalendarDayState {
  selectedDate: CalendarDate;
  setSelectedDate: (d: CalendarDate) => void;
  shiftDay: (delta: number) => void;
}

function fmt(d: Date): CalendarDate {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function parse(s: CalendarDate): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y!, (m ?? 1) - 1, d ?? 1);
}

export function dateToIso(d: Date): CalendarDate {
  return fmt(d);
}

export function isoToDate(s: CalendarDate): Date {
  return parse(s);
}

const initialDate = fmt(new Date("2026-05-09T00:00:00.000Z")); // MOCK_TODAY 整合

export const useCalendarDayStore = create<CalendarDayState>()((set) => ({
  selectedDate: initialDate,
  setSelectedDate: (d) => set({ selectedDate: d }),
  shiftDay: (delta) =>
    set((s) => {
      const d = parse(s.selectedDate);
      d.setDate(d.getDate() + delta);
      return { selectedDate: fmt(d) };
    }),
}));
