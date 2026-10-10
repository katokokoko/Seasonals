/**
 * services/config — build-time extra の解決テスト
 *
 * 配布 APK (eas.json `preview-onchain` / `production-onchain`) は Gradle build 中に
 * expo-constants が app.config.ts の `extra` を焼き込む。ここでは `extra` の有無ごとに
 * module を読み直し、BFF URL / fixture fallback / variant / version の解決を固定する
 * (docs/external-release-api-handling.md §7)。
 *
 * config.ts は module 評価時に値を確定するため、`jest.isolateModules` + `jest.doMock`
 * で expo-constants を差し替えてから require する。
 */

type ConfigModule = typeof import("./config");

interface ExpoConfigStub {
  version?: string;
  extra?: Record<string, unknown>;
}

function loadConfig(expoConfig: ExpoConfigStub | null): ConfigModule {
  let mod: ConfigModule | undefined;
  jest.isolateModules(() => {
    jest.doMock("expo-constants", () => ({
      __esModule: true,
      default: { expoConfig },
    }));
    mod = require("./config") as ConfigModule;
  });
  if (!mod) throw new Error("config module failed to load");
  return mod;
}

afterEach(() => {
  jest.dontMock("expo-constants");
});

describe("BFF_BASE_URL / SHOULD_FALLBACK_TO_FIXTURES", () => {
  it("配布 profile の extra.bffBaseUrl (公開 BFF) をそのまま使い、fixture に逃げない", () => {
    const cfg = loadConfig({
      version: "0.0.1",
      extra: { bffBaseUrl: "https://api.seasonals.cafe" },
    });
    expect(cfg.BFF_BASE_URL).toBe("https://api.seasonals.cafe");
    expect(cfg.SHOULD_FALLBACK_TO_FIXTURES).toBe(false);
  });

  it("extra が無ければ dev 既定の localhost:3030 + fixture fallback", () => {
    const cfg = loadConfig({ version: "0.0.1" });
    expect(cfg.BFF_BASE_URL).toBe("http://localhost:3030");
    expect(cfg.SHOULD_FALLBACK_TO_FIXTURES).toBe(true);
  });

  it("emulator の host alias (10.0.2.2) も localhost 扱いで fallback する", () => {
    const cfg = loadConfig({
      version: "0.0.1",
      extra: { bffBaseUrl: "http://10.0.2.2:3030" },
    });
    expect(cfg.BFF_BASE_URL).toBe("http://10.0.2.2:3030");
    expect(cfg.SHOULD_FALLBACK_TO_FIXTURES).toBe(true);
  });

  it("空文字の bffBaseUrl は未指定と同じく既定に戻す", () => {
    const cfg = loadConfig({ version: "0.0.1", extra: { bffBaseUrl: "" } });
    expect(cfg.BFF_BASE_URL).toBe("http://localhost:3030");
    expect(cfg.SHOULD_FALLBACK_TO_FIXTURES).toBe(true);
  });
});

describe("USE_ONCHAIN", () => {
  it("extra.useOnchain: true (APP_VARIANT=onchain) で true", () => {
    const cfg = loadConfig({ version: "0.0.1", extra: { useOnchain: true } });
    expect(cfg.USE_ONCHAIN).toBe(true);
  });

  it("extra が無ければ false", () => {
    const cfg = loadConfig({ version: "0.0.1" });
    expect(cfg.USE_ONCHAIN).toBe(false);
  });
});

describe("APP_VERSION", () => {
  it("expoConfig.version をそのまま返す", () => {
    const cfg = loadConfig({ version: "0.0.1" });
    expect(cfg.APP_VERSION).toBe("0.0.1");
  });

  it("expoConfig が無ければ 0.0.0", () => {
    const cfg = loadConfig(null);
    expect(cfg.APP_VERSION).toBe("0.0.0");
  });
});

describe("公開 URL", () => {
  it("privacy policy は公開 site の /privacy", () => {
    const cfg = loadConfig({ version: "0.0.1" });
    expect(cfg.PUBLIC_SITE_URL).toBe("https://seasonals.cafe");
    expect(cfg.PRIVACY_POLICY_URL).toBe("https://seasonals.cafe/privacy");
    expect(cfg.PRIVACY_POLICY_URL.endsWith("/privacy")).toBe(true);
  });

  it("source は GitHub repository", () => {
    const cfg = loadConfig({ version: "0.0.1" });
    expect(cfg.SOURCE_REPO_URL).toBe("https://github.com/katokokoko/Seasonals");
  });
});
