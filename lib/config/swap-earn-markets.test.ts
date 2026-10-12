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
  findFundingToken,
  findMarketByShareMint,
  findMarketByProtocolAsset,
  jupiterLendUnderlyingToShare,
  heldSwapEarnPositions,
  swapEarnDepositInput,
  swapEarnDepositInputBySymbol,
} from "./swap-earn-markets";
import { oracleFeedForMint } from "./oracle-feeds";

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

  it("Perena USD* は 2026-10 の Star V2 新 mint (旧 Numéraire LP は registry に無い = withdraw route を解決しない)", () => {
    const perena = SWAP_EARN_MARKETS.find((m) => m.protocol_id === "perena")!;
    expect(perena.share_mint).toBe("star9agSpjiFe3M49B3RniVU4CMBBEK3Qnaqn3RGiFM");
    expect(findMarketByShareMint("BenJy1n3WTx9mTjEvy63e8Q1j4RqUc6E4VBMz3ir4Wo6")).toBeUndefined();
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

describe("2026-10-13: funding token (USDC で jlJupUSD を買う)", () => {
  const jlJupUsd = SWAP_EARN_MARKETS.find((m) => m.share_symbol === "jlJupUSD")!;
  const jlUsdc = findMarketByShareMint(JL_USDC)!;

  it("funding は underlying / share と重複せず、oracle tier (A〜C) を持つ (fail-closed の前提)", () => {
    for (const m of SWAP_EARN_MARKETS) {
      for (const f of m.funding ?? []) {
        expect(f.mint).not.toBe(m.underlying_mint);
        expect(f.mint).not.toBe(m.share_mint);
        expect(f.decimals).toBeGreaterThan(0);
        const tier = oracleFeedForMint(f.mint)?.tier;
        expect(["A", "B", "C"]).toContain(tier);
      }
    }
  });
  it("jlJupUSD は USDC を funding に持つ。jlUSDC は持たない", () => {
    expect(jlJupUsd.funding?.map((f) => f.symbol)).toEqual(["USDC"]);
    expect(jlUsdc.funding).toBeUndefined();
  });
  it("funding は underlying ではない: findMarketByProtocolAsset(jupiter_lend, USDC) は従来どおり jlUSDC", () => {
    expect(findMarketByProtocolAsset("jupiter_lend", "USDC")?.share_mint).toBe(JL_USDC);
  });
  it("findFundingToken は symbol (大文字小文字無視) と mint で引ける", () => {
    expect(findFundingToken(jlJupUsd, "usdc")?.mint).toBe(USDC);
    expect(findFundingToken(jlJupUsd, USDC)?.symbol).toBe("USDC");
    expect(findFundingToken(jlJupUsd, "USDT")).toBeUndefined();
    expect(findFundingToken(jlUsdc, "USDC")).toBeUndefined();
  });
  it("swapEarnDepositInput: 省略 / underlying mint → underlying、funding mint → isFunding、他は undefined", () => {
    expect(swapEarnDepositInput(jlJupUsd)).toEqual({ mint: jlJupUsd.underlying_mint, symbol: "JupUSD", decimals: 6, isFunding: false });
    expect(swapEarnDepositInput(jlJupUsd, jlJupUsd.underlying_mint)?.isFunding).toBe(false);
    expect(swapEarnDepositInput(jlJupUsd, USDC)).toEqual({ mint: USDC, symbol: "USDC", decimals: 6, isFunding: true });
    expect(swapEarnDepositInput(jlJupUsd, "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB")).toBeUndefined();
    expect(swapEarnDepositInput(jlUsdc, jlJupUsd.underlying_mint)).toBeUndefined();
  });
  it("swapEarnDepositInputBySymbol: underlying 優先、funding は表記揺れ吸収、不一致は undefined", () => {
    expect(swapEarnDepositInputBySymbol(jlJupUsd, "jupUSD")?.isFunding).toBe(false);
    expect(swapEarnDepositInputBySymbol(jlJupUsd, "USDC")?.isFunding).toBe(true);
    expect(swapEarnDepositInputBySymbol(jlJupUsd, "SOL")).toBeUndefined();
    expect(swapEarnDepositInputBySymbol(jlJupUsd, undefined)).toBeUndefined();
  });
});
