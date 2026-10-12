/**
 * 2026-10: fetchSanctumTvls (rates.ts) — Sanctum /v1/tvl/current の parse 検証。
 * 値は lamports の整数 string のみ採用 (§4.5、Number() で parse しない)。
 */
import { _clearRatesCacheForTest, fetchSanctumTvls } from "./rates";

function mockFetchJson(body: unknown, ok = true, status = 200): jest.SpyInstance {
  return jest.spyOn(global, "fetch").mockResolvedValue({
    ok,
    status,
    json: async () => body,
  } as unknown as Response);
}

afterEach(() => {
  jest.restoreAllMocks();
  _clearRatesCacheForTest();
});

describe("fetchSanctumTvls", () => {
  it("symbol → lamports (bigint) を返す (2026-10-06 実測形)", async () => {
    const spy = mockFetchJson({
      tvls: { jitoSOL: "10416036201379766", INF: "2312392791041439" },
      errs: {},
    });
    const out = await fetchSanctumTvls(["jitoSOL", "INF"]);
    expect(out.get("jitoSOL")).toBe(10_416_036_201_379_766n);
    expect(out.get("INF")).toBe(2_312_392_791_041_439n);
    expect(spy.mock.calls[0]![0]).toBe(
      "https://extra-api.sanctum.so/v1/tvl/current?lst=jitoSOL&lst=INF"
    );
  });

  it("整数 string 以外 (小数 / number / 負) は捨てる", async () => {
    mockFetchJson({
      tvls: { jitoSOL: "1.5", INF: 123, bSOL: "-1", mSOL: "42" },
      errs: {},
    });
    const out = await fetchSanctumTvls(["jitoSOL", "INF", "bSOL", "mSOL"]);
    expect([...out.entries()]).toEqual([["mSOL", 42n]]);
  });

  it("HTTP エラーは throw", async () => {
    mockFetchJson({}, false, 502);
    await expect(fetchSanctumTvls(["jitoSOL"])).rejects.toThrow(/HTTP 502/);
  });

  it("5min cache: 同じ symbol 群の 2 回目は fetch しない", async () => {
    const spy = mockFetchJson({ tvls: { jitoSOL: "1" }, errs: {} });
    await fetchSanctumTvls(["jitoSOL"]);
    await fetchSanctumTvls(["jitoSOL"]);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
