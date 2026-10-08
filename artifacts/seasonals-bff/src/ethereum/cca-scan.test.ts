/**
 * CCA bid scan の経路 (Etherscan logs API / Infura getLogs fallback) と enrich の negative cache。
 * Infura credit 削減 (docs/web/WORKLOG.md) の回帰防止。
 */
import { encodeAbiParameters, encodeEventTopics, pad } from "viem";
import { ccaAuctionAbi } from "./abis";

const client = {
  getBlock: jest.fn(),
  getBlockNumber: jest.fn(),
  getLogs: jest.fn(),
  multicall: jest.fn(),
  request: jest.fn(),
};
jest.mock("./client", () => ({ getEthClient: () => client, sanitizeError: (e: unknown) => String(e) }));
jest.mock("./events", () => ({ registerPublicSource: jest.fn(), registerUserSource: jest.fn() }));
jest.mock("../persistence", () => ({ loadJson: () => null, saveJson: jest.fn() }));
jest.mock("../clients/etherscan", () => ({ etherscanApiKey: jest.fn(), fetchLogs: jest.fn() }));

import { etherscanApiKey, fetchLogs } from "../clients/etherscan";
import { _setCcaAuctionsForTest, fetchCcaPublicEvents, fetchCcaUserEvents, type CcaAuction } from "./cca";

const mockKey = etherscanApiKey as jest.Mock;
const mockFetchLogs = fetchLogs as jest.Mock;

const OWNER = "0x00000000000000000000000000000000000000aa";
const AUC = "0x00000000000000000000000000000000000000c1";
const OTHER = "0x00000000000000000000000000000000000000c2";
const HEAD = 30_000n;
const NOW = "2026-10-05T00:00:00.000Z";

const auction = (over: Partial<CcaAuction> = {}): CcaAuction => ({
  auction: AUC,
  token: "0x1234567890123456789012345678901234567890",
  factory: "0x00000000000000000000000000000000000000f1",
  amount: "1000",
  currency: "0x0000000000000000000000000000000000000000",
  startBlock: "5000",
  endBlock: "40000",
  claimBlock: "41000",
  floorPriceQ96: "1",
  requiredCurrencyRaised: "1",
  createdBlock: "4000",
  tokenSymbol: "XYZ",
  tokenDecimals: 18,
  currencySymbol: "ETH",
  currencyDecimals: 18,
  graduated: null,
  ...over,
});

function bidSubmitted(address: string, id: bigint) {
  return {
    address,
    topics: encodeEventTopics({ abi: ccaAuctionAbi, eventName: "BidSubmitted", args: { id, owner: OWNER as `0x${string}` } }),
    data: encodeAbiParameters([{ type: "uint256" }, { type: "uint128" }], [7n, 100n]),
    blockNumber: 6000n,
  };
}
function bidExited(address: string, bidId: bigint) {
  return {
    address,
    topics: encodeEventTopics({ abi: ccaAuctionAbi, eventName: "BidExited", args: { bidId, owner: OWNER as `0x${string}` } }),
    data: encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [1n, 2n]),
    blockNumber: 7000n,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  client.getBlock.mockResolvedValue({ number: HEAD, timestamp: BigInt(Date.parse(NOW) / 1000) });
  client.getBlockNumber.mockResolvedValue(HEAD);
  _setCcaAuctionsForTest([auction()]);
});

test("Etherscan path: one topic0+owner query per event, no Infura getLogs, foreign auctions dropped", async () => {
  mockKey.mockReturnValue("key");
  mockFetchLogs.mockImplementation(async ({ topics }: { topics: Record<number, string> }) => {
    const [submittedSig] = encodeEventTopics({ abi: ccaAuctionAbi, eventName: "BidSubmitted" });
    const [exitedSig] = encodeEventTopics({ abi: ccaAuctionAbi, eventName: "BidExited" });
    if (topics[0] === submittedSig) return [bidSubmitted(AUC, 1n), bidSubmitted(OTHER, 9n)];
    if (topics[0] === exitedSig) return [bidExited(AUC, 1n)];
    return [];
  });

  const ev = await fetchCcaUserEvents(OWNER, NOW);

  expect(mockFetchLogs).toHaveBeenCalledTimes(3);
  for (const [f] of mockFetchLogs.mock.calls) {
    expect(f).toMatchObject({ fromBlock: 5000n, toBlock: HEAD, topics: { 2: pad(OWNER as `0x${string}`, { size: 32 }) } });
  }
  expect(client.request).not.toHaveBeenCalled();
  expect(ev.length).toBeGreaterThan(0);
  expect(ev.every((e) => JSON.stringify(e).includes(AUC))).toBe(true);
  expect(JSON.stringify(ev)).not.toContain(OTHER);
});

test("without an Etherscan key, falls back to chunked Infura eth_getLogs with the same result", async () => {
  mockKey.mockReturnValue(null);
  mockFetchLogs.mockResolvedValue([]);
  client.request.mockImplementation(async ({ params: [p] }: { params: [{ fromBlock: string }] }) =>
    BigInt(p.fromBlock) === 5000n ? [bidSubmitted(AUC, 1n), bidExited(AUC, 1n)] : []
  );

  const viaRpc = await fetchCcaUserEvents(OWNER, NOW);

  expect(mockFetchLogs).not.toHaveBeenCalled();
  // 5000..30000 を 10k block ずつ = 3 chunk
  expect(client.request).toHaveBeenCalledTimes(3);
  expect(client.request.mock.calls[0]![0]).toMatchObject({ method: "eth_getLogs" });

  _setCcaAuctionsForTest([auction()]);
  mockKey.mockReturnValue("key");
  mockFetchLogs.mockImplementation(async ({ topics }: { topics: Record<number, string> }) => {
    const [submittedSig] = encodeEventTopics({ abi: ccaAuctionAbi, eventName: "BidSubmitted" });
    const [exitedSig] = encodeEventTopics({ abi: ccaAuctionAbi, eventName: "BidExited" });
    if (topics[0] === submittedSig) return [bidSubmitted(AUC, 1n)];
    if (topics[0] === exitedSig) return [bidExited(AUC, 1n)];
    return [];
  });
  const viaEtherscan = await fetchCcaUserEvents(OWNER, NOW);
  expect(viaEtherscan).toEqual(viaRpc);
});

test("enrich: a reverted per-token read is not retried on every request", async () => {
  _setCcaAuctionsForTest([auction({ tokenSymbol: undefined, tokenDecimals: undefined })]);
  client.multicall.mockResolvedValue([{ status: "failure" }, { status: "failure" }, { status: "success", result: false }]);

  await fetchCcaPublicEvents(NOW);
  await fetchCcaPublicEvents(NOW);

  expect(client.multicall).toHaveBeenCalledTimes(1);
});
