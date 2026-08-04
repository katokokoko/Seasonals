/**
 * MonthPager — 月送りの指追従 carousel (Phase 8.83)
 *
 * 前月 / 当月 / 翌月の 3 ページの MonthGrid を横に並べ、pan で指に追従させる。
 * 動きのモデルは DailyView の day scrub と同型:
 *   - onUpdate: tx が指にそのまま追従 (±1 ページを超える分は rubber-band 抵抗)
 *   - onEnd:    位置 + 速度の投影で -1/0/+1 step を決め、**commit-first**
 *               (先に月を確定 → tx を re-base → withSpring(0) で settle)。
 *               8.81 の cancel-safe 特性 (中断されても固まらない) を維持する
 *
 * 3×42 セルの描画は 8.81 の React.memo / day-key 索引化により軽量。
 * 隣月ページには同じ events 配列を渡すだけでよい (索引が月を跨いで引ける)。
 *
 * Task 2 (6 週月のシート位置): 当月ページの grid 下端の画面絶対 y を
 * `onCenterBottomY` で通知する。呼び手 (app/index.tsx) はこれを
 * PortfolioSummary の動的 middle snap に使う。
 */

import React, { useCallback, useMemo, useRef, useState } from "react";
import {
  Dimensions,
  StyleSheet,
  View,
  type LayoutChangeEvent,
} from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";
import { addMonths } from "date-fns";

import type { CustomEvent, UnifiedTimeEvent } from "@workspace/lib/types";

import { MonthGrid } from "./MonthGrid";

const PAGE_OFFSETS = [-1, 0, 1] as const;

export interface MonthPagerProps {
  month: Date;
  /** swipe で月送りが確定した時の callback (next month を渡す) */
  onChangeMonth: (next: Date) => void;
  events: UnifiedTimeEvent[];
  customEvents?: CustomEvent[];
  selectedDay: Date | null;
  onDayPress: (day: Date) => void;
  today?: Date;
  /** 当月 grid 下端の画面絶対 y (px)。月/レイアウト変化のたびに通知 */
  onCenterBottomY?: (bottomY: number) => void;
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
  onCenterBottomY,
  testID,
}: MonthPagerProps) {
  const [containerWidth, setContainerWidth] = useState(
    Dimensions.get("window").width
  );
  const W = containerWidth;

  const onLayout = useCallback((e: LayoutChangeEvent) => {
    const w = e.nativeEvent.layout.width;
    if (w > 0) setContainerWidth(w);
  }, []);

  // ── Task 2: 当月ページの grid 下端 (画面絶対 y) を通知 ──
  const centerRef = useRef<View>(null);
  const reportCenterBottom = useCallback(() => {
    if (!onCenterBottomY) return;
    centerRef.current?.measureInWindow((_x, y, _w, h) => {
      if (h > 0) onCenterBottomY(y + h);
    });
  }, [onCenterBottomY]);

  // ── Pan gesture (DailyView.tsx:238-261 と同パターン) ──
  const tx = useSharedValue(0);

  const commit = useCallback(
    (steps: number) => {
      if (steps === 0) {
        tx.value = withSpring(0, { damping: 20, stiffness: 160 });
        return;
      }
      // commit-first (8.81): 先に月を確定してから re-base → settle。
      // 中断されても「settle が途中で切れる」だけで固まる状態が存在しない
      onChangeMonth(addMonths(month, steps));
      tx.value = tx.value + steps * W;
      tx.value = withSpring(0, { damping: 20, stiffness: 160 });
    },
    [month, onChangeMonth, tx, W]
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
          if (abs <= W) {
            tx.value = t;
          } else {
            // rubber-band: 1 ページを超える分は徐々に抵抗 (2 ヶ月飛びは無い)
            const overshoot = abs - W;
            const resisted = W + overshoot / (1 + (overshoot / W) * 3);
            tx.value = Math.sign(t) * resisted;
          }
        })
        // 8.81: RNGH は FAILED / CANCELLED でも onEnd を呼ぶため success を見る
        .onEnd((e, success) => {
          "worklet";
          if (!success) {
            tx.value = withSpring(0, { damping: 20, stiffness: 160 });
            return;
          }
          const projected = e.translationX + e.velocityX * 0.18;
          let steps = Math.round(-projected / W);
          if (steps > 1) steps = 1;
          if (steps < -1) steps = -1;
          runOnJS(commit)(steps);
        }),
    [commit, tx, W]
  );

  // 3 ページ幅の row を tx で動かす (中央ページが x=0 に来る基準位置は -W)
  const rowStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: -W + tx.value }],
  }));

  return (
    <GestureDetector gesture={pan}>
      <View style={styles.viewport} onLayout={onLayout} testID={testID}>
        <Animated.View style={[styles.row, { width: W * 3 }, rowStyle]}>
          {PAGE_OFFSETS.map((offset) => {
            const pageMonth = addMonths(month, offset);
            const isCenter = offset === 0;
            return (
              <View
                key={offset}
                style={{ width: W }}
                ref={isCenter ? centerRef : undefined}
                onLayout={isCenter ? reportCenterBottom : undefined}
              >
                <MonthGrid
                  month={pageMonth}
                  events={events}
                  customEvents={customEvents}
                  selectedDay={selectedDay}
                  onDayPress={onDayPress}
                  today={today}
                  testID={isCenter ? `${testID ?? "month-pager"}-grid` : undefined}
                />
              </View>
            );
          })}
        </Animated.View>
      </View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  viewport: {
    overflow: "hidden",
  },
  row: {
    flexDirection: "row",
    // 各ページは自分の grid 高さを保つ (5 週と 6 週の月が並ぶことがある)
    alignItems: "flex-start",
  },
});
