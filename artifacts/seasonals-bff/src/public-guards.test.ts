/**
 * 公開 BFF の入口 guard (docs/external-release-api-handling.md §3.3)。
 *
 * - unit: isWalletAddress / rateLimitKey / isAdminAuthorized
 * - server (buildServer + inject): rate limit、CORS allowlist、wallet 検証、
 *   plans-only (SOLANA_EXECUTION_TARGET=disabled) の 409、管理 route の 403、push の 503
 *
 * env は beforeEach で退避 / afterEach で復元 (tx-status.test.ts と同じ形)。
 * 鍵はすべて明らかな fake 値。
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { ApprovalMode, Objective } from "@workspace/lib/types";

import { buildServer } from "./server";
import {
  EXECUTION_DISABLED,
  isAdminAuthorized,
  isWalletAddress,
  rateLimitKey,
} from "./public-guards";
import { _resetAutonomousForTest } from "./autonomous";
import { _resetPolicyForTest } from "./policy-store";
import {
  MAX_PUSH_TOKENS,
  _clearPlanStoreForTest,
  listPushTokens,
  registerPushToken,
} from "./plan-store";

const ENV_KEYS = [
  "SOLANA_EXECUTION_TARGET",
  "CORS_ALLOWED_ORIGINS",
  "RATE_LIMIT_MAX",
  "ADMIN_TOKEN",
  "BFF_PROXY_SECRET",
  "EXPO_PUSH_ENABLED",
  "GIT_SHA",
  "NODE_ENV",
  "FEATURE_APPROVAL_MODE_AUTO",
  "HELIUS_API_KEY",
] as const;
let savedEnv: Record<string, string | undefined>;

/** base58 32..44 文字の有効な形 (実在 wallet ではない) */
const VALID_WALLET = "WaLLet1111111111111111111111111111111111111";
/** 長さは 44 だが base58 に無い 0 / O / I / l を含む */
const NON_BASE58_44 = `0OIl${"1".repeat(40)}`;
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const FAKE_ADMIN = "fake-admin-token-for-tests";
const FAKE_PROXY = "fake-proxy-secret-for-tests";

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) {
    if (k !== "NODE_ENV") delete process.env[k];
  }
  _resetAutonomousForTest();
  _resetPolicyForTest();
  _clearPlanStoreForTest();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  jest.restoreAllMocks();
  _resetAutonomousForTest();
  _resetPolicyForTest();
  _clearPlanStoreForTest();
});

function fakeReq(headers: Record<string, string | string[] | undefined>, ip = "10.0.0.9") {
  return { headers, ip } as unknown as FastifyRequest;
}

// ─────────────────────────────────────────────────────────────────────────────
// unit
// ─────────────────────────────────────────────────────────────────────────────

describe("isWalletAddress", () => {
  it("base58 32..44 文字だけ通す (前後空白は許容)", () => {
    expect(isWalletAddress(VALID_WALLET)).toBe(true);
    expect(isWalletAddress(` ${VALID_WALLET} `)).toBe(true);
    expect(isWalletAddress(USDC)).toBe(true);
    expect(isWalletAddress(NON_BASE58_44)).toBe(false);
    expect(isWalletAddress("short")).toBe(false);
    expect(isWalletAddress("1".repeat(45))).toBe(false);
    expect(isWalletAddress(`${VALID_WALLET.slice(0, 20)} ${VALID_WALLET.slice(21)}`)).toBe(false);
    expect(isWalletAddress(undefined)).toBe(false);
    expect(isWalletAddress(123)).toBe(false);
  });
});

