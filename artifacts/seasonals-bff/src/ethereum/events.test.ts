/**
 * events aggregator の cache: 失敗した source だけを短い間隔で再試行し、
 * 成功した source の RPC read は通常 TTL まで再利用する (Infura credit 削減)。
 */
jest.mock("./client", () => ({ getEthClient: () => ({}), sanitizeError: (e: unknown) => (e as Error).message }));
jest.mock("./ethena", () => ({ fetchEthenaUserEvents: jest.fn(async () => []) }));
jest.mock("./lido", () => ({ fetchLidoUserEvents: jest.fn(async () => []) }));
jest.mock("./pendle", () => ({ fetchPendlePublicEvents: jest.fn(async () => []), fetchPendleUserEvents: jest.fn(async () => []) }));

import { fetchEthenaUserEvents } from "./ethena";
import { fetchLidoUserEvents } from "./lido";
import { _clearEthCacheForTest, _invalidateUser, getUserEvents, registerUserSource } from "./events";

const OWNER = "0x00000000000000000000000000000000000000aa";
const flaky = jest.fn();
registerUserSource(() => ({ name: "cca:bids", needsRpc: true, run: flaky }));

let now = 1_000_000;
beforeEach(() => {
  jest.clearAllMocks();
  _clearEthCacheForTest();
  now = 1_000_000;
  jest.spyOn(Date, "now").mockImplementation(() => now);
});
afterEach(() => jest.restoreAllMocks());

test("a failing source is retried after 10 s without re-running the sources that succeeded", async () => {
  flaky.mockRejectedValueOnce(new Error("Scanning auction bids in the background")).mockResolvedValueOnce([]);

  const first = await getUserEvents(OWNER);
  expect(first.sources.find((s) => s.source === "cca:bids")).toMatchObject({ ok: false });

  now += 11_000;
  const second = await getUserEvents(OWNER);
  expect(second.sources.every((s) => s.ok)).toBe(true);
  expect(flaky).toHaveBeenCalledTimes(2);
  expect(fetchEthenaUserEvents).toHaveBeenCalledTimes(1);
  expect(fetchLidoUserEvents).toHaveBeenCalledTimes(1);
});

test("_invalidateUser drops the per-source cache too (post-execution refresh)", async () => {
  flaky.mockResolvedValue([]);
  await getUserEvents(OWNER);
  _invalidateUser(OWNER);
  await getUserEvents(OWNER);
  expect(fetchEthenaUserEvents).toHaveBeenCalledTimes(2);
});
