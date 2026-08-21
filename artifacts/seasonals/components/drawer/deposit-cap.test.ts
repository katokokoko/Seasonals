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
  it("枠情報が無く預入可能な pool は null (何も表示しない)", () => {
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
    expect(v?.label).toContain("Deposits full"); // 8.52: 理由を明示 (無言で無効化しない)
  });

  it("8.52: 枠に空きがあるのに閉じていれば reason=unavailable (上流都合)", () => {
    // Kamino USDC: 上限 1.0B に対し使用 106M でも上流の誤ルーティングで預入不能
    const v = usdc("1000000000000000", "106376882000000", false);
    expect(v?.closed).toBe(true);
    expect(v?.reason).toBe("unavailable");
    expect(v?.label).toBe("Deposits unavailable · 106.3M / 1.0B USDC");
  });

  it("8.52: 枠の数値が取れなくても閉じていれば理由を出す", () => {
    // BFF の on-chain 読みが失敗した日 (cap/used undefined) でも押せない理由は出す
    const v = depositCapView({ deposit_open: false, asset: "USDC" }, 6);
    expect(v?.closed).toBe(true);
    expect(v?.reason).toBe("unavailable");
    expect(v?.label).toBe("Deposits unavailable");
  });

  it("8.52: 兆 (T) まで短縮する", () => {
    // 5,000,000,000,000 / 9,000,000,000,000 USDC
    const v = usdc("9000000000000000000", "5000000000000000000", true);
    expect(v?.label).toBe("5.0T / 9.0T USDC");
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

  // 8.91: BFF の deposit_closed_reason で文言を出し分ける
  it("8.91: blocked は枠に空きがあっても upstream issue と表示 (unavailable と区別)", () => {
    const v = depositCapView(
      {
        deposit_cap: "1000000000000000",
        deposit_used: "106376882000000",
        deposit_open: false,
        deposit_closed_reason: "blocked",
        asset: "USDC",
      },
      6
    );
    expect(v?.closed).toBe(true);
    expect(v?.reason).toBe("blocked");
    expect(v?.label).toBe("Deposits blocked · upstream issue");
  });

  it("8.91: blocked は cap 0 (停止中) より優先 (BFF の上書き順と一致)", () => {
    const v = depositCapView(
      {
        deposit_cap: "0",
        deposit_used: "527485000000",
        deposit_open: false,
        deposit_closed_reason: "blocked",
        asset: "USDC",
      },
      6
    );
    expect(v?.reason).toBe("blocked");
    expect(v?.ratio).toBe(1);
  });

  it("8.91: 数値が取れない日も BFF 理由で文言を具体化する", () => {
    const base = { deposit_open: false as const, asset: "USDC" };
    expect(
      depositCapView({ ...base, deposit_closed_reason: "blocked" }, 6)?.label
    ).toBe("Deposits blocked · upstream issue");
    expect(
      depositCapView({ ...base, deposit_closed_reason: "suspended" }, 6)
    ).toMatchObject({ label: "Deposits paused", reason: "paused", ratio: 1 });
    expect(
      depositCapView({ ...base, deposit_closed_reason: "full" }, 6)
    ).toMatchObject({ label: "Deposits full", reason: "full", ratio: 1 });
  });
});
