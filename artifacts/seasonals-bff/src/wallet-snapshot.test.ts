/**
 * Phase B3: wallet snapshot — 8 source を wallet ごとに 1 回読み、TTL / SWR / invalidate で共有する。
 * client は module mock (softfail.test.ts と同じ流儀、ただし SDK を読まない factory mock)。
 * 時計は `_setWalletSnapshotClockForTest` で注入 (timer を使わない)。
 */
import { fetchAssetsByOwner, invalidateAssetsCacheForWallet } from "./clients/helius";
import {
  fetchEnhancedTransactions,
  invalidateEnhancedTxCacheForWallet,
} from "./clients/helius-tx";
import { fetchStakeAccounts } from "./clients/helius-rpc";
import {
  fetchEarnPositions,
  invalidateEarnPositionsCacheForWallet,
} from "./clients/jupiter-lend";
import {
  fetchKaminoObligations,
  fetchKaminoVaultUserPositions,
} from "./clients/kamino-tx";
import { fetchMeteoraPositions } from "./clients/meteora-tx";
import { fetchOrcaPositions } from "./clients/orca-tx";
import { KAMINO_MAIN_MARKET } from "@workspace/lib/config/kamino-markets";
import { allCacheStats } from "./cache/ttl-cache";
import {
  SNAPSHOT_SHORT_TTL_MS,
  SNAPSHOT_TTL_MS,
  _clearWalletSnapshotForTest,
  _peekWalletSnapshotForTest,
  _setWalletSnapshotClockForTest,
  _walletSnapshotStatsForTest,
  invalidateWalletSnapshot,
  loadWalletSnapshot,
  snapshotAgeMs,
} from "./wallet-snapshot";

jest.mock("./clients/helius", () => ({
  fetchAssetsByOwner: jest.fn(),
  invalidateAssetsCacheForWallet: jest.fn(),
}));
jest.mock("./clients/helius-tx", () => ({
  fetchEnhancedTransactions: jest.fn(),
  invalidateEnhancedTxCacheForWallet: jest.fn(),
}));
jest.mock("./clients/helius-rpc", () => ({ fetchStakeAccounts: jest.fn() }));
jest.mock("./clients/jupiter-lend", () => ({
  fetchEarnPositions: jest.fn(),
  invalidateEarnPositionsCacheForWallet: jest.fn(),
}));
jest.mock("./clients/kamino-tx", () => ({
  fetchKaminoObligations: jest.fn(),
  fetchKaminoVaultUserPositions: jest.fn(),
}));
jest.mock("./clients/meteora-tx", () => ({ fetchMeteoraPositions: jest.fn() }));
jest.mock("./clients/orca-tx", () => ({ fetchOrcaPositions: jest.fn() }));

const WALLET = "6QGJNXnCjhYkKgPpDm7qRzxBKCj9KugUL2LDHc8sGUUM";
const OTHER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

const CLIENTS = [
  fetchAssetsByOwner,
  fetchEnhancedTransactions,
  fetchMeteoraPositions,
  fetchOrcaPositions,
  fetchKaminoObligations,
  fetchKaminoVaultUserPositions,
  fetchEarnPositions,
  fetchStakeAccounts,
] as unknown as jest.Mock[];

/** settle → TTL 決定 → cache.set の microtask 連鎖を流し切る */
const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

let t = 1_000_000;

beforeEach(() => {
  jest.clearAllMocks();
  t = 1_000_000;
  _setWalletSnapshotClockForTest(() => t);
  _clearWalletSnapshotForTest();
  for (const fn of CLIENTS) fn.mockResolvedValue([]);
});

afterAll(() => {
  _setWalletSnapshotClockForTest(null);
});

function callsFor(wallet: string): number {
  return (fetchAssetsByOwner as jest.Mock).mock.calls.filter((c) => c[0] === wallet).length;
}

