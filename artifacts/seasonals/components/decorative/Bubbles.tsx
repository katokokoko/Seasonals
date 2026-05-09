/**
 * Bubbles — soda bubble decoration
 *
 * prototype の Bubbles.tsx を adapt。reanimated で各 bubble に random delay /
 * duration を割り当て、画面下部から上部へ float + 横揺れ。
 *
 * 配置: home screen 背景 (`pointerEvents="none"` で touch 透過)。
 */

import React, { useEffect, useMemo } from "react";
import { Dimensions, StyleSheet, View } from "react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withTiming,
} from "react-native-reanimated";

import { COLOR, withAlpha } from "@workspace/lib/design-system";

interface BubbleProps {
  size: number;
  left: number;
  delay: number;
  duration: number;
  color: string;
  borderColor: string;
}

function Bubble({ size, left, delay, duration, color, borderColor }: BubbleProps) {
  const t = useSharedValue(0);
  useEffect(() => {
    t.value = withDelay(
      delay,
      withRepeat(
        withTiming(1, { duration, easing: Easing.inOut(Easing.quad) }),
        -1,
        false
      )
    );
  }, [t, delay, duration]);

  const style = useAnimatedStyle(() => ({
    transform: [
      { translateY: -t.value * 520 },
      { translateX: Math.sin(t.value * Math.PI * 2) * 14 },
    ],
    opacity: 0.85 - t.value * 0.85,
  }));

  return (
    <Animated.View
      pointerEvents="none"
      style={[
        styles.bubble,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          left,
          backgroundColor: color,
          borderColor,
        },
        style,
      ]}
    />
  );
}

export interface BubblesProps {
  /** 同時に floating する bubble 数 (default 8) */
  count?: number;
  /** 画面下端からの bubble 開始 offset (default 24px、SafeArea bottom 上に置きたい時) */
  bottomOffset?: number;
}

export function Bubbles({ count = 8, bottomOffset = 24 }: BubblesProps) {
  const screenWidth = Dimensions.get("window").width;
  const borderColor = withAlpha(COLOR.textPrimary, 0.25);

  const items = useMemo<BubbleProps[]>(() => {
    const arr: BubbleProps[] = [];
    for (let i = 0; i < count; i++) {
      arr.push({
        size: 10 + Math.random() * 22,
        left: Math.random() * (screenWidth - 30),
        delay: Math.random() * 2000,
        duration: 4500 + Math.random() * 2500,
        color:
          Math.random() > 0.5
            ? withAlpha(COLOR.sodaMid, 0.67)
            : withAlpha(COLOR.melonLight, 0.67),
        borderColor,
      });
    }
    return arr;
    // 配列は再生成しない (delay / left の random を保つため)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [count]);

  return (
    <View
      pointerEvents="none"
      style={[styles.container, { bottom: bottomOffset }]}
    >
      {items.map((item, idx) => (
        <Bubble key={idx} {...item} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: "absolute",
    left: 0,
    right: 0,
    height: 600, // float 範囲、translateY -520px までカバー
    overflow: "hidden",
  },
  bubble: {
    position: "absolute",
    bottom: 0,
    borderWidth: 1,
  },
});
