/**
 * portfolio-history — tx 遡りによる残高復元と値付け (Phase 8.58)。
 *
 * 「捏造しない」ための性質を固定する:
 *   - 差分から遡った残高が厳密であること (bigint、§4.5)
 *   - tx が無い期間は残高が動かないこと (価格だけで線が動く)
 *   - 遡りすぎて負になったら 0 に丸めること
 *   - 実価格が引けない asset は現在価格で近似し、**それを申告する**こと
 */
import {
  buildHistorySeries,
  endOfUtcDay,
  replayBalances,
  sampleDays,
  utcDayKey,
  type BalanceDelta,
  type HistoryAsset,
} from "./portfolio-history";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const WSOL = "So11111111111111111111111111111111111111112";
const SOL_FEED = "0xef0d8b6f";
/** 2026-08-01T00:00:00Z */
const NOW = Math.floor(Date.parse("2026-08-01T12:00:00Z") / 1000);

describe("sampleDays", () => {
  it("90 日までは日次 (両端を含む)", () => {
    const days = sampleDays(3, NOW);
    expect(days).toEqual(["2026-07-29", "2026-07-30", "2026-07-31", "2026-08-01"]);
  });

  it("90 日超は週次に間引く (過去価格を 365 回叩かない)", () => {
    const days = sampleDays(365, NOW);
    expect(days.length).toBeLessThanOrEqual(54);
    expect(days[days.length - 1]).toBe("2026-08-01"); // 今日は必ず含む
  });

  it("日付は昇順", () => {
    const days = sampleDays(30, NOW);
    expect([...days].sort()).toEqual(days);
  });
});

describe("replayBalances", () => {
  const days = ["2026-07-29", "2026-07-30", "2026-07-31", "2026-08-01"];

  it("差分を遡って各日の終値残高を復元する", () => {
    // 現在 150 USDC。7/31 に +50 入金していた → それ以前は 100
    const deltas: BalanceDelta[] = [
      {
        timestamp: endOfUtcDay("2026-07-31") - 3600,
        mint: USDC,
        amount: 50_000_000n,
      },
    ];
    const out = replayBalances(new Map([[USDC, 150_000_000n]]), deltas, days);
    expect(out.get("2026-08-01")!.get(USDC)).toBe(150_000_000n);
    expect(out.get("2026-07-31")!.get(USDC)).toBe(150_000_000n); // 当日中の入金
    expect(out.get("2026-07-30")!.get(USDC)).toBe(100_000_000n);
    expect(out.get("2026-07-29")!.get(USDC)).toBe(100_000_000n);
  });

  it("tx が無ければ全日同じ残高 (価格だけで線が動く)", () => {
    const out = replayBalances(new Map([[WSOL, 297_600_000n]]), [], days);
    for (const day of days) {
      expect(out.get(day)!.get(WSOL)).toBe(297_600_000n);
    }
  });

  it("遡りすぎて負になったら 0 に丸める (持っていた証拠が無い)", () => {
    // 現在 10 だが、window 内に +100 の入金がある → それ以前は −90 になる
    const deltas: BalanceDelta[] = [
      {
        timestamp: endOfUtcDay("2026-07-31") - 10,
        mint: USDC,
        amount: 100_000_000n,
      },
    ];
    const out = replayBalances(new Map([[USDC, 10_000_000n]]), deltas, days);
    expect(out.get("2026-07-30")!.get(USDC)).toBe(0n);
  });

  it("複数 mint を独立に遡る", () => {
    const deltas: BalanceDelta[] = [
      { timestamp: endOfUtcDay("2026-07-31") - 5, mint: USDC, amount: 1_000_000n },
      { timestamp: endOfUtcDay("2026-07-31") - 5, mint: WSOL, amount: -500_000_000n },
    ];
    const out = replayBalances(
      new Map([
        [USDC, 5_000_000n],
        [WSOL, 1_000_000_000n],
      ]),
      deltas,
      days
    );
    expect(out.get("2026-07-30")!.get(USDC)).toBe(4_000_000n);
    expect(out.get("2026-07-30")!.get(WSOL)).toBe(1_500_000_000n);
  });
});

