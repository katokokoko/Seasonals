/**
 * helius — Helius DAS API client (Phase 8.1)
 *
 * `getAssetsByOwner` JSON-RPC を呼び出して、指定 mainnet wallet が保有する
 * fungible token + native SOL を取得する。BFF /positions が wallet 指定で
 * 呼ばれた時の data source。
 *
 * 設定:
 *   env `HELIUS_API_KEY` 必須 (free tier sign-up: https://www.helius.dev/)
 *   未設定時は throw → /positions が 500 を返す。
 *
 * Cache:
 *   in-memory Map<address, { data, ts }> を TTL 30 秒で保持。
 *   free tier 10 req/sec を余裕で下回る (同一 wallet で 1 req / 30 秒)。
 *
 * 規約:
 *   - Position に map するのは positions.ts side。本 client は raw DAS response
 *     を返すだけに留める (separation of concerns)。
 *   - HTTP 失敗 / RPC error は throw、呼び出し側で 500/502 を return。
 *
 * @see https://docs.helius.dev/compression-and-das-api/digital-asset-standard-das-api/get-assets-by-owner
 */

import { fetchWithTimeout } from "./http"; // Phase 8.38 (B9): 共通 timeout
const HELIUS_MAINNET_URL = "https://mainnet.helius-rpc.com";

const CACHE_TTL_MS = 30_000;

/** Helius DAS asset (fungible / NFT どちらも含む。実際は fungible に絞って使う) */
export interface HeliusAsset {
  /** mint pubkey (= asset.id) */
  id: string;
  interface: string;
  token_info?: {
    /**
     * smallest unit。Helius は number で返す既知の挙動があるので string | number。
     * mapAssetsToPositions 側で String() に正規化する。
     */
    balance?: string | number;
    decimals?: number;
    symbol?: string;
    price_info?: {
      /** USD price as float */
      price_per_token?: number;
      currency?: string;
    };
    [key: string]: unknown;
  };
  content?: {
    metadata?: {
      name?: string;
      symbol?: string;
      description?: string;
    };
  };
  [key: string]: unknown;
}

interface CacheEntry {
  data: HeliusAsset[];
  ts: number;
}

const cache = new Map<string, CacheEntry>();

// Phase 8.38 (B10): wallet キー cache の上限 — TTL は read 時にしか効かず、
// 多数 wallet で無制限成長していた。挿入順 (Map) で古い方から落とす
const CACHE_MAX_ENTRIES = 200;
function evictOldest(m: Map<string, unknown>): void {
  while (m.size > CACHE_MAX_ENTRIES) {
    const oldest = m.keys().next().value;
    if (oldest === undefined) break;
    m.delete(oldest);
  }
}


/** test 用 cache クリア (本番では使われない) */
export function _clearHeliusCacheForTest(): void {
  cache.clear();
}

function buildUrl(): string {
  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey) {
    throw new Error(
      "HELIUS_API_KEY is not set. Get one from https://www.helius.dev/ and add to artifacts/seasonals-bff/.env"
    );
  }
  return `${HELIUS_MAINNET_URL}/?api-key=${apiKey}`;
}

/**
 * 指定 wallet pubkey の保有 asset 一覧を取得 (mainnet)。
 * - fungible / native SOL が対象 (showFungible: true, showNativeBalance: true)
 * - NFT は filter で除外 (mapping 側で interface check)
 * - pagination 1 page (limit 1000) のみ対応。それ以上保有する wallet は稀。
 */
export async function fetchAssetsByOwner(
  address: string
): Promise<HeliusAsset[]> {
  // ── cache hit check ──
  const cached = cache.get(address);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.data;
  }

  const url = buildUrl();
  const res = await fetchWithTimeout(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "seasonals-bff",
      method: "getAssetsByOwner",
      params: {
        ownerAddress: address,
        page: 1,
        limit: 1000,
        displayOptions: {
          showFungible: true,
          showNativeBalance: true,
        },
      },
    }),
  });

  if (!res.ok) {
    throw new Error(
      `Helius HTTP ${res.status} ${res.statusText}: ${await res.text().catch(() => "")}`
    );
  }

  const json = (await res.json()) as {
    jsonrpc?: string;
    result?: { items?: HeliusAsset[]; nativeBalance?: { lamports?: number } };
    error?: { code: number; message: string };
  };

  if (json.error) {
    throw new Error(
      `Helius RPC error ${json.error.code}: ${json.error.message}`
    );
  }

  const items = json.result?.items ?? [];

  // ── native SOL を synthetic asset として追加 ──
  // showNativeBalance: true で `result.nativeBalance.lamports` が返る。
  // wallet 表示で SOL 残高を欠落させないよう WSOL mint で entry を追加。
  const nativeLamports = json.result?.nativeBalance?.lamports;
  if (typeof nativeLamports === "number" && nativeLamports > 0) {
    const hasWrappedSolEntry = items.some(
      (a) => a.id === "So11111111111111111111111111111111111111112"
    );
    if (!hasWrappedSolEntry) {
      items.push({
        id: "So11111111111111111111111111111111111111112",
        interface: "FungibleToken",
        token_info: {
          balance: String(nativeLamports),
          decimals: 9,
          symbol: "SOL",
        },
        content: { metadata: { name: "Solana", symbol: "SOL" } },
      });
    }
  }

  cache.set(address, { data: items, ts: Date.now() });
  evictOldest(cache);
  return items;
}
