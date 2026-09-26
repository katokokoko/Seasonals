import { PositionCategory } from "@workspace/lib/types";

import type { PriceSeries } from "../clients/pyth-history";
import {
  createHistoryEngine,
  holdingsFromInputs,
  type ChainHistorySource,
  type HistoryInputs,
} from "./engine";

const DAY = 86_400;
const NOW = 1_780_000_000;
const ETH = "ETH";
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";

function inputs(overrides: Partial<HistoryInputs> = {}): HistoryInputs {
  return {
    current: new Map([
      [ETH, 2n * 10n ** 18n],
      [USDC, 100_000_000n],
    ]),
    assets: [
      { mint: ETH, symbol: "ETH", decimals: 18, currentUsd8: "3000", protocolId: "wallet_eth", category: PositionCategory.Other },
      {
        mint: USDC,
        symbol: "USDC",
        decimals: 6,
        currentUsd8: "1",
        deposited: true,
        protocolId: "wallet_stable",
        category: PositionCategory.Stable,
      },
    ],
    // 10 日前に ETH を 2 受け取った (それ以前は ETH ゼロ)
    deltas: [
      { timestamp: NOW - 10 * DAY, mint: ETH, amount: 2n * 10n ** 18n },
      { timestamp: NOW - 10 * DAY, mint: USDC, amount: 100_000_000n },
    ],
    oldestSeen: NOW - 10 * DAY,
    fetchedDays: 30,
    complete: true,
    ...overrides,
  };
}

function flatSeries(usd8: string): PriceSeries {
  return { t: [NOW - 400 * DAY], usd8: [usd8] };
}

function source(data: HistoryInputs | null): ChainHistorySource & {
  loadInputs: jest.Mock;
  priceSeries: jest.Mock;
} {
  return {
    chain: "ethereum",
    nativePriceKey: ETH,
    loadInputs: jest.fn().mockResolvedValue(data),
    priceSeries: jest.fn().mockResolvedValue(
      new Map([
        [ETH, flatSeries("2000")],
        [USDC, flatSeries("1")],
      ])
    ),
  };
}

describe("createHistoryEngine.history", () => {
  it("replays from funding and marks starts_at_funding when inputs are complete", async () => {
    const src = source(inputs());
    const engine = createHistoryEngine(src, { now: () => NOW * 1000 });
    const res = await engine.history("0xabc", 30, NOW);
    expect(res.chain).toBe("ethereum");
    expect(res.points.length).toBeGreaterThan(2);
    expect(res.points[0]!.at).toBeGreaterThanOrEqual(NOW - 10 * DAY);
    // 2 ETH × 2000 + 100 USDC (過去価格で値付け、現在価格 3000 ではない)
    expect(res.points[res.points.length - 1]!.usd).toBe("4100.00000000");
    expect(res.points[res.points.length - 1]!.deposited_usd).toBe("100.00000000");
    // ETH 建て = 4100 / 2000
    expect(res.points[res.points.length - 1]!.native).toBe("2.05000000");
    expect(res.starts_at_funding).toBe(true);
  });

  it("does not claim zero-before when the tx scan was truncated", async () => {
    const engine = createHistoryEngine(source(inputs({ complete: false })), { now: () => NOW * 1000 });
    expect((await engine.history("0xabc", 30, NOW)).starts_at_funding).toBe(false);
  });

  it("passes excluded_from_history through", async () => {
    const engine = createHistoryEngine(
      source(inputs({ excludedFromHistory: ["Aave V4"] })),
      { now: () => NOW * 1000 }
    );
    expect((await engine.history("0xabc", 30, NOW)).excluded_from_history).toEqual(["Aave V4"]);
  });

  it("returns empty points for a wallet with nothing held", async () => {
    const engine = createHistoryEngine(source(null), { now: () => NOW * 1000 });
    const res = await engine.history("0xabc", 30, NOW);
    expect(res.points).toEqual([]);
    expect(res.oldest_at).toBeNull();
  });

  it("serves stale data while revalidating in the background (8.83)", async () => {
    let clock = NOW * 1000;
    const src = source(inputs());
    const engine = createHistoryEngine(src, { now: () => clock, cacheTtlMs: 1000 });
    const first = await engine.history("0xabc", 30, NOW);
    clock += 5000;
    const second = await engine.history("0xabc", 30, NOW);
    expect(second).toBe(first);
    await new Promise((r) => setImmediate(r));
    expect(src.loadInputs).toHaveBeenCalledTimes(2);
  });

  it("shares one upstream load between concurrent history and holdings", async () => {
    const src = source(inputs());
    const engine = createHistoryEngine(src, { now: () => NOW * 1000 });
    await Promise.all([engine.history("0xabc", 30, NOW), engine.holdings("0xabc")]);
    expect(src.loadInputs).toHaveBeenCalledTimes(1);
  });

  it("propagates upstream failure (route turns it into 503)", async () => {
    const src = source(null);
    src.loadInputs.mockRejectedValue(new Error("etherscan down"));
    const engine = createHistoryEngine(src, { now: () => NOW * 1000 });
    await expect(engine.history("0xabc", 30, NOW)).rejects.toThrow("etherscan down");
  });
});

describe("holdingsFromInputs", () => {
  it("values holdings with the current price and keeps category / deposited", () => {
    const out = holdingsFromInputs("ethereum", "0xabc", inputs());
    expect(out.map((h) => [h.symbol, h.usd, h.category, h.deposited])).toEqual([
      ["ETH", "6000.00000000", "other", false],
      ["USDC", "100.00000000", "stable", true],
    ]);
    expect(out[1]!.amount).toEqual({ value: "100000000", decimals: 6, symbol: "USDC" });
  });

  it("skips assets whose current price is unknown and appends extra holdings", () => {
    const data = inputs({
      extraHoldings: [
        {
          symbol: "Aave V4",
          protocol_id: "aave",
          category: PositionCategory.Lending,
          usd: "50.00000000",
          deposited: true,
          in_history: false,
        },
      ],
    });
    data.assets[0]!.currentUsd8 = undefined;
    const out = holdingsFromInputs("ethereum", "0xabc", data);
    expect(out.map((h) => h.symbol)).toEqual(["USDC", "Aave V4"]);
    expect(out[1]!.in_history).toBe(false);
    expect(out[1]!.chain).toBe("ethereum");
  });
});
