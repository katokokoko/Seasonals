/**
 * jupiter-lend — B2: markets / positions の 30 秒 cache を TtlCache に移した挙動
 * (同時の呼び手は 1 回の GET に合流、wallet ごとの key、失敗は cache しない)。
 */
import { fetchWithTimeout } from "./http";
import { _clearJupiterLendCacheForTest, fetchEarnMarkets, fetchEarnPositions } from "./jupiter-lend";
import { _clearAllCachesForTest } from "../cache/ttl-cache";

jest.mock("./http");
const mockFetch = fetchWithTimeout as jest.MockedFunction<typeof fetchWithTimeout>;
const okJson = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;

const MARKET = { address: "jlUSDC", symbol: "jlUSDC", decimals: 6, asset: { address: "USDC", symbol: "USDC", decimals: 6, price: "1.0001" }, supplyRate: "303", totalAssets: "1000" };

beforeEach(() => {
  jest.clearAllMocks();
  _clearAllCachesForTest();
});
afterEach(() => jest.useRealTimers());

test("markets: 同時の呼び手は 1 回の GET、30 秒で再取得", async () => {
  jest.useFakeTimers({ now: 1_800_000_000_000, doNotFake: ["nextTick", "setImmediate"] });
  mockFetch.mockResolvedValue(okJson([MARKET]));
  const [a, b] = await Promise.all([fetchEarnMarkets(), fetchEarnMarkets()]);
  expect(a).toBe(b);
  expect(a[0]).toMatchObject({ jlMint: "jlUSDC", underlyingMint: "USDC", supplyRateBps: 303, underlyingPriceRaw: "1.0001" });
  expect(mockFetch).toHaveBeenCalledTimes(1);
  jest.advanceTimersByTime(29_000);
  await fetchEarnMarkets();
  expect(mockFetch).toHaveBeenCalledTimes(1);
  jest.advanceTimersByTime(1_000);
  await fetchEarnMarkets();
  expect(mockFetch).toHaveBeenCalledTimes(2);
});

test("positions: wallet ごとの key、同時の呼び手は合流、HTTP 失敗は cache しない", async () => {
  mockFetch.mockResolvedValueOnce({ ok: false, status: 503, statusText: "x", text: async () => "" } as unknown as Response);
  await expect(fetchEarnPositions("W1")).rejects.toThrow(/HTTP 503/);
  mockFetch.mockResolvedValue(okJson([]));
  await Promise.all([fetchEarnPositions("W1"), fetchEarnPositions("W1"), fetchEarnPositions("W2")]);
  expect(mockFetch).toHaveBeenCalledTimes(3); // 失敗 1 + W1 1 + W2 1
  expect(String(mockFetch.mock.calls[2]![0])).toContain("users=W2");
});

test("_clearJupiterLendCacheForTest は従来どおり両方の cache を消す", async () => {
  mockFetch.mockResolvedValue(okJson([MARKET]));
  await fetchEarnMarkets();
  _clearJupiterLendCacheForTest();
  await fetchEarnMarkets();
  expect(mockFetch).toHaveBeenCalledTimes(2);
});
