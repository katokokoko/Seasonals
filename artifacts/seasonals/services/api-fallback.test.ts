/**
 * api — dev fallback の失敗時挙動 (Phase 8.93)。
 *
 * tryHttpThenFixture は IS_TEST_ENV で fixture に短絡するため、通常の jest では
 * fallback 分岐に到達できない。ここでは ./config を mock して「実機 dev
 * (IS_TEST_ENV=false, SHOULD_FALLBACK_TO_FIXTURES=true)」を再現し、
 * fetch 失敗時に:
 *   - positions / earn / prices / history / jupiter markets は **reject** する
 *     (空の「成功」で TanStack Query の正常キャッシュを上書きしない — E.3.5)
 *   - menu listings 等の実 fixture 組は従来どおり fixture を resolve する
 * ことを固定する。
 */
jest.mock("./config", () => ({
  BFF_BASE_URL: "http://localhost:3030",
  IS_TEST_ENV: false,
  SHOULD_FALLBACK_TO_FIXTURES: true,
  USE_ONCHAIN: true,
}));

import * as api from "./api";
import { useDevFallbackLog } from "../stores/devFallbackLog";

const WALLET = "6QGJNXnCjhYkKgPpDm7qRzxBKCj9KugUL2LDHc8sGUUM";

beforeEach(() => {
  useDevFallbackLog.getState().clear();
  jest
    .spyOn(global, "fetch")
    .mockRejectedValue(new Error("connect ECONNREFUSED"));
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("tryHttpThenFixture onFail=throw (Phase 8.93)", () => {
  it("getPositions は fetch 失敗を reject する (空 [] で resolve しない)", async () => {
    await expect(api.getPositions(WALLET)).rejects.toThrow("ECONNREFUSED");
  });

  it("getEarnPositions / getPrices / getPortfolioHistory / getJupiterLendMarkets も reject", async () => {
    await expect(api.getEarnPositions(WALLET)).rejects.toThrow();
    await expect(api.getPrices(["SOL", "USDC"])).rejects.toThrow();
    await expect(api.getPortfolioHistory(WALLET, 30)).rejects.toThrow();
    await expect(api.getJupiterLendMarkets()).rejects.toThrow();
  });

  it("reject でも devFallbackLog には記録される (可観測性は維持)", async () => {
    await expect(api.getPositions(WALLET)).rejects.toThrow();
    const last = useDevFallbackLog.getState().last;
    expect(last?.route).toContain("/positions");
    expect(last?.message).toContain("ECONNREFUSED");
  });

  it("fixture 組 (menu listings) は従来どおり fixture を resolve する", async () => {
    const menu = await api.getMenuListings();
    expect(menu.length).toBeGreaterThan(0);
  });

  it("HTTP が生きていれば通常どおり実データを返す", async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => [],
    });
    await expect(api.getPositions(WALLET)).resolves.toEqual([]);
  });
});
