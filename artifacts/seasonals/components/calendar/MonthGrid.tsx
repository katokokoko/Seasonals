/**
 * MonthGrid — 月表示の calendar grid (CLAUDE.md §5.3)
 *
 * 各 day cell に該当する UnifiedTimeEvent を DropletMarker で集約表示。
 * 7 列 × 5-6 行の標準的な monthly grid。Tap で onDayPress を呼ぶ。
 *
 * NOTE: prototype の Calendar.tsx は gesture / reanimated 使用だが、本層は依存を増やさず
 * 静的な grid で MVP を出す。Phase B で gesture pull-to-refresh + animated cell pulse 追加。
 */

import React, { useMemo } from "react";
import {
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import {
  Gesture,
  GestureDetector,
} from "react-native-gesture-handler";
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import {
  addMonths,
  endOfMonth,
  endOfWeek,
  isSameDay,
  isSameMonth,
  startOfMonth,
  startOfWeek,
  format,
} from "date-fns";

import {
  FONT,
  FONT_SIZE,
  RADIUS,
  SPACE,
  WEIGHT,
  withAlpha,
} from "@workspace/lib/design-system";
import type {
  CustomEvent,
  UnifiedTimeEvent,
} from "@workspace/lib/types";

import { DropletMarker } from "./DropletMarker";
import { dropletShapeForEvent, sortEventsByUrgency } from "./event-display";
import {
  useThemedStyles,
  type ThemeColors,
} from "../../stores/theme";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function localDayKey(day: Date): string {
  return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
}

function eventDayKey(triggerAt: UnifiedTimeEvent["triggerAt"]): string {
  // Phase 8.3.1: local TZ で日付 key を生成。cell の localDayKey と TZ 一致させる。
  const ts = triggerAt instanceof Date ? triggerAt : new Date(triggerAt);
  return `${ts.getFullYear()}-${String(ts.getMonth() + 1).padStart(2, "0")}-${String(ts.getDate()).padStart(2, "0")}`;
}

function eventsOnDay(events: UnifiedTimeEvent[], day: Date): UnifiedTimeEvent[] {
  const key = localDayKey(day);
  return events.filter((e) => eventDayKey(e.triggerAt) === key);
}

function customEventsOnDay(
  customEvents: CustomEvent[],
  day: Date
): CustomEvent[] {
  return customEvents.filter((e) => {
    const [y, m, d] = e.date.split("-").map(Number);
    return (
      day.getFullYear() === y &&
      day.getMonth() + 1 === m &&
      day.getDate() === d
    );
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Props
// ─────────────────────────────────────────────────────────────────────────────

export interface MonthGridProps {
  month: Date;
  /** swipe で月送りされた時の callback (next month を渡す) */
  onChangeMonth: (next: Date) => void;
  events: UnifiedTimeEvent[];
  /** ユーザーが追加した CustomEvent (任意) */
  customEvents?: CustomEvent[];
  selectedDay: Date | null;
  onDayPress: (day: Date) => void;
  /** 今日として扱う日 (test では override 可能、default は new Date()) */
  today?: Date;
  testID?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export function MonthGrid({
  month,
  onChangeMonth,
  events,
  customEvents = [],
  selectedDay,
  onDayPress,
  today = new Date(),
  testID,
}: MonthGridProps) {
  // Phase 8.0: theme 連動 styles
  const styles = useThemedStyles(makeStyles);

  const days = useMemo(() => {
    // Monday start, fill until end of last week of month
    const start = startOfWeek(startOfMonth(month), { weekStartsOn: 1 });
    const end = endOfWeek(endOfMonth(month), { weekStartsOn: 1 });
    const out: Date[] = [];
    for (let d = start; d <= end; d = new Date(d.getTime() + 86400 * 1000)) {
      out.push(new Date(d));
    }
    return out;
  }, [month]);

  // Phase 5A.7 prototype 仕様: discrete slide+fade (peek なし、withTiming 駆動、threshold ±50px)
  const tx = useSharedValue(0);
  const opacity = useSharedValue(1);

  // worklet 経由で date-fns を呼べないため、delta を JS thread に渡してから addMonths
  const commitMonth = (delta: number) => {
    onChangeMonth(addMonths(month, delta));
  };

  const animateChange = (delta: number) => {
    opacity.value = withTiming(0.3, { duration: 120 });
    tx.value = withTiming(delta > 0 ? -40 : 40, { duration: 140 }, (finished) => {
      "worklet";
      if (!finished) return;
      runOnJS(commitMonth)(delta);
      // re-base: 新月を反対側から slide-in
      tx.value = delta > 0 ? 40 : -40;
      tx.value = withTiming(0, { duration: 180 });
      opacity.value = withTiming(1, { duration: 220 });
    });
  };

  const swipeGesture = Gesture.Pan()
    .activeOffsetX([-12, 12])
    .failOffsetY([-15, 15])
    .onEnd((e) => {
      "worklet";
      if (e.translationX < -50) runOnJS(animateChange)(1);
      else if (e.translationX > 50) runOnJS(animateChange)(-1);
    });

  const animStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: tx.value }],
    opacity: opacity.value,
  }));

  return (
    <GestureDetector gesture={swipeGesture}>
      <Animated.View style={[styles.container, animStyle]} testID={testID}>
        {/* Weekday headers (C3: 土日も中性色) */}
        <View style={styles.weekdayRow}>
        {WEEKDAYS.map((w) => (
          <Text key={w} style={styles.weekday}>
            {w}
          </Text>
        ))}
      </View>

      {/* Day cells */}
      <View style={styles.grid}>
        {days.map((day) => {
          const inMonth = isSameMonth(day, month);
          const isToday = isSameDay(day, today);
          const isSelected = selectedDay !== null && isSameDay(day, selectedDay);
          const dayEvents = eventsOnDay(events, day);
          const dayCustom = customEventsOnDay(customEvents, day);

          return (
            <Pressable
              key={day.toISOString()}
              accessibilityRole="button"
              onPress={() => onDayPress(day)}
              style={[
                styles.cell,
                !inMonth && styles.cellOutMonth,
                isToday && styles.cellToday,
                isSelected && styles.cellSelected,
              ]}
              testID={
                testID ? `${testID}-day-${format(day, "yyyy-MM-dd")}` : undefined
              }
            >
              <Text
                style={[
                  styles.dayNum,
                  !inMonth && styles.dayNumOutMonth,
                  isToday && styles.dayNumToday,
                ]}
              >
                {format(day, "d")}
              </Text>
              {/* Phase 8.39: マーカー行は **常時描画の固定高さスロット** —
                  条件付き描画だとセルの content 高さがアイコン有無で変わり、
                  flexWrap 行の高さ (= 行内最大セル) が月の行ごとに揺れていた。
                  空でも同高を占有することで全セル同高 = 行高さ均一を保証する */}
              <View
                style={styles.markerSlot}
                testID={
                  testID
                    ? `${testID}-day-${format(day, "yyyy-MM-dd")}-markers`
                    : undefined
                }
              >
                {/* §5.3: urgency-first — critical が 4 件目以降で隠れないよう sort */}
                {sortEventsByUrgency(dayEvents).slice(0, 3).map((e) => (
                  <DropletMarker
                    key={e.id}
                    category={dropletShapeForEvent(e)}
                    urgency={e.urgency}
                    size={9}
                    testID={`droplet-${e.id}`}
                  />
                ))}
                {/* 8.39: 1 行 (折返しなし) に収める — custom は 1 個まで */}
                {dayCustom.slice(0, 1).map((ce) => (
                  <Text key={ce.id} style={styles.customMarker}>
                    {ce.marker === "emoji" && ce.emoji ? ce.emoji : "★"}
                  </Text>
                ))}
                {dayEvents.length + dayCustom.length > 4 && (
                  <Text style={styles.moreCount}>
                    +{dayEvents.length + dayCustom.length - 4}
                  </Text>
                )}
              </View>
            </Pressable>
          );
        })}
        </View>
      </Animated.View>
    </GestureDetector>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────────────────────

// Phase 8.0: theme 連動 styles factory (sodaDeep は palette 外 → sodaText を流用)
function makeStyles(c: ThemeColors) {
  return StyleSheet.create({
    container: {
      paddingHorizontal: SPACE.md,
      gap: SPACE.sm,
    },
    monthLabelRow: {
      flexDirection: "row",
      alignItems: "baseline",
      paddingHorizontal: SPACE.sm,
      gap: 8,
    },
    monthLabelMonth: {
      fontSize: FONT_SIZE.displayMD,
      fontFamily: FONT.heading,
      fontWeight: WEIGHT.bold,
      color: c.textPrimary,
    },
    monthLabelYear: {
      fontSize: FONT_SIZE.bodyLG,
      fontFamily: FONT.heading,
      fontWeight: WEIGHT.regular,
      color: c.textMuted,
    },
    weekdayRow: {
      flexDirection: "row",
    },
    weekday: {
      flex: 1,
      fontSize: FONT_SIZE.caption,
      fontFamily: FONT.body,
      fontWeight: WEIGHT.semibold,
      color: c.textMuted,
      textAlign: "center",
      paddingVertical: SPACE.xs,
    },
    grid: {
      flexDirection: "row",
      flexWrap: "wrap",
    },
    cell: {
      width: `${100 / 7}%`,
      aspectRatio: 1,
      paddingHorizontal: 2,
      paddingVertical: 4,
      borderRadius: RADIUS.sm,
      alignItems: "center",
      justifyContent: "flex-start",
      gap: 2,
    },
    cellOutMonth: {
      opacity: 0.32,
    },
    cellToday: {
      backgroundColor: withAlpha(c.sodaText, 0.18),
      borderRadius: 100,
    },
    cellSelected: {
      backgroundColor: c.sodaLight,
      borderRadius: 100,
    },
    dayNum: {
      fontSize: FONT_SIZE.bodyMD,
      fontFamily: FONT.heading,
      fontWeight: WEIGHT.semibold,
      color: c.textPrimary,
    },
    dayNumOutMonth: {
      color: c.textMuted,
    },
    dayNumToday: {
      color: c.sodaText,
      fontWeight: WEIGHT.bold,
    },
    // Phase 8.39: 固定高さの常時スロット (旧 markerRow)。
    // 折返し (flexWrap) は廃止 — 2 行目が content 高さを押し上げて行高さが
    // 揺れる原因だった。上限超過は "+N" で表現し、はみ出しは clip する
    markerSlot: {
      height: 13,
      alignSelf: "stretch",
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 1,
      overflow: "hidden",
    },
    moreCount: {
      fontSize: 8,
      color: c.textMuted,
      fontFamily: FONT.heading,
      fontWeight: WEIGHT.bold,
    },
    customMarker: {
      fontSize: 10,
      lineHeight: 11,
    },
  });
}
