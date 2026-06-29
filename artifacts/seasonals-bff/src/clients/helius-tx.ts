/**
 * helius-tx — Helius Enhanced Transactions API client (Phase 8.3)
 *
 * https://api.helius.xyz/v0/addresses/<wallet>/transactions?api-key=<key>
 *
 * tx をカテゴリ別に整形した json で返してくれるので、生 RPC を parse するより遥かに楽。
 * BFF /time-events/wallet?wallet=<addr> で過去 50 件を取得 → tokenTransfers から
 * jlToken / Kamino share token の transfer を抽出 → UnifiedTimeEvent に変換。
 *
 * 規約:
 *   - 失敗時は throw (呼び出し側で 502)、空配列ではなく明示的にエラー
 *   - cache 60s TTL (履歴は変化頻度低い)
 *   - HELIUS_API_KEY env が必須
 */

const HELIUS_BASE = "https://api.helius.xyz/v0";
const CACHE_TTL_MS = 60_000;

export interface HeliusTokenTransfer {
  mint: string;
  fromUserAccount?: string;
  toUserAccount?: string;
  tokenAmount: number; // float (Helius が humanized で返す)
}

/**
 * Phase 8.13: Enhanced API は accountData[].tokenBalanceChanges[] に
 * smallest-unit 整数 string (符号付き) を返す。cost-basis 計算は float の
 * tokenTransfers.tokenAmount ではなくこちらを使う (§4.5 精度規約)。
 */
export interface HeliusRawTokenAmount {
  /** smallest unit, 符号付き整数 string (wallet 減少なら先頭 "-") */
  tokenAmount: string;
  decimals: number;
}

export interface HeliusTokenBalanceChange {
  mint: string;
  /** この balance change の主体 wallet (owner) */
  userAccount: string;
  /** token account 自体の address */
  tokenAccount?: string;
  rawTokenAmount: HeliusRawTokenAmount;
}

export interface HeliusAccountData {
  account: string;
  tokenBalanceChanges?: HeliusTokenBalanceChange[];
}

export interface HeliusEnhancedTx {
  signature: string;
  /** unix seconds */
  timestamp: number;
  type: string;
  description?: string;
  fee: number;
  tokenTransfers?: HeliusTokenTransfer[];
  /** Phase 8.13: cost-basis 用の smallest-unit 整数 balance changes */
  accountData?: HeliusAccountData[];
}

interface CacheEntry {
  data: HeliusEnhancedTx[];
  ts: number;
}

const cache = new Map<string, CacheEntry>();

export function _clearHeliusTxCacheForTest(): void {
  cache.clear();
}

function buildUrl(walletAddress: string, limit: number): string {
  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey) {
    throw new Error(
      "HELIUS_API_KEY is not set. Required for Enhanced Transactions API (Phase 8.3)"
    );
  }
  return `${HELIUS_BASE}/addresses/${walletAddress}/transactions?api-key=${apiKey}&limit=${limit}`;
}

/**
 * 指定 wallet の最近の tx 一覧を Enhanced Transactions API で取得。
 * 過去 50 件 (= Helius 1 page default、recent activity を見せる目的なので十分)。
 */
export async function fetchEnhancedTransactions(
  walletAddress: string,
  limit = 50
): Promise<HeliusEnhancedTx[]> {
  const cached = cache.get(walletAddress);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.data;
  }

  const res = await fetch(buildUrl(walletAddress, limit), {
    method: "GET",
    headers: { accept: "application/json" },
  });

  if (!res.ok) {
    throw new Error(
      `Helius enhanced-tx HTTP ${res.status} ${res.statusText}: ${await res.text().catch(() => "")}`
    );
  }

  const json = (await res.json()) as HeliusEnhancedTx[];
  if (!Array.isArray(json)) {
    throw new Error(`Helius enhanced-tx unexpected shape (not array)`);
  }

  cache.set(walletAddress, { data: json, ts: Date.now() });
  return json;
}
