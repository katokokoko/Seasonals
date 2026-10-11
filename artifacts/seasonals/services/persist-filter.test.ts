/**
 * persist-filter — AsyncStorage 永続化の対象 (API 効率化計画 §4.0)
 *
 * 載せる: wallet 系 4 種 (recentWallets の wallet だけ) + menu-listings、success のみ。
 * 載せない: SKR (鮮度規則が古い値の提供を禁じる) / oracle / quote / prices / plan 系。
 */
import { shouldPersistQuery } from "./persist-filter";

const A = "7nZbHkQqXkr3eW8s2dKvHqBxNz9vC5jPpL2tF6mYrXaA";
const B = "6QGJNXnCjhYkKgPpDm7qRzxBKCj9KugUL2LDHc8sGUUM";

const ok = (queryKey: unknown[]) => ({ queryKey, state: { status: "success" } });

describe("shouldPersistQuery", () => {
  it("recentWallets にある wallet の wallet 系 4 種を載せる", () => {
    for (const key of [
      ["positions", A],
      ["earn-positions", A],
      ["wallet-time-events", A],
      ["portfolio-history", A, 30],
    ]) {
      expect(shouldPersistQuery(ok(key), [A])).toBe(true);
    }
  });

  it("recentWallets に無い wallet の key は載せない (MRU から外れた wallet を端末に残さない)", () => {
    expect(shouldPersistQuery(ok(["positions", B]), [A])).toBe(false);
    expect(shouldPersistQuery(ok(["portfolio-history", B, 30]), [A])).toBe(false);
  });

  it("walletStore の復元前 (null) は wallet 系 key を残す (復元前の書き込みで永続 cache を消さない)", () => {
    expect(shouldPersistQuery(ok(["positions", B]), null)).toBe(true);
  });

  it("menu-listings は載せる", () => {
    expect(shouldPersistQuery(ok(["menu-listings"]), [])).toBe(true);
  });

  it("success 以外は載せない", () => {
    expect(
      shouldPersistQuery({ queryKey: ["positions", A], state: { status: "error" } }, [A])
    ).toBe(false);
    expect(
      shouldPersistQuery({ queryKey: ["menu-listings"], state: { status: "pending" } }, [A])
    ).toBe(false);
  });

  it("SKR / oracle / quote / prices / plan 系 / fixture positions は載せない", () => {
    for (const key of [
      ["skr-staking", "live", "mainnet-beta", A],
      ["oracle-status", "mint"],
      ["jupiter-quote", "a", "b", "1", 50],
      ["prices", "JLP,SOL,USDC,USDT"],
      ["agent-plan", "plan_1"],
      ["agent-plans"],
      ["approval-token", "t"],
      ["user-policy"],
      ["autonomous-status"],
      ["positions"],
      ["earn-positions", "disabled"],
    ]) {
      expect(shouldPersistQuery(ok(key), [A])).toBe(false);
    }
  });
});
