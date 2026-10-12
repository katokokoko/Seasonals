/**
 * TtlCache — B1 の共通 cache primitive (timer 無し、時計は注入)
 */
import { TtlCache, _clearAllCachesForTest, allCacheStats } from "./ttl-cache";

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

afterEach(() => _clearAllCachesForTest());

test("fresh hit は loader を呼ばない、期限後は再読み", async () => {
  const c = clock();
  const cache = new TtlCache<string>({ name: "t.fresh", ttlMs: 1000, now: c.now });
  const loader = jest.fn(async () => "v1");
  expect(await cache.getOrLoad("k", loader)).toBe("v1");
  c.advance(999);
  expect(await cache.getOrLoad("k", loader)).toBe("v1");
  expect(loader).toHaveBeenCalledTimes(1);
  c.advance(1);
  loader.mockResolvedValueOnce("v2");
  expect(await cache.getOrLoad("k", loader)).toBe("v2");
  expect(loader).toHaveBeenCalledTimes(2);
  expect(cache.stats()).toMatchObject({ hits: 1, misses: 2, staleHits: 0, inflightJoins: 0, size: 1 });
});

test("同時 3 本の getOrLoad は loader 1 回を共有する", async () => {
  const cache = new TtlCache<number>({ name: "t.dedupe", ttlMs: 1000, now: clock().now });
  const d = deferred<number>();
  const loader = jest.fn(() => d.promise);
  const all = Promise.all([cache.getOrLoad("k", loader), cache.getOrLoad("k", loader), cache.getOrLoad("k", loader)]);
  d.resolve(42);
  expect(await all).toEqual([42, 42, 42]);
  expect(loader).toHaveBeenCalledTimes(1);
  expect(cache.stats()).toMatchObject({ misses: 1, inflightJoins: 2 });
});

test("SWR 窓では旧値を即返し、裏の更新は 1 回だけ", async () => {
  const c = clock();
  const cache = new TtlCache<string>({ name: "t.swr", ttlMs: 1000, staleWhileRevalidateMs: 5000, now: c.now });
  await cache.getOrLoad("k", async () => "old");
  c.advance(1500);
  const d = deferred<string>();
  const loader = jest.fn(() => d.promise);
  expect(await cache.getOrLoad("k", loader)).toBe("old");
  expect(await cache.getOrLoad("k", loader)).toBe("old");
  expect(loader).toHaveBeenCalledTimes(1);
  d.resolve("new");
  await cache._awaitBackgroundRefreshesForTest();
  expect(cache.get("k")).toBe("new");
  expect(await cache.getOrLoad("k", loader)).toBe("new");
  expect(cache.stats()).toMatchObject({ staleHits: 2, hits: 1 });
});

test("SWR 窓を過ぎたら旧値を返さず待つ", async () => {
  const c = clock();
  const cache = new TtlCache<string>({ name: "t.swr2", ttlMs: 1000, staleWhileRevalidateMs: 1000, now: c.now });
  await cache.getOrLoad("k", async () => "old");
  c.advance(2000);
  expect(await cache.getOrLoad("k", async () => "new")).toBe("new");
});

test("SWR の裏更新が失敗しても旧値を残す", async () => {
  const c = clock();
  const cache = new TtlCache<string>({ name: "t.swrfail", ttlMs: 1000, staleWhileRevalidateMs: 5000, now: c.now });
  await cache.getOrLoad("k", async () => "old");
  c.advance(1500);
  expect(await cache.getOrLoad("k", async () => Promise.reject(new Error("boom")))).toBe("old");
  await cache._awaitBackgroundRefreshesForTest();
  expect(cache.peek("k")).toEqual({ value: "old", ageMs: 1500 });
});

