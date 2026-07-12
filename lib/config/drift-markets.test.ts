/**
 * Drift spot market registry — テスト (Phase 8.15e)
 */
import {
  DRIFT_MARKETS,
  findDriftMarketByAsset,
  findDriftMarketByKey,
  findDriftMarketByPool,
} from "./drift-markets";

describe("DRIFT_MARKETS 整合性", () => {
  it("USDC(0) / SOL(1) を含み、pool_id / position_key / market_index は一意", () => {
    const pools = DRIFT_MARKETS.map((m) => m.pool_id);
    const keys = DRIFT_MARKETS.map((m) => m.position_key);
    const idx = DRIFT_MARKETS.map((m) => m.market_index);
    expect(new Set(pools).size).toBe(pools.length);
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(idx).size).toBe(idx.length);
    expect(findDriftMarketByAsset("USDC")?.market_index).toBe(0);
    expect(findDriftMarketByAsset("SOL")?.market_index).toBe(1);
  });

  it("position_key は drift_spot_{index} 形式", () => {
    for (const m of DRIFT_MARKETS) {
      expect(m.position_key).toBe(`drift_spot_${m.market_index}`);
      expect(m.underlying_mint.length).toBeGreaterThan(31);
      expect(m.underlying_decimals).toBeGreaterThan(0);
    }
  });
});

describe("find helpers", () => {
  it("pool_id / key / asset で解決、未知は undefined", () => {
    expect(findDriftMarketByPool("drift_usdc_spot")?.position_key).toBe(
      "drift_spot_0"
    );
    expect(findDriftMarketByKey("drift_spot_1")?.underlying_symbol).toBe("SOL");
    expect(findDriftMarketByPool("drift_insurance_fund")).toBeUndefined();
    expect(findDriftMarketByKey("drift_spot_9")).toBeUndefined();
    expect(findDriftMarketByAsset("JLP")).toBeUndefined();
  });
});
