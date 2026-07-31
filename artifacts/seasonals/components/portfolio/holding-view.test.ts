/**
 * holding-view — Wallet holdings 行の表示モデル (Phase 8.55)。
 * 行の主表示がネイティブ単位であること、換算が固定レートと一致することを固定する。
 */
import type { Position } from "@workspace/lib/types";

import { SOL_USD_PRICE } from "./allocation";
import { conversionLine, holdingView, rateLine } from "./holding-view";

function pos(over: Partial<Position>): Position {
  return {
    position_id: "p",
    protocol_id: "wallet_holding",
    asset_symbol: "USDC",
    current_amount: "0",
    ...over,
  } as unknown as Position;
}

describe("holdingView", () => {
  it("USDC: ネイティブ量 (human) + USD/SOL 換算", () => {
    const v = holdingView(
      pos({ asset_symbol: "USDC", current_amount: "90260000" }) // 90.26 USDC
    );
    expect(v.symbol).toBe("USDC");
    expect(v.nativeAmount).toBe("90.26");
    expect(v.usd).toBeCloseTo(90.26, 6);
    expect(v.sol).toBeCloseTo(90.26 / SOL_USD_PRICE, 6);
    expect(v.priced).toBe(true);
  });

  it("SOL: lamports → SOL 量、USD は固定レート換算", () => {
    const v = holdingView(
      pos({ asset_symbol: "SOL", current_amount: "297600000" }) // 0.2976 SOL
    );
    expect(v.nativeAmount).toBe("0.2976");
    expect(v.usd).toBeCloseTo(0.2976 * SOL_USD_PRICE, 4);
  });

  it("WSOL は SOL に正規化 (decimals は WSOL=9 のまま)", () => {
    const v = holdingView(
      pos({ asset_symbol: "WSOL", current_amount: "1000000000" }) // 1 SOL
    );
    expect(v.symbol).toBe("SOL");
    expect(v.nativeAmount).toBe("1");
  });

  it("ネイティブ量は小数 4 桁で切り捨て、末尾ゼロは落とす", () => {
    const v = holdingView(
      pos({ asset_symbol: "SOL", current_amount: "1234567891" }) // 1.234567891
    );
    expect(v.nativeAmount).toBe("1.2345");
  });

  it("価格不明 asset は priced=false (換算行を出さない)", () => {
    const v = holdingView(
      pos({ asset_symbol: "UNKNOWN", current_amount: "1000000" })
    );
    expect(v.priced).toBe(false);
    expect(v.usd).toBe(0);
  });
});

describe("conversionLine / rateLine", () => {
  it("≈ USD · SOL の両換算と固定レート注記", () => {
    const v = holdingView(
      pos({ asset_symbol: "SOL", current_amount: "297600000" })
    );
    expect(conversionLine(v)).toBe("≈ 50.15 USDC · 0.2976 SOL");
    expect(rateLine()).toBe(`1 SOL = ${SOL_USD_PRICE} USDC`);
  });

  it("SOL 換算は行のネイティブ表示と同じ切り捨て (丸めで食い違わない)", () => {
    // 0.297567891 SOL → 行 0.2975、換算行も 0.2975 (toFixed だと 0.2976)
    const v = holdingView(
      pos({ asset_symbol: "SOL", current_amount: "297567891" })
    );
    expect(v.nativeAmount).toBe("0.2975");
    expect(conversionLine(v)).toContain("· 0.2975 SOL");
  });
});
