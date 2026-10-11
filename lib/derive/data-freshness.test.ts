/**
 * wallet 由来データの鮮度ラベル (API 効率化計画 §4.0)。
 * 時刻はローカル TZ で組み立てる (formatUpdatedTime はローカル時刻を出す)。
 */
import {
  combineQueryFreshness,
  describeDataFreshness,
  formatUpdatedTime,
} from "./data-freshness";

const T = new Date(2026, 9, 12, 14, 21, 0).getTime();
const STALE = 60_000;

describe("describeDataFreshness", () => {
  it("staleAfterMs 以内で取得中でも失敗でもなければ fresh", () => {
    expect(
      describeDataFreshness({
        dataUpdatedAt: T,
        isFetching: false,
        isError: false,
        nowMs: T + 30_000,
        staleAfterMs: STALE,
      })
    ).toEqual({ kind: "fresh", label: "Updated 14:21" });
  });

  it("取得中は refreshing (旧値の時刻 + updating…)", () => {
    expect(
      describeDataFreshness({
        dataUpdatedAt: T,
        isFetching: true,
        isError: false,
        nowMs: T + 120_000,
        staleAfterMs: STALE,
      })
    ).toEqual({ kind: "refreshing", label: "Updated 14:21 · updating…" });
  });

  it("staleAfterMs を超えたら stale (awaiting update)", () => {
    expect(
      describeDataFreshness({
        dataUpdatedAt: T,
        isFetching: false,
        isError: false,
        nowMs: T + STALE + 1,
        staleAfterMs: STALE,
      })
    ).toEqual({ kind: "stale", label: "Updated 14:21 · awaiting update" });
  });

  it("失敗は取得中より優先して failed (旧値は残すが最新とは言わない)", () => {
    expect(
      describeDataFreshness({
        dataUpdatedAt: T,
        isFetching: true,
        isError: true,
        nowMs: T + 1_000,
        staleAfterMs: STALE,
      })
    ).toEqual({ kind: "failed", label: "Updated 14:21 · awaiting update" });
  });

  it("foreground 復帰は時計の tick とみなす: 止まった nowMs でも復帰時刻で stale 判定", () => {
    // background 中に interval が止まり nowMs は古いまま。復帰時刻では期限切れ
    expect(
      describeDataFreshness({
        dataUpdatedAt: T,
        isFetching: false,
        isError: false,
        resumedAt: T + 10 * 60_000,
        nowMs: T + 10_000,
        staleAfterMs: STALE,
      }).kind
    ).toBe("stale");
  });

  it("staleTime 内の復帰だけでは stale にしない (再取得が来ないのに awaiting と言わない)", () => {
    expect(
      describeDataFreshness({
        dataUpdatedAt: T,
        isFetching: false,
        isError: false,
        resumedAt: T + 20_000,
        nowMs: T + 20_000,
        staleAfterMs: STALE,
      }).kind
    ).toBe("fresh");
  });

  it("復帰後の再取得が完了すれば fresh に戻る (dataUpdatedAt > resumedAt)", () => {
    const resumedAt = T + 10 * 60_000;
    expect(
      describeDataFreshness({
        dataUpdatedAt: resumedAt + 800,
        isFetching: false,
        isError: false,
        resumedAt,
        nowMs: resumedAt + 1_000,
        staleAfterMs: STALE,
      }).kind
    ).toBe("fresh");
  });

  it("一度も取れていない時は時刻を出さない", () => {
    const base = { dataUpdatedAt: 0, nowMs: T, staleAfterMs: STALE };
    expect(describeDataFreshness({ ...base, isFetching: true, isError: false })).toEqual({
      kind: "refreshing",
      label: "Updating…",
    });
    expect(describeDataFreshness({ ...base, isFetching: false, isError: true })).toEqual({
      kind: "failed",
      label: "Couldn't load · awaiting update",
    });
    expect(describeDataFreshness({ ...base, isFetching: false, isError: false }).kind).toBe(
      "stale"
    );
  });
});

describe("formatUpdatedTime", () => {
  it("同じ日は HH:mm", () => {
    expect(formatUpdatedTime(new Date(2026, 9, 12, 9, 5).getTime(), T)).toBe("09:05");
  });

  it("日付が違えば月日を付ける (永続 cache から復元した前日の値)", () => {
    expect(formatUpdatedTime(new Date(2026, 9, 11, 23, 58).getTime(), T)).toBe(
      "Oct 11 23:58"
    );
  });
});

describe("combineQueryFreshness", () => {
  it("最も古い取得時刻・どれか取得中・どれか失敗 (保守的に合成)", () => {
    expect(
      combineQueryFreshness([
        { dataUpdatedAt: T, isFetching: false, isError: false },
        { dataUpdatedAt: T - 5_000, isFetching: true, isError: false },
        { dataUpdatedAt: T + 5_000, isFetching: false, isError: true },
      ])
    ).toEqual({ dataUpdatedAt: T - 5_000, isFetching: true, isError: true });
  });

  it("未取得 (0) の query は最古の判定から外す", () => {
    expect(
      combineQueryFreshness([
        { dataUpdatedAt: 0, isFetching: false, isError: false },
        { dataUpdatedAt: T, isFetching: false, isError: false },
      ]).dataUpdatedAt
    ).toBe(T);
    expect(combineQueryFreshness([]).dataUpdatedAt).toBe(0);
  });
});
