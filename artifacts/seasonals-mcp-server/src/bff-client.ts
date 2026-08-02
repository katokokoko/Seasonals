/**
 * bff-client — Seasonals BFF への薄い HTTP wrapper (Phase 8.28)
 *
 * MCP Server v1 は §12.3 の「共有 core service」を BFF REST で代替する
 * (同じ endpoint を mobile と共有 = same source of truth)。BFF_URL env で
 * 接続先を切替 (default: ローカル BFF)。
 */

export interface BffClient {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
}

export class BffHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown
  ) {
    super(`BFF HTTP ${status}: ${JSON.stringify(body).slice(0, 300)}`);
  }
}

export function createBffClient(
  baseUrl: string = process.env.BFF_URL ?? "http://127.0.0.1:3030"
): BffClient {
  const base = baseUrl.replace(/\/$/, "");
  async function request<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown
  ): Promise<T> {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json().catch(() => null)) as T;
    if (!res.ok) throw new BffHttpError(res.status, json);
    return json;
  }
  return {
    get: (path) => request("GET", path),
    post: (path, body) => request("POST", path, body),
  };
}