describe("loadWalletSnapshot — 共有と dedupe", () => {
  it("同時の 3 呼び出しは同じ snapshot を共有し、各 client は 1 回だけ呼ばれる", async () => {
    const a = loadWalletSnapshot(WALLET);
    const b = loadWalletSnapshot(WALLET);
    const c = loadWalletSnapshot(WALLET);
    expect(b).toBe(a);
    expect(c).toBe(a);
    await a.settled;
    for (const fn of CLIENTS) expect(fn).toHaveBeenCalledTimes(1);
    // 引数の形は route が直接呼んでいた時と同じ
    expect(fetchEnhancedTransactions).toHaveBeenCalledWith(WALLET);
    expect(fetchKaminoObligations).toHaveBeenCalledWith(KAMINO_MAIN_MARKET, WALLET);
    expect(await a.assets).toEqual({ status: "fulfilled", value: [] });
  });

  it("全 source 成功 → TTL 60s で保持、期限内の再読みは client を呼ばない", async () => {
    const s = loadWalletSnapshot(WALLET);
    await s.settled;
    await flush();
    expect(_peekWalletSnapshotForTest(WALLET)?.ttlMs).toBe(SNAPSHOT_TTL_MS);
    t += 59_000;
    expect(loadWalletSnapshot(WALLET)).toBe(s);
    expect(snapshotAgeMs(s)).toBe(59_000);
    for (const fn of CLIENTS) expect(fn).toHaveBeenCalledTimes(1);
    const stats = _walletSnapshotStatsForTest();
    expect(stats).toMatchObject({ misses: 1, hits: 1, size: 1 });
    // admin usage の caches 欄にも同じ値が出る
    expect(allCacheStats()["wallet.snapshot"]).toEqual(stats);
  });

  it("source の失敗は Settled の中に閉じる (snapshot 自体は reject しない、key は redact)", async () => {
    (fetchMeteoraPositions as jest.Mock).mockRejectedValue(
      new Error("429 from https://mainnet.helius-rpc.com/?api-key=SECRET123")
    );
    (fetchStakeAccounts as jest.Mock).mockImplementation(() => {
      throw new Error("sync throw");
    });
    (fetchOrcaPositions as jest.Mock).mockReturnValue(undefined); // automock 相当 (非 Promise)
    const s = loadWalletSnapshot(WALLET);
    await expect(s.settled).resolves.toBeUndefined();
    const met = await s.meteora;
    expect(met.status).toBe("rejected");
    expect(met.status === "rejected" && met.reason).toContain("api-key=***");
    expect(met.status === "rejected" && met.reason).not.toContain("SECRET123");
    expect(await s.stake).toEqual({ status: "rejected", reason: "sync throw" });
    expect(await s.orca).toEqual({ status: "fulfilled", value: undefined });
    expect((await s.assets).status).toBe("fulfilled");
  });

  it("1 source でも rejected → TTL 5s (429 の瞬断で空データを 1 分固定しない)", async () => {
    (fetchAssetsByOwner as jest.Mock).mockRejectedValueOnce(new Error("429"));
    const s = loadWalletSnapshot(WALLET);
    await s.settled;
    await flush();
    expect(_peekWalletSnapshotForTest(WALLET)?.ttlMs).toBe(SNAPSHOT_SHORT_TTL_MS);
    t += 4_000;
    expect(loadWalletSnapshot(WALLET)).toBe(s); // 5s 以内は保持
    expect(fetchAssetsByOwner).toHaveBeenCalledTimes(1);
    t += 2_000; // 6s: 短命 entry は SWR を使わず hard に期限切れ → 新しい読みを待たせる
    const next = loadWalletSnapshot(WALLET);
    expect(next).not.toBe(s); // 失敗を含む旧 snapshot は返さない
    expect(fetchAssetsByOwner).toHaveBeenCalledTimes(2);
    expect(loadWalletSnapshot(WALLET)).toBe(next); // 同時の呼び手は進行中の読みに合流
    expect(fetchAssetsByOwner).toHaveBeenCalledTimes(2);
    expect(_walletSnapshotStatsForTest()).toMatchObject({ staleHits: 0, inflightJoins: 1 });
    expect((await next.assets).status).toBe("fulfilled");
    await next.settled;
    await flush();
    expect(loadWalletSnapshot(WALLET)).toBe(next);
    expect(_peekWalletSnapshotForTest(WALLET)?.ttlMs).toBe(SNAPSHOT_TTL_MS);
  });
});

describe("loadWalletSnapshot — stale-while-revalidate", () => {
  it("期限後 60s 以内は旧 snapshot を返し、裏の読み直しは 1 本だけ。settle 後に差し替わる", async () => {
    const s1 = loadWalletSnapshot(WALLET);
    await s1.settled;
    await flush();
    t += 61_000;
    expect(loadWalletSnapshot(WALLET)).toBe(s1);
    expect(loadWalletSnapshot(WALLET)).toBe(s1); // 2 回目も旧値、読み直しは増えない
    expect(fetchAssetsByOwner).toHaveBeenCalledTimes(2);
    expect(_walletSnapshotStatsForTest().staleHits).toBe(2);
    await flush();
    const s2 = loadWalletSnapshot(WALLET);
    expect(s2).not.toBe(s1);
    expect(s2.createdAt).toBe(t);
    expect(fetchAssetsByOwner).toHaveBeenCalledTimes(2);
  });

  it("SWR 窓 (TTL + 60s) を過ぎた entry は返さず、新しい読みを待たせる", async () => {
    const s1 = loadWalletSnapshot(WALLET);
    await s1.settled;
    await flush();
    t += 121_000;
    const s2 = loadWalletSnapshot(WALLET);
    expect(s2).not.toBe(s1);
    expect(fetchAssetsByOwner).toHaveBeenCalledTimes(2);
  });
});

