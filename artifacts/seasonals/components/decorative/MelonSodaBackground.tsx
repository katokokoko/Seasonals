/**
 * MelonSodaBackground — gravity / shake aware ambient melon-soda layer
 *
 * Phase 7.1: 初版 (gradient + sine 波 surface + bubbles + accelerometer)
 * Phase 7.2: ユーザーフィードバック反映
 *   - 濃緑の "wakame" 波帯 を撤去 (sine path + 横スクロール)
 *   - body gradient を Kotlin 参考実装の 4-stop に置換
 *   - bottom pool radial gradient (奥行き) を追加 (react-native-svg)
 *   - 液面を細 highlight + under-shadow の 2 line で表現
 *   - bubble alpha = 0.55 + (1 - y_normalized) * 0.30 (Kotlin 公式)
 *   - gravity tilt を ±4° → ±2° に縮小 (edge 端の振れ抑制)
 *
 * pointerEvents="none" で touch 透過、Calendar / sheet / modal の操作を妨げない。
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Dimensions,
  StyleSheet,
  View,
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { Accelerometer } from "expo-sensors";
import Svg, { Defs, RadialGradient, Rect, Stop } from "react-native-svg";
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
// withTiming は bubble の上昇 / shake では使うが、sensor 入力には使わない
//   (sensor 20Hz + withTiming 100ms は animation queue thrash の原因、Phase 7.3)

const SCREEN_W = Dimensions.get("window").width;
const SCREEN_H = Dimensions.get("window").height;

// 液面位置 (画面 top からの比率): 40%
const LIQUID_TOP_RATIO = 0.4;

// Shake 設定
const SHAKE_THRESHOLD = 1.8; // |a| > 1.8g
const SHAKE_COOLDOWN_MS = 600;
// Phase 7.3: bubble 数を削減 (パフォーマンス改善 + 視覚ノイズ削減)
const BURST_COUNT = 10;
const BASELINE_BUBBLES = 6;
const MAX_BUBBLES = 20;

// Soda palette (Kotlin 参考実装由来、CLAUDE.md §6 例外:
// 飲料の質感を表現する soda-only literal、本ファイル内に閉じ込める)
const SODA_TOP = "#B4F0C8"; // 0%   alpha 0.50
const SODA_MID = "#7DE1AF"; // 10%  alpha 0.62
const SODA_DEEP = "#3CC382"; // 45%  alpha 0.78
const SODA_BOTTOM = "#0F6E4B"; // 100% alpha 0.93
const POOL_SHADOW = "#084632"; // bottom radial pool

interface BubbleEntry {
  id: number;
  leftPct: number; // 5..95
  size: number; // 6..16
  durationMs: number; // 2500..5000
}

let bubbleIdCounter = 1;
function spawnBubble(): BubbleEntry {
  return {
    id: bubbleIdCounter++,
    leftPct: 5 + Math.random() * 90,
    size: 6 + Math.random() * 10,
    durationMs: 2500 + Math.random() * 2500,
  };
}

export function MelonSodaBackground() {
  // gravity x in [-1, 1] (左右傾き)
  const gravityX = useSharedValue(0);

  const [bubbles, setBubbles] = useState<BubbleEntry[]>(() =>
    Array.from({ length: BASELINE_BUBBLES }, () => spawnBubble())
  );
  const lastShakeRef = useRef(0);

  const removeBubble = useCallback((id: number) => {
    setBubbles((prev) => {
      const next = prev.filter((b) => b.id !== id);
      if (next.length < BASELINE_BUBBLES) {
        next.push(spawnBubble());
      }
      return next;
    });
  }, []);

  const spawnBurst = useCallback((count: number) => {
    setBubbles((prev) => {
      if (prev.length >= MAX_BUBBLES) return prev;
      const room = MAX_BUBBLES - prev.length;
      const adds = Math.min(count, room);
      return [...prev, ...Array.from({ length: adds }, () => spawnBubble())];
    });
  }, []);

  // Accelerometer subscription
  useEffect(() => {
    Accelerometer.setUpdateInterval(50);
    const sub = Accelerometer.addListener(({ x, y, z }) => {
      const clampedX = Math.max(-1, Math.min(1, x));
      // Phase 7.3: 直接代入 (sensor 20Hz は元々滑らか、withTiming で animation queue thrash していた)
      gravityX.value = clampedX;

      const mag = Math.sqrt(x * x + y * y + z * z);
      const now = Date.now();
      if (
        mag > SHAKE_THRESHOLD &&
        now - lastShakeRef.current > SHAKE_COOLDOWN_MS
      ) {
        lastShakeRef.current = now;
        runOnJS(spawnBurst)(BURST_COUNT);
      }
    });
    return () => sub.remove();
  }, [gravityX, spawnBurst]);

  // Phase 7.2: tilt を ±2° に縮小
  const liquidAnimStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${gravityX.value * 2}deg` }],
  }));

  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      {/* 1. Liquid base — 4-stop vertical gradient + bottom pool radial */}
      <Animated.View style={[styles.liquidWrap, liquidAnimStyle]}>
        <LinearGradient
          colors={[
            // Phase 7.3: alpha を Phase 7.1 並みに下げて全体を薄く
            `${SODA_TOP}4D`, // alpha 0.30
            `${SODA_MID}66`, // alpha 0.40
            `${SODA_DEEP}80`, // alpha 0.50
            `${SODA_BOTTOM}8C`, // alpha 0.55
          ]}
          locations={[0, 0.1, 0.45, 1.0]}
          style={StyleSheet.absoluteFill}
        />
        {/* Bottom pool radial (深緑の沈み込み奥行き演出) */}
        <Svg
          style={StyleSheet.absoluteFill}
          pointerEvents="none"
        >
          <Defs>
            <RadialGradient
              id="poolShadow"
              cx="50%"
              cy="100%"
              rx="70%"
              ry="40%"
              fx="50%"
              fy="100%"
            >
              <Stop offset="0%" stopColor={POOL_SHADOW} stopOpacity={0.35} />
              <Stop offset="100%" stopColor={POOL_SHADOW} stopOpacity={0} />
            </RadialGradient>
          </Defs>
          <Rect x="0" y="0" width="100%" height="100%" fill="url(#poolShadow)" />
        </Svg>
      </Animated.View>

      {/* Phase 7.3: 液面の細 line は撤去。グラデーション境目だけで自然に見せる */}

      {/* 2. Bubbles */}
      {bubbles.map((b) => (
        <Bubble key={b.id} entry={b} gravityX={gravityX} onDone={removeBubble} />
      ))}
    </View>
  );
}

