/**
 * helius.ts (DAS getAssetsByOwner) の wallet 別 cache と in-flight dedupe。
 *
 * - 同じ wallet の同時要求は 1 回の DAS 呼び出し (10 credit) に合流する
 *   (wallet snapshot の assets source と /portfolio/history が同時に cold で走る場面)
 * - 進行中に invalidateAssetsCacheForWallet が呼ばれたら、その読みの結果は cache に書かない
 *   (tx 直後に tx 前の保有を 30 秒固定しない)
 * - 失敗は cache にも inflight にも残らない
 */

import {
  _clearHeliusCacheForTest,
  fetchAssetsByOwner,
  invalidateAssetsCacheForWallet,
} from "./helius";
import { _setSleepForTest } from "./helius-limiter";

const WALLET = "6QGJNXnC3W5QhVvCy8v2BpKb1Nw4hvF9uJQ2kQ1nGUUM";

function dasResponse(balance: string): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id: "seasonals-bff",
      result: {
        items: [
          {
            id: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
            interface: "FungibleToken",
            token_info: { balance, decimals: 6, symbol: "USDC" },
          },
        ],
        nativeBalance: { lamports: 0 },
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

/** fetch が呼ばれてから手動で応答を返せる spy */
function deferredFetch() {
  const resolvers: Array<(r: Response) => void> = [];
  const spy = jest
    .spyOn(global, "fetch")
    .mockImplementation(
      () => new Promise<Response>((resolve) => resolvers.push(resolve))
    );
  return { spy, resolvers };
}

describe("fetchAssetsByOwner — cache と in-flight dedupe", () => {
  beforeEach(() => {
    process.env.HELIUS_API_KEY = "test-key";
    _clearHeliusCacheForTest();
    _setSleepForTest(async () => undefined);
  });
  afterEach(() => {
    jest.restoreAllMocks();
    _setSleepForTest(null);
  });

  it("同じ wallet の同時 3 要求は fetch 1 回に合流し、以後は cache を返す", async () => {
    const { spy, resolvers } = deferredFetch();
    const p = Promise.all([
      fetchAssetsByOwner(WALLET),
      fetchAssetsByOwner(WALLET),
      fetchAssetsByOwner(WALLET),
    ]);
    // 3 本とも同じ in-flight に合流しているので fetch はまだ 1 回
    await Promise.resolve();
    expect(spy).toHaveBeenCalledTimes(1);
    resolvers[0]!(dasResponse("1500000"));
    const [a, b, c] = await p;
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(a[0]?.token_info?.balance).toBe("1500000");

    const again = await fetchAssetsByOwner(WALLET);
    expect(again).toBe(a);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("進行中に invalidate されたら、その読みの結果は返すが cache には書かない", async () => {
    const { spy, resolvers } = deferredFetch();
    const first = fetchAssetsByOwner(WALLET);
    await Promise.resolve();
    expect(spy).toHaveBeenCalledTimes(1);

    invalidateAssetsCacheForWallet(WALLET); // tx 送信 → 進行中の読みは tx 前の保有かもしれない
    resolvers[0]!(dasResponse("1500000"));
    const stale = await first;
    expect(stale[0]?.token_info?.balance).toBe("1500000");

    // 次の要求は cache を使わず読み直す
    const second = fetchAssetsByOwner(WALLET);
    await Promise.resolve();
    expect(spy).toHaveBeenCalledTimes(2);
    resolvers[1]!(dasResponse("2500000"));
    const fresh = await second;
    expect(fresh[0]?.token_info?.balance).toBe("2500000");
  });

  it("失敗は cache / inflight に残らず、次の要求は読み直す", async () => {
    const spy = jest
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(new Response("nope", { status: 400 }))
      .mockResolvedValueOnce(dasResponse("42"));
    await expect(fetchAssetsByOwner(WALLET)).rejects.toThrow();
    const ok = await fetchAssetsByOwner(WALLET);
    expect(ok[0]?.token_info?.balance).toBe("42");
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
