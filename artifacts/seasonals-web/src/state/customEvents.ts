/**
 * Custom events store — ユーザーが Calendar に手入力した予定 (TGE / airdrop / unlock 等)。
 *
 * 形は mobile の services/customEventsStore.ts と同じ (型は lib の CustomEvent)。
 * 個人 metadata なので BFF / MCP には送らず、このブラウザの localStorage にだけ置く。
 * 表示は useTimeline() が fromCustomEvent で TimelineEvent (user_plan) に射影して混ぜる。
 */
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { PositionCategory } from "@workspace/lib/types";
import type { CustomEvent } from "@workspace/lib/types";
import { safeStorage } from "./storage";

/** フォーム入力 (category / marker は web では固定) */
export interface CustomPlanInput {
  date: string;
  title: string;
  emoji: string;
  note?: string;
}

interface CustomEventsState {
  events: CustomEvent[];
  add: (input: CustomPlanInput) => CustomEvent;
  update: (id: string, input: CustomPlanInput) => void;
  remove: (id: string) => void;
}

function fields(input: CustomPlanInput): Pick<CustomEvent, "date" | "title" | "note" | "category" | "marker" | "emoji"> {
  const note = input.note?.trim();
  return {
    date: input.date,
    title: input.title.trim(),
    ...(note ? { note } : {}),
    category: PositionCategory.Other,
    marker: "emoji",
    emoji: input.emoji,
  };
}

export const useCustomEvents = create<CustomEventsState>()(
  persist(
    (set) => ({
      events: [],
      add: (input) => {
        const created: CustomEvent = {
          ...fields(input),
          id: `ce_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          created_at: new Date().toISOString(),
        };
        set((s) => ({ events: [...s.events, created] }));
        return created;
      },
      update: (id, input) =>
        set((s) => ({ events: s.events.map((e) => (e.id === id ? { id: e.id, created_at: e.created_at, ...fields(input) } : e)) })),
      remove: (id) => set((s) => ({ events: s.events.filter((e) => e.id !== id) })),
    }),
    { name: "seasonals-web-custom-events-v1", storage: safeStorage, partialize: (s) => ({ events: s.events }) }
  )
);
