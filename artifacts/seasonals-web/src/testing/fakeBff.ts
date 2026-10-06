/**
 * test 用: globalThis.fetch を path ごとの応答に差し替え、呼ばれた順に記録する。
 * handler は path (query 込み、`/api` を除いたもの) と body を受けて Response 相当を返す。
 */
export interface FakeCall {
  method: string;
  path: string;
  body: unknown;
}
export type FakeReply = { status?: number; json: unknown } | undefined;
export type FakeHandler = (path: string, body: unknown, method: string) => FakeReply;

export function installFakeBff(handler: FakeHandler): FakeCall[] {
  const calls: FakeCall[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const path = String(url).replace(/^\/api/, "");
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, body });
    const r = handler(path, body, method);
    if (!r) return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
    return new Response(JSON.stringify(r.json), { status: r.status ?? 200 });
  }) as typeof fetch;
  return calls;
}

/** base64 (Buffer は test 側でだけ使う) */
export const b64 = (bytes: number[]) => Buffer.from(Uint8Array.from(bytes)).toString("base64");
