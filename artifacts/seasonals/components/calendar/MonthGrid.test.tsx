/**
 * MonthGrid — Phase 8.39: day cell の高さ安定化 (マーカー有無で縦幅が揺れない)。
 *
 * jsdom では実レイアウト寸法を測れないため、「高さ定数化の実体」である
 * (a) マーカー無し日にも固定高さスロットが常時描画されること、
 * (b) マーカーが折返しなしの上限 (droplet 3 + custom 1 + "+N") に収まること、
 * を構造で固定する。実寸の行高さ均一は実機/emulator 目視 (confirm.md §A)。
 */
import React from "react";
import { render, screen, waitFor } from "@testing-library/react-native";
import {
  fireGestureHandler,
  getByGestureTestId,
} from "react-native-gesture-handler/jest-utils";
import { State } from "react-native-gesture-handler";
import type { PanGesture } from "react-native-gesture-handler";

import { TimeEventCategory, Urgency } from "@workspace/lib/types";
import type { CustomEvent, UnifiedTimeEvent } from "@workspace/lib/types";

import { MonthGrid } from "./MonthGrid";

const MONTH = new Date(2026, 6, 1); // 2026-07 (local)
const TODAY = new Date(2026, 6, 10);

function event(id: string, day: number, urgency: Urgency = Urgency.Info): UnifiedTimeEvent {
  return {
    id,
    protocol: "kamino",
    category: TimeEventCategory.Claim,
    triggerAt: new Date(2026, 6, day, 12, 0, 0),
    urgency,
    walletAddress: "W",
    positionRef: null,
    actions: [],
    agentReadable: true,
    metadata: {},
  };
}

function custom(id: string, day: number): CustomEvent {
  return {
    id,
    date: `2026-07-${String(day).padStart(2, "0")}`,
    title: `c-${id}`,
    marker: "emoji",
    emoji: "🎈",
  } as CustomEvent;
}

function renderGrid(events: UnifiedTimeEvent[], customEvents: CustomEvent[] = []) {
  return render(
    <MonthGrid
      month={MONTH}
      onChangeMonth={() => undefined}
      events={events}
      customEvents={customEvents}
      selectedDay={null}
      onDayPress={() => undefined}
      today={TODAY}
      testID="grid"
    />
  );
}

describe("MonthGrid — 8.39 cell 高さ安定化", () => {
  it("イベント無しの日にもマーカースロットが常時描画される (高さ定数化)", () => {
    renderGrid([]);
    // 月内の任意の日 (7/15) — イベントゼロでもスロットが存在する
    expect(screen.getByTestId("grid-day-2026-07-15-markers")).toBeTruthy();
    expect(screen.getByTestId("grid-day-2026-07-16-markers")).toBeTruthy();
  });

  it("イベント 6 件の日: droplet は 3 個 + '+2' (折返しなしの上限)", () => {
    const events = [1, 2, 3, 4, 5, 6].map((i) => event(`e${i}`, 20));
    renderGrid(events);
    const droplets = [1, 2, 3, 4, 5, 6].filter(
      (i) => screen.queryByTestId(`droplet-e${i}`) !== null
    );
    expect(droplets).toHaveLength(3);
    expect(screen.getByText("+2")).toBeTruthy(); // 6 - 4 表示枠
  });

  it("custom event は 1 個まで表示、超過は '+N' に合算される", () => {
    renderGrid([], [custom("c1", 21), custom("c2", 21), custom("c3", 21)]);
    // emoji は 1 個だけ
    expect(screen.getAllByText("🎈")).toHaveLength(1);
    // 3 件中 1 件表示 → +N は total(3) - 4 では負…条件は total > 4 なので出ない
    expect(screen.queryByText(/^\+/)).toBeNull();
  });

  it("urgency-first: critical は 4 件目でも表示枠に入る (§5.3)", () => {
    const events = [
      event("i1", 22, Urgency.Info),
      event("i2", 22, Urgency.Info),
      event("i3", 22, Urgency.Info),
      event("crit", 22, Urgency.Critical),
    ];
    renderGrid(events);
    expect(screen.getByTestId("droplet-crit")).toBeTruthy(); // sort で先頭へ
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8.81: 月送り swipe — commit-first 方式 (固まりバグの regression 固定)
// ─────────────────────────────────────────────────────────────────────────────

describe("MonthGrid — 8.81 月送り swipe", () => {
  function renderWithSpy() {
    const onChangeMonth = jest.fn();
    render(
      <MonthGrid
        month={MONTH}
        onChangeMonth={onChangeMonth}
        events={[]}
        selectedDay={null}
        onDayPress={() => undefined}
        today={TODAY}
        testID="grid"
      />
    );
    return onChangeMonth;
  }

  const swipe = (translationX: number, finalState: State = State.END) => {
    fireGestureHandler<PanGesture>(getByGestureTestId("month-swipe"), [
      { state: State.BEGAN, translationX: 0 },
      { state: State.ACTIVE, translationX: translationX / 2 },
      { state: finalState, translationX },
    ]);
  };

  // NOTE: onEnd → runOnJS(commitMonth) は JS thread では microtask 経由の
  // 非同期呼び出しになるため、commit の観測は waitFor で行う

  it("左 swipe (-50px 超) で即座に翌月へ commit する (完了 callback 待ちなし)", async () => {
    const onChangeMonth = renderWithSpy();
    swipe(-60);
    // commit-first: アニメ完了 (旧 140ms slide-out) を待たずに翌月が確定する。
    // 旧実装 (slide-out 完了 callback で commit) は連打キャンセルで
    // commit ごと落ちて固まっていた
    await waitFor(() => expect(onChangeMonth).toHaveBeenCalledTimes(1));
    expect(onChangeMonth).toHaveBeenCalledWith(new Date(2026, 7, 1)); // 2026-08
  });

  it("右 swipe (+50px 超) で前月へ", async () => {
    const onChangeMonth = renderWithSpy();
    swipe(60);
    await waitFor(() =>
      expect(onChangeMonth).toHaveBeenCalledWith(new Date(2026, 5, 1))
    ); // 2026-06
  });

  it("threshold 未満 (±50px 以内) では commit しない", async () => {
    const onChangeMonth = renderWithSpy();
    swipe(-30);
    swipe(30);
    await Promise.resolve(); // runOnJS の microtask を flush
    expect(onChangeMonth).not.toHaveBeenCalled();
  });

  it("キャンセルされた pan (FAILED / CANCELLED) では commit しない", async () => {
    const onChangeMonth = renderWithSpy();
    swipe(-80, State.FAILED);
    swipe(-80, State.CANCELLED);
    await Promise.resolve();
    expect(onChangeMonth).not.toHaveBeenCalled();
  });

  it("連打: アニメ中の再 swipe でも毎回 commit される (固まらない)", async () => {
    const onChangeMonth = renderWithSpy();
    swipe(-60);
    swipe(-60); // 1 回目の settle (180ms) 完了を待たずに発火
    swipe(-60);
    await waitFor(() => expect(onChangeMonth).toHaveBeenCalledTimes(3));
  });
});
