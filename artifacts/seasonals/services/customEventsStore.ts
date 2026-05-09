/**
 * customEventsStore — user-defined Calendar events の persist store
 *
 * Zustand + persist middleware (AsyncStorage)。Mobile UI の Calendar / DailyView /
 * EventDayModal から `useCustomEventsStore` で参照。
 *
 * 個人 metadata なので BFF / MCP には送らず Mobile ローカル限定 (CLAUDE.md §5
 * 「永続化 (non-secret) → AsyncStorage」)。
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import {
  createJSONStorage,
  persist,
  type StateStorage,
} from "zustand/middleware";

import type {
  CustomEvent,
  CustomEventInput,
} from "@workspace/lib/types";

const STORE_KEY = "seasonals.customEvents.v1";

const asyncStorage: StateStorage = {
  getItem: async (key) => (await AsyncStorage.getItem(key)) ?? null,
  setItem: async (key, value) => {
    await AsyncStorage.setItem(key, value);
  },
  removeItem: async (key) => {
    await AsyncStorage.removeItem(key);
  },
};

interface CustomEventsState {
  events: CustomEvent[];
}

interface CustomEventsActions {
  add: (input: CustomEventInput) => CustomEvent;
  update: (id: string, patch: Partial<CustomEventInput>) => void;
  remove: (id: string) => void;
  clearAll: () => void;
}

export const useCustomEventsStore = create<
  CustomEventsState & CustomEventsActions
>()(
  persist(
    (set, get) => ({
      events: [],

      add: (input) => {
        const created: CustomEvent = {
          ...input,
          id: `ce_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          created_at: new Date().toISOString(),
        };
        set({ events: [...get().events, created] });
        return created;
      },

      update: (id, patch) => {
        set({
          events: get().events.map((e) =>
            e.id === id ? { ...e, ...patch } : e
          ),
        });
      },

      remove: (id) => {
        set({ events: get().events.filter((e) => e.id !== id) });
      },

      clearAll: () => set({ events: [] }),
    }),
    {
      name: STORE_KEY,
      storage: createJSONStorage(() => asyncStorage),
    }
  )
);

/** "yyyy-MM-dd" を Date に。tz は local。 */
export function dateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** 指定日の CustomEvent 一覧を返す selector hook */
export function useCustomEventsForDay(day: Date | null): CustomEvent[] {
  const events = useCustomEventsStore((s) => s.events);
  if (!day) return [];
  const key = dateKey(day);
  return events.filter((e) => e.date === key);
}

/** 指定 date range 内の CustomEvent (Calendar 全体描画用) */
export function useAllCustomEvents(): CustomEvent[] {
  return useCustomEventsStore((s) => s.events);
}
