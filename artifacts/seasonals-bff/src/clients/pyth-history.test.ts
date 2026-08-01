/**
 * pyth-history — 過去価格クライアント (Phase 8.58)。
 * 実測で判明した API の癖 (`ids=` 形式 / UA 必須) と、キャッシュ・degrade を固定する。
 */
import { fetchWithTimeout } from "./http";
import {
  _clearPythHistoryCacheForTest,
  fetchHistoricalPrices,
  pythPriceToUsd8,
} from "./pyth-history";

jest.mock("./http");

const mockFetch = fetchWithTimeout as jest.MockedFunction<typeof fetchWithTimeout>;

const SOL_FEED =
  "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";

function reply(parsed: unknown): Response {
  return {
    ok: true,
    json: async () => ({ parsed }),
  } as unknown as Response;
}

beforeEach(() => {
  jest.clearAllMocks();
  _clearPythHistoryCacheForTest();
});

describe("pythPriceToUsd8", () => {
  it("price + expo を USD 8-dec string に (実測値の形)", () => {
    expect(pythPriceToUsd8("7492000000", -8)).toBe("74.92000000");
    expect(pythPriceToUsd8("99981113", -8)).toBe("0.99981113");
  });

  it("expo が 8 以外でも 8 桁に揃える", () => {
    expect(pythPriceToUsd8("7492", -2)).toBe("74.92000000"); // 桁が少ない
    expect(pythPriceToUsd8("749200000000", -10)).toBe("74.92000000"); // 多い→切り捨て
  });

  it("整数 (expo 0) と不正値", () => {
    expect(pythPriceToUsd8("74", 0)).toBe("74.00000000");
    expect(pythPriceToUsd8("abc", -8)).toBeNull();
  });
});

describe("fetchHistoricalPrices", () => {
  it("`ids=` 形式で問い合わせ、0x 有無どちらでも引ける Map を返す", async () => {
    mockFetch.mockResolvedValue(
      reply([{ id: SOL_FEED.slice(2), price: { price: "7492000000", expo: -8 } }])
    );
    const out = await fetchHistoricalPrices([SOL_FEED], 1785461091);
    const url = mockFetch.mock.calls[0]![0] as string;
    expect(url).toContain("/1785461091?");
    expect(url).toContain(`ids=${encodeURIComponent(SOL_FEED)}`);
    expect(url).not.toContain("ids[]"); // 実測: ids[] は 422
    expect(out.get(SOL_FEED)).toBe("74.92000000");
    expect(out.get(SOL_FEED.slice(2))).toBe("74.92000000");
  });

  it("Cloudflare 対策の User-Agent を付ける", async () => {
    mockFetch.mockResolvedValue(reply([]));
    await fetchHistoricalPrices([SOL_FEED], 1785461091);
    const init = mockFetch.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>)["user-agent"]).toBeTruthy();
  });

  it("過去価格は不変なので 2 回目は fetch しない", async () => {
    mockFetch.mockResolvedValue(
      reply([{ id: SOL_FEED, price: { price: "7492000000", expo: -8 } }])
    );
    await fetchHistoricalPrices([SOL_FEED], 1785461091);
    await fetchHistoricalPrices([SOL_FEED], 1785461091);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("HTTP 失敗 / 例外はその日を空 Map で落とす (0 で埋めない)", async () => {
    mockFetch.mockResolvedValue({ ok: false } as Response);
    expect((await fetchHistoricalPrices([SOL_FEED], 1)).size).toBe(0);
    _clearPythHistoryCacheForTest();
    mockFetch.mockRejectedValue(new Error("network"));
    expect((await fetchHistoricalPrices([SOL_FEED], 2)).size).toBe(0);
  });

  it("feed 指定が空なら叩かない", async () => {
    expect((await fetchHistoricalPrices([], 1)).size).toBe(0);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
