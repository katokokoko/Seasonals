/**
 * calendarView — home screen の monthly ↔ daily view 切替 (Phase 5A.2)
 *
 * 単純 Zustand store。Mobile only state、永続化は別途 (現在 default = "monthly")。
 */

import { create } from "zustand";

export type CalendarViewMode = "monthly" | "daily";

interface CalendarViewState {
  viewMode: CalendarViewMode;
  setViewMode: (mode: CalendarViewMode) => void;
  toggle: () => void;
}

export const useCalendarViewStore = create<CalendarViewState>()((set) => ({
  viewMode: "monthly",
  setViewMode: (mode) => set({ viewMode: mode }),
  toggle: () =>
    set((s) => ({ viewMode: s.viewMode === "monthly" ? "daily" : "monthly" })),
}));
