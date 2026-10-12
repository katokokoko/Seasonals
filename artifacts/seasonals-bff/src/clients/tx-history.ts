/**
 * tx-history — wallet tx 履歴の facade (Phase C)
 *
 * consumer (wallet-snapshot.ts / server.ts の history loader と cost-basis / time-event derivation) は
 * ここだけを import する。backend は `HELIUS_TX_HISTORY_API` (flags.ts `heliusTxHistoryApi`) で選ぶ:
 *   - `enhanced` (既定): Helius Enhanced Transactions (clients/helius-tx.ts、100 credit / req)
 *   - `parsed`: Helius Parsed Events (clients/helius-parsed-events.ts、10 credit / req)。
 *     `toWalletTx` が Enhanced と同じ `accountData` shape を合成するので consumer は無変更
 *
 * 型: `WalletTx` は `HeliusEnhancedTx` と構造同一 (re-export)。既存 test の fixture もそのまま通る。
 *
 * ## cursor
 * `fetchWalletTxPage(wallet, cursor)` は両 backend で `{ txs, nextCursor }` を返す (nextCursor 無し = 終端)。
 * - enhanced: `beforeSignature` で遡るだけ。**`afterSignature` (増分) と `timeGte` (期間) は parsed 専用** —
 *   enhanced で `afterSignature` を渡すと throw (黙って全件を返すと増分 merge が二重計上になる)、
 *   `timeGte` は無視 (呼び手が `oldestSeen <= cutoff` で止める従来どおり)
 * - parsed: `paginationToken` で続きを取る。token は最終の短い page でも返るので、終端は
 *   「空 page」か「token 無し」(2026-10-12 実測)。filter (`afterSignature` / `timeGte`) は token と一緒に送り直す
 *
 * cache: `fetchWalletTxs` (直近 N 件、wallet snapshot 用) だけ `TtlCache("txhistory.recent", 60s)`、
 * key は `backend|wallet|limit`。**tx 履歴の cache はこれ 1 つ** (helius-tx.ts は cache を持たない)。
 * page 取得は cache しない (history loader が cursor 連鎖で読むため)。
 */
import { TtlCache } from "../cache/ttl-cache";
import { heliusTxHistoryApi, type HeliusTxHistoryApi } from "../flags";
import {
  fetchEnhancedTransactions,
  fetchEnhancedTransactionsPage,
  type HeliusEnhancedTx,
} from "./helius-tx";
import { fetchParsedTxHistoryPage, toWalletTx } from "./helius-parsed-events";

export type {
  HeliusAccountData,
  HeliusEnhancedTx,
  HeliusRawTokenAmount,
  HeliusTokenBalanceChange,
} from "./helius-tx";

/** consumer が読む tx の shape (= Enhanced の shape。parsed は toWalletTx で合成) */
export type WalletTx = HeliusEnhancedTx;

export const RECENT_TXS_DEFAULT_LIMIT = 50;
const RECENT_TTL_MS = 60_000;

const recent = new TtlCache<WalletTx[]>({
  name: "txhistory.recent",
  ttlMs: RECENT_TTL_MS,
  maxEntries: 200,
});

/** 今の backend (env を毎回読む。test で切り替えられるように) */
export function walletTxBackend(): HeliusTxHistoryApi {
  return heliusTxHistoryApi();
}

function recentKey(api: HeliusTxHistoryApi, wallet: string, limit: number): string {
  return `${api}|${wallet}|${limit}`;
}

async function loadRecent(
  api: HeliusTxHistoryApi,
  wallet: string,
  limit: number
): Promise<WalletTx[]> {
  if (api === "enhanced") return fetchEnhancedTransactions(wallet, limit);
  const page = await fetchParsedTxHistoryPage(wallet, { limit });
  return page.items
    .map((it) => toWalletTx(it, wallet))
    .filter((t): t is WalletTx => t !== null);
}

/**
 * 直近 `limit` 件 (既定 50、新しい順)。`backend|wallet|limit` ごとに 60s cache + in-flight dedupe
 * (limit の違う呼び出しが別 limit の cache 済み list を受け取らない)。
 */
export async function fetchWalletTxs(
  wallet: string,
  limit = RECENT_TXS_DEFAULT_LIMIT
): Promise<WalletTx[]> {
  const api = walletTxBackend();
  return recent.getOrLoad(recentKey(api, wallet, limit), () => loadRecent(api, wallet, limit));
}

export interface WalletTxCursor {
  /** 1 page の件数 (既定 100) */
  limit?: number;
  /** これより古い tx (enhanced の `before`、parsed の `beforeSignature`) */
  beforeSignature?: string;
  /** parsed 専用: 前 page の続き */
  paginationToken?: string;
  /** parsed 専用: これより新しい tx だけ (排他) */
  afterSignature?: string;
  /** parsed 専用: unix 秒、これ以降の tx だけ (enhanced では無視) */
  timeGte?: number;
}

export interface WalletTxPage {
  /** 新しい順 */
  txs: WalletTx[];
  /** 無し = 終端 */
  nextCursor?: WalletTxCursor;
  /** 上流が返した件数 (parsed の ERROR / blockTime 不明で捨てた分を含む) */
  scanned: number;
}

export async function fetchWalletTxPage(
  wallet: string,
  cursor: WalletTxCursor = {}
): Promise<WalletTxPage> {
  const limit = cursor.limit ?? 100;
  if (walletTxBackend() === "enhanced") {
    if (cursor.afterSignature) {
      throw new Error("afterSignature is supported only by the parsed tx-history backend");
    }
    const txs = await fetchEnhancedTransactionsPage(wallet, {
      limit,
      ...(cursor.beforeSignature ? { before: cursor.beforeSignature } : {}),
    });
    const last = txs[txs.length - 1]?.signature;
    return {
      txs,
      scanned: txs.length,
      ...(txs.length > 0 && last ? { nextCursor: { limit, beforeSignature: last } } : {}),
    };
  }

  const page = await fetchParsedTxHistoryPage(wallet, {
    limit,
    ...(cursor.paginationToken
      ? { paginationToken: cursor.paginationToken }
      : cursor.beforeSignature
        ? { beforeSignature: cursor.beforeSignature }
        : {}),
    ...(cursor.afterSignature ? { afterSignature: cursor.afterSignature } : {}),
    ...(cursor.timeGte !== undefined ? { timeGte: cursor.timeGte } : {}),
  });
  const txs = page.items
    .map((it) => toWalletTx(it, wallet))
    .filter((t): t is WalletTx => t !== null);
  const next: WalletTxCursor | undefined =
    page.items.length > 0 && page.paginationToken
      ? {
          limit,
          paginationToken: page.paginationToken,
          ...(cursor.afterSignature ? { afterSignature: cursor.afterSignature } : {}),
          ...(cursor.timeGte !== undefined ? { timeGte: cursor.timeGte } : {}),
        }
      : undefined;
  return { txs, scanned: page.items.length, ...(next ? { nextCursor: next } : {}) };
}

/** tx 送信後 (wallet-snapshot.ts の invalidate から): その wallet の全 backend / 全 limit の entry を捨てる */
export function invalidateWalletTxCacheForWallet(wallet: string): void {
  recent.deleteWhere((key) => key.split("|")[1] === wallet);
}

export function _clearWalletTxCacheForTest(): void {
  recent.clear();
}
