import { PositionCategory } from "../types/enums";
import type {
  PortfolioHistoryPoint,
  PortfolioHistoryResponse,
  PortfolioHolding,
} from "../types/portfolio";
import {
  allocationByCategory,
  chartAreaState,
  mergeHistorySeries,
  mergedHistoryToPoints,
  rangeToDays,
  sumHoldingsUsd,
} from "./portfolio";

const DAY = 86_400;

function pt(
  at: number,
  usd: string,
  opts: Partial<PortfolioHistoryPoint> = {}
): PortfolioHistoryPoint {
  return {
    at,
    usd,
    native: "0",
    deposited_usd: opts.deposited_usd ?? "0",
    deposited_native: "0",
    flow_usd: opts.flow_usd ?? "0",
    deposited_flow_usd: opts.deposited_flow_usd ?? "0",
  };
}

function resp(
  points: PortfolioHistoryPoint[],
  extra: Partial<PortfolioHistoryResponse> = {}
): PortfolioHistoryResponse {
  return {
    chain: "ethereum",
    points,
    oldest_at: points[0]?.at ?? null,
    approximated_symbols: [],
    ...extra,
  };
}

function holding(
  category: PortfolioHolding["category"],
  usd: string,
  deposited = false
): PortfolioHolding {
  return {
    chain: "ethereum",
    address: "0xabc",
    symbol: "X",
    protocol_id: "x",
    category,
    usd,
    deposited,
    in_history: true,
  };
}

describe("rangeToDays / chartAreaState (moved from mobile)", () => {
  it("maps ranges to days", () => {
    expect(rangeToDays("1W")).toBe(7);
    expect(rangeToDays("ALL")).toBe(730);
  });
  it("keeps chart over brewing, connect over brewing", () => {
    expect(
      chartAreaState({ hasPositions: true, showChart: true, historyFetching: true })
    ).toBe("chart");
    expect(
      chartAreaState({ hasPositions: false, showChart: false, historyFetching: true })
    ).toBe("connect");
    expect(
      chartAreaState({ hasPositions: true, showChart: false, historyFetching: true })
    ).toBe("brewing");
  });
});

describe("mergeHistorySeries", () => {
  it("returns empty for no points", () => {
    expect(mergeHistorySeries([resp([])]).points).toEqual([]);
  });

  it("sums aligned series exactly (bigint, no float drift)", () => {
    const a = resp([pt(0, "0.1"), pt(DAY, "0.2")]);
    const b = resp([pt(0, "0.2"), pt(DAY, "0.1")]);
    const m = mergeHistorySeries([a, b]);
    expect(m.points.map((p) => p.usd)).toEqual(["0.30000000", "0.30000000"]);
    expect(m.truncated).toBe(false);
  });

  it("carries forward a series with a different grid and sums its flows per bucket", () => {
    const a = resp([pt(0, "100"), pt(DAY, "100"), pt(2 * DAY, "100")]);
    // b は刻みが細かく、途中で 50 入金 (flow) している
    const b = resp([
      pt(0, "10"),
      pt(DAY / 2, "10"),
      pt(DAY, "60", { flow_usd: "50" }),
      pt((3 * DAY) / 2, "60"),
      pt(2 * DAY, "60"),
    ]);
    const m = mergeHistorySeries([a, b]);
    expect(m.points.map((p) => p.usd)).toEqual([
      "110.00000000",
      "160.00000000",
      "160.00000000",
    ]);
    expect(m.points.map((p) => p.flow_usd)).toEqual([
      "0.00000000",
      "50.00000000",
      "0.00000000",
    ]);
  });

  it("starts at the latest unknown-before start (does not treat unknown as 0)", () => {
    const long = resp([pt(0, "100"), pt(DAY, "100"), pt(2 * DAY, "100")]);
    const short = resp([pt(DAY, "5"), pt(2 * DAY, "5")], { starts_at_funding: false });
    const m = mergeHistorySeries([long, short]);
    expect(m.points.map((p) => p.at)).toEqual([DAY, 2 * DAY]);
    expect(m.points[0]!.usd).toBe("105.00000000");
    expect(m.truncated).toBe(true);
  });

  it("treats funding-started series as 0 before, and counts its arrival as inflow", () => {
    const long = resp([pt(0, "100"), pt(DAY, "100"), pt(2 * DAY, "100")]);
    const funded = resp([pt(DAY, "5", { deposited_usd: "5" }), pt(2 * DAY, "5", { deposited_usd: "5" })], {
      starts_at_funding: true,
    });
    const m = mergeHistorySeries([long, funded]);
    expect(m.points.map((p) => p.usd)).toEqual([
      "100.00000000",
      "105.00000000",
      "105.00000000",
    ]);
    expect(m.points[1]!.flow_usd).toBe("5.00000000");
    expect(m.points[1]!.deposited_flow_usd).toBe("5.00000000");
    expect(m.truncated).toBe(false);
  });

  it("extends the last point to the newest series timestamp and keeps signed flows", () => {
    const a = resp([pt(0, "100"), pt(DAY, "100")]);
    const b = resp([pt(0, "10"), pt(DAY + 60, "4", { flow_usd: "-6" })]);
    const m = mergeHistorySeries([a, b]);
    expect(m.points[m.points.length - 1]!.at).toBe(DAY + 60);
    expect(m.points[1]!.usd).toBe("104.00000000");
    expect(m.points[1]!.flow_usd).toBe("-6.00000000");
  });

  it("unions approximated / excluded labels", () => {
    const m = mergeHistorySeries([
      resp([pt(0, "1")], { approximated_symbols: ["stETH"] }),
      resp([pt(0, "1")], { approximated_symbols: ["JLP"], excluded_from_history: ["Aave V4"] }),
    ]);
    expect(m.approximated_symbols).toEqual(["JLP", "stETH"]);
    expect(m.excluded_from_history).toEqual(["Aave V4"]);
  });
});

describe("mergedHistoryToPoints", () => {
  it("trims leading zeros and picks the scope", () => {
    const pts = mergedHistoryToPoints(
      [
        { at: 0, usd: "0.00000000", deposited_usd: "0.00000000", flow_usd: "0.00000000", deposited_flow_usd: "0.00000000" },
        { at: DAY, usd: "10.00000000", deposited_usd: "4.00000000", flow_usd: "10.00000000", deposited_flow_usd: "4.00000000" },
      ],
      "deposited"
    );
    expect(pts).toHaveLength(1);
    expect(pts[0]!.value).toBe(4);
    expect(pts[0]!.flow).toBe(4);
  });
});

describe("allocationByCategory / sumHoldingsUsd", () => {
  const holdings = [
    holding(PositionCategory.Staking, "30.5", true),
    holding(PositionCategory.Staking, "0.5", true),
    holding(PositionCategory.Stable, "69"),
    holding(PositionCategory.Lending, "0"),
  ];

  it("groups by category in display order and drops empty segments", () => {
    const segs = allocationByCategory(holdings);
    expect(segs.map((s) => [s.category, s.value])).toEqual([
      ["staking", 31],
      ["stable", 69],
    ]);
    expect(segs[0]!.label).toBe("Staking");
  });

  it("respects deposited scope", () => {
    expect(allocationByCategory(holdings, "deposited").map((s) => s.category)).toEqual(["staking"]);
    expect(sumHoldingsUsd(holdings)).toBe("100.00000000");
    expect(sumHoldingsUsd(holdings, "deposited")).toBe("31.00000000");
  });
});
