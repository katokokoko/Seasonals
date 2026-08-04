/**
 * MonthGrid — Phase 8.39: day cell の高さ安定化 (マーカー有無で縦幅が揺れない)。
 *
 * jsdom では実レイアウト寸法を測れないため、「高さ定数化の実体」である
 * (a) マーカー無し日にも固定高さスロットが常時描画されること、
 * (b) マーカーが折返しなしの上限 (droplet 3 + custom 1 + "+N") に収まること、
 * を構造で固定する。実寸の行高さ均一は実機/emulator 目視 (confirm.md §A)。
 */
import React from "react";
import { render, screen } from "@testing-library/react-native";

import { TimeEventCategory, Urgency } from "@workspace/lib/types";
import type { CustomEvent, UnifiedTimeEvent } from "@workspace/lib/types";

import { MonthGrid, gridDaysOfMonth } from "./MonthGrid";

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

  it("イベント 6 件の日: droplet は 3 個 + '+3' (8.86: 表示上限 3 と整合)", () => {
    const events = [1, 2, 3, 4, 5, 6].map((i) => event(`e${i}`, 20));
    renderGrid(events);
    const droplets = [1, 2, 3, 4, 5, 6].filter(
      (i) => screen.queryByTestId(`droplet-e${i}`) !== null
    );
    expect(droplets).toHaveLength(3);
    expect(screen.getByText("+3")).toBeTruthy(); // 6 - 3 表示枠
  });

  it("8.86: custom だけの日は絵文字が 3 個まで並ぶ", () => {
    renderGrid(
      [],
      [custom("c1", 21), custom("c2", 21), custom("c3", 21), custom("c4", 21)]
    );
    expect(screen.getAllByText("🎈")).toHaveLength(3);
    expect(screen.getByText("+1")).toBeTruthy(); // 4 - 3
  });

  it("8.86: droplet 2 + custom 2 → droplet 2 + 絵文字 1 + '+1' (droplet 優先)", () => {
    renderGrid(
      [event("a", 22), event("b", 22)],
      [custom("c1", 22), custom("c2", 22)]
    );
    expect(screen.getByTestId("droplet-a")).toBeTruthy();
    expect(screen.getByTestId("droplet-b")).toBeTruthy();
    expect(screen.getAllByText("🎈")).toHaveLength(1);
    expect(screen.getByText("+1")).toBeTruthy(); // 4 - 3
  });

  it("8.86: イベント 4 件 (custom 0) の日も '+1' が出る (旧 off-by-one の regression)", () => {
    const events = [1, 2, 3, 4].map((i) => event(`e${i}`, 23));
    renderGrid(events);
    expect(screen.getByText("+1")).toBeTruthy();
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
// 8.83: gridDaysOfMonth — swipe 系のテストは MonthPager.test.tsx へ移動
// ─────────────────────────────────────────────────────────────────────────────

describe("gridDaysOfMonth", () => {
  // 8.85: grid 高さを月によらず一定にするため常に 6 週 (42 日)
  it("5 週で終わる月 (2026-07) も 42 日 — 翌月の 1 週で埋める", () => {
    const days = gridDaysOfMonth(new Date(2026, 6, 1));
    expect(days).toHaveLength(42);
    expect(days[0]!.getDay()).toBe(1); // Mon
    expect(days[41]!.getDay()).toBe(0); // Sun
    // 6 行目は 8 月の日 (out-of-month として淡色表示される)
    expect(days[35]!.getMonth()).toBe(7);
  });

  it("6 週の月 (2026-08) も 42 日", () => {
    const days = gridDaysOfMonth(new Date(2026, 7, 1));
    expect(days).toHaveLength(42);
    // 月内の日が最終週まで入る (2026-08-31 は 6 行目の月曜)
    expect(days[35]!.getDate()).toBe(31);
    expect(days[35]!.getMonth()).toBe(7);
  });

  it("月初の週は前月分で埋まる (2026-08-01 は土曜 → 先頭は 7/27)", () => {
    const days = gridDaysOfMonth(new Date(2026, 7, 1));
    expect(days[0]!.getMonth()).toBe(6);
    expect(days[0]!.getDate()).toBe(27);
  });

  it("全要素が 1 日刻み (旧 +86400s 実装の DST ずれ regression 固定)", () => {
    const days = gridDaysOfMonth(new Date(2026, 2, 1)); // 3 月 (US DST 跨ぎ月)
    for (let i = 1; i < days.length; i++) {
      expect(days[i]!.getDate()).not.toBe(days[i - 1]!.getDate());
      expect(days[i]!.getHours()).toBe(days[0]!.getHours());
    }
  });
});
