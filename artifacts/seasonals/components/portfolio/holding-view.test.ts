/**
 * holding-view — Wallet holdings 行の表示モデル (Phase 8.55 / 8.57)。
 *
 * 行の主表示がネイティブ単位であること、換算が **live 価格** で行われることを
 * 固定する。期待値は価格定数から導き、価格が動いてもテストが腐らないようにする。
 */
import type { Position } from "@workspace/lib/types";

import { conversionLine, holdingView, rateLine } from "./holding-view";

/** oracle 由来の実価格 map を模したもの */
const SOL_USD = 74.92;
const PRICES = { SOL: SOL_USD, USDC: 1 };

function pos(over: Partial<Position>): Position {
  return {
    position_id: "p",
    protocol_id: "wallet_holding",
    asset_symbol: "USDC",
    current_amount: "0",
    unit_price_usd: "0.00000000",
    ...over,
  } as unknown as Position;
}

describe("holdingView", () => {
  it("USDC: ネイティブ量 (human) + USD/SOL 換算", () => {
    const v = holdingView(
      pos({ asset_symbol: "USDC", current_amount: "90260000" }), // 90.26 USDC
      PRICES
    );
    expect(v.symbol).toBe("USDC");
    expect(v.nativeAmount).toBe("90.26");
    expect(v.usd).toBeCloseTo(90.26, 6);
    expect(v.sol).toBeCloseTo(90.26 / SOL_USD, 6);
    expect(v.priced).toBe(true);
  });

  it("SOL: lamports → SOL 量、USD は live 価格で換算", () => {
    const v = holdingView(
      pos({ asset_symbol: "SOL", current_amount: "297600000" }), // 0.2976 SOL
      PRICES
    );
    expect(v.nativeAmount).toBe("0.2976");
    expect(v.usd).toBeCloseTo(0.2976 * SOL_USD, 4);
  });

  it("8.57: position の unit_price_usd (DAS 実価格) を優先する", () => {
    // jlUSDC のような share token は DAS が per-unit 価格を返す
    const v = holdingView(
      pos({
        asset_symbol: "jlUSDC",
        current_amount: "9685801", // 9.685801
        unit_price_usd: "1.05558290",
      }),
      PRICES
    );
    expect(v.usd).toBeCloseTo(9.685801 * 1.0555829, 5);
  });

  it("WSOL は SOL に正規化 (decimals は SOL=9 で解決)", () => {
    const v = holdingView(
      pos({ asset_symbol: "WSOL", current_amount: "1000000000" }), // 1 SOL
      PRICES
    );
    expect(v.symbol).toBe("SOL");
    expect(v.nativeAmount).toBe("1");
    expect(v.usd).toBeCloseTo(SOL_USD, 6);
  });

  it("ネイティブ量は小数 4 桁で切り捨て、末尾ゼロは落とす", () => {
    const v = holdingView(
      pos({ asset_symbol: "SOL", current_amount: "1234567891" }), // 1.234567891
      PRICES
    );
    expect(v.nativeAmount).toBe("1.2345");
  });

  it("価格不明 asset は priced=false (換算行を出さない)", () => {
    const v = holdingView(
      pos({ asset_symbol: "UNKNOWN", current_amount: "1000000" }),
      PRICES
    );
    expect(v.priced).toBe(false);
    expect(v.usd).toBe(0);
  });

  it("8.57: 価格 map が空なら SOL は評価しない (固定値で騙らない)", () => {
    const v = holdingView(
      pos({ asset_symbol: "SOL", current_amount: "297600000" }),
      {}
    );
    expect(v.priced).toBe(false);
    expect(v.usd).toBe(0);
  });
});

describe("conversionLine / rateLine", () => {
  it("≈ USD · SOL の両換算と live レート注記", () => {
    const v = holdingView(
      pos({ asset_symbol: "SOL", current_amount: "297600000" }),
      PRICES
    );
    const expectedUsd = (0.2976 * SOL_USD).toFixed(2);
    expect(conversionLine(v)).toBe(`≈ ${expectedUsd} USDC · 0.2976 SOL`);
    expect(rateLine(PRICES)).toBe(`1 SOL = ${SOL_USD.toFixed(2)} USDC`);
  });

  it("8.57: SOL 価格が無ければレート注記を出さない", () => {
    expect(rateLine({})).toBeNull();
  });

  it("SOL 換算は行のネイティブ表示と同じ切り捨て (丸めで食い違わない)", () => {
    // 0.297567891 SOL → 行 0.2975、換算行も 0.2975 (toFixed だと 0.2976)
    const v = holdingView(
      pos({ asset_symbol: "SOL", current_amount: "297567891" }),
      PRICES
    );
    expect(v.nativeAmount).toBe("0.2975");
    expect(conversionLine(v)).toContain("· 0.2975 SOL");
  });
});
