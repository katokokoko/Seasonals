// @vitest-environment node
/**
 * proxy/upstream.ts — `/api/*` → BFF の upstream Request 組み立て。
 * Workers runtime と同じ Web platform の Request を Node で使って検証する (jsdom ではなく node 環境)。
 */
import { buildUpstreamRequest, CLIENT_IP_HEADER, PROXY_KEY_HEADER } from "./upstream";

const ORIGIN = "https://api.seasonals.cafe";
const inbound = (path: string, init?: RequestInit) => new Request(`https://seasonals.cafe${path}`, init);

describe("buildUpstreamRequest", () => {
  it("drops the /api prefix: segments [positions] → <origin>/positions", () => {
    const req = buildUpstreamRequest({ request: inbound("/api/positions"), bffOrigin: ORIGIN, pathSegments: ["positions"] });
    expect(req.url).toBe(`${ORIGIN}/positions`);
    expect(req.method).toBe("GET");
  });

  it("joins nested segments and keeps the query string verbatim", () => {
    const req = buildUpstreamRequest({
      request: inbound("/api/oracle/status?wallet=abc&days=30"),
      bffOrigin: ORIGIN,
      pathSegments: ["oracle", "status"],
    });
    expect(req.url).toBe(`${ORIGIN}/oracle/status?wallet=abc&days=30`);
  });

  it("maps empty / missing segments to the origin root", () => {
    expect(buildUpstreamRequest({ request: inbound("/api/"), bffOrigin: ORIGIN, pathSegments: [] }).url).toBe(`${ORIGIN}/`);
    expect(buildUpstreamRequest({ request: inbound("/api"), bffOrigin: ORIGIN, pathSegments: undefined }).url).toBe(`${ORIGIN}/`);
  });

  it("normalizes a trailing slash on the origin", () => {
    const req = buildUpstreamRequest({ request: inbound("/api/health"), bffOrigin: `${ORIGIN}//`, pathSegments: ["health"] });
    expect(req.url).toBe(`${ORIGIN}/health`);
  });

  it("passes a POST body and content-type through", async () => {
    const body = JSON.stringify({ wallet: "abc", amount: "1500000" });
    const req = buildUpstreamRequest({
      request: inbound("/api/tx/submit", { method: "POST", body, headers: { "content-type": "application/json" } }),
      bffOrigin: ORIGIN,
      pathSegments: ["tx", "submit"],
    });
    expect(req.method).toBe("POST");
    expect(req.headers.get("content-type")).toBe("application/json");
    expect(await req.text()).toBe(body);
  });

  it("passes OPTIONS through with the method preserved and no body", () => {
    const req = buildUpstreamRequest({
      request: inbound("/api/positions", { method: "OPTIONS", headers: { "access-control-request-method": "GET" } }),
      bffOrigin: ORIGIN,
      pathSegments: ["positions"],
    });
    expect(req.method).toBe("OPTIONS");
    expect(req.headers.get("access-control-request-method")).toBe("GET");
    expect(req.body).toBeNull();
  });

  it("copies ordinary headers but drops host, cf-*, x-forwarded-* and hop-by-hop headers", () => {
    const req = buildUpstreamRequest({
      request: inbound("/api/positions", {
        headers: {
          accept: "application/json",
          "user-agent": "vitest",
          host: "seasonals.cafe",
          "cf-ray": "8f00000000000000-NRT",
          "cf-ipcountry": "JP",
          "x-forwarded-for": "198.51.100.1",
          "x-forwarded-proto": "https",
          "keep-alive": "timeout=5",
        },
      }),
      bffOrigin: ORIGIN,
      pathSegments: ["positions"],
    });
    expect(req.headers.get("accept")).toBe("application/json");
    expect(req.headers.get("user-agent")).toBe("vitest");
    for (const name of ["host", "cf-ray", "cf-ipcountry", "x-forwarded-for", "x-forwarded-proto", "keep-alive"]) {
      expect(req.headers.has(name)).toBe(false);
    }
  });

  it("sets both proxy headers when the secret is given and cf-connecting-ip is present", () => {
    const req = buildUpstreamRequest({
      request: inbound("/api/positions", { headers: { "cf-connecting-ip": "203.0.113.7" } }),
      bffOrigin: ORIGIN,
      pathSegments: ["positions"],
      proxySecret: "s3cret",
    });
    expect(req.headers.get(CLIENT_IP_HEADER)).toBe("203.0.113.7");
    expect(req.headers.get(PROXY_KEY_HEADER)).toBe("s3cret");
    expect(req.headers.has("cf-connecting-ip")).toBe(false);
  });

  it("omits the proxy key without a non-empty secret, and the client ip without cf-connecting-ip", () => {
    for (const proxySecret of [undefined, null, ""]) {
      const req = buildUpstreamRequest({
        request: inbound("/api/positions", { headers: { "cf-connecting-ip": "203.0.113.7" } }),
        bffOrigin: ORIGIN,
        pathSegments: ["positions"],
        proxySecret,
      });
      expect(req.headers.has(PROXY_KEY_HEADER)).toBe(false);
    }
    const noIp = buildUpstreamRequest({ request: inbound("/api/positions"), bffOrigin: ORIGIN, pathSegments: ["positions"], proxySecret: "s3cret" });
    expect(noIp.headers.has(CLIENT_IP_HEADER)).toBe(false);
    expect(noIp.headers.get(PROXY_KEY_HEADER)).toBe("s3cret");
  });

  it("never forwards client-supplied x-seasonals-* headers (no spoofed ip / key)", () => {
    const spoofed = { [CLIENT_IP_HEADER]: "10.0.0.1", [PROXY_KEY_HEADER]: "guess", "x-seasonals-anything": "1" };
    const withoutIp = buildUpstreamRequest({ request: inbound("/api/positions", { headers: spoofed }), bffOrigin: ORIGIN, pathSegments: ["positions"] });
    expect(withoutIp.headers.has(CLIENT_IP_HEADER)).toBe(false);
    expect(withoutIp.headers.has(PROXY_KEY_HEADER)).toBe(false);
    expect(withoutIp.headers.has("x-seasonals-anything")).toBe(false);

    const withIp = buildUpstreamRequest({
      request: inbound("/api/positions", { headers: { ...spoofed, "cf-connecting-ip": "203.0.113.7" } }),
      bffOrigin: ORIGIN,
      pathSegments: ["positions"],
      proxySecret: "s3cret",
    });
    expect(withIp.headers.get(CLIENT_IP_HEADER)).toBe("203.0.113.7");
    expect(withIp.headers.get(PROXY_KEY_HEADER)).toBe("s3cret");
  });

  it("does not follow upstream redirects", () => {
    const req = buildUpstreamRequest({ request: inbound("/api/health"), bffOrigin: ORIGIN, pathSegments: ["health"] });
    expect(req.redirect).toBe("manual");
  });
});
