/**
 * MonthPager — 月送りの follow + fade-through swipe (Phase 8.83 → 8.84)
 *
 * 8.83 の carousel (隣月が見えながら追従) は user フィードバックで不採用。
 * 8.84 の動き:
 *   - ドラッグ中: **当月だけ** が指にわずかに追従 (rubber-band、最大 ±MAX_TX)
 *     し、ほんのり薄くなる (opacity 1 → 0.6)。全て UI thread の worklet
 *   - release: 位置 + 速度の投影が閾値を超えたら遷移確定、未満なら spring back
 *   - 遷移は 8.81 と同じ **commit-first** (完了 callback なし = 中断で固まる
 *     状態が構造的に存在しない): 先に月を確定 → tx を反対側に re-base →
 *     spring settle + fade in。ドラッグで既に薄くなっているため、月の中身の
 *     差し替えは低 opacity 中に起きて fade-through に見える
 */

import React, { useCallback, useMemo } from "react";
import { StyleSheet, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { addMonths } from "date-fns";

import type { CustomEvent, UnifiedTimeEvent } from "@workspace/lib/types";

import { MonthGrid } from "./MonthGrid";

/** ドラッグ追従の最大距離 (これを超える分は rubber-band 抵抗) */
const MAX_TX = 60;
/** 遷移確定の閾値 (位置 + 速度×0.18 の投影に対して) */
const COMMIT_TX = 70;
/** ドラッグ最大時の透明度の下限 (1 − DIM) */
const DIM = 0.4;

export interface MonthPagerProps {
  month: Date;
  /** swipe で月送りが確定した時の callback (next month を渡す) */
  onChangeMonth: (next: Date) => void;
  events: UnifiedTimeEvent[];
  customEvents?: CustomEvent[];
  selectedDay: Date | null;
  onDayPress: (day: Date) => void;
  today?: Date;
  testID?: string;
}

export function MonthPager({
  month,
  onChangeMonth,
  events,
  customEvents,
  selectedDay,
  onDayPress,
  today,
  testID,
}: MonthPagerProps) {
  const tx = useSharedValue(0);
  const opacity = useSharedValue(1);

  const commit = useCallback(
    (dir: 1 | -1) => {
      // commit-first (8.81): 先に月を確定してから re-base → settle
      onChangeMonth(addMonths(month, dir));
      tx.value = dir > 0 ? 40 : -40;
      tx.value = withSpring(0, { damping: 20, stiffness: 180 });
      opacity.value = 0.5;
      opacity.value = withTiming(1, { duration: 220 });
    },
    [month, onChangeMonth, tx, opacity]
  );

  const pan = useMemo(
    () =>
      Gesture.Pan()
        .withTestId("month-swipe")
        .activeOffsetX([-12, 12])
        .failOffsetY([-15, 15])
        .onUpdate((e) => {
          "worklet";
          const t = e.translationX;
          const abs = Math.abs(t);
          const resisted =
            abs <= MAX_TX
              ? abs
              : MAX_TX + (abs - MAX_TX) / (1 + (abs - MAX_TX) / 40);
          tx.value = Math.sign(t) * resisted;
          opacity.value = 1 - Math.min(resisted / MAX_TX, 1) * DIM;
        })
        // 8.81: RNGH は FAILED / CANCELLED でも onEnd を呼ぶため success を見る
        .onEnd((e, success) => {
          "worklet";
          if (!success) {
            tx.value = withSpring(0, { damping: 20, stiffness: 180 });
            opacity.value = withTiming(1, { duration: 160 });
            return;
          }
          const projected = e.translationX + e.velocityX * 0.18;
          if (projected < -COMMIT_TX) {
            runOnJS(commit)(1);
          } else if (projected > COMMIT_TX) {
            runOnJS(commit)(-1);
          } else {
            tx.value = withSpring(0, { damping: 20, stiffness: 180 });
            opacity.value = withTiming(1, { duration: 160 });
          }
        }),
    [commit, tx, opacity]
  );

  const animStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: tx.value }],
    opacity: opacity.value,
  }));

  return (
    <GestureDetector gesture={pan}>
      <View testID={testID}>
        <Animated.View style={[styles.body, animStyle]}>
          <MonthGrid
            month={month}
            events={events}
            customEvents={customEvents}
            selectedDay={selectedDay}
            onDayPress={onDayPress}
            today={today}
            testID={testID ? `${testID}-grid` : undefined}
          />
        </Animated.View>
      </View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  body: {
    width: "100%",
  },
});
