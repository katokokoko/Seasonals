/**
 * wallet-query-sync — wallet 由来クエリの「どれを取り直す / 消すか」の純判定
 * (Phase 8.77 → API 効率化計画 §4.0 で再設計)
 *
 * 設計 (§4.0「接続状態と取得済みデータの保持を分ける」):
 *   - 接続状態 (walletStore.status / authorization) は表示の ON/OFF と署名権限だけを決める
 *   - wallet 由来データは address を key にした TanStack cache に、接続状態と無関係に残す
 *   - 取り直すのは **接続した wallet の key だけ**。切断 (address → null) では何もしない
 *     (cache を保持し、再接続時に即表示 → 裏で再取得)
 *   - cold start の復元 (SecureStore から authorization が戻る) は取り直さない —
 *     永続 cache を即表示し、通常の staleTime で再取得する (二重取得を撒かない)
 *   - 端末に残す wallet は recentWallets (MRU 5 件)。外れた wallet の cache は消す
 *
 * hook 本体 (`useWalletQuerySync.ts`) から分離してある。walletStore を値として
 * import すると `@solana/web3.js` → `rpc-websockets` まで芋づるで読み込まれ、
 * jest では解決できない (mwa.test.ts が mock で回避しているのと同じ壁)。
 * `import type` は babel が消すので、この module は実行時に walletStore を require しない。
 */

import type { QueryClient, QueryKey } from "@tanstack/react-query";

import type { WalletStatus } from "./walletStore";

/**
 * wallet に紐づくクエリの key prefix。
 * `skr-staking` 以外は `[prefix, address, ...]` (address は index 1)。
 * `skr-staking` は `["skr-staking", source, cluster, address]` (address は index 3)。
 */
export const WALLET_SCOPED_QUERY_KEYS = [
  "positions",
  "earn-positions",
  "wallet-time-events",
  "portfolio-history",
  // SKR cooldown (docs/skr-r0-implementation.md §3: wallet 切替後の旧応答を使わない)
  "skr-staking",
] as const;

/** tx 成功後に取り直す key (SKR は自前の poll / 境界 retry を持つので含めない) */
export const POST_TX_QUERY_KEYS = [
  "positions",
  "earn-positions",
  "wallet-time-events",
  "portfolio-history",
] as const;

/** 端末に cache を保持する wallet の上限 (MRU) */
export const RECENT_WALLETS_MAX = 5;

export interface RecentWallet {
  address: string;
  /** 最後に接続 / 復元した時刻 (ms) */
  lastConnectedAt: number;
}

export interface WalletSyncState {
  address: string | null;
  status: WalletStatus;
  /** walletStore の SecureStore 復元が終わったか。終わる前の状態は基準にしない */
  hydrated: boolean;
}

/** query key の wallet address (wallet 系でなければ null) */
export function walletAddressOfKey(queryKey: QueryKey): string | null {
  const head = queryKey[0];
  if (head === "skr-staking") {
    const a = queryKey[3];
    return typeof a === "string" ? a : null;
  }
  if (
    head === "positions" ||
    head === "earn-positions" ||
    head === "wallet-time-events" ||
    head === "portfolio-history"
  ) {
    const a = queryKey[1];
    return typeof a === "string" ? a : null;
  }
  return null;
}

/**
 * `address` の wallet 系 key か。`keys` を絞れば prefix も限定する。
 * fixture variant の `["positions"]` (address 無し) や `"disabled"` placeholder key には一致しない。
 */
export function isWalletKeyOf(
  queryKey: QueryKey,
  address: string,
  keys: readonly string[] = WALLET_SCOPED_QUERY_KEYS
): boolean {
  return (
    typeof queryKey[0] === "string" &&
    keys.includes(queryKey[0]) &&
    walletAddressOfKey(queryKey) === address
  );
}

/**
 * 取り直すべき wallet の address。null = 何もしない。
 *
 * - 復元前 → 復元後 (cold start) → null。永続 cache を即表示し staleTime に任せる
 * - address が別の非 null に変わった → 新 address (別 wallet への切替 / 新規接続)
 * - address は同じで status が connected に**入った** → その address (再接続。
 *   key が元に戻るだけなので、これを見ないと staleTime の間 cache のまま)
 * - address → null (切断) → null。データは保持する (表示は enabled: false で消える)
 */
export function resyncTargets(
  prev: WalletSyncState,
  next: WalletSyncState
): string | null {
  if (!next.hydrated) return null;
  if (!prev.hydrated) return null; // 復元そのもの: 二重取得しない
  if (next.address === null) return null;
  if (prev.address !== next.address) return next.address;
  if (next.status === "connected" && prev.status !== "connected") {
    return next.address;
  }
  return null;
}

/**
 * recentWallets を MRU で更新した新配列 (先頭が最新、最大 `max` 件)。
 */
export function touchRecentWallets(
  list: readonly RecentWallet[],
  address: string,
  nowMs: number,
  max: number = RECENT_WALLETS_MAX
): RecentWallet[] {
  return [
    { address, lastConnectedAt: nowMs },
    ...list.filter((w) => w.address !== address),
  ].slice(0, max);
}

/** prev にあって next に無い address (cache を消す対象) */
export function evictedAddresses(
  prev: readonly RecentWallet[],
  next: readonly RecentWallet[]
): string[] {
  const keep = new Set(next.map((w) => w.address));
  return prev.map((w) => w.address).filter((a) => !keep.has(a));
}

/**
 * tx 成功後: **その wallet の** positions / earn / wallet events / history だけを取り直す。
 * 他 wallet の cache と fixture key (`["positions"]`) には触らない。
 */
export function invalidateWalletAfterTx(
  client: Pick<QueryClient, "invalidateQueries">,
  address: string
): Promise<unknown> {
  return client.invalidateQueries({
    predicate: (q) => isWalletKeyOf(q.queryKey, address, POST_TX_QUERY_KEYS),
  });
}
