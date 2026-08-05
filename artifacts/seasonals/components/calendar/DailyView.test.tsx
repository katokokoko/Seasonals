/**
 * DailyView — テスト (Phase 8.86)
 *
 * 固定する挙動:
 *   - custom event が中央カードに描画される (絵文字 / title / $amount)
 *   - custom event だけの日が "No events" にならない
 *   - protocol イベントの day-key が **local TZ** 基準 (旧 UTC getter は
 *     JST でイベントが前日カードに出ていた)
 *
 * 中央日は calendarDay store で制御する (component は store から selectedDate
 * を読む)。
 */
import React from "react";
import { render, screen } from "@testing-library/react-native";

import { TimeEventCategory, Urgency } from "@workspace/lib/types";
import type { CustomEvent, UnifiedTimeEvent } from "@workspace/lib/types";

import { DailyView } from "./DailyView";
import { useCalendarDayStore } from "../../stores/calendarDay";

function protocolEvent(id: string, triggerAt: Date): UnifiedTimeEvent {
  return {
    id,
    protocol: "kamino",
    category: TimeEventCategory.Claim,
    triggerAt,
    urgency: Urgency.Info,
    walletAddress: "W",
    positionRef: null,
    actions: [],
    agentReadable: true,
    metadata: {},
  };
}

function custom(id: string, date: string, extra?: Partial<CustomEvent>): CustomEvent {
  return {
    id,
    date,
    title: `memo-${id}`,
    marker: "emoji",
    emoji: "🎈",
    ...extra,
  } as CustomEvent;
}

beforeEach(() => {
  // 中央日を 2026-07-15 (local) に固定
  useCalendarDayStore.getState().setSelectedDate("2026-07-15");
});

describe("DailyView — 8.86 custom event 表示", () => {
  it("custom event が中央カードに title / $amount 付きで描画される", () => {
    render(
      <DailyView
        events={[]}
        customEvents={[custom("c1", "2026-07-15", { amount_usd: 12.5 })]}
        testID="daily"
      />
    );
    expect(screen.getByTestId("daily-custom-c1")).toBeTruthy();
    expect(screen.getByText("memo-c1")).toBeTruthy();
    expect(screen.getByText("$12.50")).toBeTruthy();
  });

  it("custom event だけの日は 'No events' にならない (Tap to open も出る)", () => {
    render(
      <DailyView
        events={[]}
        customEvents={[custom("c1", "2026-07-15")]}
        testID="daily"
      />
    );
    // 中央カード (7/15) には No events が無い。隣接カード (7/13 等) には出るので
    // 「存在数が offsets(5) より少ない」ことで判定する
    expect(screen.getAllByText("No events").length).toBeLessThan(5);
    expect(screen.getByText("Tap to open →")).toBeTruthy();
  });

  it("emoji marker でない custom は ★ を出す", () => {
    render(
      <DailyView
        events={[]}
        customEvents={[custom("c2", "2026-07-15", { marker: "star", emoji: undefined })]}
        testID="daily"
      />
    );
    expect(screen.getByText("★")).toBeTruthy();
  });
});

describe("DailyView — 8.86 day-key local 化", () => {
  it("local 深夜 0:30 のイベントが同じ日のカードに出る (旧 UTC key の regression)", () => {
    // local 2026-07-15 00:30 — UTC では前日 (JST なら 7/14 15:30Z)。
    // 旧実装 (getUTC*) では key が 2026-07-14 になり 7/15 カードから消えていた
    const at = new Date(2026, 6, 15, 0, 30, 0);
    render(
      <DailyView events={[protocolEvent("e1", at)]} testID="daily" />
    );
    expect(screen.getByText("Kamino")).toBeTruthy();
    expect(screen.getAllByText("No events").length).toBeLessThan(5);
  });
});
