/**
 * portfolioTimeSeries — chart 系列と y 軸範囲 (Phase 8.55 / 8.56)。
 *
 * 固定する仕様:
 *   - 系列はトグル通貨建て (8.55: 縦軸がトグルと一致)
 *   - 系列は **観測した点だけ** (8.56: 過去に遡って点を捏造しない)
 *   - 変動を観測していない間は hasHistory=false → 呼び手が線を描かない
 *   - 軸は実変動幅 (span) の ±10% — 小さな利回りの動きが見えるように
 */
import type { Position } from "@workspace/lib/types";

import type { PortfolioSnapshot } from "./history";
import {
  buildPortfolioTimeSeries,
  chartBounds,
  formatAxisValue,
  hasHistory,
  serverHistoryToPoints,
} from "./portfolioTimeSeries";

/** oracle 由来の実価格 map (8.57: 固定表をやめた) */
const SOL_USD = 74.92;
const PRICES = { SOL: SOL_USD, USDC: 1 };

const TODAY = new Date(2026, 7, 1); // 2026-08-01 (ローカル)

/** 150 USDC 保有 1 件 (wallet_stable) */
function usdcPosition(): Position {
  return {
    position_id: "p1",
    protocol_id: "wallet_stable",
    asset_symbol: "USDC",
    current_amount: "150000000", // 150 USDC (6 dec)
    unit_price_usd: "1.00000000",
  } as unknown as Position;
}

const NOW_SOL = 150 / SOL_USD;

describe("buildPortfolioTimeSeries", () => {
  it("スナップショットが無ければ今日の 1 点だけ (過去を捏造しない)", () => {
    const pts = buildPortfolioTimeSeries([], [usdcPosition()], "1M", TODAY, "USDC", PRICES);
    expect(pts).toHaveLength(1);
    expect(pts[0]!.date).toEqual(TODAY);
    expect(pts[0]!.value).toBeCloseTo(150, 6);
  });

  it("range 内の実測 + 末尾に今日の現在値を並べる", () => {
    const snaps: PortfolioSnapshot[] = [
      { day: "2026-07-30", sol: 0.88 },
      { day: "2026-07-31", sol: 0.89 },
    ];
    const pts = buildPortfolioTimeSeries(snaps, [usdcPosition()], "1M", TODAY, "SOL", PRICES);
    expect(pts.map((p) => p.value)).toEqual([0.88, 0.89, NOW_SOL]);
    expect(pts[2]!.date).toEqual(TODAY);
  });

  it("今日の分の実測は現在値で置き換える (二重に並べない)", () => {
    const snaps: PortfolioSnapshot[] = [
      { day: "2026-07-31", sol: 0.89 },
      { day: "2026-08-01", sol: 0.5 }, // 古い記録
    ];
    const pts = buildPortfolioTimeSeries(snaps, [usdcPosition()], "1M", TODAY, "SOL", PRICES);
    expect(pts).toHaveLength(2);
    expect(pts[1]!.value).toBeCloseTo(NOW_SOL, 6);
  });

  it("range 外の古い実測は含めない (1W)", () => {
    const snaps: PortfolioSnapshot[] = [
      { day: "2026-06-01", sol: 0.5 }, // 1W 外
      { day: "2026-07-30", sol: 0.88 },
    ];
    const pts = buildPortfolioTimeSeries(snaps, [usdcPosition()], "1W", TODAY, "SOL", PRICES);
    expect(pts.map((p) => p.value)).toEqual([0.88, NOW_SOL]);
  });

  it("currency=USDC なら USD 建て、SOL なら SOL 建て", () => {
    const snaps: PortfolioSnapshot[] = [{ day: "2026-07-31", sol: 1 }];
    const usdc = buildPortfolioTimeSeries(snaps, [usdcPosition()], "1M", TODAY, "USDC", PRICES);
    const sol = buildPortfolioTimeSeries(snaps, [usdcPosition()], "1M", TODAY, "SOL", PRICES);
    expect(usdc[0]!.value).toBeCloseTo(SOL_USD, 6);
    expect(sol[0]!.value).toBe(1);
  });

  it("positions 空は空配列 (履歴を偽造しない)", () => {
    expect(buildPortfolioTimeSeries([], [], "1M", TODAY, "USDC", PRICES)).toEqual([]);
  });
});

