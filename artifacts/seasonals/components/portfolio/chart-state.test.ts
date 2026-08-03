/**
 * chart-state — テスト (Phase 8.76)
 *
 * ここで固定するのは優先順位。特に「表示中のチャートを refetch で消さない」と
 * 「未接続ユーザーに brewing を見せない」の 2 点が UX の骨子。
 */
import { chartAreaState } from "./chart-state";

describe("chartAreaState", () => {
  it("読込中 + チャート不可 → brewing", () => {
    expect(
      chartAreaState({ hasPositions: true, showChart: false, historyFetching: true })
    ).toBe("brewing");
  });

  it("showChart は fetching 中でも chart (refetch で表示中のチャートを消さない)", () => {
    expect(
      chartAreaState({ hasPositions: true, showChart: true, historyFetching: true })
    ).toBe("chart");
  });

  it("position 無し → connect (fetching 中でも brewing は見せない)", () => {
    expect(
      chartAreaState({ hasPositions: false, showChart: false, historyFetching: true })
    ).toBe("connect");
    expect(
      chartAreaState({ hasPositions: false, showChart: false, historyFetching: false })
    ).toBe("connect");
  });

  it("取得済みで描ける点が無い → placeholder (既存 Tracking since カード)", () => {
    expect(
      chartAreaState({ hasPositions: true, showChart: false, historyFetching: false })
    ).toBe("placeholder");
  });

  it("range chip 切替で cache 済み → chart 即描画 (brewing を挟まない)", () => {
    // 切替直後: 新 query key が cache hit していれば showChart が既に true
    expect(
      chartAreaState({ hasPositions: true, showChart: true, historyFetching: false })
    ).toBe("chart");
  });
});
