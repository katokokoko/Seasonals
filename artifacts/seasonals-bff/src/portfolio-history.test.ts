/**
 * portfolio-history — tx 遡りによる残高復元と値付け (Phase 8.58 / 8.59)。
 *
 * 「捏造しない」ための性質を固定する:
 *   - 差分から遡った残高が厳密であること (bigint、§4.5)
 *   - tx が無い期間は残高が動かないこと (価格だけで線が動く)
 *   - 遡りすぎて負になったら 0 に丸めること
 *   - 実価格が引けない asset は現在価格で近似し、**それを申告する**こと
 * 8.59: 日単位 → unix 秒単位。range によらず ~90 点になること。
 */
import {
  HISTORY_PRICE_LAG_SEC,
  TARGET_POINTS,
  buildHistorySeries,
  earliestFundedTime,
  replayBalances,
  sampleTimestamps,
  utcDayKey,
  type BalanceDelta,
  type HistoryAsset,
} from "./portfolio-history";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const WSOL = "So11111111111111111111111111111111111111112";
const SOL_FEED = "0xef0d8b6f";
const HOUR = 3_600;
const DAY = 86_400;
const NOW = Math.floor(Date.parse("2026-08-01T12:00:00Z") / 1000);

describe("sampleTimestamps — range によらず点密度を揃える (8.59)", () => {
  it("どの range でも ~90 点になる (3M の日次が基準)", () => {
    for (const days of [7, 30, 90, 365, 730]) {
      const stamps = sampleTimestamps(days, NOW);
      expect(stamps.length).toBeGreaterThanOrEqual(TARGET_POINTS - 10);
      expect(stamps.length).toBeLessThanOrEqual(TARGET_POINTS + 10);
    }
  });

  it("1W は日内 (2h 刻み)、3M は日次、1Y は 4 日刻み", () => {
    const step = (days: number) => {
      const s = sampleTimestamps(days, NOW);
      return s[1]! - s[0]!;
    };
    expect(step(7)).toBe(2 * HOUR);
    expect(step(30)).toBe(8 * HOUR);
    expect(step(90)).toBe(1 * DAY);
    expect(step(365)).toBe(4 * DAY);
  });

  it("epoch 倍数に整列する (同じ引数なら毎回同一 = 過去価格が cache に乗る)", () => {
    const a = sampleTimestamps(30, NOW);
    const b = sampleTimestamps(30, NOW + 60); // 少し時刻がずれても
    expect(a[0]! % (8 * HOUR)).toBe(0);
    expect(a).toEqual(b);
  });

  it("末尾は「今」ではなく lag 分だけ過去 (Benchmarks は現在時刻で 404)", () => {
    const stamps = sampleTimestamps(7, NOW);
    expect(stamps[stamps.length - 1]).toBeLessThanOrEqual(
      NOW - HISTORY_PRICE_LAG_SEC
    );
  });

  it("昇順", () => {
    const stamps = sampleTimestamps(90, NOW);
    expect([...stamps].sort((x, y) => x - y)).toEqual(stamps);
  });
});

describe("replayBalances", () => {
  const stamps = [NOW - 3 * DAY, NOW - 2 * DAY, NOW - DAY, NOW - 600];

  it("差分を遡って各時点の残高を復元する", () => {
    // 現在 150 USDC。1 日前より後に +50 入金 → それ以前は 100
    const deltas: BalanceDelta[] = [
      { timestamp: NOW - DAY + 60, mint: USDC, amount: 50_000_000n },
    ];
    const out = replayBalances(new Map([[USDC, 150_000_000n]]), deltas, stamps);
    expect(out.get(NOW - 600)!.get(USDC)).toBe(150_000_000n);
    expect(out.get(NOW - DAY)!.get(USDC)).toBe(100_000_000n);
    expect(out.get(NOW - 3 * DAY)!.get(USDC)).toBe(100_000_000n);
  });

  it("8.59: 日内 2 点の間に起きた tx も反映される", () => {
    const intraday = [NOW - 6 * HOUR, NOW - 4 * HOUR, NOW - 2 * HOUR];
    const deltas: BalanceDelta[] = [
      { timestamp: NOW - 5 * HOUR, mint: USDC, amount: 10_000_000n },
    ];
    const out = replayBalances(new Map([[USDC, 60_000_000n]]), deltas, intraday);
    expect(out.get(NOW - 6 * HOUR)!.get(USDC)).toBe(50_000_000n);
    expect(out.get(NOW - 4 * HOUR)!.get(USDC)).toBe(60_000_000n);
  });

  it("tx が無ければ全点同じ残高 (価格だけで線が動く)", () => {
    const out = replayBalances(new Map([[WSOL, 297_600_000n]]), [], stamps);
    for (const at of stamps) {
      expect(out.get(at)!.get(WSOL)).toBe(297_600_000n);
    }
  });

  it("遡りすぎて負になったら 0 に丸める (持っていた証拠が無い)", () => {
    const deltas: BalanceDelta[] = [
      { timestamp: NOW - DAY + 10, mint: USDC, amount: 100_000_000n },
    ];
    const out = replayBalances(new Map([[USDC, 10_000_000n]]), deltas, stamps);
    expect(out.get(NOW - 2 * DAY)!.get(USDC)).toBe(0n);
  });

  it("複数 mint を独立に遡る", () => {
    const deltas: BalanceDelta[] = [
      { timestamp: NOW - DAY + 5, mint: USDC, amount: 1_000_000n },
      { timestamp: NOW - DAY + 5, mint: WSOL, amount: -500_000_000n },
    ];
    const out = replayBalances(
      new Map([
        [USDC, 5_000_000n],
        [WSOL, 1_000_000_000n],
      ]),
      deltas,
      stamps
    );
    expect(out.get(NOW - DAY)!.get(USDC)).toBe(4_000_000n);
    expect(out.get(NOW - DAY)!.get(WSOL)).toBe(1_500_000_000n);
  });
});

