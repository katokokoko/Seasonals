/**
 * meteora-tx — B2: DLMM pool instance の共有 cache (60 秒 + 同時 miss の合流)。
 * SDK は mock。positions の読み (getPositionsByUserAndLbPair) は毎回 live のまま。
 */
import { METEORA_MARKETS } from "@workspace/lib/config/meteora-markets";
import { fetchMeteoraPositions } from "./meteora-tx";
import { _clearAllCachesForTest } from "../cache/ttl-cache";

const mockGetPositions = jest.fn(async () => ({ activeBin: { price: "1" }, userPositions: [] }));
const mockCreate = jest.fn(async () => ({ getPositionsByUserAndLbPair: mockGetPositions }));
jest.mock("@meteora-ag/dlmm", () => ({ create: (...args: unknown[]) => mockCreate(...(args as [])) }));

const WALLET = "11111111111111111111111111111111";

beforeEach(() => {
  jest.clearAllMocks();
  _clearAllCachesForTest();
  process.env.HELIUS_API_KEY = "test-key";
});
afterEach(() => jest.useRealTimers());

test("pool は market ごとに 1 回だけ create (同時の呼び手も合流)、60 秒で作り直す", async () => {
  jest.useFakeTimers({ now: 1_800_000_000_000, doNotFake: ["nextTick", "setImmediate"] });
  await Promise.all([fetchMeteoraPositions(WALLET), fetchMeteoraPositions(WALLET)]);
  expect(mockCreate).toHaveBeenCalledTimes(METEORA_MARKETS.length);
  expect(mockGetPositions).toHaveBeenCalledTimes(METEORA_MARKETS.length * 2); // position の読みは live
  jest.advanceTimersByTime(59_000);
  await fetchMeteoraPositions(WALLET);
  expect(mockCreate).toHaveBeenCalledTimes(METEORA_MARKETS.length);
  jest.advanceTimersByTime(1_000);
  await fetchMeteoraPositions(WALLET);
  expect(mockCreate).toHaveBeenCalledTimes(METEORA_MARKETS.length * 2);
});

test("create の失敗は cache しない", async () => {
  mockCreate.mockRejectedValueOnce(new Error("rpc down"));
  await expect(fetchMeteoraPositions(WALLET)).rejects.toThrow(/rpc down/);
  await fetchMeteoraPositions(WALLET);
  expect(mockCreate).toHaveBeenCalledTimes(1 + METEORA_MARKETS.length);
});
