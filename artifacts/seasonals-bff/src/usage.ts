/**
 * usage — Helius 呼び出しの計数と概算 credit (GET /admin/helius-usage)
 *
 * Helius Free tier は月の credit 上限と秒間 request 上限があるため、どの route が
 * 何を何回呼んだかを dashboard を待たずに確かめる。ethereum/client.ts の
 * `countRpc` / `rpcUsageSnapshot` (Infura 用) と同型。
 *
 * - 数えるのは **実際に上流へ出た request** (retry も 1 回ずつ = 課金と同じ)。
 *   helius-limiter の onDispatch から供給される
 * - credit は Helius の公表値の目安: RPC 1 / getProgramAccounts 10 / DAS 10 /
 *   Enhanced Transactions 100 / Parsed Events 10
 * - 値は件数のみ。URL (api-key を含む) / wallet / body は保持しない
 */
import { allCacheStats, type TtlCacheStats } from "./cache/ttl-cache";

export type HeliusApi = "rpc" | "das" | "enhanced" | "parsed";

const API_CREDIT: Record<HeliusApi, number> = { rpc: 1, das: 10, enhanced: 100, parsed: 10 };
/** api 既定から外れる RPC method */
const METHOD_CREDIT: Record<string, number> = { getProgramAccounts: 10 };

/** Helius DAS (JSON-RPC、RPC と同じ host) の method */
const DAS_METHODS = new Set([
  "getAsset",
  "getAssetBatch",
  "getAssetProof",
  "getAssetProofBatch",
  "getAssetsByOwner",
  "getAssetsByAuthority",
  "getAssetsByCreator",
  "getAssetsByGroup",
  "searchAssets",
  "getSignaturesForAsset",
  "getTokenAccounts",
  "getNftEditions",
]);

export function isDasMethod(method: string): boolean {
  return DAS_METHODS.has(method) || method.startsWith("getAsset");
}

export function creditFor(api: HeliusApi, method: string): number {
  if (api === "rpc") return METHOD_CREDIT[method] ?? API_CREDIT.rpc;
  return API_CREDIT[api];
}

interface Counters {
  since: string;
  requests: number;
  approxCredits: number;
  byApi: Record<HeliusApi, number>;
  byMethod: Map<string, number>;
  /** 上流が 429 を返した回数 (api 別) */
  rateLimited: Record<HeliusApi, number>;
  /** 4xx / 5xx / network 失敗 (429 含む) */
  failed: number;
  maxQueueDepth: number;
}

function fresh(): Counters {
  return {
    since: new Date().toISOString(),
    requests: 0,
    approxCredits: 0,
    byApi: { rpc: 0, das: 0, enhanced: 0, parsed: 0 },
    byMethod: new Map(),
    rateLimited: { rpc: 0, das: 0, enhanced: 0, parsed: 0 },
    failed: 0,
    maxQueueDepth: 0,
  };
}

let c = fresh();

/**
 * 上流へ出た 1 request を記録する。status は HTTP status (network 失敗は null)。
 * 429 はここで rateLimited にも数える (retry helper / SDK の自前 retry どちらの経路でも漏れない)
 */
export function recordUpstreamCall(call: { api: HeliusApi; method: string; status: number | null | undefined }): void {
  c.requests++;
  c.byApi[call.api]++;
  c.approxCredits += creditFor(call.api, call.method);
  const key = `${call.api}:${call.method}`;
  c.byMethod.set(key, (c.byMethod.get(key) ?? 0) + 1);
  const s = call.status;
  if (s === 429) recordRateLimited(call.api);
  if (s === null || (typeof s === "number" && s >= 400)) c.failed++;
}

export function recordRateLimited(api: HeliusApi): void {
  c.rateLimited[api]++;
}

/** limiter の待ち行列の深さ (最大値だけ保持) */
export function recordQueueDepth(depth: number): void {
  if (depth > c.maxQueueDepth) c.maxQueueDepth = depth;
}

export interface UsageSnapshot {
  since: string;
  requests: number;
  approxCredits: number;
  byApi: Record<HeliusApi, number>;
  /** `<api>:<method>` → 回数 (多い順) */
  byMethod: Record<string, number>;
  rateLimited: Record<HeliusApi, number> & { total: number };
  failed: number;
  maxQueueDepth: number;
  caches: Record<string, TtlCacheStats>;
}

export function usageSnapshot(): UsageSnapshot {
  const rl = c.rateLimited;
  return {
    since: c.since,
    requests: c.requests,
    approxCredits: c.approxCredits,
    byApi: { ...c.byApi },
    byMethod: Object.fromEntries([...c.byMethod.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))),
    rateLimited: { ...rl, total: rl.rpc + rl.das + rl.enhanced + rl.parsed },
    failed: c.failed,
    maxQueueDepth: c.maxQueueDepth,
    caches: allCacheStats(),
  };
}

export function _resetUsageForTest(): void {
  c = fresh();
}

// ── limiter の onDispatch から使う分類 ──────────────────────────────────────

/**
 * 上流 request を api / method に分類する。URL はここで捨てる (保持しない)。
 * - `api.helius.xyz/v0/addresses/...` → enhanced
 * - `/parsed-events` を含む path → parsed
 * - それ以外は JSON-RPC body の method (batch 配列は要素ごと)。DAS method は das
 */
export function classifyHeliusRequest(url: string, body: unknown): Array<{ api: HeliusApi; method: string }> {
  if (url.includes("/v0/addresses/")) return [{ api: "enhanced", method: "addresses.transactions" }];
  if (url.includes("/parsed-events")) return [{ api: "parsed", method: "parsed-events" }];
  if (typeof body !== "string") return [{ api: "rpc", method: "unknown" }];
  try {
    const parsed = JSON.parse(body) as { method?: unknown } | Array<{ method?: unknown }>;
    const list = Array.isArray(parsed) ? parsed : [parsed];
    if (list.length === 0) return [{ api: "rpc", method: "unknown" }];
    return list.map((r) => {
      const method = typeof r?.method === "string" ? r.method : "unknown";
      return { api: isDasMethod(method) ? "das" : "rpc", method };
    });
  } catch {
    return [{ api: "rpc", method: "unknown" }];
  }
}
