/**
 * deposited-breakdown — 預入内訳の表示モデル (Phase 8.76)。
 *
 * ここで固定するのは:
 *   - family 判定 (SOL/WSOL vs USD ペッグ、**EURC は EUR 建てなので stable でない**)
 *   - share_mint → share symbol の registry 逆引きと fallback
 *   - underlying 換算量の桁 (stable 2 / sol 4) と USD 降順の並び
 */
import type { Position } from "@workspace/lib/types";

import {
  depositedBreakdown,
  emptyBreakdownLine,
  familyOfHolding,
} from "./deposited-breakdown";

// 実 registry の mint (lib/config/*)
const JLUSDC_MINT = "9BEcn9aPEmhSPbPQeFGjidRiEKki46fVQDyPpSQXPA2D";
const JITOSOL_MINT = "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn";
const SHYUSD_MINT = "HnnGv3HrSqjRpgdFmx7vQGjntNEoex1SU4e9Lxcxuihz";
const CUSDC_MINT = "993dVFL2uXWYeoXuEBFXR4BijeXdTv4s6BzsCjJZuwqk";

const PRICES = { SOL: 80, USDC: 1 };

function pos(over: Partial<Position>): Position {
  return {
    position_id: `p_${Math.random().toString(36).slice(2, 8)}`,
    protocol_id: "jupiter_lend",
    asset_symbol: "USDC",
    current_amount: "0",
    unit_price_usd: "1.00000000",
    raw_state: {},
    ...over,
  } as unknown as Position;
}

describe("familyOfHolding", () => {
  it("SOL / WSOL → sol、USD ペッグ → stable、その他 → null", () => {
    expect(familyOfHolding("SOL")).toBe("sol");
    expect(familyOfHolding("WSOL")).toBe("sol");
    expect(familyOfHolding("USDC")).toBe("stable");
    expect(familyOfHolding("USDT")).toBe("stable");
    expect(familyOfHolding("JupUSD")).toBe("stable");
    expect(familyOfHolding("JLP")).toBeNull();
    expect(familyOfHolding("UNKNOWN")).toBeNull();
  });

  it("EURC は EUR 建てなので stable に入れない (USDC 換算表示に混ぜない)", () => {
    expect(familyOfHolding("EURC")).toBeNull();
  });
});

describe("depositedBreakdown", () => {
  it("stable family: jlUSDC / sHYUSD が share symbol + ≈ USDC 量で並ぶ", () => {
    const rows = depositedBreakdown(
      "stable",
      [
        pos({
          position_id: "jl",
          current_amount: "12340000", // 12.34 USDC (decimals 6)
          raw_state: { share_mint: JLUSDC_MINT },
        }),
        pos({
          position_id: "hylo",
          protocol_id: "hylo",
          current_amount: "5000000", // 5.00
          raw_state: { share_mint: SHYUSD_MINT },
        }),
      ],
      PRICES
    );
    expect(rows.map((r) => r.shareSymbol)).toEqual(["jlUSDC", "sHYUSD"]);
    expect(rows[0]!.amountLine).toBe("≈ 12.34 USDC");
    expect(rows[1]!.amountLine).toBe("≈ 5 USDC");
  });

  it("sol family: jitoSOL が ≈ x.xxxx SOL (4 桁切捨て) で出る", () => {
    const rows = depositedBreakdown(
      "sol",
      [
        pos({
          protocol_id: "jito",
          asset_symbol: "SOL",
          current_amount: "512345678", // 0.512345678 SOL
          unit_price_usd: "80.00000000",
          raw_state: { share_mint: JITOSOL_MINT },
        }),
      ],
      PRICES
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.shareSymbol).toBe("jitoSOL");
    expect(rows[0]!.amountLine).toBe("≈ 0.5123 SOL");
    expect(rows[0]!.usd).toBeCloseTo(0.512345678 * 80, 2);
  });

  it("WSOL underlying も sol family に入る", () => {
    const rows = depositedBreakdown(
      "sol",
      [
        pos({
          protocol_id: "jupiter_lend",
          asset_symbol: "WSOL",
          current_amount: "1000000000",
          unit_price_usd: "80.00000000",
          raw_state: { share_mint: "unknown-mint" },
        }),
      ],
      PRICES
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.amountLine).toBe("≈ 1 SOL");
  });

  it("wallet_* 行と family 外 (EURC / JLP) は含めない", () => {
    const rows = depositedBreakdown(
      "stable",
      [
        pos({ protocol_id: "wallet_stable", current_amount: "9000000" }),
        pos({
          protocol_id: "jupiter_lend",
          asset_symbol: "EURC",
          current_amount: "1000000",
        }),
        pos({
          protocol_id: "kamino_jlp",
          asset_symbol: "JLP",
          current_amount: "1000000",
        }),
      ],
      PRICES
    );
    expect(rows).toHaveLength(0);
  });

  it("registry に無い share_mint は protocol 名に fallback (空にしない)", () => {
    const rows = depositedBreakdown(
      "stable",
      [
        pos({
          protocol_id: "meteora",
          current_amount: "1000000",
          raw_state: { share_mint: "SomePositionPubkey111" },
        }),
      ],
      PRICES
    );
    expect(rows[0]!.shareSymbol).toBe("Meteora");
  });

  it("Save cToken mint → cUSDC", () => {
    const rows = depositedBreakdown(
      "stable",
      [
        pos({
          protocol_id: "save",
          current_amount: "2500000",
          raw_state: { share_mint: CUSDC_MINT },
        }),
      ],
      PRICES
    );
    expect(rows[0]!.shareSymbol).toBe("cUSDC");
  });

  it("USD 降順で並ぶ", () => {
    const rows = depositedBreakdown(
      "stable",
      [
        pos({
          position_id: "small",
          current_amount: "1000000", // 1 USDC
          raw_state: { share_mint: JLUSDC_MINT },
        }),
        pos({
          position_id: "big",
          protocol_id: "hylo",
          current_amount: "100000000", // 100 USDC
          raw_state: { share_mint: SHYUSD_MINT },
        }),
      ],
      PRICES
    );
    expect(rows.map((r) => r.key)).toEqual(["big", "small"]);
  });
});

describe("emptyBreakdownLine", () => {
  it("預入ゼロの案内文", () => {
    expect(emptyBreakdownLine("stable")).toBe(
      "Nothing deposited from this asset yet"
    );
    expect(emptyBreakdownLine("sol")).toBe(
      "Nothing deposited from this asset yet"
    );
  });
});
