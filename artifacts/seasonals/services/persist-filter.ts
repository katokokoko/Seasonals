/**
 * persist-filter — TanStack Query の AsyncStorage 永続化に何を載せるか (純関数)
 *
 * app/_layout.tsx の `PersistQueryClientProvider` の `shouldDehydrateQuery` から呼ぶ。
 * 判定だけをここに置き、walletStore は値として import しない (jest で
 * `@solana/web3.js` まで芋づるで読まれるのを避ける。wallet-query-sync.ts と同じ理由)。
 *
 * 載せるもの (API 効率化計画 §4.0、すべて `success` のみ):
 *   - `portfolio-history` (8.83 から)。address 別 key なので wallet 系と同じ扱いにする
 *   - `positions` / `earn-positions` / `wallet-time-events` — key[1] の address が
 *     recentWallets (MRU 5) に含まれるものだけ。再起動直後に即表示 → 裏で再取得
 *   - `menu-listings` — 共有カタログ。cold start の空 drawer を避ける
 *
 * 載せないもの:
 *   - `skr-staking` — 鮮度規則 (docs/skr-r0-implementation.md §3) が古い値の提供を禁じる
 *   - `oracle-status` / `jupiter-quote` / `prices` — 実行・価格系。古い値を出さない (§4.6 fail-closed)
 *   - `agent-plan*` / `approval-token` / `user-policy` / `autonomous-*` — 状態遷移があり、
 *     古い snapshot は誤操作の元
 *   - fixture variant の `["positions"]` (address 無し)
 *
 * どれも public な on-chain 情報で秘密は含まない (authorization は SecureStore のまま)。
 */

import type { QueryKey } from "@tanstack/react-query";

const WALLET_PERSIST_KEYS: ReadonlySet<string> = new Set([
  "positions",
  "earn-positions",
  "wallet-time-events",
  "portfolio-history",
]);

const SHARED_PERSIST_KEYS: ReadonlySet<string> = new Set(["menu-listings"]);

export interface PersistCandidate {
  queryKey: QueryKey;
  state: { status: string };
}

/**
 * @param recentAddresses recentWallets の address。`null` = walletStore の復元前で未確定。
 *   その間に載っている wallet 系 key は前回の永続 (= 当時の recentWallets で絞り込み済み)
 *   か復元中の wallet のものだけなので残す — ここで落とすと復元前の書き込み 1 回で
 *   永続 cache から wallet 系が全部消える
 */
export function shouldPersistQuery(
  query: PersistCandidate,
  recentAddresses: readonly string[] | null
): boolean {
  if (query.state.status !== "success") return false;
  const head = query.queryKey[0];
  if (typeof head !== "string") return false;
  if (SHARED_PERSIST_KEYS.has(head)) return true;
  if (!WALLET_PERSIST_KEYS.has(head)) return false;
  const address = query.queryKey[1];
  if (typeof address !== "string" || address.length === 0) return false;
  if (recentAddresses === null) return true;
  return recentAddresses.includes(address);
}
