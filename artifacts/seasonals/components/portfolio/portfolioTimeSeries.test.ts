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
  coverageFromKnownStart,
  hasHistory,
  historyCoverage,
  rangeExceedsCoverage,
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
  const AT_1 = Math.floor(Date.parse("2026-07-31T12:00:00Z") / 1000);
  const AT_2 = Math.floor(Date.parse("2026-08-01T12:00:00Z") / 1000);
  const server = [
    { at: AT_1, usd: "122.13275883", sol: "1.67776341" },
    { at: AT_2, usd: "122.17923625", sol: "1.67479218" },
  ];

  it("トグル通貨に応じて usd / sol を選ぶ", () => {
    const usdc = serverHistoryToPoints(server, "USDC");
    expect(usdc.map((p) => p.value)).toEqual([122.13275883, 122.17923625]);
    const sol = serverHistoryToPoints(server, "SOL");
    expect(sol.map((p) => p.value)).toEqual([1.67776341, 1.67479218]);
  });

  it("at (unix 秒) から Date を作る", () => {
    const pts = serverHistoryToPoints(server, "USDC");
    expect(pts[0]!.date.getTime()).toBe(AT_1 * 1000);
  });

  it("SOL 建てだけ 0 で USD が正の点は落とす (SOL 価格が引けなかった点)", () => {
    const pts = serverHistoryToPoints(
      [
        { at: AT_1, usd: "122.00000000", sol: "0.00000000" },
        { at: AT_2, usd: "1", sol: "bad" },
      ],
      "SOL"
    );
    expect(pts).toHaveLength(0);
  });

  it("8.60: 保有ゼロの点 (usd も sol も 0) は落とさない — 事実なので描く", () => {
    const zeroPeriod = [
      { at: AT_1, usd: "0.00000000", sol: "0.00000000" },
      { at: AT_2, usd: "122.00000000", sol: "1.60000000" },
    ];
    expect(serverHistoryToPoints(zeroPeriod, "USDC").map((p) => p.value)).toEqual([
      0, 122,
    ]);
    expect(serverHistoryToPoints(zeroPeriod, "SOL").map((p) => p.value)).toEqual([
      0, 1.6,
    ]);
  });
});

describe("historyCoverage / rangeExceedsCoverage (8.60)", () => {
  const DAY = 86_400;
  const END = Math.floor(Date.parse("2026-08-01T00:00:00Z") / 1000);
  /** span 日分の points を作る (値は使わない) */
  const pointsSpanning = (spanDays: number) => [
    { at: END - spanDays * DAY, usd: "100", sol: "1" },
    { at: END, usd: "100", sol: "1" },
  ];

  it("range を満たしていれば partial=false", () => {
    // 1W (7 日) に対し 7 日分ある
    expect(historyCoverage(pointsSpanning(7), "1W").partial).toBe(false);
  });

  it("range より短ければ partial=true と開始日を返す", () => {
    // 1Y を要求したが 82 日分しかない (今回の wallet)
    const c = historyCoverage(pointsSpanning(82), "1Y");
    expect(c.partial).toBe(true);
    expect(c.coveredDays).toBeCloseTo(82, 3);
    expect(c.from!.getTime()).toBe((END - 82 * DAY) * 1000);
  });

  it("points が無い / 1 点だけなら判定しない", () => {
    expect(historyCoverage([], "1Y").partial).toBe(false);
    expect(historyCoverage([{ at: END, usd: "1", sol: "1" }], "1Y").partial).toBe(
      false
    );
  });

  it("サンプリングの端で 1 日欠けても partial にしない", () => {
    // 3M (90 日) に対し 89.5 日分 → 刻みの都合なので partial 扱いしない
    expect(historyCoverage(pointsSpanning(89.5), "3M").partial).toBe(false);
  });

  it("淡色化: カバー外の range だけ true", () => {
    const c = historyCoverage(pointsSpanning(82), "1Y");
    expect(rangeExceedsCoverage("1W", c)).toBe(false);
    expect(rangeExceedsCoverage("1M", c)).toBe(false);
    expect(rangeExceedsCoverage("3M", c)).toBe(true); // 90 > 82
    expect(rangeExceedsCoverage("1Y", c)).toBe(true);
    expect(rangeExceedsCoverage("ALL", c)).toBe(true);
  });

  it("カバーしきっている時は何も淡色にしない (長い range の有無は不明)", () => {
    const c = historyCoverage(pointsSpanning(7), "1W");
    for (const r of ["1W", "1M", "3M", "1Y", "ALL"] as const) {
      expect(rangeExceedsCoverage(r, c)).toBe(false);
    }
  });
});

describe("coverageFromKnownStart (8.60)", () => {
  const NOW = new Date("2026-08-01T00:00:00Z");

  it("開始日が分かっていれば、その時点からの日数で判定する", () => {
    const start = new Date("2026-05-11T00:00:00Z");
    const c = coverageFromKnownStart(start, NOW);
    expect(c.partial).toBe(true);
    expect(c.coveredDays).toBeCloseTo(82, 0);
    // 短い range に切り替えても長い range は淡色のまま
    expect(rangeExceedsCoverage("1M", c)).toBe(false);
    expect(rangeExceedsCoverage("1Y", c)).toBe(true);
  });

  it("未知なら何も淡色にしない", () => {
    const c = coverageFromKnownStart(null, NOW);
    expect(c.partial).toBe(false);
    expect(rangeExceedsCoverage("1Y", c)).toBe(false);
  });
});
