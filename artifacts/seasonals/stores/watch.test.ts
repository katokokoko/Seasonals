/**
 * watch store — watch-only address mode の watchlist (web の session.ts の移植)
 *
 *   - addWatch: trim → 検証、不正はエラー文、dedupe で先頭へ + select、MAX_WATCH で末尾を落とす
 *   - removeWatch / select / reset
 *   - 永続化 (AsyncStorage) と merge での不正 entry / list 外 selected の除去
 *
 * AsyncStorage は jest.setup の in-memory mock。
 */
import AsyncStorage from "@react-native-async-storage/async-storage";

import {
  INVALID_WATCH_ADDRESS_ERROR,
  MAX_WATCH,
  WATCH_STORE_KEY,
  normalizeWatchAddress,
  sanitizeWatchState,
  useWatchStore,
} from "./watch";

const A = "7nZbHkQqXkr3eW8s2dKvHqBxNz9vC5jPpL2tF6mYrXaA";
const B = "6QGJNXnCjhYkKgPpDm7qRzxBKCj9KugUL2LDHc8sGUUM";

/** base58 の 44 文字を n ごとに変えた address */
const addr = (n: number) => `${"1".repeat(43)}${"ABCDEFGHJK"[n]}`;

beforeEach(async () => {
  await AsyncStorage.clear();
  useWatchStore.getState().reset();
});

describe("normalizeWatchAddress", () => {
  it("前後の空白 / 改行を trim する", () => {
    expect(normalizeWatchAddress(`  ${A}\n`)).toBe(A);
  });

  it("base58 以外 / 長さ不正 / prefix 付きは null", () => {
    expect(normalizeWatchAddress("")).toBeNull();
    expect(normalizeWatchAddress("0x" + "a".repeat(40))).toBeNull();
    expect(normalizeWatchAddress(`solana:${A}`)).toBeNull();
    expect(normalizeWatchAddress(A.slice(0, 20))).toBeNull();
    expect(normalizeWatchAddress(A.replace("7", "0"))).toBeNull();
  });
});

describe("useWatchStore actions", () => {
  it("addWatch は正規化して先頭に入れ、選択する", () => {
    const r = useWatchStore.getState().addWatch(` ${A} `);
    expect(r).toEqual({ ok: true, address: A });
    expect(useWatchStore.getState().watchlist).toEqual([A]);
    expect(useWatchStore.getState().selected).toBe(A);
  });

  it("addWatch は不正 address でエラー文を返し state を変えない", () => {
    const r = useWatchStore.getState().addWatch("not-an-address");
    expect(r).toEqual({ ok: false, error: INVALID_WATCH_ADDRESS_ERROR });
    expect(useWatchStore.getState().watchlist).toEqual([]);
    expect(useWatchStore.getState().selected).toBeNull();
  });

  it("既存 address の再追加は重複させず先頭へ移す", () => {
    const s = useWatchStore.getState();
    s.addWatch(A);
    s.addWatch(B);
    s.addWatch(A);
    expect(useWatchStore.getState().watchlist).toEqual([A, B]);
    expect(useWatchStore.getState().selected).toBe(A);
  });

  it(`MAX_WATCH (${MAX_WATCH}) を超えたら最も古いものを落とす`, () => {
    for (let i = 0; i <= MAX_WATCH; i++) useWatchStore.getState().addWatch(addr(i));
    const list = useWatchStore.getState().watchlist;
    expect(list).toHaveLength(MAX_WATCH);
    expect(list[0]).toBe(addr(MAX_WATCH));
    expect(list).not.toContain(addr(0));
  });

  it("removeWatch: selected を消したら list の先頭に移る / 空なら null", () => {
    const s = useWatchStore.getState();
    s.addWatch(A);
    s.addWatch(B); // [B, A], selected B
    s.removeWatch(B);
    expect(useWatchStore.getState()).toMatchObject({ watchlist: [A], selected: A });
    useWatchStore.getState().removeWatch(A);
    expect(useWatchStore.getState()).toMatchObject({ watchlist: [], selected: null });
  });

  it("removeWatch: selected 以外を消しても selected は変わらない", () => {
    const s = useWatchStore.getState();
    s.addWatch(A);
    s.addWatch(B);
    s.removeWatch(A);
    expect(useWatchStore.getState()).toMatchObject({ watchlist: [B], selected: B });
  });

  it("select(null) は監視停止 (list は保持)、list 外の address は無視", () => {
    const s = useWatchStore.getState();
    s.addWatch(A);
    s.select(null);
    expect(useWatchStore.getState()).toMatchObject({ watchlist: [A], selected: null });
    useWatchStore.getState().select(B);
    expect(useWatchStore.getState().selected).toBeNull();
    useWatchStore.getState().select(A);
    expect(useWatchStore.getState().selected).toBe(A);
  });
});

describe("persist", () => {
  it("watchlist と selected だけを AsyncStorage に保存する", async () => {
    useWatchStore.getState().addWatch(A);
    await new Promise((r) => setTimeout(r, 0));
    const raw = await AsyncStorage.getItem(WATCH_STORE_KEY);
    expect(JSON.parse(raw as string).state).toEqual({ watchlist: [A], selected: A });
  });

  it("rehydrate で不正 entry と list 外の selected を落とす", async () => {
    await AsyncStorage.setItem(
      WATCH_STORE_KEY,
      JSON.stringify({
        state: { watchlist: [A, "bogus", A, 42, B], selected: "bogus" },
        version: 0,
      })
    );
    await useWatchStore.persist.rehydrate();
    expect(useWatchStore.getState().watchlist).toEqual([A, B]);
    expect(useWatchStore.getState().selected).toBeNull();
    expect(useWatchStore.persist.hasHydrated()).toBe(true);
  });

  it("sanitizeWatchState: 形の壊れた値は空に倒す", () => {
    expect(sanitizeWatchState(null)).toEqual({ watchlist: [], selected: null });
    expect(sanitizeWatchState({ watchlist: "x", selected: A })).toEqual({
      watchlist: [],
      selected: null,
    });
  });
});