describe("rateLimitKey", () => {
  it("proxy 鍵が一致し client ip がある時だけ x-seasonals-client-ip を使う", () => {
    const req = fakeReq({
      "x-seasonals-proxy-key": FAKE_PROXY,
      "x-seasonals-client-ip": "203.0.113.7",
      "fly-client-ip": "198.51.100.1",
    });
    expect(rateLimitKey(req, FAKE_PROXY)).toBe("203.0.113.7");
  });

  it("鍵が違う / 未設定 / client ip が空なら fly-client-ip に落ちる", () => {
    const spoofed = fakeReq({
      "x-seasonals-proxy-key": "wrong-key",
      "x-seasonals-client-ip": "203.0.113.7",
      "fly-client-ip": "198.51.100.1",
    });
    expect(rateLimitKey(spoofed, FAKE_PROXY)).toBe("198.51.100.1");
    // BFF 側に secret が無ければ proxy header は一切信じない
    expect(
      rateLimitKey(
        fakeReq({ "x-seasonals-proxy-key": FAKE_PROXY, "x-seasonals-client-ip": "203.0.113.7", "fly-client-ip": "198.51.100.1" }),
        null
      )
    ).toBe("198.51.100.1");
    expect(
      rateLimitKey(
        fakeReq({ "x-seasonals-proxy-key": FAKE_PROXY, "x-seasonals-client-ip": "", "fly-client-ip": "198.51.100.1" }),
        FAKE_PROXY
      )
    ).toBe("198.51.100.1");
  });

  it("どちらも無ければ socket の req.ip (x-forwarded-for は読まない)", () => {
    expect(rateLimitKey(fakeReq({ "x-forwarded-for": "203.0.113.99" }, "10.0.0.9"), FAKE_PROXY)).toBe("10.0.0.9");
  });
});

describe("isAdminAuthorized", () => {
  it("token 未設定: dev / test は開放、production は閉じる (fail-closed)", () => {
    expect(isAdminAuthorized(fakeReq({}), null, { NODE_ENV: "development" } as NodeJS.ProcessEnv)).toBe(true);
    expect(isAdminAuthorized(fakeReq({}), null, { NODE_ENV: "production" } as NodeJS.ProcessEnv)).toBe(false);
  });

  it("token 設定時は x-seasonals-admin-token の完全一致だけ", () => {
    expect(isAdminAuthorized(fakeReq({ "x-seasonals-admin-token": FAKE_ADMIN }), FAKE_ADMIN)).toBe(true);
    expect(isAdminAuthorized(fakeReq({}), FAKE_ADMIN)).toBe(false);
    // 同じ長さで違う値 / 長さ違い / 配列
    const sameLength = "x".repeat(FAKE_ADMIN.length);
    expect(isAdminAuthorized(fakeReq({ "x-seasonals-admin-token": sameLength }), FAKE_ADMIN)).toBe(false);
    expect(isAdminAuthorized(fakeReq({ "x-seasonals-admin-token": `${FAKE_ADMIN}x` }), FAKE_ADMIN)).toBe(false);
    expect(isAdminAuthorized(fakeReq({ "x-seasonals-admin-token": [FAKE_ADMIN] }), FAKE_ADMIN)).toBe(false);
  });
});

