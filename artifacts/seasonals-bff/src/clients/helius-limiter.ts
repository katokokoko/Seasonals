/**
 * helius-limiter — Helius への request を絞る fetch と、読み取り用の retry
 *
 * 1 本の Helius Free-tier key を全 user で共有するため、BFF から出る Helius request を
 * 同時実行数と最小間隔で絞り (429 の手前で並ばせる)、出た request を usage.ts に数える。
 * ethereum/client.ts の throttledFetch (Infura 用) を一般化したもの (getLogs 専用 lane は無し)。
 *
 * - `heliusRpcFetch`  — JSON-RPC (4 in flight / 100ms 間隔 ≈ 10 rps)。Meteora / Orca SDK の
 *   Connection にも `fetch` として渡す
 * - `heliusDataFetch` — DAS / Enhanced Transactions / Parsed Events (2 in flight / 500ms 間隔 ≈ 2 rps、
 *   credit が重い口)
 * - `fetchJsonWithRetry` — 冪等な読み取りの 429 / 5xx / network を backoff 再試行
 *   (helius-rpc.ts の rpcReadWithRetry から抽出)。**sendTransaction には使わない**
 *
 * 秘密の扱い: URL は api-key を含むので error message / log に出さない。usage には
 * api / method の分類だけ渡す (URL・body は保持しない)。
 *
 * jest 下 (NODE_ENV=test) では 2 instance の最小間隔を 0 にする — 既存の route test が
 * 呼び出しごとに実時間を待たないため (同時実行数の制限は test でも効く)。gap なら timer も作らない。
 */
import { DEFAULT_FETCH_TIMEOUT_MS, fetchWithTimeout } from "./http";
import { classifyHeliusRequest, recordQueueDepth, recordUpstreamCall } from "../usage";

type FetchInput = string | URL | Request;
/** fetch 互換 (web3.js Connection の `fetch` option にもそのまま渡せる形) */
export type FetchLike = (input: FetchInput, init?: RequestInit) => Promise<Response>;

export interface ThrottleOptions {
  maxInFlight: number;
  minGapMs: number;
  /**
   * 上流へ実際に出す直前に呼ばれる。完了時 (HTTP status、network 失敗は null) に
   * 呼ばれる callback を返してよい
   */
  onDispatch?: (url: string, init: RequestInit | undefined) => ((status: number | null) => void) | void;
  /** 待ち行列に積んだ直後の深さ */
  onQueueDepth?: (depth: number) => void;
}

export interface ThrottledFetch extends FetchLike {
  /** 同じ列に並ぶが、dispatch 時に timeout (AbortSignal) を付ける fetch (init.signal があればそちら優先) */
  timed(timeoutMs?: number): FetchLike;
  /** 現在の in-flight / 待ち数 */
  state(): { inFlight: number; queued: number };
  /** test 用: 最小間隔を変える */
  _setGapForTest(ms: number): void;
}

function urlOf(input: FetchInput): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  const u = (input as { url?: unknown } | null | undefined)?.url;
  return typeof u === "string" ? u : String(input);
}

