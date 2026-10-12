import { pendleHoldingsFrom } from "./holdings";
import type { PendleMarket, PendlePosition } from "./pendle";

const M = "0x00000000000000000000000000000000000000aa";
const PT = "0x00000000000000000000000000000000000000b1";
const YT = "0x00000000000000000000000000000000000000b2";
const market: PendleMarket = { name: "sUSDe", address: M, expiry: "2026-12-01T00:00:00.000Z", pt: `1-${PT}`, yt: `1-${YT}`, sy: "1-0x0", underlyingAsset: "1-0x0" };
const pos = (ptVal: number, ytVal: number): PendlePosition => ({
  marketId: `1-${M}`,
  pt: { balance: "1", valuation: ptVal },
  yt: { balance: "1", valuation: ytVal },
  lp: { balance: "0", valuation: 0 },
});

test("on-chain balances decide what is held; dashboard only locates the market", () => {
  const onchain = new Map([
    [PT, { balance: 5_000000000000000000n, decimals: 18 }],
    [YT, { balance: 0n, decimals: 18 }],
  ]);
  const { holdings, heldMarkets } = pendleHoldingsFrom([pos(4.9, 1)], [market], onchain);
  expect(holdings).toEqual([
    { productId: `ethereum:pendle:pt:${M}`, amounts: [{ value: "5000000000000000000", decimals: 18, symbol: "PT-sUSDe" }], usd: "4.90000000" },
  ]);
  expect(heldMarkets.map((m) => m.address)).toEqual([M]);
});

test("USD is omitted when Pendle has no valuation (never guessed)", () => {
  const onchain = new Map([[YT, { balance: 7n, decimals: 18 }]]);
  const { holdings } = pendleHoldingsFrom([pos(0, 0)], [market], onchain);
  expect(holdings).toHaveLength(1);
  expect(holdings[0]!.productId).toBe(`ethereum:pendle:yt:${M}`);
  expect(holdings[0]!.usd).toBeUndefined();
});

test("unknown markets and missing balances are skipped", () => {
  expect(pendleHoldingsFrom([pos(1, 1)], [], new Map()).holdings).toEqual([]);
});
