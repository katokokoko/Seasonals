/**
 * 2026-10: fetchSaveReserveTotals — Save reserve の on-chain decode → 供給総量 (bigint)。
 * getMultipleAccountsBase64 は mock。decode は実 SDK (parseReserve) に
 * 2026-10-06 実測の USDC main reserve account data を食わせて検証する。
 */
import { fetchSaveReserveTotals, _clearSaveReserveCacheForTest } from "./save-reserve";
import { getMultipleAccountsBase64 } from "./helius-rpc";

jest.mock("./helius-rpc");
const mockAccounts = getMultipleAccountsBase64 as jest.MockedFunction<
  typeof getMultipleAccountsBase64
>;

const SAVE_PROGRAM = "So1endDq2YkqhipRh3WViPa8hdiSpxWy6z3Z6tMCpAo";
const USDC_RESERVE = "BgxfHJDzm44T7XG68MYKx7YisTjZu73tVovyZSjJMpmw";
// 2026-10-06 実測 (getAccountInfo base64)。availableAmount 5337852800102 /
// borrowedAmountWads 17175893161672370158452809679932 / mintDecimals 6
const USDC_RESERVE_DATA_B64 =
  "AbyWCRsAAAAAATOzHsTv+PoomuqMlUwBYy4tdkkIzlRNaGW97xEb/2Erxvp6877brTo9ZfNqq8l0MbG75MLS9uDkfKYCA0UvXWEGbpdIlAlxcAyM9MVHGESm8j26mv3yVsBd27pvWYrqpBy+k5qDCfVkBxh//zCsVLFpSYvpn22OG/1CRGgM1PfR4gvB7tjQdPHDN9RMFkvKKNhMzhupikCxHBNanAAAAAAAZuzR0NoEAAA8RHSwSkGFNJ3TTcrYAAAAz2IQRKAVJBUAAAAAAAAAAAAoSp9baOANAAAAAAAAAAB47R1Wfg2+kjfDllSe3sA08hkpKYMRa2acM+p6tDx4Y3hrVJqiDwAAByTVoAxu0AT/TCxk3n5czwWGco/AWYg4MQFXus/s6qBcRgNNAQMHAIDGpH6NAwAAQGNSv8YBABQAsFtMNkQAAADAr9aRNgAAP3BApl+Czb2JX5yhJpGXIgODFyy65r5NP0zSG9YtqS4TFCh6odwJ3uMFAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACjvxexv4A0AAAAAAAAAAABflgAAAAAAAAAFTwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAN9RumhuTqUj640AAAAAAAD/////////////////////AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==";

afterEach(() => {
  jest.resetAllMocks();
  _clearSaveReserveCacheForTest();
});

describe("fetchSaveReserveTotals", () => {
  it("available + borrowedWads/1e18 を bigint で返す (実 account data)", async () => {
    mockAccounts.mockResolvedValue([
      { owner: SAVE_PROGRAM, data: Buffer.from(USDC_RESERVE_DATA_B64, "base64") },
    ]);
    const out = await fetchSaveReserveTotals([USDC_RESERVE]);
    expect(out.get(USDC_RESERVE)).toEqual({
      total: 5_337_852_800_102n + 17_175_893_161_672n, // = 22513745961774 (≈ 22.5M USDC)
      decimals: 6,
    });
  });

  it("account 欠落は throw (fixture へ degrade させる)", async () => {
    mockAccounts.mockResolvedValue([null]);
    await expect(fetchSaveReserveTotals([USDC_RESERVE])).rejects.toThrow(/not found/);
  });

  it("owner が Save program でなければ throw", async () => {
    mockAccounts.mockResolvedValue([
      {
        owner: "11111111111111111111111111111111",
        data: Buffer.from(USDC_RESERVE_DATA_B64, "base64"),
      },
    ]);
    await expect(fetchSaveReserveTotals([USDC_RESERVE])).rejects.toThrow(/unexpected owner/);
  });

  it("RPC 失敗はそのまま throw", async () => {
    mockAccounts.mockRejectedValue(new Error("Helius getMultipleAccounts HTTP 500"));
    await expect(fetchSaveReserveTotals([USDC_RESERVE])).rejects.toThrow(/HTTP 500/);
  });
});