describe("registerPushToken の上限", () => {
  it(`${MAX_PUSH_TOKENS} 件を超えたら最古から捨てる`, () => {
    for (let i = 0; i < MAX_PUSH_TOKENS + 5; i++) registerPushToken(`ExponentPushToken[fake-${i}]`);
    const tokens = listPushTokens();
    expect(tokens).toHaveLength(MAX_PUSH_TOKENS);
    expect(tokens).not.toContain("ExponentPushToken[fake-0]");
    expect(tokens).not.toContain("ExponentPushToken[fake-4]");
    expect(tokens[0]).toBe("ExponentPushToken[fake-5]");
  });

  it("再登録は最新に付け直す (古い順の掃除で消えない)", () => {
    registerPushToken("ExponentPushToken[keep]");
    for (let i = 0; i < MAX_PUSH_TOKENS - 1; i++) registerPushToken(`ExponentPushToken[fake-${i}]`);
    registerPushToken("ExponentPushToken[keep]");
    registerPushToken("ExponentPushToken[one-more]");
    expect(listPushTokens()).toContain("ExponentPushToken[keep]");
    expect(listPushTokens()).not.toContain("ExponentPushToken[fake-0]");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// server
// ─────────────────────────────────────────────────────────────────────────────

describe("server: rate limit", () => {
  let app: FastifyInstance;
  afterEach(async () => {
    await app.close();
  });

  it("global 上限を超えると 429 rate_limited、/health は対象外", async () => {
    app = await buildServer({ logger: false, rateLimit: { max: 2, timeWindowMs: 60_000 } });
    const codes: number[] = [];
    for (let i = 0; i < 3; i++) codes.push((await app.inject({ method: "GET", url: "/protocols" })).statusCode);
    expect(codes).toEqual([200, 200, 429]);
    const limited = await app.inject({ method: "GET", url: "/protocols" });
    expect(limited.json()).toMatchObject({ statusCode: 429, error: "rate_limited" });
    expect(limited.headers["retry-after"]).toBeDefined();

    for (let i = 0; i < 5; i++) {
      expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    }
  });

  it("POST /tx/submit は route 別に 10 回 / 分", async () => {
    app = await buildServer({ logger: false, rateLimit: { max: 1000, timeWindowMs: 60_000 } });
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) {
      codes.push((await app.inject({ method: "POST", url: "/tx/submit", payload: {} })).statusCode);
    }
    // body 不正の 400 も 1 回に数える (上流に届く前の段階で絞る)
    expect(codes.slice(0, 10)).toEqual(Array(10).fill(400));
    expect(codes[10]).toBe(429);
  });

  it("proxy 鍵が一致すれば client ip ごとに数え、偽の鍵は 1 つの bucket に潰れる", async () => {
    process.env.BFF_PROXY_SECRET = FAKE_PROXY;
    app = await buildServer({ logger: false, rateLimit: { max: 1, timeWindowMs: 60_000 } });
    const viaProxy = (ip: string, key = FAKE_PROXY) =>
      app.inject({
        method: "GET",
        url: "/protocols",
        headers: { "x-seasonals-proxy-key": key, "x-seasonals-client-ip": ip },
      });
    expect((await viaProxy("203.0.113.1")).statusCode).toBe(200);
    expect((await viaProxy("203.0.113.2")).statusCode).toBe(200);
    expect((await viaProxy("203.0.113.1")).statusCode).toBe(429);
    // 鍵が違えば client ip header は無視 → socket ip (127.0.0.1) の bucket
    expect((await viaProxy("198.51.100.1", "wrong-key")).statusCode).toBe(200);
    expect((await viaProxy("198.51.100.2", "wrong-key")).statusCode).toBe(429);
  });

  it("rateLimit: false では plugin を登録せず、route 別 config も害にならない", async () => {
    app = await buildServer({ logger: false, rateLimit: false });
    for (let i = 0; i < 12; i++) {
      expect((await app.inject({ method: "GET", url: "/protocols" })).statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: "/positions" })).statusCode).toBe(200);
      expect((await app.inject({ method: "POST", url: "/tx/submit", payload: {} })).statusCode).toBe(400);
    }
  });
});

describe("server: CORS allowlist", () => {
  let app: FastifyInstance;
  afterEach(async () => {
    await app.close();
  });

  it("許可 origin だけ echo し、Origin 無し (mobile) は従来どおり 200", async () => {
    process.env.CORS_ALLOWED_ORIGINS = "https://seasonals.cafe";
    app = await buildServer({ logger: false });
    const ok = await app.inject({ method: "GET", url: "/protocols", headers: { origin: "https://seasonals.cafe" } });
    expect(ok.headers["access-control-allow-origin"]).toBe("https://seasonals.cafe");

    const evil = await app.inject({ method: "GET", url: "/protocols", headers: { origin: "https://evil.example" } });
    expect(evil.headers["access-control-allow-origin"]).toBeUndefined();

    const noOrigin = await app.inject({ method: "GET", url: "/protocols" });
    expect(noOrigin.statusCode).toBe(200);
  });

  it("未設定なら any origin (dev)", async () => {
    app = await buildServer({ logger: false });
    const res = await app.inject({ method: "GET", url: "/protocols", headers: { origin: "http://192.168.0.5:8081" } });
    expect(res.headers["access-control-allow-origin"]).toBe("http://192.168.0.5:8081");
  });
});

