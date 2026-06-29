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
