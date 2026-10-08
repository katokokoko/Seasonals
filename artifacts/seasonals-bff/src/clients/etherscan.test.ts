jest.mock("./http", () => ({ fetchWithTimeout: jest.fn() }));

import { fetchWithTimeout } from "./http";
import {
  ETHERSCAN_PAGE_SIZE,
  EtherscanNotConfiguredError,
  _resetEtherscanQueueForTest,
  fetchAccountHistory,
  fetchLogs,
} from "./etherscan";

const mockFetch = fetchWithTimeout as jest.Mock;
const ENV = { ETHERSCAN_API_KEY: "secret-etherscan-key-123" } as NodeJS.ProcessEnv;
const ADDR = "0x1111111111111111111111111111111111111111";

function page(n: number, oldestTs: number) {
  return Array.from({ length: n }, (_, i) => ({
    hash: `0x${i}`,
    timeStamp: String(oldestTs + (n - i)),
    from: ADDR,
    to: "0x2",
    value: "1",
  }));
}

function respond(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}

beforeEach(() => {
  mockFetch.mockReset();
  _resetEtherscanQueueForTest();
});

describe("fetchAccountHistory", () => {
  it("refuses without a key (no request is made)", async () => {
    await expect(
      fetchAccountHistory("txlist", ADDR, { cutoffSec: 0 }, {} as NodeJS.ProcessEnv)
    ).rejects.toBeInstanceOf(EtherscanNotConfiguredError);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("stops on a short page and reports complete", async () => {
    mockFetch.mockResolvedValueOnce(respond({ status: "1", result: page(3, 1000) }));
    const res = await fetchAccountHistory("txlist", ADDR, { cutoffSec: 0 }, ENV);
    expect(res.rows).toHaveLength(3);
    expect(res.complete).toBe(true);
    const url = mockFetch.mock.calls[0]![0] as string;
    expect(url).toContain("chainid=1");
    expect(url).toContain("action=txlist");
    expect(url).toContain("sort=desc");
  });

  it("pages until the cutoff is reached", async () => {
    mockFetch
      .mockResolvedValueOnce(respond({ status: "1", result: page(ETHERSCAN_PAGE_SIZE, 5000) }))
      .mockResolvedValueOnce(respond({ status: "1", result: page(ETHERSCAN_PAGE_SIZE, 100) }));
    const res = await fetchAccountHistory("tokentx", ADDR, { cutoffSec: 200 }, ENV);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(res.complete).toBe(true);
  });

  it("reports incomplete when the page cap is hit", async () => {
    mockFetch.mockResolvedValue(respond({ status: "1", result: page(ETHERSCAN_PAGE_SIZE, 5000) }));
    const res = await fetchAccountHistory("txlist", ADDR, { cutoffSec: 0, maxPages: 2 }, ENV);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(res.complete).toBe(false);
  });

  it("treats 'No transactions found' as empty, not as failure", async () => {
    mockFetch.mockResolvedValueOnce(respond({ status: "0", message: "No transactions found", result: [] }));
    const res = await fetchAccountHistory("txlistinternal", ADDR, { cutoffSec: 0 }, ENV);
    expect(res).toEqual({ rows: [], complete: true });
  });

  it("throws on API errors without leaking the key or URL", async () => {
    const prev = process.env.ETHERSCAN_API_KEY;
    process.env.ETHERSCAN_API_KEY = ENV.ETHERSCAN_API_KEY;
    mockFetch.mockRejectedValueOnce(
      new Error(`fetch failed https://api.etherscan.io/v2/api?apikey=${ENV.ETHERSCAN_API_KEY}`)
    );
    try {
      const err = await fetchAccountHistory("txlist", ADDR, { cutoffSec: 0 }, ENV).catch((e: Error) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).not.toContain(ENV.ETHERSCAN_API_KEY);
      expect((err as Error).message).not.toContain("api.etherscan.io");
    } finally {
      process.env.ETHERSCAN_API_KEY = prev;
    }
  });

  it("throws on NOTOK responses (rate limit / invalid key)", async () => {
    mockFetch.mockResolvedValueOnce(respond({ status: "0", message: "NOTOK", result: "Max rate limit reached" }));
    await expect(fetchAccountHistory("txlist", ADDR, { cutoffSec: 0 }, ENV)).rejects.toThrow(
      /Max rate limit reached/
    );
  });
});

describe("fetchLogs", () => {
  const T0 = `0x${"ab".repeat(32)}` as const;
  const T2 = `0x${"00".repeat(12)}${"11".repeat(20)}` as const;
  const log = (i: number) => ({
    address: "0xC0DA000000000000000000000000000000000001",
    topics: [T0, `0x${String(i).padStart(64, "0")}`, T2],
    data: "0x",
    blockNumber: "0x10",
  });

  it("queries topics with AND operators and normalises rows for decodeEventLog", async () => {
    mockFetch.mockResolvedValueOnce(respond({ status: "1", result: [log(1)] }));
    const rows = await fetchLogs({ fromBlock: 100n, toBlock: 200n, topics: { 0: T0, 2: T2 } }, ENV);
    const url = new URL(mockFetch.mock.calls[0]![0] as string);
    expect(url.searchParams.get("module")).toBe("logs");
    expect(url.searchParams.get("action")).toBe("getLogs");
    expect(url.searchParams.get("chainid")).toBe("1");
    expect(url.searchParams.get("fromBlock")).toBe("100");
    expect(url.searchParams.get("toBlock")).toBe("200");
    expect(url.searchParams.get("topic0")).toBe(T0);
    expect(url.searchParams.get("topic2")).toBe(T2);
    expect(url.searchParams.get("topic0_2_opr")).toBe("and");
    expect(url.searchParams.has("address")).toBe(false);
    expect(rows).toEqual([{ address: "0xc0da000000000000000000000000000000000001", topics: log(1).topics, data: "0x", blockNumber: 16n }]);
  });

  it("pages while a page is full", async () => {
    mockFetch
      .mockResolvedValueOnce(respond({ status: "1", result: Array.from({ length: ETHERSCAN_PAGE_SIZE }, (_, i) => log(i)) }))
      .mockResolvedValueOnce(respond({ status: "1", result: [log(9999)] }));
    const rows = await fetchLogs({ fromBlock: 1n, toBlock: "latest", topics: { 0: T0 } }, ENV);
    expect(rows).toHaveLength(ETHERSCAN_PAGE_SIZE + 1);
    expect(new URL(mockFetch.mock.calls[1]![0] as string).searchParams.get("page")).toBe("2");
  });

  it("treats 'No records found' as empty and refuses without a key", async () => {
    mockFetch.mockResolvedValueOnce(respond({ status: "0", message: "No records found", result: [] }));
    expect(await fetchLogs({ fromBlock: 1n, toBlock: 2n, topics: { 0: T0 } }, ENV)).toEqual([]);
    await expect(fetchLogs({ fromBlock: 1n, toBlock: 2n, topics: { 0: T0 } }, {} as NodeJS.ProcessEnv)).rejects.toBeInstanceOf(
      EtherscanNotConfiguredError
    );
  });

  it("throws on NOTOK (rate limit) responses", async () => {
    mockFetch.mockResolvedValueOnce(respond({ status: "0", message: "NOTOK", result: "Max calls per sec rate limit reached (3/sec)" }));
    await expect(fetchLogs({ fromBlock: 1n, toBlock: 2n, topics: { 0: T0 } }, ENV)).rejects.toThrow(/rate limit/);
  });
});
