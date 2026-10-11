/**
 * helius-limiter — 同時実行数 / 順序 / 失敗で詰まらない / 計数 / retry
 * (ethereum/throttle.test.ts を写したもの。gap は 1ms で実時間をほぼ使わない)
 */
import {
  _setSleepForTest,
  createThrottledFetch,
  fetchJsonWithRetry,
  heliusDataFetch,
  heliusRpcFetch,
  HeliusRpcError,
} from "./helius-limiter";
import { _resetUsageForTest, usageSnapshot } from "../usage";

const KEY = "limiter-test-key";
const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${KEY}`;

describe("createThrottledFetch", () => {
  let fetchSpy: jest.SpyInstance;
  afterEach(() => fetchSpy?.mockRestore());

  test("同時実行数を上限以下に保ち、dispatch 順を保つ", async () => {
    let inFlight = 0;
    let maxSeen = 0;
    const order: string[] = [];
    fetchSpy = jest.spyOn(global, "fetch").mockImplementation(async (input) => {
      inFlight++;
      maxSeen = Math.max(maxSeen, inFlight);
      order.push(String(input));
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return new Response("{}");
    });
    const depths: number[] = [];
    const f = createThrottledFetch({ maxInFlight: 2, minGapMs: 1, onQueueDepth: (d) => depths.push(d) });
    await Promise.all(["a", "b", "c", "d", "e"].map((u) => f(u)));
    expect(maxSeen).toBeLessThanOrEqual(2);
    expect(order).toEqual(["a", "b", "c", "d", "e"]);
    expect(Math.max(...depths)).toBeGreaterThanOrEqual(1);
    expect(f.state()).toEqual({ inFlight: 0, queued: 0 });
  });

  test("失敗 (reject / 同期 throw) で列が詰まらない", async () => {
    let n = 0;
    fetchSpy = jest.spyOn(global, "fetch").mockImplementation(async () => {
      n++;
      if (n % 2 === 1) throw new TypeError("fetch failed");
      return new Response("{}");
    });
    const f = createThrottledFetch({ maxInFlight: 1, minGapMs: 1 });
    const results = await Promise.allSettled([f("1"), f("2"), f("3"), f("4")]);
    expect(results.map((r) => r.status)).toEqual(["rejected", "fulfilled", "rejected", "fulfilled"]);
    // onDispatch が throw しても request は出る
    fetchSpy.mockImplementation(async () => new Response("{}"));
    const g = createThrottledFetch({
      maxInFlight: 1,
      minGapMs: 1,
      onDispatch: () => {
        throw new Error("counter broke");
      },
    });
    await expect(g("x")).resolves.toBeInstanceOf(Response);
    expect(g.state()).toEqual({ inFlight: 0, queued: 0 });
  });

  test("onDispatch の完了 callback に HTTP status (network 失敗は null) が届く", async () => {
    fetchSpy = jest
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(new Response("x", { status: 429 }))
      .mockRejectedValueOnce(new TypeError("fetch failed"));
    const seen: Array<number | null> = [];
    const f = createThrottledFetch({ maxInFlight: 2, minGapMs: 1, onDispatch: () => (s) => seen.push(s) });
    await f("a");
    await f("b").catch(() => undefined);
    expect(seen).toEqual([429, null]);
  });

  test("1 gap 内の N 回の enqueue / 完了でも gap timer は 1 本だけ (順序 / 同時実行数も保つ)", async () => {
    // fake timer (Date も) で gap を決定的に進め、生きている timer 数を直接数える
    jest.useFakeTimers({ doNotFake: ["setImmediate", "nextTick"] });
    try {
      let inFlight = 0;
      let maxSeen = 0;
      const order: string[] = [];
      fetchSpy = jest.spyOn(global, "fetch").mockImplementation(async (input) => {
        inFlight++;
        maxSeen = Math.max(maxSeen, inFlight);
        order.push(String(input));
        await new Promise((r) => setImmediate(r)); // 完了は gap の途中 (timer 待ちの間) に来る
        inFlight--;
        return new Response("{}");
      });
      const f = createThrottledFetch({ maxInFlight: 2, minGapMs: 20 });
      const urls = ["a", "b", "c", "d", "e", "f"];
      let done = false;
      const all = Promise.all(urls.map((u) => f(u))).then(() => {
        done = true;
      });
      // 1 本目だけ即 dispatch、残り 5 本の enqueue は同じ gap 内 → timer は 1 本
      expect(jest.getTimerCount()).toBe(1);
      let maxTimers = 1;
      for (let i = 0; i < 50 && !done; i++) {
        await new Promise((r) => setImmediate(r)); // 完了 → pump (timer 待ち中は増やさない)
        maxTimers = Math.max(maxTimers, jest.getTimerCount());
        await jest.advanceTimersByTimeAsync(20);
        maxTimers = Math.max(maxTimers, jest.getTimerCount());
      }
      await all;
      expect(maxTimers).toBe(1);
      expect(order).toEqual(urls);
      expect(maxSeen).toBeLessThanOrEqual(2);
      expect(f.state()).toEqual({ inFlight: 0, queued: 0 });
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  test("timed() は dispatch 時に AbortSignal を付ける (呼び手の signal があればそちら)", async () => {
    fetchSpy = jest.spyOn(global, "fetch").mockResolvedValue(new Response("{}"));
    const f = createThrottledFetch({ maxInFlight: 1, minGapMs: 1 });
    await f.timed(1000)("a");
    expect((fetchSpy.mock.calls[0]![1] as RequestInit).signal).toBeInstanceOf(AbortSignal);
    const own = new AbortController().signal;
    await f.timed(1000)("b", { signal: own });
    expect((fetchSpy.mock.calls[1]![1] as RequestInit).signal).toBe(own);
    await f("c");
    expect((fetchSpy.mock.calls[2]![1] as RequestInit | undefined)?.signal).toBeUndefined();
  });
});

describe("heliusRpcFetch / heliusDataFetch の計数", () => {
  let fetchSpy: jest.SpyInstance;
  beforeEach(() => _resetUsageForTest());
  afterEach(() => fetchSpy.mockRestore());

  test("JSON-RPC (batch 含む) / DAS / Enhanced を api 別に数え、URL を保持しない", async () => {
    fetchSpy = jest.spyOn(global, "fetch").mockImplementation(async () => new Response("{}"));
    const post = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });
    await heliusRpcFetch(RPC_URL, post({ jsonrpc: "2.0", id: 1, method: "getEpochInfo" }));
    await heliusRpcFetch(RPC_URL, post([{ method: "getAccountInfo" }, { method: "getProgramAccounts" }]));
    await heliusDataFetch(RPC_URL, post({ method: "getAssetsByOwner" }));
    await heliusDataFetch(`https://api.helius.xyz/v0/addresses/W/transactions?api-key=${KEY}&limit=50`);
    const u = usageSnapshot();
    expect(u.byApi).toEqual({ rpc: 3, das: 1, enhanced: 1, parsed: 0 });
    expect(u.requests).toBe(5);
    expect(u.approxCredits).toBe(1 + 1 + 10 + 10 + 100);
    expect(u.byMethod).toMatchObject({
      "rpc:getEpochInfo": 1,
      "rpc:getAccountInfo": 1,
      "rpc:getProgramAccounts": 1,
      "das:getAssetsByOwner": 1,
      "enhanced:addresses.transactions": 1,
    });
    expect(JSON.stringify(u)).not.toContain(KEY);
  });
});

