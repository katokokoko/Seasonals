/**
 * fair-value — swap quote の償還価値ガード (Phase 8.72)。
 *
 * 固定する性質:
 *   - **ユーザー不利方向だけ**止める (有利方向は通す)
 *   - 参照を持たない market は素通り / 参照を持つのに取れなければ fail-closed
 */
import {
  DEFAULT_FAIR_VALUE_GUARD_BPS,
  evaluateFairValue,
  FAIR_VALUE_LST_SYMBOLS,
  fairValueBlockMessage,
  fairValueGuardBps,
} from "./fair-value";

/** jitoSOL 1 枚 = 1.2 SOL 相当の想定レート */
const RATE = 1_200_000_000n;
const ONE_SOL = "1000000000";

function deposit(outAmount: string, guardBps = 50) {
  return evaluateFairValue({
    direction: "deposit",
    inAmount: ONE_SOL,
    outAmount,
    lamportsPerLst: RATE,
    hasReference: true,
    guardBps,
  });
}

describe("evaluateFairValue — 方向判定 (ユーザー不利側のみ止める)", () => {
  // 1 SOL 入れたときの fair な受取 = 1e9 × 1e9 / 1.2e9 = 833333333 jitoSOL smallest
  const FAIR_OUT = 833_333_333n;

  it("fair どおりなら ok (乖離 0)", () => {
    const v = deposit(FAIR_OUT.toString());
    expect(v.status).toBe("ok");
    expect(v).toMatchObject({ deviation_bps: 0 });
  });

  it("受取が fair を大きく下回れば blocked (不利方向)", () => {
    // 2% 少ない受取
    const bad = (FAIR_OUT * 98n) / 100n;
    const v = deposit(bad.toString());
    expect(v).toMatchObject({
      status: "blocked",
      reason: "fair_value_deviation",
    });
    expect((v as { deviation_bps: number }).deviation_bps).toBeGreaterThan(190);
  });

  it("受取が fair を上回る (ユーザー有利) 方向は通す", () => {
    const good = (FAIR_OUT * 105n) / 100n;
    const v = deposit(good.toString());
    expect(v.status).toBe("ok");
    // 有利方向は負の乖離
    expect((v as { deviation_bps: number }).deviation_bps).toBeLessThan(0);
  });

  it("閾値ちょうどは通す (境界は通す側)", () => {
    // ちょうど 50bps 少ない受取
    const edge = (FAIR_OUT * 9_950n) / 10_000n;
    const v = deposit(edge.toString(), 50);
    expect(v.status).toBe("ok");
    expect((v as { deviation_bps: number }).deviation_bps).toBe(50);
  });

  it("withdraw は LST → SOL の向きで計算する", () => {
    // 1 jitoSOL 出すと fair は 1.2 SOL
    const v = evaluateFairValue({
      direction: "withdraw",
      inAmount: "1000000000",
      outAmount: "1200000000",
      lamportsPerLst: RATE,
      hasReference: true,
      guardBps: 50,
    });
    expect(v).toMatchObject({ status: "ok", deviation_bps: 0 });

    // 同じ入力を deposit として見ると fair は 0.833 SOL なので、
    // 向きを取り違えていたら「有利すぎる」判定になって差が出る
    const wrongWay = evaluateFairValue({
      direction: "deposit",
      inAmount: "1000000000",
      outAmount: "1200000000",
      lamportsPerLst: RATE,
      hasReference: true,
      guardBps: 50,
    });
    expect((wrongWay as { deviation_bps: number }).deviation_bps).toBeLessThan(-4000);
  });
});

