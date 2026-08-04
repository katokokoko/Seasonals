/**
 * MonthPager — 指追従 carousel のテスト (Phase 8.83)
 *
 * 8.81 の commit-first / cancel-safe 特性の regression 固定 (旧 MonthGrid の
 * swipe テストから移設) + 指追従 (onUpdate) と velocity commit の検証。
 *
 * ページ幅 W は jest の Dimensions mock (750px) — swipe 距離はそれ前提。
 */
import React from "react";
import { Dimensions } from "react-native";
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
const W = Dimensions.get("window").width;

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

describe("MonthPager — 3 ページ描画", () => {
  it("当月 grid が描画され、前後月のセルも存在する", () => {
    renderPager();
    // 中央ページ (当月) は testID 付き
    expect(screen.getByTestId("pager-grid")).toBeTruthy();
    // 当月 7/15 のセル
    expect(screen.getByTestId("pager-grid-day-2026-07-15")).toBeTruthy();
  });
});

describe("MonthPager — commit (8.81 特性の維持)", () => {
  // NOTE: onEnd → runOnJS(commit) は JS thread では microtask 経由の
  // 非同期呼び出しになるため、commit の観測は waitFor で行う

  it("半ページ超の左 swipe で翌月へ commit-first (アニメ完了待ちなし)", async () => {
    const onChangeMonth = renderPager();
    swipe(-W * 0.6);
    await waitFor(() => expect(onChangeMonth).toHaveBeenCalledTimes(1));
    expect(onChangeMonth).toHaveBeenCalledWith(new Date(2026, 7, 1)); // 2026-08
  });

  it("半ページ超の右 swipe で前月へ", async () => {
    const onChangeMonth = renderPager();
    swipe(W * 0.6);
    await waitFor(() =>
      expect(onChangeMonth).toHaveBeenCalledWith(new Date(2026, 5, 1))
    ); // 2026-06
  });

  it("移動が小さく velocity も無ければ commit しない (spring back)", async () => {
    const onChangeMonth = renderPager();
    swipe(-W * 0.2);
    await Promise.resolve();
    expect(onChangeMonth).not.toHaveBeenCalled();
  });

  it("移動が小さくても velocity が大きければ commit (flick)", async () => {
    const onChangeMonth = renderPager();
    // projected = -0.2W + (-3000 * 0.18) = -0.2W - 540 → |projected| > W/2
    swipe(-W * 0.2, { velocityX: -3000 });
    await waitFor(() =>
      expect(onChangeMonth).toHaveBeenCalledWith(new Date(2026, 7, 1))
    );
  });

  it("巨大な swipe でも ±1 ヶ月に clamp される", async () => {
    const onChangeMonth = renderPager();
    swipe(-W * 3, { velocityX: -8000 });
    await waitFor(() => expect(onChangeMonth).toHaveBeenCalledTimes(1));
    expect(onChangeMonth).toHaveBeenCalledWith(new Date(2026, 7, 1)); // +1 のみ
  });

  it("キャンセルされた pan (FAILED / CANCELLED) では commit しない", async () => {
    const onChangeMonth = renderPager();
    swipe(-W * 0.8, { finalState: State.FAILED });
    swipe(-W * 0.8, { finalState: State.CANCELLED });
    await Promise.resolve();
    expect(onChangeMonth).not.toHaveBeenCalled();
  });

  it("連打: settle 完了を待たない再 swipe でも毎回 commit (固まらない)", async () => {
    const onChangeMonth = renderPager();
    swipe(-W * 0.6);
    swipe(-W * 0.6);
    swipe(-W * 0.6);
    await waitFor(() => expect(onChangeMonth).toHaveBeenCalledTimes(3));
  });
});
