/**
 * 2026-10: fetchJupiterUsdPrices (Jupiter Price v3) の parse / fail-closed 検証。
 */
import { fetchJupiterUsdPrices, _clearJupiterPriceCacheForTest } from "./jupiter-price";

const SHYUSD = "HnnGv3HrSqjRpgdFmx7vQGjntNEoex1SU4e9Lxcxuihz";
const OTHER = "So11111111111111111111111111111111111111112";

function mockFetchJson(body: unknown, ok = true, status = 200): jest.SpyInstance {
  return jest.spyOn(global, "fetch").mockResolvedValue({
    ok,
    status,
    json: async () => body,
  } as unknown as Response);
}

afterEach(() => {
  jest.restoreAllMocks();
  _clearJupiterPriceCacheForTest();
});

describe("fetchJupiterUsdPrices", () => {
  it("mint → usdPrice を返す (2026-10-06 実測形)", async () => {
    const spy = mockFetchJson({
      [SHYUSD]: { usdPrice: 1.4952520733393782, decimals: 6, liquidity: 2545.04 },
    });
    const out = await fetchJupiterUsdPrices([SHYUSD]);
    expect(out.get(SHYUSD)).toBeCloseTo(1.49525, 5);
    expect(spy.mock.calls[0]![0]).toBe(`https://lite-api.jup.ag/price/v3?ids=${SHYUSD}`);
  });

  it("不正値 (0 / 負 / 文字列 / null) は捨てる、全滅なら throw", async () => {
    mockFetchJson({ [SHYUSD]: { usdPrice: "1.5" }, [OTHER]: { usdPrice: 0 } });
    await expect(fetchJupiterUsdPrices([SHYUSD, OTHER])).rejects.toThrow(/no valid usdPrice/);
  });

  it("一部だけ不正なら有効な mint のみ返す", async () => {
    mockFetchJson({ [SHYUSD]: { usdPrice: 1.5 }, [OTHER]: null });
    const out = await fetchJupiterUsdPrices([SHYUSD, OTHER]);
    expect([...out.keys()]).toEqual([SHYUSD]);
  });

  it("HTTP エラーは throw", async () => {
    mockFetchJson({}, false, 503);
    await expect(fetchJupiterUsdPrices([SHYUSD])).rejects.toThrow(/HTTP 503/);
  });

  it("5min cache: 2 回目は fetch しない", async () => {
    const spy = mockFetchJson({ [SHYUSD]: { usdPrice: 1.5 } });
    await fetchJupiterUsdPrices([SHYUSD]);
    await fetchJupiterUsdPrices([SHYUSD]);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
