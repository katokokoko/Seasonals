/**
 * Phase 8.14: evaluateOracle の §4.6 decision table 全分岐 (pure、network なし)。
 */
import { evaluateOracle } from "./oracle";
import type { OracleSourceStatus } from "@workspace/lib/types";

const fresh = (price: string, age = 2): OracleSourceStatus => ({
  available: true,
  price_usd: price,
  age_seconds: age,
});
const stale = (price: string, age = 120): OracleSourceStatus => ({
  available: true,
  price_usd: price,
  age_seconds: age,
});
const sbFresh = (price: string): OracleSourceStatus => ({
  available: true,
  price_usd: price,
  age_seconds: 0,
});
const NA: OracleSourceStatus = {
  available: false,
  price_usd: null,
  age_seconds: null,
};

describe("evaluateOracle — §4.6 decision table", () => {
  it("pyth fresh + sb fresh, 乖離≤2% → ok / primary=pyth", () => {
    const r = evaluateOracle("SOL", fresh("71.00000000"), sbFresh("71.50000000"));
    expect(r.status).toBe("ok");
    expect(r.primary).toBe("pyth");
    expect(r.price_usd).toBe("71.00000000");
    expect(r.block_reason).toBeNull();
    expect(r.warnings).toHaveLength(0);
    expect(r.divergence_pct).not.toBeNull();
    expect(r.divergence_pct!).toBeLessThan(2);
  });

  it("乖離 2-5% → warning oracle_divergence_warning (通す)", () => {
    const r = evaluateOracle("SOL", fresh("71.00000000"), sbFresh("73.50000000"));
    expect(r.status).toBe("warning");
    expect(r.primary).toBe("pyth");
    expect(r.warnings.map((w) => w.kind)).toContain("oracle_divergence_warning");
    expect(r.divergence_pct!).toBeGreaterThanOrEqual(2);
    expect(r.divergence_pct!).toBeLessThanOrEqual(5);
    expect(r.block_reason).toBeNull();
  });

  it("乖離 >5% → blocked oracle_divergence_too_large", () => {
    const r = evaluateOracle("SOL", fresh("71.00000000"), sbFresh("80.00000000"));
    expect(r.status).toBe("blocked");
    expect(r.block_reason).toBe("oracle_divergence_too_large");
    expect(r.price_usd).toBeNull();
    expect(r.divergence_pct!).toBeGreaterThan(5);
  });

  it("pyth stale + sb fresh → warning oracle_pyth_stale / primary=switchboard", () => {
    const r = evaluateOracle("SOL", stale("71.00000000", 120), sbFresh("71.40000000"));
    expect(r.status).toBe("warning");
    expect(r.primary).toBe("switchboard");
    expect(r.price_usd).toBe("71.40000000");
    expect(r.warnings.map((w) => w.kind)).toContain("oracle_pyth_stale");
    // stale price 比較はしない → divergence は評価されない
    expect(r.divergence_pct).toBeNull();
  });

  it("pyth stale + sb unavailable → blocked oracle_both_stale", () => {
    const r = evaluateOracle("SOL", stale("71.00000000", 200), NA);
    expect(r.status).toBe("blocked");
    expect(r.block_reason).toBe("oracle_both_stale");
    expect(r.price_usd).toBeNull();
  });

  it("両 unavailable → blocked oracle_unavailable", () => {
    const r = evaluateOracle("SOL", NA, NA);
    expect(r.status).toBe("blocked");
    expect(r.block_reason).toBe("oracle_unavailable");
    expect(r.primary).toBeNull();
  });

  it("pyth fresh + sb unavailable → ok / primary=pyth (USDC のような片肺)", () => {
    const r = evaluateOracle("USDC", fresh("0.99960000"), NA);
    expect(r.status).toBe("ok");
    expect(r.primary).toBe("pyth");
    expect(r.price_usd).toBe("0.99960000");
    expect(r.divergence_pct).toBeNull();
    expect(r.warnings).toHaveLength(0);
  });

  it("pyth unavailable + sb fresh → warning oracle_pyth_stale / primary=switchboard", () => {
    const r = evaluateOracle("SOL", NA, sbFresh("71.40000000"));
    expect(r.status).toBe("warning");
    expect(r.primary).toBe("switchboard");
    expect(r.price_usd).toBe("71.40000000");
    expect(r.warnings.map((w) => w.kind)).toContain("oracle_pyth_stale");
  });

  it("境界: age=60 は fresh (≤60)", () => {
    const r = evaluateOracle("SOL", fresh("71.00000000", 60), NA);
    expect(r.status).toBe("ok");
    expect(r.primary).toBe("pyth");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 8.78: last-good フォールバック — Hermes/Crossbar の瞬断を §4.6 の
// staleness 予算 (60 秒) の範囲内でだけ吸収する。USDC は Pyth 片肺なので、
// これが無いと 1 fetch 失敗 = 即 oracle_unavailable → execution block だった。
// ─────────────────────────────────────────────────────────────────────────────

import {
  fetchPyth,
  fetchSwitchboard,
  _clearOracleCacheForTest,
} from "./oracle";

const FEED = "0xfeed";

function hermesOk(price: string, publishTimeSec: number) {
  return {
    ok: true,
    json: async () => ({
      parsed: [{ price: { price, expo: -8, publish_time: publishTimeSec } }],
    }),
  } as unknown as Response;
}

describe("8.78: fetchPyth last-good フォールバック", () => {
  const realFetch = global.fetch;
  beforeEach(() => {
    jest.useFakeTimers();
    _clearOracleCacheForTest();
  });
  afterEach(() => {
    jest.useRealTimers();
    global.fetch = realFetch;
  });

  it("成功直後の fetch 失敗は last-good で吸収 (age は実時間で再計算)", async () => {
    const t0 = 1_700_000_000_000;
    jest.setSystemTime(t0);
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(hermesOk("9997823600", t0 / 1000 - 2))
      .mockRejectedValueOnce(new Error("The user aborted a request."));

    const first = await fetchPyth(FEED);
    expect(first.available).toBe(true);

    // 10 秒後に Hermes が落ちる
    jest.setSystemTime(t0 + 10_000);
    const second = await fetchPyth(FEED);
    expect(second.available).toBe(true);
    expect(second.price_usd).toBe(first.price_usd);
    // publish から 12 秒 (2 + 10) — 正直な age
    expect(second.age_seconds).toBe(12);
  });

  it("last-good が 60 秒予算を超えていたら使わない (fail-closed 維持)", async () => {
    const t0 = 1_700_000_000_000;
    jest.setSystemTime(t0);
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(hermesOk("9997823600", t0 / 1000))
      .mockRejectedValue(new Error("timeout"));

    await fetchPyth(FEED);
    jest.setSystemTime(t0 + 61_000); // publish から 61 秒
    const r = await fetchPyth(FEED);
    expect(r.available).toBe(false);
  });

  it("last-good が無いままの失敗は従来どおり unavailable", async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error("ECONNRESET"));
    const r = await fetchPyth(FEED);
    expect(r.available).toBe(false);
  });
});

describe("8.78: fetchSwitchboard last-good フォールバック", () => {
  const realFetch = global.fetch;
  beforeEach(() => {
    jest.useFakeTimers();
    _clearOracleCacheForTest();
  });
  afterEach(() => {
    jest.useRealTimers();
    global.fetch = realFetch;
  });

  it("成功 → 失敗で取得時刻起点の 60 秒以内なら吸収する", async () => {
    const t0 = 1_700_000_000_000;
    jest.setSystemTime(t0);
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [{ results: ["71.5"] }],
      } as unknown as Response)
      .mockRejectedValue(new Error("timeout"));

    const first = await fetchSwitchboard(FEED);
    expect(first.available).toBe(true);

    jest.setSystemTime(t0 + 30_000);
    const second = await fetchSwitchboard(FEED);
    expect(second.available).toBe(true);
    expect(second.age_seconds).toBe(30);

    jest.setSystemTime(t0 + 61_000);
    const third = await fetchSwitchboard(FEED);
    expect(third.available).toBe(false);
  });
});