describe("buildHistorySeries", () => {
  const days = ["2026-07-31", "2026-08-01"];
  const solAsset: HistoryAsset = {
    mint: WSOL,
    symbol: "SOL",
    decimals: 9,
    feedId: SOL_FEED,
    currentUsd8: "73.00000000",
  };

  it("その日の実価格で値付けする (残高が同じでも価格で動く)", () => {
    const balances = new Map([
      ["2026-07-31", new Map([[WSOL, 1_000_000_000n]])], // 1 SOL
      ["2026-08-01", new Map([[WSOL, 1_000_000_000n]])],
    ]);
    const prices = new Map([
      ["2026-07-31", new Map([[SOL_FEED, "80.00000000"]])],
      ["2026-08-01", new Map([[SOL_FEED, "73.00000000"]])],
    ]);
    const out = buildHistorySeries(days, balances, [solAsset], prices, SOL_FEED);
    expect(out.points.map((p) => p.usd)).toEqual(["80.00000000", "73.00000000"]);
    // SOL 建てはその日の SOL 価格で割るので 1 SOL のまま
    expect(out.points.map((p) => p.sol)).toEqual(["1.00000000", "1.00000000"]);
    expect(out.approximatedSymbols).toEqual([]);
  });

  it("feed が無い asset は現在価格で近似し、symbol を申告する", () => {
    const jl: HistoryAsset = {
      mint: "JL_MINT",
      symbol: "jlUSDC",
      decimals: 6,
      currentUsd8: "1.05000000",
    };
    const balances = new Map([
      ["2026-07-31", new Map([["JL_MINT", 10_000_000n]])],
      ["2026-08-01", new Map([["JL_MINT", 10_000_000n]])],
    ]);
    const out = buildHistorySeries(days, balances, [jl], new Map(), undefined);
    expect(out.points.map((p) => p.usd)).toEqual(["10.50000000", "10.50000000"]);
    expect(out.approximatedSymbols).toEqual(["jlUSDC"]);
  });

  it("価格が全く引けない日は点を作らない (0 の谷を作らない)", () => {
    const noPrice: HistoryAsset = { mint: "X", symbol: "X", decimals: 6 };
    const balances = new Map([["2026-08-01", new Map([["X", 1_000_000n]])]]);
    const out = buildHistorySeries(
      ["2026-08-01"],
      balances,
      [noPrice],
      new Map(),
      SOL_FEED
    );
    expect(out.points).toEqual([]);
  });

  it("SOL 価格が無い日は sol='0' (USD は出す)", () => {
    const balances = new Map([["2026-08-01", new Map([[WSOL, 1_000_000_000n]])]]);
    const out = buildHistorySeries(
      ["2026-08-01"],
      balances,
      [solAsset],
      new Map(),
      SOL_FEED
    );
    expect(out.points[0]!.usd).toBe("73.00000000"); // 現在価格で近似
    expect(out.points[0]!.sol).toBe("0.00000000");
    expect(out.approximatedSymbols).toEqual(["SOL"]);
  });
});

describe("utcDayKey / endOfUtcDay", () => {
  it("UTC 基準で日付キーを作る", () => {
    expect(utcDayKey(Math.floor(Date.parse("2026-08-01T23:59:00Z") / 1000))).toBe(
      "2026-08-01"
    );
  });

  it("日の終わりは 23:59:59 UTC", () => {
    expect(utcDayKey(endOfUtcDay("2026-08-01"))).toBe("2026-08-01");
    expect(endOfUtcDay("2026-08-01")).toBeGreaterThan(
      Math.floor(Date.parse("2026-08-01T23:00:00Z") / 1000)
    );
  });
});
