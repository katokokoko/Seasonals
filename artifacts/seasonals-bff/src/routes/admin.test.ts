/**
 * GET /admin/helius-usage — isAdminAuthorized で gate (PATCH /user-policy と同じ方針)
 */
import Fastify, { type FastifyInstance } from "fastify";
import { buildServer } from "../server";
import { registerAdminRoutes, HELIUS_USAGE_PATH } from "./admin";
import { _resetUsageForTest, recordUpstreamCall } from "../usage";

const TOKEN = "admin-test-token-123";

describe("registerAdminRoutes (単体)", () => {
  let app: FastifyInstance;
  afterEach(async () => app.close());

  async function make(token: string | null, nodeEnv = "test") {
    app = Fastify({ logger: false });
    await registerAdminRoutes(app, { adminToken: () => token, env: () => ({ NODE_ENV: nodeEnv }) });
    await app.ready();
  }

  test("ADMIN_TOKEN 設定時: header 無し / 不一致は 403、一致で snapshot", async () => {
    _resetUsageForTest();
    recordUpstreamCall({ api: "das", method: "getAssetsByOwner", status: 200 });
    await make(TOKEN);
    const denied = await app.inject({ method: "GET", url: HELIUS_USAGE_PATH });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toEqual({ error: "admin_token_required" });
    const wrong = await app.inject({ method: "GET", url: HELIUS_USAGE_PATH, headers: { "x-seasonals-admin-token": "nope" } });
    expect(wrong.statusCode).toBe(403);
    const ok = await app.inject({ method: "GET", url: HELIUS_USAGE_PATH, headers: { "x-seasonals-admin-token": TOKEN } });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers["cache-control"]).toBe("no-store");
    expect(ok.json()).toMatchObject({ requests: 1, approxCredits: 10, byApi: { das: 1 }, caches: expect.any(Object) });
  });

  test("ADMIN_TOKEN 未設定: dev / test は開放、production は閉じる", async () => {
    await make(null, "development");
    expect((await app.inject({ method: "GET", url: HELIUS_USAGE_PATH })).statusCode).toBe(200);
    await app.close();
    await make(null, "production");
    const res = await app.inject({ method: "GET", url: HELIUS_USAGE_PATH });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "admin_token_required" });
  });
});

describe("buildServer に登録されている", () => {
  const saved = process.env.ADMIN_TOKEN;
  afterEach(() => {
    if (saved === undefined) delete process.env.ADMIN_TOKEN;
    else process.env.ADMIN_TOKEN = saved;
  });

  test("ADMIN_TOKEN (env) で gate される", async () => {
    process.env.ADMIN_TOKEN = TOKEN;
    const app = await buildServer({ logger: false, rateLimit: false });
    try {
      expect((await app.inject({ method: "GET", url: HELIUS_USAGE_PATH })).statusCode).toBe(403);
      const ok = await app.inject({ method: "GET", url: HELIUS_USAGE_PATH, headers: { "x-seasonals-admin-token": TOKEN } });
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toHaveProperty("approxCredits");
    } finally {
      await app.close();
    }
  });
});
