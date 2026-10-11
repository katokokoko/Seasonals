/**
 * usage — Helius 呼び出しの分類と概算 credit
 */
import { TtlCache, _clearAllCachesForTest } from "./cache/ttl-cache";
import {
  _resetUsageForTest,
  classifyHeliusRequest,
  creditFor,
  recordQueueDepth,
  recordUpstreamCall,
  usageSnapshot,
} from "./usage";

beforeEach(() => {
  _resetUsageForTest();
  _clearAllCachesForTest();
});

test("credit 表: RPC 1 / GPA 10 / DAS 10 / Enhanced 100 / Parsed 10", () => {
  expect(creditFor("rpc", "getMultipleAccounts")).toBe(1);
  expect(creditFor("rpc", "getProgramAccounts")).toBe(10);
  expect(creditFor("das", "getAssetsByOwner")).toBe(10);
  expect(creditFor("enhanced", "addresses.transactions")).toBe(100);
  expect(creditFor("parsed", "parsed-events")).toBe(10);
});

test("classifyHeliusRequest: URL と JSON-RPC method で振り分ける", () => {
  expect(classifyHeliusRequest("https://api.helius.xyz/v0/addresses/W/transactions?api-key=k", undefined)).toEqual([
    { api: "enhanced", method: "addresses.transactions" },
  ]);
  expect(classifyHeliusRequest("https://api.helius.xyz/v1/parsed-events/W?api-key=k", undefined)).toEqual([
    { api: "parsed", method: "parsed-events" },
  ]);
  const rpc = "https://mainnet.helius-rpc.com/?api-key=k";
  expect(classifyHeliusRequest(rpc, JSON.stringify({ method: "searchAssets" }))).toEqual([{ api: "das", method: "searchAssets" }]);
  expect(classifyHeliusRequest(rpc, JSON.stringify({ method: "getAssetBatch" }))).toEqual([{ api: "das", method: "getAssetBatch" }]);
  expect(classifyHeliusRequest(rpc, JSON.stringify([{ method: "getSlot" }, { method: "getBalance" }]))).toEqual([
    { api: "rpc", method: "getSlot" },
    { api: "rpc", method: "getBalance" },
  ]);
  expect(classifyHeliusRequest(rpc, "not json")).toEqual([{ api: "rpc", method: "unknown" }]);
});

test("usageSnapshot: 合計・429・失敗・最大待ち行列・cache stats", async () => {
  recordUpstreamCall({ api: "rpc", method: "getEpochInfo", status: 200 });
  recordUpstreamCall({ api: "rpc", method: "getProgramAccounts", status: 200 });
  recordUpstreamCall({ api: "das", method: "getAssetsByOwner", status: 429 });
  recordUpstreamCall({ api: "enhanced", method: "addresses.transactions", status: null });
  recordQueueDepth(3);
  recordQueueDepth(1);
  const cache = new TtlCache<number>({ name: "usage.test", ttlMs: 1000 });
  await cache.getOrLoad("k", async () => 1);
  const u = usageSnapshot();
  expect(u).toMatchObject({
    requests: 4,
    approxCredits: 1 + 10 + 10 + 100,
    byApi: { rpc: 2, das: 1, enhanced: 1, parsed: 0 },
    rateLimited: { rpc: 0, das: 1, enhanced: 0, parsed: 0, total: 1 },
    failed: 2,
    maxQueueDepth: 3,
  });
  expect(Object.keys(u.byMethod)[0]).toBe("das:getAssetsByOwner"); // 同数は名前順
  expect(u.caches["usage.test"]).toMatchObject({ misses: 1, size: 1 });
  expect(typeof u.since).toBe("string");
  _resetUsageForTest();
  expect(usageSnapshot().requests).toBe(0);
});
