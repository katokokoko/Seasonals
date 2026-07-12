/**
 * Meteora DLMM market registry — テスト (Phase 8.17)
 */
import {
  METEORA_MARKETS,
  findMeteoraMarketByAddress,
  findMeteoraMarketByPool,
} from "./meteora-markets";

describe("METEORA_MARKETS 整合性", () => {
  it("USDC-USDT / SOL-USDC を含み、pool_id / address は一意", () => {
    const pools = METEORA_MARKETS.map((m) => m.pool_id);
    const addrs = METEORA_MARKETS.map((m) => m.pool_address);
    expect(new Set(pools).size).toBe(pools.length);
    expect(new Set(addrs).size).toBe(addrs.length);
    expect(findMeteoraMarketByPool("meteora_usdc_usdt_dlmm")?.deposit_side).toBe("x");
    expect(findMeteoraMarketByPool("meteora_sol_usdc_dlmm")?.deposit_side).toBe("y");
  });

  it("deposit token (single-sided) と mint/decimals が正当", () => {
    const expected: Record<string, [string, number]> = {
      meteora_usdc_usdt_dlmm: ["USDC", 6],
      meteora_sol_usdc_dlmm: ["USDC", 6],
      meteora_jitosol_sol_dlmm: ["SOL", 9],
    };
    expect(METEORA_MARKETS).toHaveLength(3);
    for (const m of METEORA_MARKETS) {
      const [sym, dec] = expected[m.pool_id]!;
      expect(m.deposit_symbol).toBe(sym);
      expect(m.deposit_decimals).toBe(dec);
      expect(m.pool_address.length).toBeGreaterThan(31);
      expect(m.deposit_mint.length).toBeGreaterThan(31);
      expect(m.other_mint.length).toBeGreaterThan(31);
    }
  });

  it("stable_pair (8.19 LP cost-basis): USDC-USDT のみ true", () => {
    expect(findMeteoraMarketByPool("meteora_usdc_usdt_dlmm")?.stable_pair).toBe(true);
    expect(findMeteoraMarketByPool("meteora_sol_usdc_dlmm")?.stable_pair).toBe(false);
    // stable_pair は両脚同 decimals が前提 (1:1 smallest 換算)
    for (const m of METEORA_MARKETS) {
      if (m.stable_pair) expect(m.other_decimals).toBe(m.deposit_decimals);
    }
  });
});

describe("find helpers", () => {
  it("address / pool_id で解決、未知は undefined", () => {
    expect(
      findMeteoraMarketByAddress("ARwi1S4DaiTG5DX7S4M4ZsrXqpMD1MrTmbu9ue2tpmEq")
        ?.pair_name
    ).toBe("USDC-USDT");
    expect(findMeteoraMarketByPool("meteora_jitosol_sol_dlmm")?.pair_name).toBe(
      "JitoSOL-SOL" // 8.27 で registry 入り
    );
    expect(findMeteoraMarketByPool("meteora_unknown_pool")).toBeUndefined();
    expect(findMeteoraMarketByAddress("Unknown111")).toBeUndefined();
  });
});
