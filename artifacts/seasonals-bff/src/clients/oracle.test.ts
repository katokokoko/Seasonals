/**
 * §4.6 oracle gate — Pyth push (primary) + RedStone push (secondary) の on-chain 版。
 *   1. evaluateOracle の決定表 全分岐 (tier A / C、pure)
 *   2. on-chain account の decode (2026-10-05 に Helius で取った実 bytes を fixture に固定)
 *   3. getOracleResult: 1 回の getMultipleAccounts、RPC 失敗時の last-good (閾値以内だけ)、tier D
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { OracleSecondaryStatus, OracleSourceStatus } from "@workspace/lib/types";
import { ORACLE_FEEDS, PYTH_PUSH_MAX_AGE_S, REDSTONE_GATEWAY_MAX_AGE_S, REDSTONE_PUSH_MAX_AGE_S } from "@workspace/lib/config/oracle-feeds";
import { _clearOracleCacheForTest, evaluateOracle, getOracleResult } from "./oracle";
import { decodePythPriceUpdate, decodeRedstonePriceData, pythPushAccount, redstonePriceAccount, toUsd8 } from "./oracle-onchain";
import { _setSleepForTest, type RawAccount } from "./helius-rpc";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDT_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const EURC_MINT = "HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr";
const USDS_MINT = "USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA";
const SOL_PYTH = ORACLE_FEEDS[SOL_MINT]!.pythFeedId!;
const USDC_PYTH = ORACLE_FEEDS.EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v!.pythFeedId!;

const src = (price: string, age: number): OracleSourceStatus => ({ available: true, price_usd: price, age_seconds: age });
const rs = (price: string, age: number): OracleSecondaryStatus => ({ source: "redstone", ...src(price, age) });
const NA: OracleSourceStatus = { available: false, price_usd: null, age_seconds: null };
const RS_NA: OracleSecondaryStatus = { source: "redstone", ...NA };
const NONE: OracleSecondaryStatus = { source: null, ...NA };
const evalA = (pyth: OracleSourceStatus, secondary: OracleSecondaryStatus) => evaluateOracle({ symbol: "SOL", tier: "A", pyth, secondary });
const evalC = (pyth: OracleSourceStatus) => evaluateOracle({ symbol: "USDT", tier: "C", pyth, secondary: NONE });

describe("evaluateOracle — §4.6 decision table (tier A: Pyth + RedStone)", () => {
  it("両 fresh、乖離 ≤2% → ok / primary pyth", () => {
    const r = evalA(src("120.00000000", 10), rs("120.50000000", 20));
    expect(r).toMatchObject({ status: "ok", primary: "pyth", price_usd: "120.00000000", tier: "A", block_reason: null, warnings: [] });
    expect(r.divergence_pct).toBeCloseTo(0.415, 2);
  });
  it("両 fresh、乖離 2–5% → warning oracle_divergence_warning", () => {
    const r = evalA(src("100.00000000", 10), rs("103.50000000", 10));
    expect(r.status).toBe("warning");
    expect(r.warnings).toEqual([{ kind: "oracle_divergence_warning", divergencePct: expect.any(Number) }]);
  });
  it("両 fresh、乖離 >5% → blocked oracle_divergence_too_large", () => {
    const r = evalA(src("100.00000000", 10), rs("110.00000000", 10));
    expect(r).toMatchObject({ status: "blocked", primary: null, price_usd: null, block_reason: "oracle_divergence_too_large" });
    expect(r.divergence_pct).toBeGreaterThan(5);
  });
  it("Pyth fresh / RedStone stale → warning oracle_secondary_stale、乖離は評価しない", () => {
    const r = evalA(src("100.00000000", 10), rs("150.00000000", REDSTONE_PUSH_MAX_AGE_S + 1));
    expect(r).toMatchObject({ status: "warning", primary: "pyth", divergence_pct: null });
    expect(r.warnings).toEqual([{ kind: "oracle_secondary_stale", secondaryAgeSeconds: REDSTONE_PUSH_MAX_AGE_S + 1 }]);
  });
  it("Pyth fresh / RedStone 取得失敗 → ok / primary pyth", () => {
    expect(evalA(src("100.00000000", 10), RS_NA)).toMatchObject({ status: "ok", primary: "pyth", warnings: [] });
  });
  it("Pyth stale / RedStone fresh → warning oracle_pyth_stale / primary redstone", () => {
    const r = evalA(src("100.00000000", PYTH_PUSH_MAX_AGE_S + 5), rs("100.10000000", 20));
    expect(r).toMatchObject({ status: "warning", primary: "redstone", price_usd: "100.10000000" });
    expect(r.warnings).toEqual([{ kind: "oracle_pyth_stale", pythAgeSeconds: PYTH_PUSH_MAX_AGE_S + 5 }]);
  });
  it("Pyth 取得失敗 / RedStone fresh → warning oracle_pyth_stale / primary redstone", () => {
    expect(evalA(NA, rs("100.10000000", 20))).toMatchObject({ status: "warning", primary: "redstone" });
  });
  it("両 stale → blocked oracle_both_stale", () => {
    const r = evalA(src("100.00000000", PYTH_PUSH_MAX_AGE_S + 1), rs("100.00000000", REDSTONE_PUSH_MAX_AGE_S + 1));
    expect(r).toMatchObject({ status: "blocked", block_reason: "oracle_both_stale" });
  });
  it("両 取得失敗 → blocked oracle_unavailable", () => {
    expect(evalA(NA, RS_NA)).toMatchObject({ status: "blocked", block_reason: "oracle_unavailable" });
  });
  it("境界: age = 閾値ちょうどは fresh", () => {
    expect(evalA(src("100.00000000", PYTH_PUSH_MAX_AGE_S), rs("100.00000000", REDSTONE_PUSH_MAX_AGE_S))).toMatchObject({ status: "ok" });
  });
});

describe("evaluateOracle — tier C (Pyth のみ)", () => {
  it("Pyth fresh → ok (乖離は評価できない、secondary.source は null)", () => {
    const r = evalC(src("0.99970000", 30));
    expect(r).toMatchObject({ status: "ok", primary: "pyth", tier: "C", divergence_pct: null, warnings: [] });
    expect(r.secondary.source).toBeNull();
  });
  it("Pyth stale → blocked oracle_both_stale (fallback が無い)", () => {
    expect(evalC(src("0.99970000", PYTH_PUSH_MAX_AGE_S + 1))).toMatchObject({ status: "blocked", block_reason: "oracle_both_stale" });
  });
  it("Pyth 取得失敗 → blocked oracle_unavailable", () => {
    expect(evalC(NA)).toMatchObject({ status: "blocked", block_reason: "oracle_unavailable" });
  });
});

describe("evaluateOracle — tier B (Pyth + RedStone gateway)", () => {
  const gw = (price: string, age: number): OracleSecondaryStatus => ({ source: "redstone_gateway", ...src(price, age) });
  const evalB = (pyth: OracleSourceStatus, secondary: OracleSecondaryStatus, pythMaxAgeS?: number) =>
    evaluateOracle({ symbol: "USDT", tier: "B", pyth, secondary, pythMaxAgeS });
  it("両 fresh → ok、乖離を評価する", () => {
    const r = evalB(src("0.99970000", 20), gw("0.99965000", 20));
    expect(r).toMatchObject({ status: "ok", primary: "pyth", tier: "B" });
    expect(r.divergence_pct).toBeCloseTo(0.005, 3);
  });
  it("乖離 >5% → blocked", () => {
    expect(evalB(src("1.00000000", 20), gw("0.90000000", 20))).toMatchObject({ status: "blocked", block_reason: "oracle_divergence_too_large" });
  });
  it("Pyth stale → gateway に fallback + oracle_pyth_stale", () => {
    expect(evalB(src("1.00000000", PYTH_PUSH_MAX_AGE_S + 1), gw("0.99965000", 20))).toMatchObject({ status: "warning", primary: "redstone_gateway" });
  });
  it("gateway の閾値は 60 秒", () => {
    expect(evalB(src("1.00000000", 20), gw("1.00000000", REDSTONE_GATEWAY_MAX_AGE_S + 1)).warnings[0]?.kind).toBe("oracle_secondary_stale");
  });
  it("gateway 取得失敗 (quorum 不足を含む) → Pyth で通す", () => {
    expect(evalB(src("1.00000000", 20), { source: "redstone_gateway", ...NA })).toMatchObject({ status: "ok", primary: "pyth", warnings: [] });
  });
  it("feed 別の Pyth 閾値 (USDG 200 秒): 150 秒は fresh、210 秒は stale", () => {
    expect(evalB(src("1.00000000", 150), gw("1.00000000", 20), 200)).toMatchObject({ status: "ok", primary: "pyth" });
    expect(evalB(src("1.00000000", 210), gw("1.00000000", 20), 200)).toMatchObject({ status: "warning", primary: "redstone_gateway" });
  });
});

// ── on-chain decode (実 bytes) ──

function fixture(name: string): RawAccount & { address: string } {
  const j = JSON.parse(readFileSync(join(__dirname, "../__fixtures__/oracle", `${name}.json`), "utf8")) as { address: string; owner: string; data: string };
  return { address: j.address, owner: j.owner, data: Buffer.from(j.data, "base64") };
}

describe("PDA 導出 (docs の規則で計算した address が実 account と一致)", () => {
  it("Pyth sponsored push (shard 0)", () => {
    expect(pythPushAccount(SOL_PYTH)).toBe(fixture("pyth-sol").address);
    expect(pythPushAccount(USDC_PYTH)).toBe(fixture("pyth-usdc").address);
    expect(pythPushAccount(ORACLE_FEEDS[USDT_MINT]!.pythFeedId!)).toBe("HT2PLQBcG5EiCcNSaMHAjSgd9F98ecpATbk4Sk5oYuM");
  });
  it("RedStone push", () => {
    expect(redstonePriceAccount("SOL")).toBe(fixture("redstone-sol").address);
    expect(redstonePriceAccount("USDC")).toBe(fixture("redstone-usdc").address);
    expect(redstonePriceAccount("JupUSD")).toBe("TJ1xyzZhUX8H8thjF5Uc9DANrSw5zfBNiUrCjw9DCmJ");
  });
});

describe("decodePythPriceUpdate", () => {
  it("実 account を exact な 8 桁 string に (float を通さない)", () => {
    expect(decodePythPriceUpdate(fixture("pyth-sol"), SOL_PYTH)).toEqual({ ok: true, price_usd: "120.98446203", publishTimeSec: 1791209472 });
    expect(decodePythPriceUpdate(fixture("pyth-usdc"), USDC_PYTH)).toEqual({ ok: true, price_usd: "0.99993292", publishTimeSec: 1791209467 });
  });
  it("owner / feed id が違う、未検証、無い account は拒否", () => {
    const a = fixture("pyth-sol");
    expect(decodePythPriceUpdate({ ...a, owner: "11111111111111111111111111111111" }, SOL_PYTH).ok).toBe(false);
    expect(decodePythPriceUpdate(a, USDC_PYTH)).toEqual({ ok: false, reason: "feed id mismatch" });
    const partial = Buffer.from(a.data);
    partial[40] = 0;
    expect(decodePythPriceUpdate({ ...a, data: partial }, SOL_PYTH)).toEqual({ ok: false, reason: "price update is not fully verified" });
    expect(decodePythPriceUpdate(null, SOL_PYTH).ok).toBe(false);
  });
});

describe("decodeRedstonePriceData", () => {
  it("実 account を exact な 8 桁 string に (timestamp は ms → 秒)", () => {
    expect(decodeRedstonePriceData(fixture("redstone-sol"), "SOL")).toEqual({ ok: true, price_usd: "121.03883280", publishTimeSec: 1791209442 });
    expect(decodeRedstonePriceData(fixture("redstone-usdc"), "USDC")).toEqual({ ok: true, price_usd: "0.99985993", publishTimeSec: 1791209424 });
  });
  it("feed id 違い / owner 違い / 価格 0 は拒否", () => {
    const a = fixture("redstone-sol");
    expect(decodeRedstonePriceData(a, "USDC")).toEqual({ ok: false, reason: "feed id mismatch" });
    expect(decodeRedstonePriceData({ ...a, owner: "11111111111111111111111111111111" }, "SOL").ok).toBe(false);
    const zero = Buffer.from(a.data);
    zero.fill(0, 40, 72);
    expect(decodeRedstonePriceData({ ...a, data: zero }, "SOL")).toEqual({ ok: false, reason: "non-positive price" });
  });
});

test("toUsd8 は桁を bigint のまま合わせる", () => {
  expect(toUsd8(12098446203n, 8)).toBe("120.98446203");
  expect(toUsd8(99993292n, 8)).toBe("0.99993292");
  expect(toUsd8(5n, 10)).toBe("0.00000000");
  expect(toUsd8(123n, 2)).toBe("1.23000000");
});

// ── getOracleResult (Helius は fetch spy で差し替え) ──

function rpcReturning(accounts: Array<RawAccount | null>) {
  return jest.spyOn(global, "fetch").mockImplementation(
    async () =>
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "x",
          result: { value: accounts.map((a) => (a ? { owner: a.owner, data: [a.data.toString("base64"), "base64"] } : null)) },
        }),
        { status: 200 }
      )
  );
}

describe("getOracleResult", () => {
  const savedKey = process.env.HELIUS_API_KEY;
  beforeEach(() => {
    process.env.HELIUS_API_KEY = "test-key";
    _clearOracleCacheForTest();
    // RPC 失敗の backoff を待たない (fake timer と組み合わせると解決しない)
    _setSleepForTest(async () => undefined);
    // fixture の publish time に時計を合わせる (Pyth 10 秒前 / RedStone 40 秒前)
    jest.useFakeTimers({ now: (1791209482) * 1000, doNotFake: ["nextTick", "setImmediate"] });
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    _setSleepForTest(null);
    if (savedKey === undefined) delete process.env.HELIUS_API_KEY;
    else process.env.HELIUS_API_KEY = savedKey;
  });

  it("tier A: Pyth と RedStone を 1 回の getMultipleAccounts で読んで判定する", async () => {
    const spy = rpcReturning([fixture("pyth-sol"), fixture("redstone-sol")]);
    const r = await getOracleResult(SOL_MINT);
    expect(r).toMatchObject({ status: "ok", primary: "pyth", tier: "A", price_usd: "120.98446203" });
    expect(r.secondary).toEqual({ source: "redstone", available: true, price_usd: "121.03883280", age_seconds: 40 });
    expect(spy).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String((spy.mock.calls[0]![1] as RequestInit).body));
    expect(body.method).toBe("getMultipleAccounts");
    expect(body.params[0]).toEqual([fixture("pyth-sol").address, fixture("redstone-sol").address]);
  });

  it("RPC 失敗は last-good で吸収するが、閾値を超えたら unavailable (fail-closed)", async () => {
    rpcReturning([fixture("pyth-sol"), fixture("redstone-sol")]);
    await getOracleResult(SOL_MINT);
    jest.restoreAllMocks();
    jest.spyOn(global, "fetch").mockRejectedValue(new Error("network down"));
    _clearCacheOnly();
    jest.setSystemTime((1791209472 + 30) * 1000);
    expect(await getOracleResult(SOL_MINT)).toMatchObject({ status: "ok", primary: "pyth" });
    // RedStone の last-good だけ予算 (90 秒) を超える → secondary は unavailable、Pyth (61 秒前) で通す
    _clearCacheOnly();
    jest.setSystemTime((1791209442 + REDSTONE_PUSH_MAX_AGE_S + 1) * 1000);
    const r = await getOracleResult(SOL_MINT);
    expect(r).toMatchObject({ status: "ok", primary: "pyth" });
    expect(r.secondary).toMatchObject({ source: "redstone", available: false });
    // Pyth の last-good も予算 (75 秒) を超える → どちらも使えず oracle_unavailable
    _clearCacheOnly();
    jest.setSystemTime((1791209472 + PYTH_PUSH_MAX_AGE_S + 1) * 1000);
    expect(await getOracleResult(SOL_MINT)).toMatchObject({ status: "blocked", block_reason: "oracle_unavailable" });
  });

  it("tier C (EURC) は Pyth の account だけを読み、gateway は呼ばない", async () => {
    const spy = rpcReturning([fixture("pyth-usdc")]); // feed id 不一致で unavailable になる (layout は同じ)
    const r = await getOracleResult(EURC_MINT);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String((spy.mock.calls[0]![1] as RequestInit).body)).params[0]).toEqual(["HyBsZY1UiGttbQ3ppBmnFVss9rmDAEvEbtYxdfjNAqBZ"]);
    expect(r).toMatchObject({ tier: "C", status: "blocked", block_reason: "oracle_unavailable" });
    expect(r.secondary.source).toBeNull();
  });

  it("tier B (USDT): Pyth は RPC、secondary は gateway の署名検証済み中央値", async () => {
    const gwFx = JSON.parse(readFileSync(join(__dirname, "../__fixtures__/oracle/redstone-gateway.json"), "utf8"));
    jest.setSystemTime(gwFx.USDT[0].timestampMilliseconds + 20_000);
    const calls: string[] = [];
    jest.spyOn(global, "fetch").mockImplementation(async (url) => {
      calls.push(String(url));
      if (String(url).includes("redstone.finance")) return new Response(JSON.stringify({ USDT: gwFx.USDT }), { status: 200 });
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: "x", result: { value: [null] } }), { status: 200 });
    });
    const r = await getOracleResult(USDT_MINT);
    expect(r.tier).toBe("B");
    expect(r.secondary).toEqual({ source: "redstone_gateway", available: true, price_usd: "0.99965000", age_seconds: 20 });
    // Pyth の account が無い (null) → gateway に fallback
    expect(r).toMatchObject({ status: "warning", primary: "redstone_gateway", price_usd: "0.99965000" });
    expect(calls.filter((c) => c.includes("redstone.finance"))).toHaveLength(1);
  });

  it("tier D は RPC を呼ばず not_configured + reason で通す", async () => {
    const spy = jest.spyOn(global, "fetch");
    const r = await getOracleResult(USDS_MINT);
    expect(r).toMatchObject({ status: "ok", tier: "D", not_configured: true, primary: null });
    expect(r.reason).toMatch(/stopped updating/);
    expect(spy).not.toHaveBeenCalled();
  });

  it("registry 外の mint も not_configured (理由付き)", async () => {
    const r = await getOracleResult("Unknown11111111111111111111111111111111111");
    expect(r).toMatchObject({ tier: "D", not_configured: true, reason: "Not in the oracle registry." });
  });
});

/** result cache だけ消す (last-good は残す) — RPC 失敗時の挙動を見るため */
function _clearCacheOnly() {
  // cache TTL (ok 12 秒) を越える: fake timer を進めるより直接時計を動かす方が意図が明確
  jest.advanceTimersByTime(13_000);
}
