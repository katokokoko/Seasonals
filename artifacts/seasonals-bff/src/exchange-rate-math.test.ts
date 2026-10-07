/**
 * exchange-rate-math — kVault tokensPerShare / Save cTokenExchangeRate の bigint 換算 (§4.5)。
 * positions 表示 (kamino.test.ts / earnings.test.ts が値を固定) と simulate 見積りが共有する式。
 */
import {
  EXCHANGE_RATE_SCALE,
  kvaultSharesToUnderlying,
  kvaultUnderlyingToShares,
  saveCTokenToUnderlying,
  saveUnderlyingToCToken,
  truncateDecimal,
} from "./exchange-rate-math";
import { truncateDecimal as fromServer } from "./server";

describe("truncateDecimal", () => {
  it("指定桁で切り捨て、整数はそのまま、不正 shape は '0'", () => {
    expect(truncateDecimal("1.23456789", 4)).toBe("1.2345");
    expect(truncateDecimal("42", 6)).toBe("42");
    expect(truncateDecimal("1.5", 0)).toBe("1");
    expect(truncateDecimal("-1.5", 2)).toBe("0");
    expect(truncateDecimal("1e-7", 8)).toBe("0");
    expect(truncateDecimal("", 2)).toBe("0");
  });
  it("server.ts からの re-export は同じ関数 (既存 test の import 経路)", () => {
    expect(fromServer).toBe(truncateDecimal);
  });
});

describe("kVault shares ⇄ underlying", () => {
  it("2 shares (6 dec) × 1.25 SOL/share = 2.5 SOL (9 dec)、逆も一致", () => {
    expect(kvaultSharesToUnderlying("2000000", "1.25", 6, 9)).toBe("2500000000");
    expect(kvaultUnderlyingToShares("2500000000", "1.25", 6, 9)).toBe("2000000");
  });
  it("切り捨て (受け取りを多く見積もらない)", () => {
    // 1 USDC / 3 USDC per share = 0.333333 shares (6 dec、端数切り捨て)
    expect(kvaultUnderlyingToShares("1000000", "3", 6, 6)).toBe("333333");
    expect(kvaultSharesToUnderlying("333333", "3", 6, 6)).toBe("999999");
    expect(kvaultUnderlyingToShares("1", "3", 6, 6)).toBe("0");
  });
  it(`rate は ${EXCHANGE_RATE_SCALE} 桁で切り捨てる`, () => {
    // 13 桁目 (9) は捨てられる
    expect(kvaultSharesToUnderlying("1000000000000", "1.0000000000019", 12, 12)).toBe("1000000000001");
  });
  it("rate が 0 以下 / 不正、または shares が §4.5 違反なら null", () => {
    for (const bad of ["0", "0.0000000000001", "-1.2", "abc", "1e3", ""]) {
      expect(kvaultSharesToUnderlying("1000000", bad, 6, 6)).toBeNull();
      expect(kvaultUnderlyingToShares("1000000", bad, 6, 6)).toBeNull();
    }
    expect(kvaultSharesToUnderlying("1.5", "1.1", 6, 6)).toBeNull();
    expect(kvaultUnderlyingToShares("-1", "1.1", 6, 6)).toBeNull();
    expect(kvaultSharesToUnderlying("1", "1.1", -1, 6)).toBeNull();
    expect(kvaultSharesToUnderlying("1", "1.1", 6, 1.5)).toBeNull();
  });
});

describe("Save cToken ⇄ underlying", () => {
  it("1 cUSDC × 1.05 = 1.05 USDC、逆も一致 (decimals は同一)", () => {
    expect(saveCTokenToUnderlying("1000000", "1.05")).toBe("1050000");
    expect(saveUnderlyingToCToken("1050000", "1.05")).toBe("1000000");
  });
  it("往復は切り捨て分だけ小さくなる (増えない)", () => {
    const rate = "1.234567891234";
    const ctoken = saveUnderlyingToCToken("1000000", rate)!;
    expect(ctoken).toBe("810000");
    const back = BigInt(saveCTokenToUnderlying(ctoken, rate)!);
    expect(back <= 1_000_000n).toBe(true);
  });
  it("rate 0 / 不正は null", () => {
    expect(saveCTokenToUnderlying("1000000", "0")).toBeNull();
    expect(saveUnderlyingToCToken("1000000", "x")).toBeNull();
    expect(saveCTokenToUnderlying("1.5", "1.05")).toBeNull();
  });
});
