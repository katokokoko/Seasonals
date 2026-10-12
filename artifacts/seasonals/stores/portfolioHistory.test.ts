/**
 * portfolioHistory store — 日次スナップショットの永続化 (Phase 8.56)。
 * prefs.test.ts と同じく AsyncStorage mock 経由で挙動を固定する。
 *
 * API 効率化計画 §4.0: wallet 別 key (`portfolio:history:<address>`)。
 * 切替で別 wallet の点を **一瞬でも** 見せないこと、読込前に書かないことを固定する。
 */
import AsyncStorage from "@react-native-async-storage/async-storage";

import {
  _resetLegacyDropForTest,
  historyKey,
  LEGACY_HISTORY_KEY,
  usePortfolioHistoryStore,
} from "./portfolioHistory";

const A = "7nZbHkQqXkr3eW8s2dKvHqBxNz9vC5jPpL2tF6mYrXaA";
const B = "6QGJNXnCjhYkKgPpDm7qRzxBKCj9KugUL2LDHc8sGUUM";

const store = () => usePortfolioHistoryStore.getState();

beforeEach(async () => {
  await AsyncStorage.clear();
  _resetLegacyDropForTest();
  usePortfolioHistoryStore.setState({
    snapshots: [],
    activeAddress: null,
    loadedAddress: null,
    byAddress: {},
  });
});

describe("record", () => {
  beforeEach(async () => {
    await store().hydrate(A);
  });

  it("その日の値を wallet 別 key に記録し永続化する", async () => {
    store().record(A, 0.89, new Date(2026, 7, 1));
    expect(store().snapshots).toEqual([{ day: "2026-08-01", sol: 0.89 }]);
    // setItem は fire-and-forget なので microtask を 1 回流す
    await Promise.resolve();
    expect(JSON.parse((await AsyncStorage.getItem(historyKey(A)))!)).toEqual([
      { day: "2026-08-01", sol: 0.89 },
    ]);
    expect(await AsyncStorage.getItem(LEGACY_HISTORY_KEY)).toBeNull();
  });

  it("同じ日に再度記録すると上書き (1 日 1 点)", () => {
    store().record(A, 0.89, new Date(2026, 7, 1));
    store().record(A, 0.9, new Date(2026, 7, 1));
    expect(store().snapshots).toEqual([{ day: "2026-08-01", sol: 0.9 }]);
  });

  it("日が変われば点が増える (翌日から線になる)", () => {
    store().record(A, 0.89, new Date(2026, 7, 1));
    store().record(A, 0.9, new Date(2026, 7, 2));
    expect(store().snapshots).toHaveLength(2);
  });

  it("0 / 負 / NaN は記録しない (偽の谷を作らない)", () => {
    store().record(A, 0, new Date(2026, 7, 1));
    store().record(A, -1, new Date(2026, 7, 1));
    store().record(A, Number.NaN, new Date(2026, 7, 1));
    expect(store().snapshots).toEqual([]);
  });

  it("同日・同値の再記録は state を作り直さない (無駄な re-render を避ける)", () => {
    store().record(A, 0.89, new Date(2026, 7, 1));
    const first = store().snapshots;
    store().record(A, 0.89, new Date(2026, 7, 1));
    expect(store().snapshots).toBe(first);
  });

  it("active でない wallet の記録は捨てる (別 wallet の値を混ぜない)", async () => {
    store().record(B, 1.5, new Date(2026, 7, 1));
    expect(store().snapshots).toEqual([]);
    await Promise.resolve();
    expect(await AsyncStorage.getItem(historyKey(B))).toBeNull();
  });
});

describe("hydrate (wallet 切替)", () => {
  it("永続データを wallet 別に復元する", async () => {
    await AsyncStorage.setItem(historyKey(A), JSON.stringify([{ day: "2026-07-31", sol: 0.88 }]));
    await AsyncStorage.setItem(historyKey(B), JSON.stringify([{ day: "2026-07-30", sol: 5 }]));
    await store().hydrate(A);
    expect(store().snapshots).toEqual([{ day: "2026-07-31", sol: 0.88 }]);
    await store().hydrate(B);
    expect(store().snapshots).toEqual([{ day: "2026-07-30", sol: 5 }]);
  });

  it("切替の瞬間に前の wallet の点を消す (読込完了を待たない)", async () => {
    await AsyncStorage.setItem(historyKey(A), JSON.stringify([{ day: "2026-07-31", sol: 0.88 }]));
    await store().hydrate(A);
    const pending = store().hydrate(B);
    // 読込中: A の点は見えない、B へはまだ書けない
    expect(store().snapshots).toEqual([]);
    store().record(B, 2, new Date(2026, 7, 1));
    expect(store().snapshots).toEqual([]);
    await pending;
    expect(store().loadedAddress).toBe(B);
  });

  it("読込中に別 wallet へ切り替わったら古い読込結果を捨てる", async () => {
    await AsyncStorage.setItem(historyKey(A), JSON.stringify([{ day: "2026-07-31", sol: 0.88 }]));
    const first = store().hydrate(A);
    const second = store().hydrate(null);
    await Promise.all([first, second]);
    expect(store().activeAddress).toBeNull();
    expect(store().snapshots).toEqual([]);
  });

  it("未接続 (null) は空", async () => {
    await AsyncStorage.setItem(historyKey(A), JSON.stringify([{ day: "2026-07-31", sol: 0.88 }]));
    await store().hydrate(A);
    await store().hydrate(null);
    expect(store().snapshots).toEqual([]);
  });

  it("旧 un-keyed の portfolio:history は移行せず削除する (どの wallet の値か分からない)", async () => {
    await AsyncStorage.setItem(LEGACY_HISTORY_KEY, JSON.stringify([{ day: "2026-07-31", sol: 0.88 }]));
    await store().hydrate(A);
    expect(store().snapshots).toEqual([]);
    await Promise.resolve();
    expect(await AsyncStorage.getItem(LEGACY_HISTORY_KEY)).toBeNull();
  });

  it("壊れた JSON は空のまま (次回から貯め直す)", async () => {
    await AsyncStorage.setItem(historyKey(A), "{ not json");
    await store().hydrate(A);
    expect(store().snapshots).toEqual([]);
    expect(store().loadedAddress).toBe(A);
  });
});

describe("forget", () => {
  it("recentWallets から外れた wallet の永続履歴と in-memory を消す", async () => {
    await store().hydrate(A);
    store().record(A, 0.89, new Date(2026, 7, 1));
    await Promise.resolve();
    await store().hydrate(B);
    store().forget(A);
    await Promise.resolve();
    expect(await AsyncStorage.getItem(historyKey(A))).toBeNull();
    expect(store().byAddress[A]).toBeUndefined();
  });
});
