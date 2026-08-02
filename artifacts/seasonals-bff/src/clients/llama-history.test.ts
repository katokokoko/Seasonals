/**
 * llama-history — Pyth feed が無い token の過去価格 (Phase 8.64)。
 *
 * 実測で判明した癖 (バッチ / period 表記 / confidence / 空応答) と、
 * 「取れなければ degrade するだけで 0 では埋めない」性質を固定する。
 */
import { fetchWithTimeout } from "./http";
import {
  _clearLlamaHistoryCacheForTest,
  anchorSeries,
  fetchLlamaPriceSeries,
  llamaCoinKey,
  periodForStep,
} from "./llama-history";

jest.mock("./http");

const mockFetch = fetchWithTimeout as jest.MockedFunction<typeof fetchWithTimeout>;
const HOUR = 3_600;
const DAY = 86_400;
const JL_USDC = "9BEcn9aPEmhSPbPQeFGjidRiEKki46fVQDyPpSQXPA2D";
const JITO_SOL = "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn";

function reply(body: unknown): Response {
  return { ok: true, json: async () => body } as unknown as Response;
}

beforeEach(() => {
  jest.clearAllMocks();
  _clearLlamaHistoryCacheForTest();
});

describe("llamaCoinKey / periodForStep", () => {
  it("mint は solana: 接頭辞のキーになる", () => {
    expect(llamaCoinKey(JL_USDC)).toBe(`solana:${JL_USDC}`);
  });

  it("刻みが 1 日未満なら時間表記、以上なら日表記", () => {
    expect(periodForStep(2 * HOUR)).toBe("2h");
    expect(periodForStep(12 * HOUR)).toBe("12h");
    expect(periodForStep(DAY)).toBe("1d");
    expect(periodForStep(4 * DAY)).toBe("4d");
  });
});

describe("fetchLlamaPriceSeries", () => {
  it("複数 mint を 1 リクエストにまとめ、昇順の 8-dec 系列にする", async () => {
    mockFetch.mockResolvedValue(
      reply({
        coins: {
          [`solana:${JL_USDC}`]: {
            symbol: "jlUSDC",
            confidence: 0.9,
            prices: [
              { timestamp: 200, price: 1.0428957372 },
              { timestamp: 100, price: 1.0426878415 },
            ],
          },
          [`solana:${JITO_SOL}`]: {
            symbol: "JITOSOL",
            confidence: 0.99,
            prices: [{ timestamp: 100, price: 96.67011659 }],
          },
        },
      })
    );
    const out = await fetchLlamaPriceSeries([JL_USDC, JITO_SOL], 100, 300, DAY);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const url = mockFetch.mock.calls[0]![0] as string;
    expect(url).toContain("coins.llama.fi/chart/");
    expect(url).toContain(`solana:${JL_USDC}`);
    expect(url).toContain(`solana:${JITO_SOL}`);
    expect(url).toContain("period=1d");
    // 返る順に依存せず時刻昇順に整列する
    expect(out.get(JL_USDC)).toEqual({
      t: [100, 200],
      usd8: ["1.04268784", "1.04289574"],
    });
    expect(out.get(JITO_SOL)!.usd8).toEqual(["96.67011659"]);
  });

  it("Cloudflare 対策の User-Agent を付ける", async () => {
    mockFetch.mockResolvedValue(reply({ coins: {} }));
    await fetchLlamaPriceSeries([JL_USDC], 1, 2, DAY);
    const init = mockFetch.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>)["user-agent"]).toBeTruthy();
  });

  it("confidence が閾値未満の coin は採用しない", async () => {
    mockFetch.mockResolvedValue(
      reply({
        coins: {
          [`solana:${JL_USDC}`]: {
            confidence: 0.3,
            prices: [{ timestamp: 100, price: 1.04 }],
          },
        },
      })
    );
    const out = await fetchLlamaPriceSeries([JL_USDC], 100, 300, DAY);
    expect(out.has(JL_USDC)).toBe(false);
  });

  it("空 coins / HTTP 失敗 / 例外は空 Map で degrade (0 で埋めない)", async () => {
    mockFetch.mockResolvedValue(reply({ coins: {} }));
    expect((await fetchLlamaPriceSeries([JL_USDC], 1, 2, DAY)).size).toBe(0);
    _clearLlamaHistoryCacheForTest();
    mockFetch.mockResolvedValue({ ok: false } as Response);
    expect((await fetchLlamaPriceSeries([JL_USDC], 3, 4, DAY)).size).toBe(0);
    _clearLlamaHistoryCacheForTest();
    mockFetch.mockRejectedValue(new Error("network"));
    expect((await fetchLlamaPriceSeries([JL_USDC], 5, 6, DAY)).size).toBe(0);
  });

  it("同じ範囲の 2 回目は fetch しない", async () => {
    mockFetch.mockResolvedValue(
      reply({
        coins: {
          [`solana:${JL_USDC}`]: { prices: [{ timestamp: 1, price: 1.04 }] },
        },
      })
    );
    await fetchLlamaPriceSeries([JL_USDC], 1, 2, DAY);
    await fetchLlamaPriceSeries([JL_USDC], 1, 2, DAY);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("mint が空なら fetch しない", async () => {
    expect((await fetchLlamaPriceSeries([], 1, 2, DAY)).size).toBe(0);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("anchorSeries", () => {
  const series = { t: [100, 200], usd8: ["1.04268784", "1.05372000"] };

  it("末尾を現在価格に合わせ、比 (= 利回りの形) を保つ", () => {
    const out = anchorSeries(series, "1.05312160");
    expect(out.usd8[1]).toBe("1.05312160");
    // 先頭も同じ比率で下がる (1.04268784 × 1.05312160 / 1.05372)
    expect(out.usd8[0]).toBe("1.04209570");
    // 元の系列は書き換えない
    expect(series.usd8[1]).toBe("1.05372000");
  });

  it("currentUsd8 が無い / 系列が空 / 同値なら素通し", () => {
    expect(anchorSeries(series, undefined)).toBe(series);
    const empty = { t: [], usd8: [] };
    expect(anchorSeries(empty, "1.0")).toBe(empty);
    expect(anchorSeries(series, "1.05372000")).toBe(series);
  });
});
