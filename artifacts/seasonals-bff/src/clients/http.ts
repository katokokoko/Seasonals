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

/**
 * Phase 8.78: 上流 timeout / abort を人が読める 1 文にする。
 *
 * solend-sdk (isomorphic-fetch) が global fetch を node-fetch に上書きしている
 * ため (CLAUDE.md §10 既知事項)、AbortSignal 発火時のエラーが
 * "The user aborted a request." になる。これが tx-build の 502 message として
 * mobile にそのまま出て、**ユーザーが自分で中断した**ように読めた (Phase 8.78 の
 * 発端)。実際はサーバー側の上流 timeout であり、署名前に止まっている。
 *
 * error code は変えない (machine-readable 契約は 8.74 と同じく不変)。
 */
export function readableUpstreamError(
  err: unknown,
  upstreamName: string
): string {
  const message = err instanceof Error ? err.message : String(err);
  const name = err instanceof Error ? err.name : "";
  const isAbort =
    name === "AbortError" ||
    name === "TimeoutError" ||
    /abort/i.test(message) ||
    /timeout/i.test(message);
  if (isAbort) {
    return `${upstreamName} timed out — nothing was signed. Try again.`;
  }
  return message;
}
