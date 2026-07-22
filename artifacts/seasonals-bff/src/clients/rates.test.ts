/**
 * Phase 8.33: fetchExponentFullMarkets の parse / fail-closed 検証。
 * global fetch を mock し、実 network なし (_clearRatesCacheForTest で cache 隔離)。
 */
import { _clearRatesCacheForTest, fetchExponentFullMarkets } from "./rates";

const VALID_ENTRY = {
  underlyingAsset: {
    ticker: "USX",
    mint: "6FrrzDk5mQARGc1TDYoyVnSyRdds1t4PbtohCD6p3tgG",
    decimals: 6,
    price_source: "jupiter",
  },
  quoteAsset: { ticker: "USD" },
  ptMint: "6gUU7UXtGgJ3tmeb2gXxQcVeM2L82bg9MzRYxu2YUspu",
  ytMint: "47gQiyWpVd13mmAFXemW1wVTd2e2GYKq5bLrdRXUfxsS",
  vaultAddress: "CdUviheAUJaXUryT7JCRDUoNdPXdVvkxNQY1okC6uY8S",
  decimals: 6,
  maturityDateUnixTs: 1789552700,
  impliedApy: 0.056,
  underlyingApy: 0.048,
  totalMarketSize: 47593493.68,
  ptPriceInAsset: 0.972,
  marketStatus: "active",
};

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

describe("fetchExponentFullMarkets (Phase 8.33)", () => {
  it("valid entry を ExponentFullMarket に map する", async () => {
    mockFetchJson([VALID_ENTRY]);
    const out = await fetchExponentFullMarkets();
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      ticker: "USX",
      underlying_mint: VALID_ENTRY.underlyingAsset.mint,
      underlying_decimals: 6,
      pt_mint: VALID_ENTRY.ptMint,
      yt_mint: VALID_ENTRY.ytMint,
      vault_address: VALID_ENTRY.vaultAddress,
      pt_decimals: 6,
      maturity_ts: 1789552700,
      implied_apy: 0.056,
      underlying_apy: 0.048,
      total_market_size: 47593493.68,
      quote_ticker: "USD",
      pt_price_in_asset: 0.972,
      market_status: "active",
    });
  });

  it("ptMint / maturity 欠落 entry は skip (fail-closed、他の entry は生きる)", async () => {
    mockFetchJson([
      { ...VALID_ENTRY, ptMint: undefined },
      { ...VALID_ENTRY, maturityDateUnixTs: 0 },
      { ...VALID_ENTRY, underlyingAsset: { ticker: "USX" } }, // mint 欠落
      VALID_ENTRY,
    ]);
    const out = await fetchExponentFullMarkets();
    expect(out).toHaveLength(1);
    expect(out[0]!.pt_mint).toBe(VALID_ENTRY.ptMint);
  });

  it("非配列 response は空配列", async () => {
    mockFetchJson({ error: "unexpected" });
    expect(await fetchExponentFullMarkets()).toEqual([]);
  });

  it("optional な pt_price_in_asset / quote_ticker / vault_address は安全 default に落ちる", async () => {
    mockFetchJson([
      {
        ...VALID_ENTRY,
        ptPriceInAsset: undefined,
        quoteAsset: undefined,
        vaultAddress: undefined,
      },
    ]);
    const out = await fetchExponentFullMarkets();
    expect(out[0]!.pt_price_in_asset).toBe(1);
    expect(out[0]!.quote_ticker).toBe("");
    expect(out[0]!.vault_address).toBe(""); // 空 = redeem endpoint が unsupported 扱い
  });

  it("HTTP エラーは throw (呼び手の allSettled が degrade)", async () => {
    mockFetchJson(null, false, 503);
    await expect(fetchExponentFullMarkets()).rejects.toThrow(
      "Exponent markets HTTP 503"
    );
  });

  it("10min cache: 2 回目は fetch しない", async () => {
    const spy = mockFetchJson([VALID_ENTRY]);
    await fetchExponentFullMarkets();
    await fetchExponentFullMarkets();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
