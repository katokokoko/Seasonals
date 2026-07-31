/**
 * portfolioTimeSeries — chart 系列と y 軸範囲 (Phase 8.55)。
 *
 * 8.55 で直した 2 つの症状を固定する:
 *   1. トグル USDC でも系列が SOL 建てのままだった (縦軸不一致)
 *   2. 水平線 (履歴未実装の 2 点) で y 軸ラベル 4 つが同値に潰れていた
 */
import type { Position } from "@workspace/lib/types";

import { SOL_USD_PRICE } from "./allocation";
import {
  buildPortfolioTimeSeries,
  chartBounds,
  formatAxisValue,
} from "./portfolioTimeSeries";

const TODAY = new Date("2026-08-01T00:00:00.000Z");

/** 150 USDC 保有 1 件 (wallet_stable) */
function usdcPosition(): Position {
  return {
    position_id: "p1",
    protocol_id: "wallet_stable",
    asset_symbol: "USDC",
    current_amount: "150000000", // 150 USDC (6 dec)
  } as unknown as Position;
}

describe("buildPortfolioTimeSeries", () => {
  it("currency=USDC なら USD 建て、SOL なら SOL 建ての系列を返す", () => {
    const usdc = buildPortfolioTimeSeries([usdcPosition()], "1M", TODAY, "USDC");
    const sol = buildPortfolioTimeSeries([usdcPosition()], "1M", TODAY, "SOL");
    expect(usdc).toHaveLength(2);
    expect(usdc[0]!.value).toBeCloseTo(150, 6);
    expect(sol[0]!.value).toBeCloseTo(150 / SOL_USD_PRICE, 6);
  });

  it("右端は today (リアルタイム)、左端は range 日数分前", () => {
    const pts = buildPortfolioTimeSeries([usdcPosition()], "1M", TODAY, "USDC");
    expect(pts[1]!.date).toEqual(TODAY);
    const diffDays =
      (TODAY.getTime() - pts[0]!.date.getTime()) / (24 * 3600 * 1000);
    expect(diffDays).toBe(30);
  });

  it("positions 空は空配列 (履歴を偽造しない)", () => {
    expect(buildPortfolioTimeSeries([], "1M", TODAY, "USDC")).toEqual([]);
  });
});

describe("chartBounds — 値 ±10% (8.55)", () => {
  it("水平線でも上下に幅が出る (min×0.9 / max×1.1)", () => {
    const pts = buildPortfolioTimeSeries([usdcPosition()], "1M", TODAY, "USDC");
    const { minValue, maxValue } = chartBounds(pts);
    expect(minValue).toBeCloseTo(135, 6);
    expect(maxValue).toBeCloseTo(165, 6);
  });

  it("水平線で 4 段の軸ラベルがすべて異なる値になる (旧実装の regression)", () => {
    const pts = buildPortfolioTimeSeries([usdcPosition()], "1M", TODAY, "SOL");
    const { minValue, maxValue } = chartBounds(pts);
    const labels = Array.from({ length: 4 }, (_, i) =>
      formatAxisValue(minValue + ((maxValue - minValue) * i) / 3)
    );
    expect(new Set(labels).size).toBe(4);
  });

  it("値が 0 / 空なら {0, 1} fallback (0 除算しない)", () => {
    expect(chartBounds([])).toEqual({ minValue: 0, maxValue: 1 });
    expect(
      chartBounds([{ date: TODAY, value: 0, isFuture: false }])
    ).toEqual({ minValue: 0, maxValue: 1 });
  });
});

describe("formatAxisValue — 桁に応じた小数桁", () => {
  it("≥100 は 1 桁 / ≥1 は 2 桁 / <1 は 4 桁", () => {
    expect(formatAxisValue(150.61)).toBe("150.6");
    expect(formatAxisValue(12.345)).toBe("12.35");
    expect(formatAxisValue(0.8938)).toBe("0.8938");
  });
});
