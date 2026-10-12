/**
 * save-tx — B2: reserve rates の共有 cache (120 秒、key = 並べ替えた ids)。
 */
import { fetchWithTimeout } from "./http";
import { fetchSaveReserveRates } from "./save-tx";
import { _clearAllCachesForTest } from "../cache/ttl-cache";

jest.mock("./http");
const mockFetch = fetchWithTimeout as jest.MockedFunction<typeof fetchWithTimeout>;
const reply = (ids: string[]) =>
  ({
    ok: true,
    status: 200,
    json: async () => ({ results: ids.map((id) => ({ reserve: { pubkey: id }, rates: { supplyInterest: "2.5" }, cTokenExchangeRate: "1.02" })) }),
  }) as unknown as Response;

beforeEach(() => {
  jest.clearAllMocks();
  _clearAllCachesForTest();
});

test("ids の順序に依らず同じ key、同時の呼び手は 1 回の GET に合流", async () => {
  mockFetch.mockResolvedValue(reply(["A", "B"]));
  const [x, y] = await Promise.all([fetchSaveReserveRates(["B", "A"]), fetchSaveReserveRates(["A", "B"])]);
  expect(x).toBe(y);
  expect(x).toEqual([
    { reserve: "A", supply_apy: 0.025, ctoken_exchange_rate: "1.02" },
    { reserve: "B", supply_apy: 0.025, ctoken_exchange_rate: "1.02" },
  ]);
  expect(mockFetch).toHaveBeenCalledTimes(1);
  expect(String(mockFetch.mock.calls[0]![0])).toContain("ids=A,B");
  await fetchSaveReserveRates(["A"]); // 別の組は別 key
  expect(mockFetch).toHaveBeenCalledTimes(2);
});

test("HTTP 失敗は cache しない、空 ids は呼ばない", async () => {
  mockFetch.mockResolvedValueOnce({ ok: false, status: 500 } as unknown as Response);
  await expect(fetchSaveReserveRates(["A"])).rejects.toThrow(/HTTP 500/);
  mockFetch.mockResolvedValue(reply(["A"]));
  await fetchSaveReserveRates(["A"]);
  await fetchSaveReserveRates(["A"]);
  expect(mockFetch).toHaveBeenCalledTimes(2);
  expect(await fetchSaveReserveRates([])).toEqual([]);
  expect(mockFetch).toHaveBeenCalledTimes(2);
});