describe("fetchJsonWithRetry", () => {
  let fetchSpy: jest.SpyInstance;
  let sleeps: number[];
  beforeEach(() => {
    _resetUsageForTest();
    sleeps = [];
    _setSleepForTest(async (ms) => {
      sleeps.push(ms);
    });
    fetchSpy = jest.spyOn(global, "fetch");
  });
  afterEach(() => {
    fetchSpy.mockRestore();
    _setSleepForTest(null);
  });

  const init: RequestInit = { method: "POST", body: JSON.stringify({ method: "getAssetsByOwner" }) };

  test("429 (Retry-After 2s) → 200: 待ちは Retry-After、rateLimited を数える", async () => {
    fetchSpy
      .mockResolvedValueOnce(new Response("Too Many Requests", { status: 429, headers: { "retry-after": "2" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ result: { items: [] } })));
    const json = await fetchJsonWithRetry<{ result: unknown }>(RPC_URL, init, {
      label: "getAssetsByOwner",
      fetchImpl: heliusDataFetch.timed(),
    });
    expect(json).toEqual({ result: { items: [] } });
    expect(sleeps).toEqual([2000]);
    const u = usageSnapshot();
    expect(u.rateLimited).toMatchObject({ das: 1, total: 1 });
    expect(u.byMethod["das:getAssetsByOwner"]).toBe(2);
  });

  test("400 は即失敗、message に URL / key を出さない", async () => {
    fetchSpy.mockResolvedValue(new Response(`bad ${RPC_URL}`, { status: 400 }));
    const err = (await fetchJsonWithRetry(RPC_URL, init, { label: "x" }).catch((e: unknown) => e)) as HeliusRpcError;
    expect(err).toBeInstanceOf(HeliusRpcError);
    expect(err.message).toBe("Helius x HTTP 400");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test("再試行しない HTTP 失敗 (400) でも body を cancel してから throw する (socket を返す)", async () => {
    const cancel = jest.fn(() => Promise.resolve());
    const res = { ok: false, status: 400, headers: new Headers(), body: { cancel } } as unknown as Response;
    fetchSpy.mockResolvedValue(res);
    await expect(fetchJsonWithRetry(RPC_URL, init, { label: "x" })).rejects.toThrow("HTTP 400");
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
  });

  test("network 失敗: retryNetworkErrors=false なら 1 回で reject、key は伏せる", async () => {
    fetchSpy.mockRejectedValue(new TypeError(`fetch failed ${RPC_URL}`));
    const err = (await fetchJsonWithRetry(RPC_URL, init, { label: "x", retryNetworkErrors: false }).catch(
      (e: unknown) => e
    )) as HeliusRpcError;
    expect(err.kind).toBe("network");
    expect(err.message).not.toContain(KEY);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test("maxAttempts を増やすと backoff は 500 → 1000 → 2000 → 2000", async () => {
    fetchSpy.mockImplementation(async () => new Response("down", { status: 503 }));
    await expect(fetchJsonWithRetry(RPC_URL, init, { label: "x", maxAttempts: 5 })).rejects.toThrow("HTTP 503");
    expect(fetchSpy).toHaveBeenCalledTimes(5);
    expect(sleeps).toEqual([500, 1000, 2000, 2000]);
  });

  test("JSON でない 200 は parse error (再試行しない)", async () => {
    fetchSpy.mockResolvedValue(new Response("<html>", { status: 200 }));
    await expect(fetchJsonWithRetry(RPC_URL, init, { label: "x" })).rejects.toMatchObject({ kind: "parse" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
