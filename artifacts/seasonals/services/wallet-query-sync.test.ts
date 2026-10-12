/**
 * wallet-query-sync — テスト (Phase 8.77 → API 効率化計画 §4.0)
 *
 * 固定するのは「どの遷移で **どの wallet の** クエリを取り直すか」。
 *   - 同じ wallet に繋ぎ直した時 (address が変わらない) を落とすと、実機で報告された
 *     「再接続してもグラフとカレンダーが変わらない」(8.77) に戻る
 *   - 切断で取り直す / 他 wallet まで取り直すと、保持した cache を無駄に撃ち直す (§4.0)
 *   - cold start の復元で取り直すと、mount 時の取得と二重になる (Phase A-4)
 */
import { QueryClient } from "@tanstack/react-query";

import {
  evictedAddresses,
  evictedWatchAddresses,
  invalidateWalletAfterTx,
  isWalletKeyOf,
  RECENT_WALLETS_MAX,
  resyncTargets,
  touchRecentWallets,
  WALLET_SCOPED_QUERY_KEYS,
  walletAddressOfKey,
  type WalletSyncState,
} from "./wallet-query-sync";

const ADDR_A = "7nZbHkQqXkr3eW8s2dKvHqBxNz9vC5jPpL2tF6mYrXaA";
const ADDR_B = "6QGJNXnCjhYkKgPpDm7qRzxBKCj9KugUL2LDHc8sGUUM";

const s = (
  address: string | null,
  status: WalletSyncState["status"],
  hydrated = true
): WalletSyncState => ({ address, status, hydrated });

describe("resyncTargets", () => {
  it("**同じ address でも connected に入り直したら、その address を取り直す** (再接続)", () => {
    // disconnect では address が null になるが、MWA の再接続中に idle → connected だけが
    // 見える経路も同じ扱い。key は元に戻るだけなので、これを拾わないとキャッシュのまま
    expect(resyncTargets(s(ADDR_A, "idle"), s(ADDR_A, "connected"))).toBe(ADDR_A);
  });

  it("切断 → 同じ wallet に再接続したら、その address を取り直す", () => {
    expect(resyncTargets(s(null, "connecting"), s(ADDR_A, "connected"))).toBe(ADDR_A);
  });

  it("別の wallet に切り替えたら **新しい address だけ** を取り直す", () => {
    expect(resyncTargets(s(ADDR_A, "connected"), s(ADDR_B, "connected"))).toBe(ADDR_B);
  });

  it("切断 (address → null) では何もしない — cache は保持し、表示は enabled:false で消える", () => {
    expect(resyncTargets(s(ADDR_A, "connected"), s(null, "idle"))).toBeNull();
  });

  it("cold start の復元 (復元前 → 復元後) では取り直さない (mount 時の取得と二重にしない)", () => {
    expect(
      resyncTargets(s(null, "idle", false), s(ADDR_A, "connected", true))
    ).toBeNull();
    // 復元前に state だけ先に見えた場合も同じ
    expect(
      resyncTargets(s(null, "idle", false), s(ADDR_A, "connected", false))
    ).toBeNull();
  });

  it("接続中 / エラーへの遷移では取り直さない (まだ繋がっていない)", () => {
    expect(resyncTargets(s(null, "idle"), s(null, "connecting"))).toBeNull();
    expect(resyncTargets(s(null, "connecting"), s(null, "error"))).toBeNull();
  });

  it("何も変わっていなければ取り直さない (無駄な再取得を撒かない)", () => {
    expect(resyncTargets(s(ADDR_A, "connected"), s(ADDR_A, "connected"))).toBeNull();
  });
});

describe("WALLET_SCOPED_QUERY_KEYS", () => {
  it("wallet 由来の 5 系統をすべて含む (履歴を落とすとグラフが 5 分固まる / SKR は旧 wallet の応答を使わない)", () => {
    expect([...WALLET_SCOPED_QUERY_KEYS]).toEqual([
      "positions",
      "earn-positions",
      "wallet-time-events",
      "portfolio-history",
      "skr-staking",
    ]);
  });
});

