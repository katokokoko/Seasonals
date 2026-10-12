/**
 * funding-fair-value (2026-10-13) — funding token deposit の cross-asset 償還価値ガード (純関数)。
 *
 * fairOut = in × P_f8 × 10^(d_u + d_s) / (P_u8 × C × 10^d_f)、deviation_bps = (fairOut − out) × 1e4 / fairOut。
 * 実測 (2026-10-13): 1 USDC → 0.960781 jlJupUSD、jlJupUSD の convertToAssets ≈ 1.041200 JupUSD。
 */
import {
  evaluateCrossAssetFairValue,
  fundingFairValueBlockMessage,
  type CrossAssetFairValueInput,
} from "./funding-fair-value";

/** USDC (6) → jlJupUSD (6)、underlying JupUSD (6)、両 oracle ≈ $1、C = 1.0412 */
function base(partial: Partial<CrossAssetFairValueInput> = {}): CrossAssetFairValueInput {
  return {
    inAmount: "1000000",
    outAmount: "960781",
    fundingDecimals: 6,
    underlyingDecimals: 6,
    shareDecimals: 6,
    fundingPriceUsd8: "1.00000000",
    underlyingPriceUsd8: "1.00000000",
    convertToAssets: "1041200",
    guardBps: 200,
    ...partial,
  };
}

describe("evaluateCrossAssetFairValue", () => {
  it("今日の実測値: fairOut ≈ 960,430、quote 960,781 → ≈ -3bps (ユーザー有利) で ok", () => {
    // 1e6 × 1e8 × 1e12 / (1e8 × 1041200 × 1e6) = 960430.27…
    expect(evaluateCrossAssetFairValue(base())).toEqual({ status: "ok", deviation_bps: -3 });
  });

  it("ユーザー不利に guard (2%) を超えて外れた quote は blocked fair_value_deviation", () => {
    // fairOut 960430 に対し 930000 = 約 3.17% 少ない
    expect(evaluateCrossAssetFairValue(base({ outAmount: "930000" }))).toEqual({
      status: "blocked",
      reason: "fair_value_deviation",
      deviation_bps: 316,
    });
  });

  it("guard 以内の不利 (1%) は ok", () => {
    const v = evaluateCrossAssetFairValue(base({ outAmount: "950826" }));
    expect(v.status).toBe("ok");
    expect((v as { deviation_bps: number }).deviation_bps).toBe(99);
  });

  it("ユーザー有利 (受け取りが多い) は大きく外れても通す", () => {
    const v = evaluateCrossAssetFairValue(base({ outAmount: "1100000" }));
    expect(v.status).toBe("ok");
    expect((v as { deviation_bps: number }).deviation_bps).toBeLessThan(0);
  });

  it("funding が depeg すると fair が縮む (USDC $0.95 → 受け取り 0.9608 は有利側)", () => {
    // fairOut = 960430 × 0.95 ≈ 912408 → 960781 はそれより多い = ok
    const v = evaluateCrossAssetFairValue(base({ fundingPriceUsd8: "0.95000000" }));
    expect(v.status).toBe("ok");
    // underlying が depeg (JupUSD $0.95) すると fair が増え、同じ quote は不利側に 4.9% 外れる
    const u = evaluateCrossAssetFairValue(base({ underlyingPriceUsd8: "0.95000000" }));
    expect(u).toMatchObject({ status: "blocked", reason: "fair_value_deviation" });
  });

  it.each([
    ["funding 価格 null (blocked / not_configured)", { fundingPriceUsd8: null }],
    ["underlying 価格 undefined", { underlyingPriceUsd8: undefined }],
    ["価格 0", { underlyingPriceUsd8: "0" }],
    ["価格が 8 桁超 (不正)", { fundingPriceUsd8: "1.000000001" }],
    ["C 欠損", { convertToAssets: undefined }],
    ["C = 0", { convertToAssets: "0" }],
    ["C が decimal string", { convertToAssets: "1.0412" }],
    ["inAmount 不正", { inAmount: "1.5" }],
    ["outAmount 不正", { outAmount: "-1" }],
    ["inAmount 0", { inAmount: "0" }],
  ])("%s → blocked fair_value_unavailable (fail-closed)", (_label, partial) => {
    expect(evaluateCrossAssetFairValue(base(partial as Partial<CrossAssetFairValueInput>))).toEqual({
      status: "blocked",
      reason: "fair_value_unavailable",
    });
  });

  it("guard 0 = 無効化 (no_reference)", () => {
    expect(evaluateCrossAssetFairValue(base({ guardBps: 0, convertToAssets: undefined }))).toEqual({
      status: "no_reference",
    });
  });

  it("decimals 混在: funding 9 桁 ($2) → underlying 6 桁 ($1)、C 1:1 → fair 2.000000 share", () => {
    const v = evaluateCrossAssetFairValue(
      base({
        inAmount: "1000000000", // 1 枚 (9 dec)
        fundingDecimals: 9,
        fundingPriceUsd8: "2.00000000",
        convertToAssets: "1000000",
        outAmount: "2000000",
      })
    );
    expect(v).toEqual({ status: "ok", deviation_bps: 0 });
    // 同条件で 1.9 share しか来なければ 5% 不利
    expect(
      evaluateCrossAssetFairValue(
        base({
          inAmount: "1000000000",
          fundingDecimals: 9,
          fundingPriceUsd8: "2.00000000",
          convertToAssets: "1000000",
          outAmount: "1900000",
        })
      )
    ).toEqual({ status: "blocked", reason: "fair_value_deviation", deviation_bps: 500 });
  });

  it("decimals 混在: share 9 桁 / underlying 6 桁 (C = 1.1) → fair 0.909090909 share", () => {
    // 1e6 × 1e8 × 1e15 / (1e8 × 1100000 × 1e6) = 909090909.09…
    const v = evaluateCrossAssetFairValue(
      base({ shareDecimals: 9, convertToAssets: "1100000", outAmount: "909090909" })
    );
    expect(v).toEqual({ status: "ok", deviation_bps: 0 });
  });
});

describe("fundingFairValueBlockMessage", () => {
  const common = {
    guardBps: 200,
    inAmount: "1000000",
    fundingSymbol: "USDC",
    fundingDecimals: 6,
    shareSymbol: "jlJupUSD",
    underlyingSymbol: "JupUSD",
  };
  it("deviation は量と symbol を名指しし、量の問題ではないと伝える", () => {
    expect(
      fundingFairValueBlockMessage({ ...common, reason: "fair_value_deviation", deviationBps: 316 })
    ).toBe(
      "Quote is 3.16% below what 1 USDC should buy in jlJupUSD (limit 2.00%). Stopped before signing — this is a routing or liquidity problem, not your amount."
    );
  });
  it("unavailable は何が読めなかったかを言う", () => {
    expect(
      fundingFairValueBlockMessage({ ...common, reason: "fair_value_unavailable", deviationBps: undefined })
    ).toMatch(/USDC \/ JupUSD prices or the jlJupUSD exchange rate.*Stopped before signing/);
  });
});
