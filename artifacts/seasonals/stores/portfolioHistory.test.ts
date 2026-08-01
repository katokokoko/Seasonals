/**
 * portfolioHistory store — 日次スナップショットの永続化 (Phase 8.56)。
 * prefs.test.ts と同じく AsyncStorage mock 経由で挙動を固定する。
 */
import AsyncStorage from "@react-native-async-storage/async-storage";

import { usePortfolioHistoryStore } from "./portfolioHistory";

const KEY = "portfolio:history";

beforeEach(async () => {
  await AsyncStorage.clear();
  usePortfolioHistoryStore.setState({ snapshots: [] });
});

describe("record", () => {
  it("その日の値を記録し永続化する", async () => {
    usePortfolioHistoryStore.getState().record(0.89, new Date(2026, 7, 1));
    expect(usePortfolioHistoryStore.getState().snapshots).toEqual([
      { day: "2026-08-01", sol: 0.89 },
    ]);
    // setItem は fire-and-forget なので microtask を 1 回流す
    await Promise.resolve();
    expect(JSON.parse((await AsyncStorage.getItem(KEY))!)).toEqual([
      { day: "2026-08-01", sol: 0.89 },
    ]);
  });

  it("同じ日に再度記録すると上書き (1 日 1 点)", () => {
    const { record } = usePortfolioHistoryStore.getState();
    record(0.89, new Date(2026, 7, 1));
    record(0.9, new Date(2026, 7, 1));
    expect(usePortfolioHistoryStore.getState().snapshots).toEqual([
      { day: "2026-08-01", sol: 0.9 },
    ]);
  });

  it("日が変われば点が増える (翌日から線になる)", () => {
    const { record } = usePortfolioHistoryStore.getState();
    record(0.89, new Date(2026, 7, 1));
    record(0.9, new Date(2026, 7, 2));
    expect(usePortfolioHistoryStore.getState().snapshots).toHaveLength(2);
  });

  it("0 / 負 / NaN は記録しない (偽の谷を作らない)", () => {
    const { record } = usePortfolioHistoryStore.getState();
    record(0, new Date(2026, 7, 1));
    record(-1, new Date(2026, 7, 1));
    record(Number.NaN, new Date(2026, 7, 1));
    expect(usePortfolioHistoryStore.getState().snapshots).toEqual([]);
  });

  it("同日・同値の再記録は state を作り直さない (無駄な re-render を避ける)", () => {
    const { record } = usePortfolioHistoryStore.getState();
    record(0.89, new Date(2026, 7, 1));
    const first = usePortfolioHistoryStore.getState().snapshots;
    record(0.89, new Date(2026, 7, 1));
    expect(usePortfolioHistoryStore.getState().snapshots).toBe(first);
  });
});

describe("hydrate", () => {
  it("永続データを復元する", async () => {
    await AsyncStorage.setItem(
      KEY,
      JSON.stringify([{ day: "2026-07-31", sol: 0.88 }])
    );
    await usePortfolioHistoryStore.getState().hydrate();
    expect(usePortfolioHistoryStore.getState().snapshots).toEqual([
      { day: "2026-07-31", sol: 0.88 },
    ]);
  });

  it("壊れた JSON は空のまま (次回から貯め直す)", async () => {
    await AsyncStorage.setItem(KEY, "{ not json");
    await usePortfolioHistoryStore.getState().hydrate();
    expect(usePortfolioHistoryStore.getState().snapshots).toEqual([]);
  });

  it("未保存なら何もしない", async () => {
    await usePortfolioHistoryStore.getState().hydrate();
    expect(usePortfolioHistoryStore.getState().snapshots).toEqual([]);
  });
});
