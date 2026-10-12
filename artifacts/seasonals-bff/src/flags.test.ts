/**
 * flags — 公開 BFF の env 解釈 (docs/external-release-api-handling.md §3.3 / §3.4)。
 * すべて env object を直接渡すので process.env は触らない。
 */
import {
  adminToken,
  assertProductionEnvSafe,
  corsOrigins,
  gitSha,
  proxySecret,
  pushEnabled,
  rateLimitConfig,
  solanaExecutionTarget,
} from "./flags";

const env = (vars: Record<string, string | undefined>): NodeJS.ProcessEnv =>
  vars as NodeJS.ProcessEnv;

describe("solanaExecutionTarget (fail-closed)", () => {
  it("未設定 / 空 / mainnet は mainnet", () => {
    expect(solanaExecutionTarget(env({}))).toBe("mainnet");
    expect(solanaExecutionTarget(env({ SOLANA_EXECUTION_TARGET: "" }))).toBe("mainnet");
    expect(solanaExecutionTarget(env({ SOLANA_EXECUTION_TARGET: "  " }))).toBe("mainnet");
    expect(solanaExecutionTarget(env({ SOLANA_EXECUTION_TARGET: "mainnet" }))).toBe("mainnet");
  });

  it("disabled は disabled", () => {
    expect(solanaExecutionTarget(env({ SOLANA_EXECUTION_TARGET: "disabled" }))).toBe("disabled");
  });

  it.each(["mainet", "MAINNET", "devnet", "true", "off"])(
    "知らない値 %s は disabled (typo で実行が開かない)",
    (v) => {
      expect(solanaExecutionTarget(env({ SOLANA_EXECUTION_TARGET: v }))).toBe("disabled");
    }
  );
});

describe("corsOrigins", () => {
  it("未設定は true (any origin、従来どおり)", () => {
    expect(corsOrigins(env({}))).toBe(true);
  });

  it("カンマ区切りを trim し、空要素を落とす", () => {
    expect(
      corsOrigins(env({ CORS_ALLOWED_ORIGINS: " https://seasonals.cafe ,, http://localhost:5173 ," }))
    ).toEqual(["https://seasonals.cafe", "http://localhost:5173"]);
  });

  it("空文字 (要素ゼロ) は未設定扱いで true", () => {
    expect(corsOrigins(env({ CORS_ALLOWED_ORIGINS: " , " }))).toBe(true);
  });
});

describe("rateLimitConfig", () => {
  it("既定は 300 / 60 秒", () => {
    expect(rateLimitConfig(env({}))).toEqual({ max: 300, timeWindowMs: 60_000 });
  });

  it("RATE_LIMIT_MAX で上書き", () => {
    expect(rateLimitConfig(env({ RATE_LIMIT_MAX: "50" }))).toEqual({ max: 50, timeWindowMs: 60_000 });
  });

  it("0 / 負は null (無効)", () => {
    expect(rateLimitConfig(env({ RATE_LIMIT_MAX: "0" }))).toBeNull();
    expect(rateLimitConfig(env({ RATE_LIMIT_MAX: "-1" }))).toBeNull();
  });

  it("読めない値は既定 300 (limit を外す方向に倒さない)", () => {
    expect(rateLimitConfig(env({ RATE_LIMIT_MAX: "lots" }))?.max).toBe(300);
  });
});

describe("string flags", () => {
  it("adminToken / proxySecret / gitSha は trim、空は null", () => {
    expect(adminToken(env({ ADMIN_TOKEN: "  fake-admin  " }))).toBe("fake-admin");
    expect(adminToken(env({ ADMIN_TOKEN: "   " }))).toBeNull();
    expect(adminToken(env({}))).toBeNull();
    expect(proxySecret(env({ BFF_PROXY_SECRET: "fake-proxy" }))).toBe("fake-proxy");
    expect(proxySecret(env({}))).toBeNull();
    expect(gitSha(env({ GIT_SHA: "abc1234\n" }))).toBe("abc1234");
    expect(gitSha(env({}))).toBeNull();
  });

  it("pushEnabled は厳密に \"true\" の時だけ", () => {
    expect(pushEnabled(env({ EXPO_PUSH_ENABLED: "true" }))).toBe(true);
    expect(pushEnabled(env({ EXPO_PUSH_ENABLED: "1" }))).toBe(false);
    expect(pushEnabled(env({ EXPO_PUSH_ENABLED: "yes" }))).toBe(false);
    expect(pushEnabled(env({}))).toBe(false);
  });
});

describe("assertProductionEnvSafe", () => {
  const SECRET_VALUE = "fake-delegate-secret-do-not-log";
  const dangerous = {
    AUTONOMOUS_DELEGATE_SECRET: SECRET_VALUE,
    FEATURE_APPROVAL_MODE_AUTO: "true",
    AUTONOMOUS_LOOP_MS: "60000",
  };

  it("production 以外では何もしない (dev / test の自律デモを壊さない)", () => {
    expect(() => assertProductionEnvSafe(env({ ...dangerous }))).not.toThrow();
    expect(() => assertProductionEnvSafe(env({ ...dangerous, NODE_ENV: "development" }))).not.toThrow();
    expect(() => assertProductionEnvSafe(env({ ...dangerous, NODE_ENV: "test" }))).not.toThrow();
  });

  it("production で危険な env が無ければ通す", () => {
    expect(() =>
      assertProductionEnvSafe(
        env({
          NODE_ENV: "production",
          FEATURE_APPROVAL_MODE_AUTO: "false",
          AUTONOMOUS_LOOP_MS: "0",
          AUTONOMOUS_DELEGATE_SECRET: "",
        })
      )
    ).not.toThrow();
  });

  it.each([
    ["AUTONOMOUS_DELEGATE_SECRET", { AUTONOMOUS_DELEGATE_SECRET: SECRET_VALUE }],
    ["FEATURE_APPROVAL_MODE_AUTO", { FEATURE_APPROVAL_MODE_AUTO: "true" }],
    ["AUTONOMOUS_LOOP_MS", { AUTONOMOUS_LOOP_MS: "1000" }],
    ["AUTONOMOUS_LOOP_MS", { AUTONOMOUS_LOOP_MS: "soon" }],
  ])("production で %s を拒否する", (name, vars) => {
    expect(() => assertProductionEnvSafe(env({ NODE_ENV: "production", ...vars }))).toThrow(name);
  });

  it("全部の変数名を並べ、値は message に含めない", () => {
    let message = "";
    try {
      assertProductionEnvSafe(env({ NODE_ENV: "production", ...dangerous }));
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("AUTONOMOUS_DELEGATE_SECRET");
    expect(message).toContain("FEATURE_APPROVAL_MODE_AUTO");
    expect(message).toContain("AUTONOMOUS_LOOP_MS");
    expect(message).not.toContain(SECRET_VALUE);
    expect(message).not.toContain("60000");
  });
});