test("loader 失敗は cache を汚さない (次の呼び手が再読み)", async () => {
  const cache = new TtlCache<string>({ name: "t.reject", ttlMs: 1000, now: clock().now });
  await expect(cache.getOrLoad("k", async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
  expect(cache.peek("k")).toBeUndefined();
  const loader = jest.fn(async () => "ok");
  expect(await cache.getOrLoad("k", loader)).toBe("ok");
  expect(loader).toHaveBeenCalledTimes(1);
});

test("上限超過は挿入順で古い方から落とし、set は挿入順を更新する", () => {
  const cache = new TtlCache<number>({ name: "t.evict", ttlMs: 1000, maxEntries: 2, now: clock().now });
  cache.set("a", 1);
  cache.set("b", 2);
  cache.set("a", 11); // 再挿入 → b が最古
  cache.set("c", 3);
  expect(cache.get("b")).toBeUndefined();
  expect(cache.get("a")).toBe(11);
  expect(cache.get("c")).toBe(3);
  expect(cache.stats().size).toBe(2);
});

test("entry ごとの TTL 上書き (set / getOrLoad の ttlMs)", async () => {
  const c = clock();
  const cache = new TtlCache<{ partial: boolean }>({ name: "t.ttl", ttlMs: 60_000, now: c.now });
  cache.set("short", { partial: true }, { ttlMs: 5000 });
  await cache.getOrLoad("dyn", async () => ({ partial: true }), { ttlMs: (v) => (v.partial ? 5000 : 60_000) });
  await cache.getOrLoad("full", async () => ({ partial: false }), { ttlMs: (v) => (v.partial ? 5000 : 60_000) });
  c.advance(5000);
  expect(cache.get("short")).toBeUndefined();
  expect(cache.get("dyn")).toBeUndefined();
  expect(cache.get("full")).toEqual({ partial: false });
});

test("delete は進行中の load を切り離す (結果は返すが cache に書かない)", async () => {
  const cache = new TtlCache<string>({ name: "t.delete", ttlMs: 1000, now: clock().now });
  const d = deferred<string>();
  const p = cache.getOrLoad("k", () => d.promise);
  cache.delete("k");
  const loader2 = jest.fn(async () => "fresh");
  expect(await cache.getOrLoad("k", loader2)).toBe("fresh"); // 切り離し後は合流せず新しく読む
  d.resolve("stale-read");
  expect(await p).toBe("stale-read");
  expect(cache.get("k")).toBe("fresh");
});

test("deleteWhere は合う key の entry と進行中の load だけを消す", async () => {
  const cache = new TtlCache<string>({ name: "t.deleteWhere", ttlMs: 1000, now: clock().now });
  await cache.getOrLoad("a|1", async () => "a1");
  await cache.getOrLoad("a|2", async () => "a2");
  await cache.getOrLoad("b|1", async () => "b1");
  const d = deferred<string>();
  const p = cache.getOrLoad("a|3", () => d.promise);
  cache.deleteWhere((k) => k.startsWith("a|"));
  expect(cache.get("a|1")).toBeUndefined();
  expect(cache.get("a|2")).toBeUndefined();
  expect(cache.get("b|1")).toBe("b1");
  d.resolve("stale");
  expect(await p).toBe("stale");
  expect(cache.get("a|3")).toBeUndefined(); // 切り離した load は書かない
});

test("registry: allCacheStats と _clearAllCachesForTest", async () => {
  const cache = new TtlCache<number>({ name: "t.registry", ttlMs: 1000, now: clock().now });
  await cache.getOrLoad("k", async () => 1);
  await cache.getOrLoad("k", async () => 1);
  expect(allCacheStats()["t.registry"]).toEqual({ hits: 1, misses: 1, staleHits: 0, inflightJoins: 0, size: 1 });
  _clearAllCachesForTest();
  expect(allCacheStats()["t.registry"]).toEqual({ hits: 0, misses: 0, staleHits: 0, inflightJoins: 0, size: 0 });
  const unlisted = new TtlCache<number>({ name: "t.unlisted", ttlMs: 1000, register: false });
  unlisted.set("k", 1);
  expect(allCacheStats()["t.unlisted"]).toBeUndefined();
});

test("loader の同期 throw: 1 回目は reject、in-flight に残らず 2 回目は loader を呼び直す", async () => {
  const cache = new TtlCache<string>({ name: "t.syncthrow", ttlMs: 1000, now: clock().now });
  const loader = jest.fn((): Promise<string> => {
    throw new Error("sync boom");
  });
  await expect(cache.getOrLoad("k", loader)).rejects.toThrow("sync boom");
  loader.mockImplementationOnce(async () => "ok");
  expect(await cache.getOrLoad("k", loader)).toBe("ok");
  expect(loader).toHaveBeenCalledTimes(2);
  expect(cache.stats()).toMatchObject({ misses: 2, inflightJoins: 0, size: 1 });
});
