/**
 * portfolioHistory — ポートフォリオ評価額の日次スナップショット (Phase 8.56)
 *
 * prefs.ts / theme.ts と同型の zustand + AsyncStorage パターン。
 *
 * **観測した値だけを貯める**: 1 日 1 点 (同じ日は上書き)、過去は捏造しない。
 * chart は 2 点以上たまってから線になる (それまでは現在値カードを出す)。
 * SOL 建てで 1 本化し、USDC 表示は SOL_USD_PRICE 換算で導出する
 * (通貨ごとに二重管理しない)。
 */

import { create } from "zustand";
import AsyncStorage from "@react-native-async-storage/async-storage";

import {
  dayKey,
  parseSnapshots,
  upsertSnapshot,
  type PortfolioSnapshot,
} from "../components/portfolio/history";

const KEY = "portfolio:history";

interface PortfolioHistoryState {
  snapshots: PortfolioSnapshot[];
  /** AsyncStorage から復元 (起動時 1 回、_layout で呼ぶ) */
  hydrate: () => Promise<void>;
  /** その日の評価額を記録 (同日は上書き)。0 以下は記録しない */
  record: (sol: number, today?: Date) => void;
}

export const usePortfolioHistoryStore = create<PortfolioHistoryState>()(
  (set, get) => ({
    snapshots: [],

    hydrate: async () => {
      try {
        const raw = await AsyncStorage.getItem(KEY);
        if (raw === null) return;
        set({ snapshots: parseSnapshots(JSON.parse(raw)) });
      } catch {
        /* noop — 壊れた JSON は空のまま (履歴は次回から貯め直す) */
      }
    },

    record: (sol, today = new Date()) => {
      // 未接続 / fixture 時の 0 を貯めない (偽の谷を作らない)
      if (!Number.isFinite(sol) || sol <= 0) return;
      const day = dayKey(today);
      const prev = get().snapshots;
      const existing = prev.find((s) => s.day === day);
      // 同じ日・同じ値なら書き込みも再 render も起こさない
      if (existing && existing.sol === sol) return;
      const next = upsertSnapshot(prev, { day, sol });
      set({ snapshots: next });
      AsyncStorage.setItem(KEY, JSON.stringify(next)).catch(() => {});
    },
  })
);