describe("hasHistory — 変動を観測できているか", () => {
  const pt = (value: number) => ({ date: TODAY, value, isFuture: false });

  it("1 点だけなら false (記録初日)", () => {
    expect(hasHistory([pt(1)])).toBe(false);
  });

  it("全点が同値なら false (中身のない目盛りを作らない)", () => {
    expect(hasHistory([pt(1), pt(1), pt(1)])).toBe(false);
  });

  it("変動があれば true", () => {
    expect(hasHistory([pt(1), pt(1.0001)])).toBe(true);
  });
});

describe("chartBounds — 実変動幅の ±10% (8.56)", () => {
  it("小さな利回りの動きでも軸いっぱいに見える", () => {
    const pts = [150.61, 150.68].map((v) => ({
      date: TODAY,
      value: v,
      isFuture: false,
    }));
    const { minValue, maxValue } = chartBounds(pts);
    expect(minValue).toBeCloseTo(150.603, 3);
    expect(maxValue).toBeCloseTo(150.687, 3);
    // 4 段の軸ラベルがすべて異なる文字列になる (刻み幅から小数桁を決めるため)
    const step = (maxValue - minValue) / 3;
    const labels = Array.from({ length: 4 }, (_, i) =>
      formatAxisValue(minValue + step * i, step)
    );
    expect(new Set(labels).size).toBe(4);
    expect(labels[0]).toBe("150.603");
  });

  it("空 / 全点同値でも 0 除算しない (保険。通常は hasHistory=false で未到達)", () => {
    expect(chartBounds([])).toEqual({ minValue: 0, maxValue: 1 });
    const flat = chartBounds([{ date: TODAY, value: 100, isFuture: false }]);
    expect(flat.maxValue).toBeGreaterThan(flat.minValue);
  });
});

describe("formatAxisValue", () => {
  it("step 未指定は値の桁で決める (≥100 → 1 桁 / ≥1 → 2 桁 / <1 → 4 桁)", () => {
    expect(formatAxisValue(150.61)).toBe("150.6");
    expect(formatAxisValue(12.345)).toBe("12.35");
    expect(formatAxisValue(0.8938)).toBe("0.8938");
  });

  it("step 指定時は刻み幅で決める (隣の目盛りと同じ文字列にしない)", () => {
    expect(formatAxisValue(150.631, 0.028)).toBe("150.631");
    expect(formatAxisValue(0.8641, 0.0596)).toBe("0.864");
    expect(formatAxisValue(1234, 100)).toBe("1234");
  });
});

describe("serverHistoryToPoints — BFF 復元履歴 (8.58)", () => {
  const server = [
    { day: "2026-07-31", usd: "122.13275883", sol: "1.67776341" },
    { day: "2026-08-01", usd: "122.17923625", sol: "1.67479218" },
  ];

  it("トグル通貨に応じて usd / sol を選ぶ", () => {
    const usdc = serverHistoryToPoints(server, "USDC");
    expect(usdc.map((p) => p.value)).toEqual([122.13275883, 122.17923625]);
    const sol = serverHistoryToPoints(server, "SOL");
    expect(sol.map((p) => p.value)).toEqual([1.67776341, 1.67479218]);
  });

  it("day を Date に戻す (ローカル 0 時)", () => {
    const pts = serverHistoryToPoints(server, "USDC");
    expect(pts[0]!.date.getFullYear()).toBe(2026);
    expect(pts[0]!.date.getDate()).toBe(31);
  });

  it("0 / 不正値の点は落とす (SOL 価格が無い日の sol='0' 等)", () => {
    const pts = serverHistoryToPoints(
      [
        { day: "2026-08-01", usd: "122.00000000", sol: "0.00000000" },
        { day: "2026-08-02", usd: "1", sol: "bad" },
      ],
      "SOL"
    );
    expect(pts).toHaveLength(0);
  });
});