describe("walletAddressOfKey / isWalletKeyOf", () => {
  it("wallet 系 key の address を取り出す (SKR だけ index 3)", () => {
    expect(walletAddressOfKey(["positions", ADDR_A])).toBe(ADDR_A);
    expect(walletAddressOfKey(["portfolio-history", ADDR_A, 30])).toBe(ADDR_A);
    expect(walletAddressOfKey(["skr-staking", "live", "mainnet-beta", ADDR_A])).toBe(ADDR_A);
    expect(walletAddressOfKey(["positions"])).toBeNull();
    expect(walletAddressOfKey(["menu-listings"])).toBeNull();
  });

  it("他 wallet / fixture key / 共有 key には一致しない", () => {
    expect(isWalletKeyOf(["earn-positions", ADDR_A], ADDR_A)).toBe(true);
    expect(isWalletKeyOf(["earn-positions", ADDR_B], ADDR_A)).toBe(false);
    expect(isWalletKeyOf(["positions"], ADDR_A)).toBe(false);
    expect(isWalletKeyOf(["prices", ADDR_A], ADDR_A)).toBe(false);
    // prefix を絞れば SKR は外れる
    expect(
      isWalletKeyOf(["skr-staking", "live", "mainnet-beta", ADDR_A], ADDR_A, ["positions"])
    ).toBe(false);
  });
});

describe("recentWallets (MRU)", () => {
  it("接続した wallet を先頭に、重複は 1 件にまとめる", () => {
    const one = touchRecentWallets([], ADDR_A, 1);
    const two = touchRecentWallets(one, ADDR_B, 2);
    const again = touchRecentWallets(two, ADDR_A, 3);
    expect(again).toEqual([
      { address: ADDR_A, lastConnectedAt: 3 },
      { address: ADDR_B, lastConnectedAt: 2 },
    ]);
  });

  it(`${RECENT_WALLETS_MAX} 件を超えたら最古を落とし、落ちた address を返す`, () => {
    let list = touchRecentWallets([], "w0", 0);
    for (let i = 1; i < RECENT_WALLETS_MAX; i++) list = touchRecentWallets(list, `w${i}`, i);
    expect(list).toHaveLength(RECENT_WALLETS_MAX);
    const next = touchRecentWallets(list, "w5", 5);
    expect(next).toHaveLength(RECENT_WALLETS_MAX);
    expect(next[0]!.address).toBe("w5");
    expect(evictedAddresses(list, next)).toEqual(["w0"]);
    // 並べ替えだけなら何も落ちない
    expect(evictedAddresses(next, touchRecentWallets(next, "w3", 6))).toEqual([]);
  });
});

describe("evictedWatchAddresses (watch-only mode)", () => {
  it("watchlist から外れ、recentWallets にも無い address だけを返す", () => {
    expect(evictedWatchAddresses([ADDR_A, ADDR_B], [ADDR_B], [])).toEqual([ADDR_A]);
    // 接続 wallet として recentWallets に残っていれば cache は消さない
    expect(evictedWatchAddresses([ADDR_A, ADDR_B], [ADDR_B], [ADDR_A])).toEqual([]);
    // 並べ替え / 追加だけなら何も落ちない
    expect(evictedWatchAddresses([ADDR_A], [ADDR_B, ADDR_A], [])).toEqual([]);
  });
});

describe("invalidateWalletAfterTx", () => {
  it("署名した wallet の 4 系統だけを invalidate し、他 wallet / fixture / SKR は触らない", async () => {
    const qc = new QueryClient();
    const keys = [
      ["positions", ADDR_A],
      ["earn-positions", ADDR_A],
      ["wallet-time-events", ADDR_A],
      ["portfolio-history", ADDR_A, 30],
      ["positions", ADDR_B],
      ["portfolio-history", ADDR_B, 30],
      ["positions"],
      ["skr-staking", "live", "mainnet-beta", ADDR_A],
      ["menu-listings"],
    ];
    for (const k of keys) qc.setQueryData(k, { v: 1 });
    await invalidateWalletAfterTx(qc, ADDR_A);
    const invalidated = (k: unknown[]) =>
      qc.getQueryCache().find({ queryKey: k, exact: true })!.state.isInvalidated;
    expect(keys.slice(0, 4).map(invalidated)).toEqual([true, true, true, true]);
    expect(keys.slice(4).map(invalidated)).toEqual([false, false, false, false, false]);
    qc.clear();
  });
});