export function createThrottledFetch(opts: ThrottleOptions): ThrottledFetch {
  let minGapMs = opts.minGapMs;
  let inFlight = 0;
  let last = 0;
  const queue: Array<() => void> = [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  const pump = (): void => {
    timer = null;
    while (inFlight < opts.maxInFlight && queue.length > 0) {
      const now = Date.now();
      // 時計が戻った (fake timer / NTP 補正) 時に gap が負の無限待ちにならないよう clamp
      if (last > now) last = now;
      const gap = minGapMs > 0 ? Math.max(0, last + minGapMs - now) : 0;
      if (gap > 0) {
        timer ??= setTimeout(pump, gap);
        return;
      }
      const next = queue.shift()!;
      last = now;
      inFlight++;
      next();
    }
  };

  const enqueue = (input: FetchInput, init: RequestInit | undefined, timeoutMs: number | null): Promise<Response> =>
    new Promise<Response>((resolve, reject) => {
      queue.push(() => {
        let done: ((status: number | null) => void) | void = undefined;
        let p: Promise<Response>;
        // ここで同期 throw すると in-flight 枠が漏れて列が詰まるので、全部 promise に寄せる
        try {
          const url = urlOf(input);
          try {
            done = opts.onDispatch?.(url, init);
          } catch {
            // 計数の失敗で request を止めない
          }
          // timeout 付きは http.ts 経由 (呼び出し時に global fetch を参照 — test の spy が効く)
          p = timeoutMs !== null ? fetchWithTimeout(url, init, timeoutMs) : fetch(input, init);
          if (!p || typeof p.then !== "function") p = Promise.resolve(p);
        } catch (e) {
          p = Promise.reject(e);
        }
        p.then(
          (res) => {
            try {
              done?.(typeof res?.status === "number" ? res.status : null);
            } catch {
              /* ignore */
            }
            resolve(res);
          },
          (err: unknown) => {
            try {
              done?.(null);
            } catch {
              /* ignore */
            }
            reject(err);
          }
        ).finally(() => {
          inFlight--;
          pump();
        });
      });
      opts.onQueueDepth?.(queue.length);
      pump();
    });

  const f = ((input: FetchInput, init?: RequestInit) => enqueue(input, init, null)) as ThrottledFetch;
  f.timed = (timeoutMs = DEFAULT_FETCH_TIMEOUT_MS) => (input, init) => enqueue(input, init, timeoutMs);
  f.state = () => ({ inFlight, queued: queue.length });
  f._setGapForTest = (ms: number) => {
    minGapMs = ms;
  };
  return f;
}

// ── Helius 用 instance ──────────────────────────────────────────────────────

const IS_TEST = process.env.NODE_ENV === "test";

function countHelius(url: string, init: RequestInit | undefined): (status: number | null) => void {
  const calls = classifyHeliusRequest(url, init?.body);
  return (status) => {
    for (const call of calls) recordUpstreamCall({ ...call, status });
  };
}

/** JSON-RPC 用 (4 in flight / 100ms 間隔) */
export const heliusRpcFetch: ThrottledFetch = createThrottledFetch({
  maxInFlight: 4,
  minGapMs: IS_TEST ? 0 : 100,
  onDispatch: countHelius,
  onQueueDepth: recordQueueDepth,
});

/** DAS / Enhanced / Parsed 用 (2 in flight / 500ms 間隔) */
export const heliusDataFetch: ThrottledFetch = createThrottledFetch({
  maxInFlight: 2,
  minGapMs: IS_TEST ? 0 : 500,
  onDispatch: countHelius,
  onQueueDepth: recordQueueDepth,
});

// ── 読み取りの retry (Helius 429 対策) ─────────────────────────────────────
//
// Helius は混雑時に `429 Too Many Requests` (本文は plain text) を返す。読み取り
// 専用の request は冪等なので、429 / 5xx / network・timeout を指数 backoff で
// 再試行する (既定 3 attempt。attempt 間の待ちは 500ms → 1000ms、attempt を増やせば
// 次段は 2000ms。`Retry-After` (秒、上限 10s) が backoff より長ければそちらを使う)。
// - 429 以外の 4xx は即 throw (再試行しても結果は同じ)
// - **sendTransaction には使わない** — broadcast の自動再送は二重送信の余地を作る
// - error message に URL / api-key を含めない

const DEFAULT_MAX_ATTEMPTS = 3;
const BACKOFF_MS = [500, 1000, 2000] as const;
/** Retry-After が異常に長い時に handler を長く塞がない上限 */
const RETRY_AFTER_CAP_MS = 10_000;

type SleepFn = (ms: number) => Promise<void>;
/** backoff の待ち。失敗を流す test は _setSleepForTest で差し替える (fake timer と組み合わせると解決しないため) */
const defaultSleep: SleepFn = (ms) => new Promise((r) => setTimeout(r, ms));
let sleep: SleepFn = defaultSleep;

/** test 専用: backoff の待ちを差し替える (null で既定に戻す) */
export function _setSleepForTest(fn: SleepFn | null): void {
  sleep = fn ?? defaultSleep;
}

export type HeliusRpcErrorKind = "http" | "rpc" | "network" | "parse";

/** Helius 読み取りの失敗。message に URL / api-key を含めない */
export class HeliusRpcError extends Error {
  constructor(
    message: string,
    readonly kind: HeliusRpcErrorKind,
    readonly status?: number
  ) {
    super(message);
    this.name = "HeliusRpcError";
  }
}

export const redactKey = (s: string): string => s.replace(/api-key=[^&\s"']+/g, "api-key=***");

function parseRetryAfterMs(res: Response): number | null {
  const raw = res.headers?.get?.("retry-after");
  if (!raw) return null;
  const sec = Number(raw.trim()); // 秒数 (小整数、§4.5 適用外)
  if (!Number.isFinite(sec) || sec < 0) return null;
  return Math.min(sec * 1000, RETRY_AFTER_CAP_MS);
}

export interface FetchJsonRetryOptions {
  /** error message 上の名前 (URL は出さない) */
  label: string;
  /** 既定: heliusRpcFetch.timed() (10s timeout、RPC の列) */
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  /** 既定 3 */
  maxAttempts?: number;
  /** network / timeout を再試行するか (既定 true)。false なら 429 / 5xx のみ */
  retryNetworkErrors?: boolean;
}

/**
 * 冪等な読み取りを 1 本投げ、JSON を返す。429 / 5xx / network は backoff 再試行、
 * それ以外の HTTP 失敗と JSON でない応答は即 throw (HeliusRpcError)。
 * JSON-RPC の `error` 判定は呼び手 (rpcReadWithRetry 等) の責務。
 */
export async function fetchJsonWithRetry<T = unknown>(
  url: string,
  init: RequestInit,
  opts: FetchJsonRetryOptions
): Promise<T> {
  const label = opts.label;
  const fetchImpl = opts.fetchImpl ?? heliusRpcFetch.timed();
  const maxAttempts = Math.max(1, opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const retryNetwork = opts.retryNetworkErrors ?? true;
  const backoff = (attempt: number) => BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]!;
  let lastErr: HeliusRpcError | null = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let res: Response;
    try {
      res = await fetchImpl(url, init);
    } catch (e) {
      const msg = redactKey(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
      lastErr = new HeliusRpcError(`Helius ${label} network error: ${msg}`, "network");
      if (!retryNetwork) throw lastErr;
      if (attempt + 1 < maxAttempts) await sleep(backoff(attempt));
      continue;
    }

    if (!res.ok) {
      const retryable = res.status === 429 || res.status >= 500;
      const hint = res.status === 429 ? " (rate limited)" : "";
      lastErr = new HeliusRpcError(`Helius ${label} HTTP ${res.status}${hint}`, "http", res.status);
      if (!retryable) throw lastErr;
      const waitFloorMs = parseRetryAfterMs(res);
      // body は読まずに捨てる (接続を解放)
      await res.body?.cancel().catch(() => undefined);
      if (attempt + 1 < maxAttempts) {
        await sleep(Math.max(backoff(attempt), waitFloorMs ?? 0));
      }
      continue;
    }

    try {
      return (await res.json()) as T;
    } catch {
      throw new HeliusRpcError(`Helius ${label}: response is not JSON`, "parse", res.status);
    }
  }
  throw lastErr ?? new HeliusRpcError(`Helius ${label}: retries exhausted`, "network");
}
