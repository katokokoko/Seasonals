/**
 * portfolioHistory — ポートフォリオ評価額の日次スナップショット (Phase 8.56)
 *
 * prefs.ts / theme.ts と同型の zustand + AsyncStorage パターン。
 *
 * **観測した値だけを貯める**: 1 日 1 点 (同じ日は上書き)、過去は捏造しない。
 * chart は 2 点以上たまってから線になる (それまでは現在値カードを出す)。
 * SOL 建てで 1 本化し、USDC 表示は SOL_USD_PRICE 換算で導出する
 * (通貨ごとに二重管理しない)。
 *
 * API 効率化計画 §4.0: **wallet 別に保存する** (`portfolio:history:<address>`)。
 * 旧版は 1 本の `portfolio:history` に接続中 wallet の値を混ぜて貯めていたため、
 * 別 wallet に繋ぎ替えると前の wallet の履歴が線に混ざった。
 *   - `snapshots` は **active wallet の分だけ**。`hydrate(address)` で切り替え、
 *     切替の瞬間に空にする (読込中に前の wallet の点を見せない)
 *   - `record(address, sol)` は active かつ読込済みの wallet にだけ書く
 *     (読込完了前に書くと、保存済みの履歴を今日 1 点で上書きしてしまう)
 *   - 旧 key `portfolio:history` はどの wallet の値か判別できないので移行せず削除する
 *     (過去分は BFF の portfolio-history が tx から復元する。端末の点は fallback)
 */

import { create } from "zustand";
import AsyncStorage from "@react-native-async-storage/async-storage";

import {
  dayKey,
  parseSnapshots,
  upsertSnapshot,
  type PortfolioSnapshot,
} from "../components/portfolio/history";

/** 旧 (wallet 不問) key。読まずに削除する */
export const LEGACY_HISTORY_KEY = "portfolio:history";

export function historyKey(address: string): string {
  return `portfolio:history:${address}`;
}

interface PortfolioHistoryState {
  /** active wallet のスナップショット (未接続なら空) */
  snapshots: PortfolioSnapshot[];
  /** snapshots の持ち主。null = 未接続 */
  activeAddress: string | null;
  /** AsyncStorage から読み終わった wallet (record の書き込み許可) */
  loadedAddress: string | null;
  /** 一度読んだ wallet の in-memory cache (再接続・切替で即表示) */
  byAddress: Record<string, PortfolioSnapshot[]>;
  /** active wallet を切り替え、その wallet の履歴を復元する (null = 未接続 → 空) */
  hydrate: (address: string | null) => Promise<void>;
  /** その日の評価額を記録 (同日は上書き)。0 以下 / 非 active wallet は記録しない */
  record: (address: string, sol: number, today?: Date) => void;
  /** recentWallets から外れた wallet の履歴を消す */
  forget: (address: string) => void;
}

let legacyDropped = false;

export const usePortfolioHistoryStore = create<PortfolioHistoryState>()(
  (set, get) => ({
    snapshots: [],
    activeAddress: null,
    loadedAddress: null,
    byAddress: {},

    hydrate: async (address) => {
      if (!legacyDropped) {
        legacyDropped = true;
        AsyncStorage.removeItem(LEGACY_HISTORY_KEY).catch(() => {});
      }
      if (address === null) {
        set({ activeAddress: null, loadedAddress: null, snapshots: [] });
        return;
      }
      const cached = get().byAddress[address];
      if (cached) {
        set({ activeAddress: address, loadedAddress: address, snapshots: cached });
        return;
      }
      // 読込中は空 (前の wallet の点を出さない)、書き込みも止める
      set({ activeAddress: address, loadedAddress: null, snapshots: [] });
      let loaded: PortfolioSnapshot[] = [];
      try {
        const raw = await AsyncStorage.getItem(historyKey(address));
        if (raw !== null) loaded = parseSnapshots(JSON.parse(raw));
      } catch {
        /* noop — 壊れた JSON は空のまま (履歴は次回から貯め直す) */
      }
      // 読込中に別 wallet へ切り替わっていたら捨てる
      if (get().activeAddress !== address) return;
      set((s) => ({
        loadedAddress: address,
        snapshots: loaded,
        byAddress: { ...s.byAddress, [address]: loaded },
      }));
    },

    record: (address, sol, today = new Date()) => {
      // 未接続 / fixture 時の 0 を貯めない (偽の谷を作らない)
      if (!Number.isFinite(sol) || sol <= 0) return;
      // active でない / 読込前の wallet には書かない
      const { activeAddress, loadedAddress } = get();
      if (address !== activeAddress || address !== loadedAddress) return;
      const day = dayKey(today);
      const prev = get().snapshots;
      const existing = prev.find((s) => s.day === day);
      // 同じ日・同じ値なら書き込みも再 render も起こさない
      if (existing && existing.sol === sol) return;
      const next = upsertSnapshot(prev, { day, sol });
      set((s) => ({
        snapshots: next,
        byAddress: { ...s.byAddress, [address]: next },
      }));
      AsyncStorage.setItem(historyKey(address), JSON.stringify(next)).catch(
        () => {}
      );
    },

    forget: (address) => {
      AsyncStorage.removeItem(historyKey(address)).catch(() => {});
      set((s) => {
        const { [address]: _drop, ...rest } = s.byAddress;
        return s.activeAddress === address
          ? { byAddress: rest, snapshots: [], loadedAddress: null }
          : { byAddress: rest };
      });
    },
  })
);

/** test 用: 旧 key 削除を 1 回だけにする module フラグを戻す */
export function _resetLegacyDropForTest(): void {
  legacyDropped = false;
}
