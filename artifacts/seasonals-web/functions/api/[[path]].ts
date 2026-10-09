/**
 * Cloudflare Pages Function: `https://seasonals.cafe/api/*` → BFF (`BFF_ORIGIN`、本番は
 * `https://api.seasonals.cafe`) の pass-through proxy。
 *
 * なぜ proxy するか:
 * - web は相対 `/api/...` しか叩かない (src/services/api.ts `BASE = "/api"`、dev は vite proxy)。
 *   本番も same-origin のまま保てば CORS / CSP / bundle への URL 埋め込みが要らない。
 * - e2e/run.mjs は `/api/...` への route mock (と `/api/health` の疎通確認) を `WEB_URL` と同じ
 *   origin で行うので、本番 URL に対してもそのまま走る。
 * - BFF の per-user rate limit 用に client IP (`cf-connecting-ip`) と共有 secret を header で渡す
 *   (proxy/upstream.ts)。BFF は secret が一致した時だけ client IP を信用する。
 *
 * public/_routes.json で `/api/*` だけがこの Function を起動する (静的 asset は CDN 直配信)。
 * upstream の Response は包み直さず返す (content-encoding / length の不整合を避ける、cache しない)。
 */
import { buildUpstreamRequest } from "../../proxy/upstream";

type PagesContext = {
  request: Request;
  env: { BFF_ORIGIN?: string; BFF_PROXY_SECRET?: string };
  params: { path?: string[] | string };
};

export const onRequest = async (ctx: PagesContext): Promise<Response> => {
  const bffOrigin = ctx.env.BFF_ORIGIN;
  if (!bffOrigin) {
    return new Response(JSON.stringify({ error: "bff_origin_not_configured" }), {
      status: 503,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    });
  }
  const raw = ctx.params.path;
  const pathSegments = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
  return fetch(
    buildUpstreamRequest({ request: ctx.request, bffOrigin, pathSegments, proxySecret: ctx.env.BFF_PROXY_SECRET }),
  );
};
