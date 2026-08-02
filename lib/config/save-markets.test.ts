/**
 * Save market registry — テスト (Phase 8.15c)
 *
 * §32.2 same source of truth: pool_id ⇔ reserve ⇔ cToken ⇔ underlying の整合性と
 * find helper、保有 cToken → EarnPosition マッピングを検証する。
 */
import type { Position } from "../types/position";
import {
  SAVE_MAIN_MARKET,
  SAVE_MARKETS,
  findSaveMarketByAsset,
  findSaveMarketByCToken,
  findSaveMarketByPool,
  findSaveMarketByReserve,
  heldSavePositions,
} from "./save-markets";

const CUSDC = "993dVFL2uXWYeoXuEBFXR4BijeXdTv4s6BzsCjJZuwqk";
const CSOL = "5h6ssFpeDeRbzsEHDbTQNH7nVGgsKrZydxdSTnLm6QdV";
const USDC_RESERVE = "BgxfHJDzm44T7XG68MYKx7YisTjZu73tVovyZSjJMpmw";

describe("SAVE_MARKETS 整合性", () => {
  it("USDC / SOL main を含み、reserve と cToken mint は一意", () => {
    const assets = SAVE_MARKETS.map((m) => m.underlying_symbol);
    expect(assets).toEqual(expect.arrayContaining(["USDC", "SOL"]));
    const reserves = SAVE_MARKETS.map((m) => m.reserve);
    const ctokens = SAVE_MARKETS.map((m) => m.ctoken_mint);
    expect(new Set(reserves).size).toBe(reserves.length);
    expect(new Set(ctokens).size).toBe(ctokens.length);
  });

  it("全 market が main market 上で、address / decimals が正当", () => {
    for (const m of SAVE_MARKETS) {
      expect(m.protocol_id).toBe("savefi");
      expect(m.market).toBe(SAVE_MAIN_MARKET);
      expect(m.reserve.length).toBeGreaterThan(31);
      expect(m.ctoken_mint.length).toBeGreaterThan(31);
      expect(m.underlying_mint.length).toBeGreaterThan(31);
      expect(m.underlying_decimals).toBeGreaterThan(0);
    }
  });
});

describe("find helpers", () => {
  it("reserve → market", () => {
    expect(findSaveMarketByReserve(USDC_RESERVE)?.underlying_symbol).toBe(
      "USDC"
    );
  });
  it("cToken mint → market", () => {
    expect(findSaveMarketByCToken(CSOL)?.underlying_symbol).toBe("SOL");
  });
  it("pool_id → market", () => {
    expect(findSaveMarketByPool("savefi_usdc_main")?.ctoken_mint).toBe(CUSDC);
  });
  it("asset → market", () => {
    expect(findSaveMarketByAsset("SOL")?.ctoken_mint).toBe(CSOL);
  });
  it("未登録 (turbo pool / 未知 mint) は undefined", () => {
    expect(findSaveMarketByPool("savefi_turbo_sol")).toBeUndefined();
    expect(findSaveMarketByCToken("UnknownMint111111111111111111111")).toBeUndefined();
  });
});

// ── heldSavePositions ────────────────────────────────────────────────────────
function pos(
  partial: Partial<Position> & { raw_state: Record<string, unknown> }
): Position {
  return {
    position_id: "p1",
    wallet_id: "w1",
    protocol_id: "savefi",
    asset_symbol: "cUSDC",
    principal_amount: "0",
    current_amount: "1300000",
    accrued_yield_amount: "0",
    unit_price_usd: "0",
    unit_price_sol: "0",
    deposited_at: "2026-01-01T00:00:00Z",
    maturity_at: null,
    unlock_at: null,
    health_factor: null,
    auto_roll_rule: null,
    risk_score: 0,
    ...partial,
  };
}

describe("heldSavePositions", () => {
  it("保有 cUSDC を savefi の EarnPosition に (shares = cToken smallest)", () => {
    const out = heldSavePositions(
      [pos({ raw_state: { mint: CUSDC }, current_amount: "1300000" })],
      "savefi"
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.protocol_id).toBe("savefi");
    expect(out[0]!.share_mint).toBe(CUSDC);
    expect(out[0]!.shares).toBe("1300000");
    expect(out[0]!.asset_symbol).toBe("cUSDC");
    expect(out[0]!.market_symbol).toBe("USDC");
    expect(out[0]!.accrued_yield_sign).toBe("unknown");
  });

  it("未登録 mint / raw_state.mint 無し / 別 protocol 要求は除外", () => {
    const positions = [
      pos({ raw_state: { mint: "SomeOtherMint111111111111111111111111111" } }),
      pos({ raw_state: {} }),
      pos({ raw_state: { mint: CSOL } }),
    ];
    expect(heldSavePositions(positions, "savefi")).toHaveLength(1);
    expect(heldSavePositions(positions, "kamino")).toHaveLength(0);
  });
});