describe("buildHistorySeries", () => {
  const stamps = [NOW - DAY, NOW - 600];
  const solAsset: HistoryAsset = {
    mint: WSOL,
    symbol: "SOL",
    decimals: 9,
    feedId: SOL_FEED,
    currentUsd8: "73.00000000",
  };

  it("その時点の実価格で値付けする (残高が同じでも価格で動く)", () => {
    const balances = new Map([
      [NOW - DAY, new Map([[WSOL, 1_000_000_000n]])], // 1 SOL
      [NOW - 600, new Map([[WSOL, 1_000_000_000n]])],
    ]);
    const prices = new Map([
      [NOW - DAY, new Map([[SOL_FEED, "80.00000000"]])],
      [NOW - 600, new Map([[SOL_FEED, "73.00000000"]])],
    ]);
    const out = buildHistorySeries(stamps, balances, [solAsset], prices, SOL_FEED);
    expect(out.points.map((p) => p.usd)).toEqual(["80.00000000", "73.00000000"]);
    expect(out.points.map((p) => p.at)).toEqual(stamps);
    // SOL 建てはその時点の SOL 価格で割るので 1 SOL のまま
    expect(out.points.map((p) => p.sol)).toEqual(["1.00000000", "1.00000000"]);
    expect(out.approximatedSymbols).toEqual([]);
  });

  it("8.59: 同じ日の 2 点が別々の点として出る", () => {
    const intraday = [NOW - 4 * HOUR, NOW - 2 * HOUR];
    const balances = new Map(
      intraday.map((at) => [at, new Map([[WSOL, 1_000_000_000n]])])
    );
    const prices = new Map([
      [intraday[0]!, new Map([[SOL_FEED, "75.00000000"]])],
      [intraday[1]!, new Map([[SOL_FEED, "73.00000000"]])],
    ]);
    const out = buildHistorySeries(intraday, balances, [solAsset], prices, SOL_FEED);
    expect(out.points).toHaveLength(2);
    expect(utcDayKey(out.points[0]!.at)).toBe(utcDayKey(out.points[1]!.at));
    expect(out.points[0]!.usd).not.toBe(out.points[1]!.usd);
  });

  it("feed が無い asset は現在価格で近似し、symbol を申告する", () => {
    const jl: HistoryAsset = {
      mint: "JL_MINT",
      symbol: "jlUSDC",
      decimals: 6,
      currentUsd8: "1.05000000",
    };
    const balances = new Map(
      stamps.map((at) => [at, new Map([["JL_MINT", 10_000_000n]])])
    );
    const out = buildHistorySeries(stamps, balances, [jl], new Map(), undefined);
    expect(out.points.map((p) => p.usd)).toEqual(["10.50000000", "10.50000000"]);
    expect(out.approximatedSymbols).toEqual(["jlUSDC"]);
  });

  it("価格が全く引けない点は作らない (0 の谷を作らない)", () => {
    const noPrice: HistoryAsset = { mint: "X", symbol: "X", decimals: 6 };
    const balances = new Map([[NOW - 600, new Map([["X", 1_000_000n]])]]);
    const out = buildHistorySeries(
      [NOW - 600],
      balances,
      [noPrice],
      new Map(),
      SOL_FEED
    );
    expect(out.points).toEqual([]);
  });

  it("SOL 価格が無い点は sol='0' (USD は出す)", () => {
    const balances = new Map([[NOW - 600, new Map([[WSOL, 1_000_000_000n]])]]);
    const out = buildHistorySeries(
      [NOW - 600],
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

describe("utcDayKey", () => {
  it("UTC 基準で日付キーを作る", () => {
    expect(utcDayKey(Math.floor(Date.parse("2026-08-01T23:59:00Z") / 1000))).toBe(
      "2026-08-01"
    );
  });
});

describe("earliestFundedTime — 資産を持ち始めた時刻 (8.59)", () => {
  it("全 mint が 0 になる tx の時刻を返す (それ以前は空)", () => {
    // 現在 100 USDC。3 日前に +100 の入金 = それ以前は空
    const deltas: BalanceDelta[] = [
      { timestamp: NOW - 3 * DAY, mint: USDC, amount: 100_000_000n },
    ];
    expect(earliestFundedTime(new Map([[USDC, 100_000_000n]]), deltas)).toBe(
      NOW - 3 * DAY
    );
  });

  it("複数 mint はすべて空になった時点で判定する", () => {
    const deltas: BalanceDelta[] = [
      { timestamp: NOW - DAY, mint: WSOL, amount: 1_000_000_000n },
      { timestamp: NOW - 3 * DAY, mint: USDC, amount: 100_000_000n },
    ];
    const current = new Map([
      [USDC, 100_000_000n],
      [WSOL, 1_000_000_000n],
    ]);
    // USDC 入金 (3 日前) を戻した時点で両方 0 になる
    expect(earliestFundedTime(current, deltas)).toBe(NOW - 3 * DAY);
  });

  it("window 全体で保有していれば null (起点を絞らない)", () => {
    const deltas: BalanceDelta[] = [
      { timestamp: NOW - DAY, mint: USDC, amount: 10_000_000n },
    ];
    expect(
      earliestFundedTime(new Map([[USDC, 100_000_000n]]), deltas)
    ).toBeNull();
  });

  it("差分が無ければ null", () => {
    expect(earliestFundedTime(new Map([[USDC, 1n]]), [])).toBeNull();
  });
});
