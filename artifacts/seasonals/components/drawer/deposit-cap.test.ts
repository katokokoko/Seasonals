/**
 * deposit-cap — 預入枠表示 (Phase 8.51)。
 * §4.5: cap/used は smallest unit string。Number() を通さずに扱えているかを固定する。
 */
import { depositCapView } from "./deposit-cap";

const usdc = (cap: string, used: string, open?: boolean) =>
  depositCapView(
    { deposit_cap: cap, deposit_used: used, deposit_open: open, asset: "USDC" },
    6
  );

describe("depositCapView", () => {
  it("枠情報が無い pool は null (何も表示しない)", () => {
    expect(depositCapView({ asset: "USDC" }, 6)).toBeNull();
    expect(depositCapView({ deposit_cap: "100", asset: "USDC" }, 6)).toBeNull();
  });

  it("used / cap を短縮表記で出す", () => {
    // 106,376,882 USDC / 1,000,000,000 USDC
    const v = usdc("1000000000000000", "106376882000000", true);
    expect(v?.label).toBe("106.3M / 1.0B USDC");
    expect(v?.closed).toBe(false);
  });

  it("使用率を返す (bigint 計算、桁落ちしない)", () => {
    const v = usdc("1000000000000000", "106376882000000", true);
    expect(v?.ratio).toBeCloseTo(0.1063, 3);
  });

  it("上限 0 は「停止中」として扱う (0 除算しない)", () => {
    const v = usdc("0", "527485000000");
    expect(v?.closed).toBe(true);
    expect(v?.reason).toBe("paused");
    expect(v?.ratio).toBe(1);
    expect(v?.label).toContain("Deposits paused");
  });

  it("満杯 (used >= cap) は closed / reason=full", () => {
    const v = usdc("1000000", "1000000", true);
    expect(v?.closed).toBe(true);
    expect(v?.reason).toBe("full");
    expect(v?.ratio).toBe(1);
  });

  it("BFF が deposit_open=false と言えば従う (満杯でなくても)", () => {
    const v = usdc("1000000000000000", "1000000", false);
    expect(v?.closed).toBe(true);
  });

  it("巨大な値でも精度を落とさない (2^53 超)", () => {
    // 90,071,992,547,409.91 USDC (smallest で 2^53 超)
    const v = usdc("90071992547409910000000", "45035996273704950000000", true);
    expect(v?.ratio).toBeCloseTo(0.5, 3);
    expect(v?.closed).toBe(false);
  });

  it("不正な文字列は null (小数や負数を弾く §4.5)", () => {
    expect(usdc("1.5", "1")).toBeNull();
    expect(usdc("100", "-1")).toBeNull();
  });
});
