/**
 * Ethereum event aggregator — UI (/eth/*) と MCP Server (list_events) が読む
 * 同一の event source (CLAUDE.md §0 "Same source of truth")。
 *
 * - adapter ごとに Promise.allSettled で隔離。部分失敗は sources[] に記録して 200
 * - 結果は id で merge (再導出で重複を溜めない)、短時間 cache
 * - エラー文言は sanitizeError 済み (key / URL を含めない)
 */
import { mergeTimelineEvents, sortTimeline } from "@workspace/lib/derive/timeline";
import type { TimelineEvent, TimelineEventsResponse } from "@workspace/lib/types";
import { getEthClient, sanitizeError } from "./client";
import { fetchEthenaUserEvents } from "./ethena";
import { fetchLidoUserEvents } from "./lido";
import { fetchPendlePublicEvents, fetchPendleUserEvents } from "./pendle";

type Source = { name: string; run: (observedAt: string) => Promise<TimelineEvent[]>; needsRpc: boolean };

const cache = new Map<string, { at: number; value: TimelineEventsResponse; ttlMs: number }>();
/** 部分失敗 (429 等) を含む結果は短時間だけ cache して早めに再試行する */
const FAILED_TTL_MS = 10_000;
const inflight = new Map<string, Promise<TimelineEventsResponse>>();

async function collect(key: string, sources: Source[], ttlMs: number): Promise<TimelineEventsResponse> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < hit.ttlMs) return hit.value;
  const running = inflight.get(key);
  if (running) return running;
  const p = (async () => {
    const observedAt = new Date().toISOString();
    const hasRpc = getEthClient() !== null;
    const settled = await Promise.allSettled(
      sources.map((s) => (s.needsRpc && !hasRpc ? Promise.reject(new Error("Ethereum RPC is not configured.")) : s.run(observedAt)))
    );
    const lists: TimelineEvent[][] = [];
    const status: TimelineEventsResponse["sources"] = settled.map((r, i) => {
      const name = sources[i]!.name;
      if (r.status === "fulfilled") {
        lists.push(r.value);
        return { source: name, ok: true, observedAt };
      }
      return { source: name, ok: false, error: sanitizeError(r.reason), observedAt };
    });
    const value = { events: sortTimeline(mergeTimelineEvents(...lists)), sources: status };
    cache.set(key, { at: Date.now(), value, ttlMs: status.every((x) => x.ok) ? ttlMs : FAILED_TTL_MS });
    return value;
  })().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/** extra: CCA など後段で登録される source (公開 / address 別) */
const extraPublic: Source[] = [];
const extraUser: Array<(owner: string) => Source> = [];
export function registerPublicSource(s: Source) {
  extraPublic.push(s);
}
export function registerUserSource(f: (owner: string) => Source) {
  extraUser.push(f);
}

export function getPublicEvents(): Promise<TimelineEventsResponse> {
  return collect(
    "public",
    [{ name: "pendle:markets", run: fetchPendlePublicEvents, needsRpc: false }, ...extraPublic],
    5 * 60_000
  );
}

export function getUserEvents(owner: string): Promise<TimelineEventsResponse> {
  const o = owner.toLowerCase();
  return collect(
    `user:${o}`,
    [
      { name: "pendle:positions", run: (t) => fetchPendleUserEvents(owner, t), needsRpc: false },
      { name: "ethena:cooldown", run: (t) => fetchEthenaUserEvents(owner, t), needsRpc: true },
      { name: "lido:withdrawals", run: (t) => fetchLidoUserEvents(owner, t), needsRpc: true },
      ...extraUser.map((f) => f(owner)),
    ],
    60_000
  );
}

/** 実行後など、address の cache を捨てて次回再導出させる */
export function _invalidateUser(owner: string) {
  cache.delete(`user:${owner.toLowerCase()}`);
}

export function _clearEthCacheForTest() {
  cache.clear();
}
