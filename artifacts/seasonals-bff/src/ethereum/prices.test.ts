/** prices.ts: Chainlink → on-chain 換算 → Llama の合成と単価の bigint 計算 (RPC / HTTP は mock) */
jest.mock("./pricing", () => ({ getChainlinkPrice: jest.fn() }));
jest.mock("../clients/llama-history", () => ({ fetchLlamaCurrentPrices: jest.fn() }));

import { ETH_ASSET_ADDRESS } from "@workspace/lib/config/eth-assets";
import { fetchLlamaCurrentPrices } from "../clients/llama-history";
import { getChainlinkPrice } from "./pricing";
import { _clearPriceCacheForTest, chainlinkToUsd8, derivePrice, mergePriceSources, priceEthAssetsNow } from "./prices";

const base = { asset: "ETH" as const, updatedAt: "", source: "chainlink" as const };
const USDe = ETH_ASSET_ADDRESS.USDe.toLowerCase();
const sUSDe = ETH_ASSET_ADDRESS.sUSDe.toLowerCase();
const stETH = ETH_ASSET_ADDRESS.stETH.toLowerCase();
const wstETH = ETH_ASSET_ADDRESS.wstETH.toLowerCase();

beforeEach(() => {
  _clearPriceCacheForTest();
  jest.clearAllMocks();
  (fetchLlamaCurrentPrices as jest.Mock).mockResolvedValue(new Map());
});

describe("chainlinkToUsd8", () => {
  it("rescales the feed's decimals to 8 and refuses stale / zero", () => {
    expect(chainlinkToUsd8({ ...base, answer: "312345678901", decimals: 8, stale: false })).toBe("3123.45678901");
    expect(chainlinkToUsd8({ ...base, answer: "1000200000000000000", decimals: 18, stale: false })).toBe("1.00020000");
    expect(chainlinkToUsd8(null)).toBeNull();
    expect(chainlinkToUsd8({ ...base, answer: "100", decimals: 8, stale: true })).toBeNull();
    expect(chainlinkToUsd8({ ...base, answer: "0", decimals: 8, stale: false })).toBeNull();
  });
});

test("derivePrice multiplies the base price by a 1e18 rate in bigint", () => {
  expect(derivePrice("1.00000000", 1_250_000_000_000_000_000n)).toBe("1.25000000");
  expect(derivePrice("3000.12345678", 1_200_000_000_000_000_000n)).toBe("3600.14814813");
});

test("mergePriceSources prefers Chainlink, then derived, then Llama, and skips unknown keys", () => {
  const m = mergePriceSources(["a", "b", "c", "d"], new Map([["a", "1.00000000"], ["b", null]]), new Map([["b", "2.00000000"]]), new Map([["c", "3.00000000"], ["a", "9.00000000"]]));
  expect([...m]).toEqual([
    ["a", "1.00000000"],
    ["b", "2.00000000"],
    ["c", "3.00000000"],
  ]);
});

test("priceEthAssetsNow derives sUSDe / wstETH from their base feeds and asks Llama only for the rest", async () => {
  (getChainlinkPrice as jest.Mock).mockImplementation(async (asset: string) =>
    asset === "USDe" ? { ...base, asset, answer: "100000000", decimals: 8, stale: false } : asset === "stETH" ? { ...base, asset, answer: "300000000000", decimals: 8, stale: false } : null
  );
  const client = {
    readContract: async ({ functionName }: { functionName: string }) => (functionName === "convertToAssets" ? 1_250_000_000_000_000_000n : 1_200_000_000_000_000_000n),
  } as never;
  (fetchLlamaCurrentPrices as jest.Mock).mockResolvedValue(new Map([["0xpt", "0.90000000"]]));
  const m = await priceEthAssetsNow([sUSDe, wstETH, "0xPT", "ETH"], { client, now: 1 });
  expect(m.get(sUSDe)).toBe("1.25000000");
  expect(m.get(wstETH)).toBe("3600.00000000");
  expect(m.get("0xpt")).toBe("0.90000000");
  expect(m.has("ETH")).toBe(false);
  expect((fetchLlamaCurrentPrices as jest.Mock).mock.calls[0]![0]).toEqual(["0xpt", "ETH"]);
  expect((fetchLlamaCurrentPrices as jest.Mock).mock.calls[0]![1]).toBe("ethereum");
  // 60 秒内は cache (Llama を呼ばない)
  await priceEthAssetsNow([sUSDe, "0xPT"], { client, now: 2 });
  expect(fetchLlamaCurrentPrices).toHaveBeenCalledTimes(1);
});

test("priceEthAssetsNow without RPC falls back to Llama for everything and never throws", async () => {
  (fetchLlamaCurrentPrices as jest.Mock).mockResolvedValue(new Map([[USDe, "1.00000000"]]));
  const m = await priceEthAssetsNow([USDe, stETH], { client: null });
  expect([...m]).toEqual([[USDe, "1.00000000"]]);
  expect(getChainlinkPrice).not.toHaveBeenCalled();
});
