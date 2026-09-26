import { ethHoldingText, solHoldingText, sumUsd } from "./holdingText";
import type { EarnPosition } from "@workspace/lib/types";

test("amounts from several addresses are summed per symbol with bigint", () => {
  const h = ethHoldingText([
    { productId: "p", amounts: [{ value: "1500000000000000000", decimals: 18, symbol: "stETH" }] },
    { productId: "p", amounts: [{ value: "500000000000000000", decimals: 18, symbol: "stETH" }, { value: "1000000000000000000", decimals: 18, symbol: "wstETH" }] },
  ]);
  expect(h.text).toBe("You hold 2 stETH · 1 wstETH");
});

test("USD is shown only when every holding has it", () => {
  expect(sumUsd(["1.50000000", "2.25000000"])).toBe("3.75");
  expect(sumUsd(["1.50000000", undefined])).toBeNull();
  expect(ethHoldingText([{ productId: "p", amounts: [{ value: "1", decimals: 0, symbol: "PT-X" }], usd: "10.00000000" }]).text).toBe("You hold 1 PT-X (≈ $10.00)");
});

test("pending cooldown becomes a note; Solana '0' USD means unknown", () => {
  const h = ethHoldingText([
    { productId: "p", amounts: [], pending: { label: "Cooling down", amount: { value: "2000000000000000000", decimals: 18, symbol: "USDe" }, endsAt: "2026-10-01T00:00:00.000Z" } },
  ]);
  expect(h.note).toMatch(/^2 USDe cooling down until /);
  const p = { underlying_amount: "1000000", underlying_decimals: 6, asset_symbol: "USDC", underlying_usd: "0" } as EarnPosition;
  expect(solHoldingText([p]).text).toBe("You hold 1 USDC");
});
