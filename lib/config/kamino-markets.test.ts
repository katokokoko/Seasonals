/**
 * Kamino Lend market registry — テスト (Phase 8.15b)
 *
 * §32.2 same source of truth: deposit/withdraw の解決に使う {market, reserve} registry の
 * 整合性 + find helper を検証する。
 */
import {
  KAMINO_MAIN_MARKET,
  KAMINO_MARKETS,
  KAMINO_VAULTS,
  findKaminoMarketByAsset,
  findKaminoMarketByPool,
  findKaminoMarketByReserve,
  findKaminoVaultByAddress,
  findKaminoVaultByPool,
} from "./kamino-markets";

const USDC_RESERVE = "D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59";
const SOL_RESERVE = "d4A2prbA2whesmvHaL88BH6Ewn5N4bTSU2Ze8P6Bc4Q";

describe("KAMINO_MARKETS 整合性", () => {
  it("USDC / SOL main reserve を含む", () => {
    const assets = KAMINO_MARKETS.map((m) => m.underlying_symbol);
    expect(assets).toEqual(expect.arrayContaining(["USDC", "SOL"]));
  });

  it("reserve address は一意", () => {
    const reserves = KAMINO_MARKETS.map((m) => m.reserve);
    expect(new Set(reserves).size).toBe(reserves.length);
  });

  it("全 market が main market 上で、非空 mint / 正の decimals", () => {
    for (const m of KAMINO_MARKETS) {
      expect(m.protocol_id).toBe("kamino");
      expect(m.market).toBe(KAMINO_MAIN_MARKET);
      expect(m.underlying_mint.length).toBeGreaterThan(31);
      expect(m.reserve.length).toBeGreaterThan(31);
      expect(m.underlying_decimals).toBeGreaterThan(0);
    }
  });

  it("USDC は 6 decimals / SOL は 9 decimals", () => {
    expect(findKaminoMarketByAsset("USDC")?.underlying_decimals).toBe(6);
    expect(findKaminoMarketByAsset("SOL")?.underlying_decimals).toBe(9);
  });
});

describe("findKaminoMarketByReserve", () => {
  it("USDC reserve を解決", () => {
    expect(findKaminoMarketByReserve(USDC_RESERVE)?.underlying_symbol).toBe(
      "USDC"
    );
  });
  it("SOL reserve を解決", () => {
    expect(findKaminoMarketByReserve(SOL_RESERVE)?.underlying_symbol).toBe(
      "SOL"
    );
  });
  it("未登録 reserve は undefined", () => {
    expect(findKaminoMarketByReserve("NotAReserve1111111111111111")).toBeUndefined();
  });
});

describe("findKaminoMarketByPool / findKaminoMarketByAsset", () => {
  it("pool_id kamino_usdc_main → USDC reserve", () => {
    expect(findKaminoMarketByPool("kamino_usdc_main")?.reserve).toBe(
      USDC_RESERVE
    );
  });
  it("pool_id kamino_sol_main → SOL reserve", () => {
    expect(findKaminoMarketByPool("kamino_sol_main")?.reserve).toBe(SOL_RESERVE);
  });
  it("asset SOL → SOL reserve", () => {
    expect(findKaminoMarketByAsset("SOL")?.reserve).toBe(SOL_RESERVE);
  });
  it("未登録 pool / asset は undefined、JLP は 8.27 で登録済", () => {
    expect(findKaminoMarketByPool("kamino_unknown_pool")).toBeUndefined();
    expect(findKaminoMarketByAsset("JLP")?.reserve).toBe(
      "EAA3VVsxUuQB1Tm5x7TJkq9ATtiX5Qwq8ok7gXwim7oo"
    );
    expect(findKaminoMarketByAsset("WIF")).toBeUndefined();
  });
});

// ── Phase 8.15d: kVault registry ─────────────────────────────────────────────
const STEAKHOUSE = "HDsayqAsDWy3QvANGqh2yNraqcD8Fnjgh73Mhb3WRS5E";
const ALLEZ_SOL = "A1so1bPD3W1TfeFwboDh8yfAAVaVtcdAYBYCjhg2mJQ";

describe("KAMINO_VAULTS 整合性", () => {
  it("Steakhouse USDC + Allez SOL を含み、vault address / pool_id は一意", () => {
    const vaults = KAMINO_VAULTS.map((v) => v.vault);
    const pools = KAMINO_VAULTS.map((v) => v.pool_id);
    expect(new Set(vaults).size).toBe(vaults.length);
    expect(new Set(pools).size).toBe(pools.length);
    expect(vaults).toEqual(expect.arrayContaining([STEAKHOUSE, ALLEZ_SOL]));
  });

  it("reserve pool_id と vault pool_id が衝突しない (dispatch 一意性)", () => {
    const reservePools = new Set(KAMINO_MARKETS.map((m) => m.pool_id));
    for (const v of KAMINO_VAULTS) {
      expect(reservePools.has(v.pool_id)).toBe(false);
    }
  });

  it("vault address が reserve address と衝突しない (share_mint 流用キーの一意性)", () => {
    const reserves = new Set(KAMINO_MARKETS.map((m) => m.reserve));
    for (const v of KAMINO_VAULTS) {
      expect(reserves.has(v.vault)).toBe(false);
    }
  });

  it("decimals / mint が正当", () => {
    for (const v of KAMINO_VAULTS) {
      expect(v.underlying_mint.length).toBeGreaterThan(31);
      expect(v.vault.length).toBeGreaterThan(31);
      expect(v.underlying_decimals).toBeGreaterThan(0);
      expect(v.shares_decimals).toBeGreaterThan(0);
    }
  });
});

describe("findKaminoVaultByAddress / findKaminoVaultByPool", () => {
  it("vault address → vault", () => {
    expect(findKaminoVaultByAddress(STEAKHOUSE)?.underlying_symbol).toBe("USDC");
    expect(findKaminoVaultByAddress(ALLEZ_SOL)?.underlying_symbol).toBe("SOL");
  });
  it("pool_id → vault", () => {
    expect(findKaminoVaultByPool("kamino_steakhouse_usdc")?.vault).toBe(STEAKHOUSE);
    expect(findKaminoVaultByPool("kamino_allez_sol_vault")?.vault).toBe(ALLEZ_SOL);
  });
  it("未知は undefined", () => {
    expect(findKaminoVaultByAddress("Unknown11111111111111111111111111")).toBeUndefined();
    expect(findKaminoVaultByPool("kamino_usdc_main")).toBeUndefined();
  });
});
