/**
 * swap-earn market registry — テスト (Phase 8.15)
 *
 * §32.2 same source of truth: BFF / mobile が共有する market 定義の整合性、
 * 解決 helper、保有 LST → EarnPosition マッピングを検証する。
 */
import type { Position } from "../types/position";
import { PositionCategory } from "../types/enums";
import {
  SWAP_EARN_MARKETS,
  findMarketByShareMint,
  findMarketByProtocolAsset,
  jupiterLendUnderlyingToShare,
  heldSwapEarnPositions,
} from "./swap-earn-markets";

const JITOSOL = "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn";
const MSOL = "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So";
const BSOL = "bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1"; // 未登録 (registry は INF)
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const JL_USDC = "9BEcn9aPEmhSPbPQeFGjidRiEKki46fVQDyPpSQXPA2D";

describe("SWAP_EARN_MARKETS 整合性", () => {
  it("share_mint は一意 (重複定義なし)", () => {
    const mints = SWAP_EARN_MARKETS.map((m) => m.share_mint);
    expect(new Set(mints).size).toBe(mints.length);
  });

  it("全 market が非空の mint / symbol / 正の decimals を持つ", () => {
    for (const m of SWAP_EARN_MARKETS) {
      expect(m.underlying_mint.length).toBeGreaterThan(31);
      expect(m.share_mint.length).toBeGreaterThan(31);
      expect(m.underlying_symbol.length).toBeGreaterThan(0);
      expect(m.share_symbol.length).toBeGreaterThan(0);
      expect(m.underlying_decimals).toBeGreaterThan(0);
      expect(m.share_decimals).toBeGreaterThan(0);
    }
  });

  it("Jupiter Lend は 7 markets", () => {
    const jl = SWAP_EARN_MARKETS.filter((m) => m.protocol_id === "jupiter_lend");
    expect(jl).toHaveLength(7);
  });

  it("Tier A LST/stable (jito/marinade/sanctum/perena) を含む", () => {
    const ids = new Set(SWAP_EARN_MARKETS.map((m) => m.protocol_id));
    expect(ids.has("jito")).toBe(true);
    expect(ids.has("marinade")).toBe(true);
    expect(ids.has("sanctum")).toBe(true);
    expect(ids.has("perena")).toBe(true);
  });
});

describe("jupiterLendUnderlyingToShare (BFF back-compat 導出)", () => {
  it("7 entries、USDC mint → jlUSDC share mint", () => {
    const map = jupiterLendUnderlyingToShare();
    expect(Object.keys(map)).toHaveLength(7);
    expect(map[USDC]).toBe(JL_USDC);
  });
});

describe("findMarketByShareMint", () => {
  it("登録 share mint (jitoSOL) を解決", () => {
    expect(findMarketByShareMint(JITOSOL)?.protocol_id).toBe("jito");
    expect(findMarketByShareMint(JITOSOL)?.underlying_symbol).toBe("SOL");
  });
  it("Jupiter Lend share mint も解決", () => {
    expect(findMarketByShareMint(JL_USDC)?.protocol_id).toBe("jupiter_lend");
  });
  it("未登録 mint (bSOL) は undefined", () => {
    expect(findMarketByShareMint(BSOL)).toBeUndefined();
  });
});

describe("findMarketByProtocolAsset", () => {
  it("(jupiter_lend, USDC) → jlUSDC market", () => {
    expect(findMarketByProtocolAsset("jupiter_lend", "USDC")?.share_mint).toBe(
      JL_USDC
    );
  });
  it("(jito, SOL) → jitoSOL market", () => {
    expect(findMarketByProtocolAsset("jito", "SOL")?.share_mint).toBe(JITOSOL);
  });
  it("(kamino, SOL) は未登録 → undefined", () => {
    expect(findMarketByProtocolAsset("kamino", "SOL")).toBeUndefined();
  });
});

// ── heldSwapEarnPositions ──────────────────────────────────────────────────
function pos(partial: Partial<Position> & { raw_state: Record<string, unknown> }): Position {
  return {
    position_id: "p1",
    wallet_id: "w1",
    protocol_id: "wallet_holding",
    asset_symbol: "X",
    principal_amount: "0",
    current_amount: "1000000000",
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

describe("heldSwapEarnPositions", () => {
  it("jitoSOL 保有を 'jito' で EarnPosition に正規化", () => {
    const positions = [
      pos({ protocol_id: "jito", asset_symbol: "JitoSOL", current_amount: "2500000000", raw_state: { mint: JITOSOL } }),
    ];
    const out = heldSwapEarnPositions(positions, "jito");
    expect(out).toHaveLength(1);
    expect(out[0]!.protocol_id).toBe("jito");
    expect(out[0]!.share_mint).toBe(JITOSOL);
    expect(out[0]!.shares).toBe("2500000000"); // withdraw input amount
    expect(out[0]!.asset_symbol).toBe("jitoSOL"); // registry share_symbol
    expect(out[0]!.market_symbol).toBe("SOL"); // underlying
    expect(out[0]!.accrued_yield_sign).toBe("unknown");
  });

  it("別 protocol を要求すると空 (protocol 別に分離)", () => {
    const positions = [
      pos({ protocol_id: "jito", raw_state: { mint: JITOSOL } }),
    ];
    expect(heldSwapEarnPositions(positions, "marinade")).toHaveLength(0);
  });

  it("未登録 mint (bSOL) は除外", () => {
    const positions = [
      pos({ protocol_id: "sanctum", asset_symbol: "bSOL", raw_state: { mint: BSOL } }),
    ];
    expect(heldSwapEarnPositions(positions, "sanctum")).toHaveLength(0);
  });

  it("raw_state.mint が無い position は無視", () => {
    const positions = [pos({ protocol_id: "jito", raw_state: {} })];
    expect(heldSwapEarnPositions(positions, "jito")).toHaveLength(0);
  });

  it("複数 protocol 混在から marinade だけ抽出", () => {
    const positions = [
      pos({ protocol_id: "jito", raw_state: { mint: JITOSOL } }),
      pos({ protocol_id: "marinade", asset_symbol: "mSOL", current_amount: "777", raw_state: { mint: MSOL } }),
    ];
    const out = heldSwapEarnPositions(positions, "marinade");
    expect(out).toHaveLength(1);
    expect(out[0]!.share_mint).toBe(MSOL);
    expect(out[0]!.shares).toBe("777");
  });
});
