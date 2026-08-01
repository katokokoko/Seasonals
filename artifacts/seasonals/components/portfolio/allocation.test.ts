/**
 * allocation — 評価額の価格解決 (Phase 8.57)。
 *
 * 8.57 以前は固定表だけを見ており SOL を $168.5 (実勢の 2 倍超) で評価していた。
 * 価格の優先順 (position の実価格 → oracle → stablecoin fallback) と、
 * **価格不明を 0 として合算しない**ことを固定する。
 * 期待値は価格定数から導き、実勢が動いてもテストが腐らないようにする。
 */
import type { Position } from "@workspace/lib/types";

import {
  positionSolValue,
  positionUsdValue,
  solUsdPrice,
  totalUsdValue,
  unitUsdPrice,
} from "./allocation";

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

describe("unitUsdPrice — 価格の優先順", () => {
  it("1. position の unit_price_usd (Helius DAS の実価格) を最優先", () => {
    const p = pos({ asset_symbol: "jlUSDC", unit_price_usd: "1.05558290" });
    expect(unitUsdPrice(p, PRICES)).toBeCloseTo(1.0555829, 8);
  });

  it("2. DAS 価格が 0 の asset は oracle 価格 (native SOL が該当)", () => {
    const p = pos({ asset_symbol: "SOL", unit_price_usd: "0.00000000" });
    expect(unitUsdPrice(p, PRICES)).toBe(SOL_USD);
  });

  it("3. どちらも無ければ stablecoin の固定 fallback のみ", () => {
    expect(unitUsdPrice(pos({ asset_symbol: "USDC" }), {})).toBe(1);
    // SOL 系に固定 fallback は置かない (実勢と乖離するため)
    expect(unitUsdPrice(pos({ asset_symbol: "SOL" }), {})).toBeNull();
    expect(unitUsdPrice(pos({ asset_symbol: "mSOL" }), {})).toBeNull();
  });

  it("WSOL は SOL として価格を引く", () => {
    expect(unitUsdPrice(pos({ asset_symbol: "WSOL" }), PRICES)).toBe(SOL_USD);
  });
});

describe("positionUsdValue / positionSolValue", () => {
  it("SOL 保有を live 価格で評価する (固定 168.5 ではない)", () => {
    const p = pos({ asset_symbol: "SOL", current_amount: "297600000" });
    expect(positionUsdValue(p, PRICES)).toBeCloseTo(0.2976 * SOL_USD, 6);
  });

  it("価格不明は 0 (合算に影響させない)", () => {
    const p = pos({ asset_symbol: "UNKNOWN", current_amount: "1000000" });
    expect(positionUsdValue(p, PRICES)).toBe(0);
  });

  it("SOL 価格が無ければ SOL 建て評価は 0 (レートを騙らない)", () => {
    const p = pos({ asset_symbol: "USDC", current_amount: "1000000" });
    expect(positionSolValue(p, {})).toBe(0);
    expect(positionSolValue(p, PRICES)).toBeCloseTo(1 / SOL_USD, 8);
  });
});

describe("totalUsdValue", () => {
  it("実価格の合算 (USDC + SOL)", () => {
    const positions = [
      pos({
        position_id: "a",
        asset_symbol: "USDC",
        current_amount: "90260000",
        unit_price_usd: "0.99986310",
      }),
      pos({ position_id: "b", asset_symbol: "SOL", current_amount: "297600000" }),
    ];
    const expected = 90.26 * 0.9998631 + 0.2976 * SOL_USD;
    expect(totalUsdValue(positions, PRICES)).toBeCloseTo(expected, 4);
  });
});

describe("solUsdPrice", () => {
  it("live 価格があれば返し、無ければ null", () => {
    expect(solUsdPrice(PRICES)).toBe(SOL_USD);
    expect(solUsdPrice({})).toBeNull();
    expect(solUsdPrice({ SOL: 0 })).toBeNull();
  });
});
