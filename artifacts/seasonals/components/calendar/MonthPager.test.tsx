/**
 * MonthPager — follow + fade-through swipe のテスト (Phase 8.83 → 8.84)
 *
 * 8.81 の commit-first / cancel-safe 特性の regression 固定 + velocity commit。
 * 8.84: carousel 撤去 → 単一 grid。閾値は projected (translation + velocity×0.18)
 * に対して ±70px。
 */
import React from "react";
import { render, screen, waitFor } from "@testing-library/react-native";
import {
  fireGestureHandler,
  getByGestureTestId,
} from "react-native-gesture-handler/jest-utils";
import { State } from "react-native-gesture-handler";
import type { PanGesture } from "react-native-gesture-handler";

import { MonthPager } from "./MonthPager";

const MONTH = new Date(2026, 6, 1); // 2026-07
const TODAY = new Date(2026, 6, 10);

function renderPager() {
  const onChangeMonth = jest.fn();
  render(
    <MonthPager
      month={MONTH}
      onChangeMonth={onChangeMonth}
      events={[]}
      selectedDay={null}
      onDayPress={() => undefined}
      today={TODAY}
      testID="pager"
    />
  );
  return onChangeMonth;
}

const swipe = (
  translationX: number,
  opts: { velocityX?: number; finalState?: State } = {}
) => {
  const { velocityX = 0, finalState = State.END } = opts;
  fireGestureHandler<PanGesture>(getByGestureTestId("month-swipe"), [
    { state: State.BEGAN, translationX: 0 },
    { state: State.ACTIVE, translationX: translationX / 2 },
    { state: finalState, translationX, velocityX },
  ]);
};

describe("MonthPager — 単一 grid 描画 (8.84: carousel 撤去)", () => {
  it("当月 grid だけが描画される", () => {
    renderPager();
    expect(screen.getByTestId("pager-grid")).toBeTruthy();
    expect(screen.getByTestId("pager-grid-day-2026-07-15")).toBeTruthy();
    // 隣月のセルは存在しない (単一 grid)
    expect(screen.queryByTestId("pager-grid-day-2026-08-15")).toBeNull();
  });
});

describe("MonthPager — commit (8.81 特性の維持)", () => {
  // NOTE: onEnd → runOnJS(commit) は JS thread では microtask 経由の
  // 非同期呼び出しになるため、commit の観測は waitFor で行う

  it("閾値超の左 swipe で翌月へ commit-first (アニメ完了待ちなし)", async () => {
    const onChangeMonth = renderPager();
    swipe(-100);
    await waitFor(() => expect(onChangeMonth).toHaveBeenCalledTimes(1));
    expect(onChangeMonth).toHaveBeenCalledWith(new Date(2026, 7, 1)); // 2026-08
  });

  it("閾値超の右 swipe で前月へ", async () => {
    const onChangeMonth = renderPager();
    swipe(100);
    await waitFor(() =>
      expect(onChangeMonth).toHaveBeenCalledWith(new Date(2026, 5, 1))
    ); // 2026-06
  });

  it("移動が小さく velocity も無ければ commit しない (spring back)", async () => {
    const onChangeMonth = renderPager();
    swipe(-40);
    swipe(40);
    await Promise.resolve();
    expect(onChangeMonth).not.toHaveBeenCalled();
  });

  it("移動が小さくても velocity が大きければ commit (flick)", async () => {
    const onChangeMonth = renderPager();
    // projected = -40 + (-3000 × 0.18) = -580 → 閾値 70 超
    swipe(-40, { velocityX: -3000 });
    await waitFor(() =>
      expect(onChangeMonth).toHaveBeenCalledWith(new Date(2026, 7, 1))
    );
  });

  it("巨大な swipe でも 1 回の commit は ±1 ヶ月", async () => {
    const onChangeMonth = renderPager();
    swipe(-2000, { velocityX: -8000 });
    await waitFor(() => expect(onChangeMonth).toHaveBeenCalledTimes(1));
    expect(onChangeMonth).toHaveBeenCalledWith(new Date(2026, 7, 1));
  });

  it("キャンセルされた pan (FAILED / CANCELLED) では commit しない", async () => {
    const onChangeMonth = renderPager();
    swipe(-200, { finalState: State.FAILED });
    swipe(-200, { finalState: State.CANCELLED });
    await Promise.resolve();
    expect(onChangeMonth).not.toHaveBeenCalled();
  });

  it("連打: settle 完了を待たない再 swipe でも毎回 commit (固まらない)", async () => {
    const onChangeMonth = renderPager();
    swipe(-100);
    swipe(-100);
    swipe(-100);
    await waitFor(() => expect(onChangeMonth).toHaveBeenCalledTimes(3));
  });
});
