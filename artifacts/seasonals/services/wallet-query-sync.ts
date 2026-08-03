/**
 * wallet-query-sync — 「wallet 由来のクエリを取り直すべき遷移か」の純判定
 * (Phase 8.77)
 *
 * hook 本体 (`useWalletQuerySync.ts`) から分離してある。walletStore を値として
 * import すると `@solana/web3.js` → `rpc-websockets` まで芋づるで読み込まれ、
 * jest では解決できない (mwa.test.ts が mock で回避しているのと同じ壁)。
 * 判定ロジックだけここに置けば mock 無しでテストできる。
 *
 * `import type` は babel が消すので、この module は実行時に walletStore を
 * require しない。
 */

import type { WalletStatus } from "./walletStore";

/**
 * wallet に紐づくクエリの key prefix。
 * ActionModal が tx 後に invalidate しているものと同じ粒度 + 履歴。
 */
export const WALLET_SCOPED_QUERY_KEYS = [
  "positions",
  "earn-positions",
  "wallet-time-events",
  "portfolio-history",
] as const;

export interface WalletSyncState {
  address: string | null;
  status: WalletStatus;
}

/**
 * 取り直すべき遷移か。
 *
 * - address が変わった → 別 wallet (切断で null になる場合も含む)
 * - address は同じでも status が connected に**入った** → 再接続。
 *   query key が変わらないので、これを見ないと staleTime の間キャッシュのまま
 *   (history は 5 分 = 「再接続してもグラフが変わらない」の正体)
 */
export function shouldResyncWallet(
  prev: WalletSyncState,
  next: WalletSyncState
): boolean {
  if (prev.address !== next.address) return true;
  return next.status === "connected" && prev.status !== "connected";
}
