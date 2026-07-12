/**
 * Orca Whirlpools market registry — テスト (Phase 8.18)
 */
import {
  ORCA_MARKETS,
  findOrcaMarketByAddress,
  findOrcaMarketByPool,
} from "./orca-markets";

describe("ORCA_MARKETS 整合性", () => {
  it("3 pool を含み、pool_id / address は一意、deposit_side が正当", () => {
    const pools = ORCA_MARKETS.map((m) => m.pool_id);
    const addrs = ORCA_MARKETS.map((m) => m.pool_address);
    expect(ORCA_MARKETS).toHaveLength(3);
    expect(new Set(pools).size).toBe(pools.length);
    expect(new Set(addrs).size).toBe(addrs.length);
    expect(findOrcaMarketByPool("orca_usdc_usdt_whirlpool")?.deposit_side).toBe("a");
    expect(findOrcaMarketByPool("orca_sol_usdc_whirlpool")?.deposit_side).toBe("b");
    expect(findOrcaMarketByPool("orca_jitosol_sol_whirlpool")?.deposit_side).toBe("a");
  });

  it("stable_pair (8.19 LP cost-basis): USDC-USDT のみ true", () => {
    expect(findOrcaMarketByPool("orca_usdc_usdt_whirlpool")?.stable_pair).toBe(true);
    expect(findOrcaMarketByPool("orca_sol_usdc_whirlpool")?.stable_pair).toBe(false);
    expect(findOrcaMarketByPool("orca_jitosol_sol_whirlpool")?.stable_pair).toBe(false);
    // stable_pair は両脚同 decimals が前提 (1:1 smallest 換算)
    for (const m of ORCA_MARKETS) {
      if (m.stable_pair) expect(m.other_decimals).toBe(m.deposit_decimals);
    }
  });

  it("deposit token (zap-in) と mint/decimals/tickSpacing が正当", () => {
    const expected: Record<string, [string, number]> = {
      orca_usdc_usdt_whirlpool: ["USDC", 6],
      orca_sol_usdc_whirlpool: ["USDC", 6],
      orca_jitosol_sol_whirlpool: ["SOL", 9],
    };
    for (const m of ORCA_MARKETS) {
      const [sym, dec] = expected[m.pool_id]!;
      expect(m.deposit_symbol).toBe(sym);
      expect(m.deposit_decimals).toBe(dec);
      expect(m.pool_address.length).toBeGreaterThan(31);
      expect(m.other_mint.length).toBeGreaterThan(31);
      expect(m.tick_spacing).toBeGreaterThan(0);
    }
  });
});

describe("find helpers", () => {
  it("address / pool_id で解決、未知は undefined", () => {
    expect(
      findOrcaMarketByAddress("Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE")
        ?.pair_name
    ).toBe("SOL-USDC");
    expect(findOrcaMarketByPool("orca_jitosol_sol_whirlpool")?.pair_name).toBe(
      "JitoSOL-SOL"
    );
    expect(findOrcaMarketByPool("orca_unknown_pool")).toBeUndefined();
    expect(findOrcaMarketByAddress("Unknown111")).toBeUndefined();
  });
});