describe("invalidateWalletSnapshot", () => {
  it("source 側の per-wallet cache (DAS / Enhanced / Jupiter Lend) も同じ wallet だけ捨てる", async () => {
    const a = loadWalletSnapshot(WALLET);
    await a.settled;
    await flush();
    invalidateWalletSnapshot(WALLET);
    expect(invalidateAssetsCacheForWallet).toHaveBeenCalledTimes(1);
    expect(invalidateAssetsCacheForWallet).toHaveBeenCalledWith(WALLET);
    expect(invalidateEnhancedTxCacheForWallet).toHaveBeenCalledWith(WALLET);
    expect(invalidateEarnPositionsCacheForWallet).toHaveBeenCalledWith(WALLET);
    expect(invalidateAssetsCacheForWallet).not.toHaveBeenCalledWith(OTHER);
  });

  it("invalidate 後の load は読み直し、他 wallet の snapshot は残る", async () => {
    const a = loadWalletSnapshot(WALLET);
    const o = loadWalletSnapshot(OTHER);
    await Promise.all([a.settled, o.settled]);
    await flush();
    invalidateWalletSnapshot(WALLET);
    const a2 = loadWalletSnapshot(WALLET);
    expect(a2).not.toBe(a);
    expect(callsFor(WALLET)).toBe(2);
    expect(loadWalletSnapshot(OTHER)).toBe(o);
    expect(callsFor(OTHER)).toBe(1);
  });

  it("invalidate 後 20 秒間は新 entry が TTL 5s、SWR も使わない (chain 反映待ち)", async () => {
    invalidateWalletSnapshot(WALLET);
    t += 1_000;
    const s1 = loadWalletSnapshot(WALLET);
    await s1.settled;
    await flush();
    expect(_peekWalletSnapshotForTest(WALLET)?.ttlMs).toBe(SNAPSHOT_SHORT_TTL_MS);
    t += 6_000; // 7s: 期限切れ。bust window 内なので旧値は返さない
    const s2 = loadWalletSnapshot(WALLET);
    expect(s2).not.toBe(s1);
    await s2.settled;
    await flush();
    t += 20_000; // window の外 → 通常の 60s
    const s3 = loadWalletSnapshot(WALLET);
    await s3.settled;
    await flush();
    expect(_peekWalletSnapshotForTest(WALLET)?.ttlMs).toBe(SNAPSHOT_TTL_MS);
  });

  it("読み途中の snapshot は切り離される (呼び手には返るが cache には書かれない)", async () => {
    const s1 = loadWalletSnapshot(WALLET);
    invalidateWalletSnapshot(WALLET);
    await s1.settled;
    await flush();
    expect(_peekWalletSnapshotForTest(WALLET)).toBeUndefined();
    expect((await s1.assets).status).toBe("fulfilled");
  });
});

describe("forceRefresh", () => {
  it("fresh な entry があっても読み直し、同時の force は 1 本に合流し、結果は cache に入る", async () => {
    const s1 = loadWalletSnapshot(WALLET);
    await s1.settled;
    await flush();
    const f1 = loadWalletSnapshot(WALLET, { forceRefresh: true });
    const f2 = loadWalletSnapshot(WALLET, { forceRefresh: true });
    expect(f1).not.toBe(s1);
    expect(f2).toBe(f1);
    // force の読み途中でも通常の呼び手は fresh な旧 entry を使う
    expect(loadWalletSnapshot(WALLET)).toBe(s1);
    for (const fn of CLIENTS) expect(fn).toHaveBeenCalledTimes(2);
    await f1.settled;
    await flush();
    expect(loadWalletSnapshot(WALLET)).toBe(f1);
  });

  it("cold の読み途中に force が来たら、その読みに合流する", () => {
    const s1 = loadWalletSnapshot(WALLET);
    expect(loadWalletSnapshot(WALLET, { forceRefresh: true })).toBe(s1);
    expect(fetchAssetsByOwner).toHaveBeenCalledTimes(1);
  });
});