interface BubbleProps {
  entry: BubbleEntry;
  gravityX: SharedValue<number>;
  onDone: (id: number) => void;
}

// Phase 7.3: React.memo で親の bubbles 配列再計算による無駄な re-render を抑制
const Bubble = React.memo(function Bubble({
  entry,
  gravityX,
  onDone,
}: BubbleProps) {
  const ty = useSharedValue(0);

  useEffect(() => {
    // 上昇: 0 → -SCREEN_H * 0.55
    ty.value = withTiming(-SCREEN_H * 0.55, {
      duration: entry.durationMs,
      easing: Easing.out(Easing.cubic),
    });
    const t = setTimeout(() => onDone(entry.id), entry.durationMs);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const animStyle = useAnimatedStyle(() => {
    // y_norm: 0 (start, bottom) → 1 (top)
    const yNorm = Math.min(1, Math.abs(ty.value) / (SCREEN_H * 0.55));
    // Phase 7.2: Kotlin 公式 alpha = 0.55 + (1 - y_norm) * 0.30
    //   y=0 (生成直後) → 0.85
    //   y=1 (上端到達) → 0.55
    const alpha = 0.55 + (1 - yNorm) * 0.3;
    const tx = gravityX.value * yNorm * 30;
    return {
      transform: [{ translateY: ty.value }, { translateX: tx }],
      opacity: alpha,
    };
  });

  return (
    <Animated.View
      style={[
        styles.bubble,
        {
          left: `${entry.leftPct}%`,
          width: entry.size,
          height: entry.size,
          borderRadius: entry.size / 2,
        },
        animStyle,
      ]}
    />
  );
});

const styles = StyleSheet.create({
  liquidWrap: {
    position: "absolute",
    top: SCREEN_H * LIQUID_TOP_RATIO,
    left: 0,
    right: 0,
    bottom: 0,
    overflow: "hidden",
  },
  bubble: {
    position: "absolute",
    bottom: 8,
    backgroundColor: "rgba(255, 255, 255, 0.45)",
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.7)",
  },
});
