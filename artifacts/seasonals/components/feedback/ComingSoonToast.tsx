/**
 * ComingSoonToast — bottom-center glass pill toast (Phase 7.8)
 *
 * `useComingSoon().visible` を watch して fade + slide-up で表示、
 * 2200ms 後に同 store の auto-dismiss で消える。pointerEvents="none" で
 * 下の UI の操作を妨げない。
 *
 * Motion 言語は WalletPopover (Phase 7.6) / ActionModal (Phase 6.4) と同型:
 * SharedValue enter (0→1) で opacity + translateY (8→0) を spring open /
 * timing close。
 */

import React, { useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { BlurView } from "expo-blur";
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";

import {
  COLOR,
  FONT,
  FONT_SIZE,
  RADIUS,
  SPACE,
  WEIGHT,
  withAlpha,
} from "@workspace/lib/design-system";

import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useComingSoon } from "../../stores/comingSoon";

export function ComingSoonToast({ testID }: { testID?: string }) {
  const visible = useComingSoon((s) => s.visible);
  const message = useComingSoon((s) => s.message);
  // 8.45: edge-to-edge の下端 inset
  const insets = useSafeAreaInsets();

  // Modal を使わず常時 mount。`render` で entry/exit lifecycle を制御。
  const [render, setRender] = useState(visible);
  const [stickyMessage, setStickyMessage] = useState(message);
  const enter = useSharedValue(0);

  // message 差し替え: visible が true のままで message が変わったら sticky を更新
  useEffect(() => {
    if (visible) setStickyMessage(message);
  }, [visible, message]);

  useEffect(() => {
    if (visible) {
      setRender(true);
      enter.value = withSpring(1, {
        damping: 18,
        stiffness: 220,
        mass: 0.6,
      });
    } else {
      enter.value = withTiming(
        0,
        { duration: 180, easing: Easing.in(Easing.cubic) },
        (finished) => {
          if (finished) runOnJS(setRender)(false);
        }
      );
    }
  }, [visible, enter]);

  const anim = useAnimatedStyle(() => ({
    opacity: enter.value,
    transform: [{ translateY: (1 - enter.value) * 8 }],
  }));

  if (!render) return null;

  return (
    // 8.45 (edge-to-edge): SafeArea 外に置かれる global トーストなので inset を自前で足す
    <View
      pointerEvents="none"
      style={[styles.host, { bottom: SPACE.xl + SPACE.lg + insets.bottom }]}
    >
      <Animated.View style={[styles.pill, anim]} testID={testID}>
        <BlurView
          intensity={40}
          tint="light"
          style={StyleSheet.absoluteFill}
          pointerEvents="none"
        />
        <View style={styles.tint} pointerEvents="none" />
        <View style={styles.highlight} pointerEvents="none" />
        <Text style={styles.label} numberOfLines={2}>
          {stickyMessage}
        </Text>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  host: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: SPACE.xl + SPACE.lg,
    alignItems: "center",
    paddingHorizontal: SPACE.md,
  },
  pill: {
    maxWidth: 320,
    paddingHorizontal: SPACE.lg,
    paddingVertical: SPACE.sm + 2,
    borderRadius: RADIUS.pill,
    borderWidth: 1,
    borderColor: withAlpha(COLOR.textOnColor, 0.55),
    overflow: "hidden",
    backgroundColor: "transparent",
    shadowColor: "rgba(0,0,0,0.18)",
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 1,
    shadowRadius: 14,
    elevation: 10,
  },
  tint: {
    ...StyleSheet.absoluteFill,
    backgroundColor: "rgba(255,255,255,0.28)",
  },
  highlight: {
    position: "absolute",
    top: 0,
    left: 12,
    right: 12,
    height: 1,
    backgroundColor: "rgba(255,255,255,0.65)",
  },
  label: {
    fontSize: FONT_SIZE.bodyMD,
    fontFamily: FONT.heading,
    fontWeight: WEIGHT.semibold,
    color: COLOR.textPrimary,
    textAlign: "center",
  },
});