describe("server: wallet 検証 (不正値で上流 credit を使わない)", () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    app = await buildServer({ logger: false, rateLimit: false });
  });
  afterEach(async () => {
    await app.close();
  });

  it("/positions は長さが合っても base58 でなければ 400", async () => {
    process.env.HELIUS_API_KEY = "fake-helius-key";
    const fetchSpy = jest.spyOn(global, "fetch");
    const res = await app.inject({ method: "GET", url: `/positions?wallet=${NON_BASE58_44}` });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "invalid_wallet_address", wallet: NON_BASE58_44 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("/portfolio/history?wallet=bad は 400 invalid_wallet_address", async () => {
    const res = await app.inject({ method: "GET", url: "/portfolio/history?wallet=bad" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "invalid_wallet_address", wallet: "bad" });
  });

  it("/agent-plans?wallet=bad は 400、wallet 無しは従来どおり 200", async () => {
    const bad = await app.inject({ method: "GET", url: "/agent-plans?wallet=bad" });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ error: "invalid_wallet_address" });
    expect((await app.inject({ method: "GET", url: "/agent-plans" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `/agent-plans?wallet=${VALID_WALLET}` })).statusCode).toBe(200);
  });

  it("*-tx builder の不正 user は 400 で、上流を叩かない", async () => {
    const fetchSpy = jest.spyOn(global, "fetch");
    const res = await app.inject({
      method: "POST",
      url: "/protocols/jupiter-lend/deposit-tx",
      payload: { user: NON_BASE58_44, inputMint: USDC, amount: "1000000" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "invalid_wallet_address", user: NON_BASE58_44 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("server: plans-only (SOLANA_EXECUTION_TARGET=disabled)", () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    process.env.SOLANA_EXECUTION_TARGET = "disabled";
    process.env.HELIUS_API_KEY = "fake-helius-key";
    app = await buildServer({ logger: false, rateLimit: false });
  });
  afterEach(async () => {
    await app.close();
  });

  it("POST /tx/submit は 409 (Helius に届かない)", async () => {
    const fetchSpy = jest.spyOn(global, "fetch");
    const res = await app.inject({ method: "POST", url: "/tx/submit", payload: { signedTx: "AQID" } });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      error: "action_not_available",
      message: "Execution is disabled: this server is configured for plans only.",
    });
    expect(res.json()).toEqual(EXECUTION_DISABLED);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("tx builder と plan execute も 409 (Seed Vault を開く前に断る)", async () => {
    const fetchSpy = jest.spyOn(global, "fetch");
    const builder = await app.inject({
      method: "POST",
      url: "/protocols/jupiter-lend/withdraw-tx",
      payload: { user: VALID_WALLET, jlMint: USDC, amount: "1" },
    });
    expect(builder.statusCode).toBe(409);
    expect(builder.json()).toEqual(EXECUTION_DISABLED);

    const kaminoVault = await app.inject({
      method: "POST",
      url: "/protocols/kamino/vault-deposit-tx",
      payload: {},
    });
    expect(kaminoVault.statusCode).toBe(409);

    const execute = await app.inject({
      method: "POST",
      url: "/agent-plans/x/execute",
      payload: { approval_token: "tok_x" },
    });
    expect(execute.statusCode).toBe(409);
    expect(execute.json()).toEqual(EXECUTION_DISABLED);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("plan の作成 / 読み取りは通る", async () => {
    const created = await app.inject({ method: "POST", url: "/agent-plans", payload: { objective: Objective.MaxYield } });
    expect(created.statusCode).toBe(201);
    expect((await app.inject({ method: "GET", url: "/agent-plans" })).statusCode).toBe(200);
  });

  it("/health が executionTarget=disabled を出す", async () => {
    const body = (await app.inject({ method: "GET", url: "/health" })).json();
    expect(body.solana).toEqual({ heliusConfigured: true, executionTarget: "disabled" });
  });

  it("/autonomous/tick は dry_run=true 以外を 409", async () => {
    const live = await app.inject({
      method: "POST",
      url: "/autonomous/tick",
      payload: { objective: Objective.SafetyFirst },
    });
    expect(live.statusCode).toBe(409);
    expect(live.json()).toEqual(EXECUTION_DISABLED);

    const dry = await app.inject({
      method: "POST",
      url: "/autonomous/tick",
      payload: { objective: Objective.SafetyFirst, dry_run: true },
    });
    expect(dry.statusCode).not.toBe(409);
    // feature flag off なので従来どおり 403
    expect(dry.json()).toMatchObject({ error: "autonomous_disabled", reason: "feature_flag_off" });
  });

  it("garbage 値も disabled 扱い (fail-closed)", async () => {
    process.env.SOLANA_EXECUTION_TARGET = "mainet";
    const res = await app.inject({ method: "POST", url: "/tx/submit", payload: { signedTx: "AQID" } });
    expect(res.statusCode).toBe(409);
  });
});

describe("server: 管理 route", () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    app = await buildServer({ logger: false, rateLimit: false });
  });
  afterEach(async () => {
    await app.close();
  });

  it.each(["/autonomous/kill", "/autonomous/resume"])(
    "%s: feature flag off は 403 feature_flag_off",
    async (url) => {
      const res = await app.inject({ method: "POST", url });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: "autonomous_disabled", reason: "feature_flag_off" });
    }
  );

  it.each(["/autonomous/kill", "/autonomous/resume"])(
    "%s: flag on + ADMIN_TOKEN 設定時は header 必須",
    async (url) => {
      process.env.FEATURE_APPROVAL_MODE_AUTO = "true";
      process.env.ADMIN_TOKEN = FAKE_ADMIN;
      const denied = await app.inject({ method: "POST", url });
      expect(denied.statusCode).toBe(403);
      expect(denied.json()).toEqual({ error: "admin_token_required" });

      const wrong = await app.inject({ method: "POST", url, headers: { "x-seasonals-admin-token": "nope" } });
      expect(wrong.statusCode).toBe(403);

      const ok = await app.inject({ method: "POST", url, headers: { "x-seasonals-admin-token": FAKE_ADMIN } });
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toHaveProperty("killed", url === "/autonomous/kill");
    }
  );

  it("PATCH /user-policy: ADMIN_TOKEN 設定時は header 必須", async () => {
    process.env.ADMIN_TOKEN = FAKE_ADMIN;
    const denied = await app.inject({
      method: "PATCH",
      url: "/user-policy",
      payload: { approval_mode: ApprovalMode.ManualOnly },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toEqual({ error: "admin_token_required" });

    const ok = await app.inject({
      method: "PATCH",
      url: "/user-policy",
      headers: { "x-seasonals-admin-token": FAKE_ADMIN },
      payload: { approval_mode: ApprovalMode.ManualOnly },
    });
    expect(ok.statusCode).toBe(200);
  });

  it("PATCH /user-policy: production で ADMIN_TOKEN 未設定なら閉じる", async () => {
    process.env.NODE_ENV = "production";
    const res = await app.inject({
      method: "PATCH",
      url: "/user-policy",
      payload: { approval_mode: ApprovalMode.ManualOnly },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "admin_token_required" });
  });

  it("GET /autonomous/status は従来どおり開いている", async () => {
    process.env.ADMIN_TOKEN = FAKE_ADMIN;
    expect((await app.inject({ method: "GET", url: "/autonomous/status" })).statusCode).toBe(200);
  });
});

describe("server: push / health", () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    app = await buildServer({ logger: false, rateLimit: false });
  });
  afterEach(async () => {
    await app.close();
  });

  it("POST /push-tokens は EXPO_PUSH_ENABLED 無しで 503 push_not_configured", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/push-tokens",
      payload: { token: "ExponentPushToken[fake]" },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: "push_not_configured" });
    expect(listPushTokens()).toEqual([]);
  });

  it("/health.version は GIT_SHA、未設定は null", async () => {
    expect((await app.inject({ method: "GET", url: "/health" })).json().version).toBeNull();
    process.env.GIT_SHA = "abc1234";
    expect((await app.inject({ method: "GET", url: "/health" })).json().version).toBe("abc1234");
  });
});
