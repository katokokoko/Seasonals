// @vitest-environment node
/**
 * functions/api/[[path]].ts — Cloudflare Pages Function の振る舞い (fetch を stub)。
 * test を functions/ 配下に置くと Pages が route として拾うので、ここ (proxy/) に置く。
 */
import { onRequest } from "../functions/api/[[path]]";
import { PROXY_KEY_HEADER } from "./upstream";

const inbound = (path: string, init?: RequestInit) => new Request(`https://seasonals.cafe${path}`, init);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Pages Function /api/[[path]]", () => {
  it("returns 503 bff_origin_not_configured without BFF_ORIGIN and does not fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await onRequest({ request: inbound("/api/health"), env: {}, params: { path: ["health"] } });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "bff_origin_not_configured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fetches the upstream request and returns the upstream Response object as-is", async () => {
    const upstream = new Response('{"ok":true}', { status: 201, headers: { "content-type": "application/json" } });
    const fetchMock = vi.fn(async (_req: Request) => upstream);
    vi.stubGlobal("fetch", fetchMock);
    const res = await onRequest({
      request: inbound("/api/positions?wallet=abc"),
      env: { BFF_ORIGIN: "https://api.seasonals.cafe", BFF_PROXY_SECRET: "s3cret" },
      params: { path: ["positions"] },
    });
    expect(res).toBe(upstream);
    const sent = fetchMock.mock.calls[0]![0];
    expect(sent.url).toBe("https://api.seasonals.cafe/positions?wallet=abc");
    expect(sent.headers.get(PROXY_KEY_HEADER)).toBe("s3cret");
  });

  it("accepts a single-string path param and a missing one", async () => {
    const fetchMock = vi.fn(async (_req: Request) => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const env = { BFF_ORIGIN: "http://127.0.0.1:3035" };
    await onRequest({ request: inbound("/api/health"), env, params: { path: "health" } });
    await onRequest({ request: inbound("/api"), env, params: {} });
    expect(fetchMock.mock.calls.map(([r]) => r.url)).toEqual(["http://127.0.0.1:3035/health", "http://127.0.0.1:3035/"]);
  });
});
