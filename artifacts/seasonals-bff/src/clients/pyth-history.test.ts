/**
 * pyth-history — 過去価格の系列取得 (Phase 8.58 / 8.59)。
 *
 * 8.59: 点ごとの個別取得をやめ、**1 symbol 1 リクエスト**で範囲全体を取る形に。
 * 実測で判明した癖 (symbol 名 / UA 必須) と、キャッシュ・degrade を固定する。
 */
import { fetchWithTimeout } from "./http";
import {
  _clearPythHistoryCacheForTest,
  fetchPriceSeries,
  priceAtOrBefore,
  priceToUsd8,
  resolutionForStep,
  tradingViewSymbol,
} from "./pyth-history";

jest.mock("./http");

const mockFetch = fetchWithTimeout as jest.MockedFunction<typeof fetchWithTimeout>;
const HOUR = 3_600;

function reply(body: unknown): Response {
  return { ok: true, json: async () => body } as unknown as Response;
}

beforeEach(() => {
  jest.clearAllMocks();
  _clearPythHistoryCacheForTest();
});

describe("tradingViewSymbol / resolutionForStep / priceToUsd8", () => {
  it("symbol は Crypto.<SYMBOL>/USD (WSOL は SOL に正規化)", () => {
    expect(tradingViewSymbol("SOL")).toBe("Crypto.SOL/USD");
    expect(tradingViewSymbol("WSOL")).toBe("Crypto.SOL/USD");
    expect(tradingViewSymbol("JLP")).toBe("Crypto.JLP/USD");
  });

  it("刻みより細かい resolution を選ぶ", () => {
    expect(resolutionForStep(2 * HOUR)).toBe("120");
    expect(resolutionForStep(8 * HOUR)).toBe("720");
    expect(resolutionForStep(24 * HOUR)).toBe("D");
    expect(resolutionForStep(4 * 24 * HOUR)).toBe("D");
  });

  it("float 価格 → 8-dec string (不正は null)", () => {
    expect(priceToUsd8(73.05423163)).toBe("73.05423163");
    expect(priceToUsd8(0)).toBeNull();
    expect(priceToUsd8("73")).toBeNull();
    expect(priceToUsd8(Number.NaN)).toBeNull();
  });
});

describe("fetchPriceSeries", () => {
  it("範囲全体を 1 リクエストで取り、昇順の系列にする", async () => {
    mockFetch.mockResolvedValue(
      reply({ s: "ok", t: [100, 200, 300], c: [70.5, 71.25, 73] })
    );
    const series = await fetchPriceSeries("SOL", 100, 300, 2 * HOUR);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const url = mockFetch.mock.calls[0]![0] as string;
    expect(url).toContain("shims/tradingview/history");
    expect(url).toContain(encodeURIComponent("Crypto.SOL/USD"));
    expect(url).toContain("resolution=120");
    expect(series.t).toEqual([100, 200, 300]);
    expect(series.usd8).toEqual(["70.50000000", "71.25000000", "73.00000000"]);
  });

  it("Cloudflare 対策の User-Agent を付ける", async () => {
    mockFetch.mockResolvedValue(reply({ s: "ok", t: [], c: [] }));
    await fetchPriceSeries("SOL", 1, 2, HOUR);
    const init = mockFetch.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>)["user-agent"]).toBeTruthy();
  });

  it("同じ範囲の 2 回目は fetch しない", async () => {
    mockFetch.mockResolvedValue(reply({ s: "ok", t: [1], c: [1] }));
    await fetchPriceSeries("SOL", 1, 2, HOUR);
    await fetchPriceSeries("SOL", 1, 2, HOUR);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("HTTP 失敗 / s!=ok / 例外は空系列で degrade (0 で埋めない)", async () => {
    mockFetch.mockResolvedValue({ ok: false } as Response);
    expect((await fetchPriceSeries("SOL", 1, 2, HOUR)).t).toEqual([]);
    _clearPythHistoryCacheForTest();
    mockFetch.mockResolvedValue(reply({ s: "no_data" }));
    expect((await fetchPriceSeries("SOL", 3, 4, HOUR)).t).toEqual([]);
    _clearPythHistoryCacheForTest();
    mockFetch.mockRejectedValue(new Error("network"));
    expect((await fetchPriceSeries("SOL", 5, 6, HOUR)).t).toEqual([]);
  });
});

describe("priceAtOrBefore", () => {
  const series = { t: [100, 200, 300], usd8: ["70.00000000", "71.00000000", "73.00000000"] };

  it("その時刻以前の直近を返す", () => {
    expect(priceAtOrBefore(series, 100)).toBe("70.00000000");
    expect(priceAtOrBefore(series, 150)).toBe("70.00000000");
    expect(priceAtOrBefore(series, 200)).toBe("71.00000000");
    expect(priceAtOrBefore(series, 999)).toBe("73.00000000");
  });

  it("系列より前 / 空系列は undefined (前方の値で捏造しない)", () => {
    expect(priceAtOrBefore(series, 99)).toBeUndefined();
    expect(priceAtOrBefore({ t: [], usd8: [] }, 100)).toBeUndefined();
  });
});
