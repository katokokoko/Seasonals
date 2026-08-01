/**
 * portfolio history — 実測スナップショットの純関数 (Phase 8.56)。
 * 「1 日 1 点 / 過去を捏造しない / 壊れた永続データで落ちない」を固定する。
 */
import {
  MAX_SNAPSHOT_DAYS,
  dayKey,
  dayKeyToDate,
  parseSnapshots,
  snapshotsInRange,
  upsertSnapshot,
  type PortfolioSnapshot,
} from "./history";

describe("dayKey / dayKeyToDate", () => {
  it("端末のローカル日付で 1 日 1 点のキーを作る (UTC 変換しない)", () => {
    expect(dayKey(new Date(2026, 7, 1, 23, 30))).toBe("2026-08-01");
    expect(dayKey(new Date(2026, 0, 9, 0, 5))).toBe("2026-01-09");
  });

  it("キー → ローカル 0 時の Date に戻せる", () => {
    const d = dayKeyToDate("2026-08-01");
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(7);
    expect(d.getDate()).toBe(1);
  });
});

describe("upsertSnapshot", () => {
  it("同じ日は上書き (1 日 1 点)", () => {
    const out = upsertSnapshot(
      [
        { day: "2026-07-31", sol: 0.88 },
        { day: "2026-08-01", sol: 0.89 },
      ],
      { day: "2026-08-01", sol: 0.9 }
    );
    expect(out).toEqual([
      { day: "2026-07-31", sol: 0.88 },
      { day: "2026-08-01", sol: 0.9 },
    ]);
  });

  it("日付昇順に整列する (順不同で来ても)", () => {
    const out = upsertSnapshot([{ day: "2026-08-01", sol: 1 }], {
      day: "2026-07-01",
      sol: 2,
    });
    expect(out.map((s) => s.day)).toEqual(["2026-07-01", "2026-08-01"]);
  });

  it("上限 (730 日) を超えたら古い順に捨てる", () => {
    const many: PortfolioSnapshot[] = Array.from(
      { length: MAX_SNAPSHOT_DAYS },
      (_, i) => ({ day: `20${20 + Math.floor(i / 365)}-01-${(i % 28) + 1}`, sol: i })
    );
    // 実キーの重複を避けるため index をそのまま日付に使わず、末尾追加で検証
    const out = upsertSnapshot(many.slice(0, MAX_SNAPSHOT_DAYS), {
      day: "2099-12-31",
      sol: 99,
    });
    expect(out.length).toBeLessThanOrEqual(MAX_SNAPSHOT_DAYS);
    expect(out[out.length - 1]).toEqual({ day: "2099-12-31", sol: 99 });
  });
});

describe("parseSnapshots — 壊れた永続データで落ちない", () => {
  it("正常な配列はそのまま (日付順)", () => {
    expect(
      parseSnapshots([
        { day: "2026-08-01", sol: 2 },
        { day: "2026-07-31", sol: 1 },
      ])
    ).toEqual([
      { day: "2026-07-31", sol: 1 },
      { day: "2026-08-01", sol: 2 },
    ]);
  });

  it("配列でない / 型が違う項目は捨てる", () => {
    expect(parseSnapshots(null)).toEqual([]);
    expect(parseSnapshots("nope")).toEqual([]);
    expect(
      parseSnapshots([
        { day: "bad", sol: 1 },
        { day: "2026-08-01", sol: "1" },
        { day: "2026-08-01", sol: Number.NaN },
        { day: "2026-08-02", sol: 3 },
      ])
    ).toEqual([{ day: "2026-08-02", sol: 3 }]);
  });
});

describe("snapshotsInRange", () => {
  const TODAY = new Date(2026, 7, 1);
  const snaps: PortfolioSnapshot[] = [
    { day: "2026-06-01", sol: 1 },
    { day: "2026-07-26", sol: 2 },
    { day: "2026-08-01", sol: 3 },
  ];

  it("1W は 7 日前以降だけ", () => {
    expect(snapshotsInRange(snaps, 7, TODAY).map((s) => s.day)).toEqual([
      "2026-07-26",
      "2026-08-01",
    ]);
  });

  it("1M は 30 日前以降", () => {
    expect(snapshotsInRange(snaps, 30, TODAY)).toHaveLength(2);
  });

  it("ALL (730 日) は全部", () => {
    expect(snapshotsInRange(snaps, 730, TODAY)).toHaveLength(3);
  });

  it("未来日 (端末時計のズレ等) は含めない", () => {
    const withFuture = [...snaps, { day: "2026-09-01", sol: 9 }];
    expect(snapshotsInRange(withFuture, 730, TODAY).map((s) => s.day)).not.toContain(
      "2026-09-01"
    );
  });
});
