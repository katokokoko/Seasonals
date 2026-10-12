/**
 * /api/* → BFF の upstream Request を組み立てる (Cloudflare Pages Function
 * `functions/api/[[path]].ts` から呼ぶ)。
 *
 * - Workers runtime で動くので Web platform API (Request / Headers / URL) だけを使う。
 *   Node 固有 API・npm 依存を足さない (vitest は Node の Request でそのまま検証できる)。
 * - URL: `${bffOrigin}/${pathSegments.join("/")}${search}`。`/api` prefix は落とす
 *   (vite.config.ts の dev proxy の `rewrite` と同じ契約、src/services/api.ts の `BASE = "/api"`)。
 * - header: 受けた header を写すが、host / content-length / hop-by-hop / `cf-*` /
 *   `x-forwarded-*` / `x-seasonals-*` は落とす。`x-seasonals-*` を落とすのは、client が
 *   `x-seasonals-client-ip` 等を偽造して BFF の per-user rate limit をすり抜けられないようにするため。
 *   その上で proxy 自身が `x-seasonals-client-ip` (inbound の `cf-connecting-ip`) と
 *   `x-seasonals-proxy-key` (secret) を付ける。BFF は key が一致した時だけ client-ip を信用する。
 * - redirect は manual: BFF の 3xx はそのまま browser に返す (proxy が勝手に辿らない)。
 */

const DROPPED_HEADERS = new Set([
  "host",
  "content-length", // fetch が body から再計算する
  // hop-by-hop (RFC 9110 §7.6.1): 次の hop に転送しない
  "connection",
  "keep-alive",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const DROPPED_PREFIXES = ["cf-", "x-forwarded-", "x-seasonals-"];

export const CLIENT_IP_HEADER = "x-seasonals-client-ip";
export const PROXY_KEY_HEADER = "x-seasonals-proxy-key";

export type UpstreamInput = {
  request: Request;
  bffOrigin: string;
  pathSegments: string[] | undefined;
  proxySecret?: string | null;
};

function isDropped(name: string): boolean {
  const n = name.toLowerCase();
  return DROPPED_HEADERS.has(n) || DROPPED_PREFIXES.some((p) => n.startsWith(p));
}

export function buildUpstreamRequest({ request, bffOrigin, pathSegments, proxySecret }: UpstreamInput): Request {
  const origin = bffOrigin.replace(/\/+$/, "");
  const path = (pathSegments ?? []).join("/");
  const url = `${origin}/${path}${new URL(request.url).search}`;

  const headers = new Headers();
  request.headers.forEach((value, name) => {
    if (!isDropped(name)) headers.append(name, value);
  });
  const clientIp = request.headers.get("cf-connecting-ip");
  if (clientIp) headers.set(CLIENT_IP_HEADER, clientIp);
  if (typeof proxySecret === "string" && proxySecret.length > 0) headers.set(PROXY_KEY_HEADER, proxySecret);

  const method = request.method;
  const hasBody = method !== "GET" && method !== "HEAD";
  // stream body を渡す時、Node (undici) の Request は `duplex: "half"` を要求する (workerd も受け付ける)。
  // TS の DOM lib の RequestInit には無いので最小限の型拡張で渡す。
  const init: RequestInit & { duplex?: "half" } = {
    method,
    headers,
    redirect: "manual",
    ...(hasBody && request.body ? { body: request.body, duplex: "half" } : {}),
  };
  return new Request(url, init);
}
