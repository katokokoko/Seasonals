/**
 * http — BFF 外部 fetch の共通 timeout (Phase 8.38 B9)
 *
 * Node の fetch には default timeout が無く、上流 (Jupiter / Kamino / Helius /
 * 各 protocol API) が hang すると tx-build handler が無期限に待っていた。
 * 全 client はこのラッパー経由で fetch する (oracle.ts は独自 AbortSignal 済)。
 *
 * global fetch を呼び出し時に参照する (import 時 capture しない) — テストの
 * `jest.spyOn(global, "fetch")` がそのまま効く。
 */

export const DEFAULT_FETCH_TIMEOUT_MS = 10_000;

export function fetchWithTimeout(
  url: string,
  init?: RequestInit,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS
): Promise<Response> {
  return fetch(url, {
    ...init,
    signal: init?.signal ?? AbortSignal.timeout(timeoutMs),
  });
}