describe("evaluateFairValue — 参照の有無 (fail-closed の境目)", () => {
  it("参照を持たない market は素通り (jlUSDC 等を殺さない)", () => {
    const v = evaluateFairValue({
      direction: "deposit",
      inAmount: ONE_SOL,
      outAmount: "1",
      lamportsPerLst: undefined,
      hasReference: false,
      guardBps: 50,
    });
    expect(v).toEqual({ status: "no_reference" });
  });

  it("参照を持つのにレートが取れなければ blocked (fail-closed)", () => {
    for (const rate of [undefined, 0n, -1n]) {
      const v = evaluateFairValue({
        direction: "deposit",
        inAmount: ONE_SOL,
        outAmount: "833333333",
        lamportsPerLst: rate,
        hasReference: true,
        guardBps: 50,
      });
      expect(v).toEqual({
        status: "blocked",
        reason: "fair_value_unavailable",
      });
    }
  });

  it("金額が不正 / 0 なら blocked (0 除算も防ぐ)", () => {
    const bad = ["", "1.5", "-100", "0"];
    for (const amount of bad) {
      const v = evaluateFairValue({
        direction: "deposit",
        inAmount: amount,
        outAmount: "833333333",
        lamportsPerLst: RATE,
        hasReference: true,
        guardBps: 50,
      });
      expect(v).toMatchObject({
        status: "blocked",
        reason: "fair_value_unavailable",
      });
    }
  });

  it("guardBps=0 は無効化 (参照があっても判定しない)", () => {
    const v = deposit("1", 0);
    expect(v).toEqual({ status: "no_reference" });
  });
});

describe("fairValueGuardBps / FAIR_VALUE_LST_SYMBOLS", () => {
  it("未設定は既定 200bps (実測の平常乖離 |25bps| に約 8 倍の余裕)", () => {
    expect(fairValueGuardBps({})).toBe(DEFAULT_FAIR_VALUE_GUARD_BPS);
    expect(DEFAULT_FAIR_VALUE_GUARD_BPS).toBe(200);
    expect(fairValueGuardBps({ SEASONALS_FAIR_VALUE_GUARD_BPS: "  " })).toBe(200);
  });

  it("整数を読む / 0 も尊重する (明示的な無効化)", () => {
    expect(fairValueGuardBps({ SEASONALS_FAIR_VALUE_GUARD_BPS: "120" })).toBe(120);
    expect(fairValueGuardBps({ SEASONALS_FAIR_VALUE_GUARD_BPS: "0" })).toBe(0);
  });

  it("壊れた値は既定にフォールバック (無防備にしない)", () => {
    expect(fairValueGuardBps({ SEASONALS_FAIR_VALUE_GUARD_BPS: "abc" })).toBe(200);
    expect(fairValueGuardBps({ SEASONALS_FAIR_VALUE_GUARD_BPS: "-10" })).toBe(200);
    expect(fairValueGuardBps({ SEASONALS_FAIR_VALUE_GUARD_BPS: "1.5" })).toBe(200);
  });

  it("参照を持つのは Sanctum sol-value がある 3 LST", () => {
    expect([...FAIR_VALUE_LST_SYMBOLS].sort()).toEqual(["INF", "jitoSOL", "mSOL"]);
  });
});

describe("fairValueBlockMessage (8.74) — 生 code ではなく文章を返す", () => {
  it("乖離: symbol / 実測 % / 上限 % が入り、量の問題ではないと明示する", () => {
    const msg = fairValueBlockMessage(
      "fair_value_deviation",
      "jitoSOL",
      620,
      200
    );
    expect(msg).toContain("jitoSOL");
    expect(msg).toContain("6.20%");
    expect(msg).toContain("2.00%");
    expect(msg).toContain("Stopped before signing");
    // 乖離は取引量にほぼ依存しないので、減額リトライに誘導しない
    expect(msg).toContain("not your amount");
  });

  it("参照が取れない場合は別の文面 (乖離 % を語らない)", () => {
    const msg = fairValueBlockMessage(
      "fair_value_unavailable",
      "mSOL",
      undefined,
      200
    );
    expect(msg).toContain("mSOL");
    expect(msg).toContain("Stopped before signing");
    expect(msg).not.toContain("%");
  });

  it("deviation_bps が無くても壊れない", () => {
    const msg = fairValueBlockMessage(
      "fair_value_deviation",
      "INF",
      undefined,
      200
    );
    expect(msg).toContain("INF");
    expect(msg).toContain("2.00%");
    expect(msg).not.toContain("undefined");
  });
});
