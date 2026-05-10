/**
 * WalletDrinkButton — home Row 1 右端の circular wallet button (Phase 5A.4 / 5A.8.1)
 *
 * 動作:
 *   - tap → WalletPopover を開く (MWA は modal 内 "+ Add Wallet" でのみ起動)
 *   - active wallet あり: drink icon + 8px melonText status dot (右下)
 *   - active wallet なし: drink icon のみ
 *
 * Phase 7.5: BlurView + tint + top highlight の 3 層 glass 化。
 * 背景の MelonSodaBackground (Phase 7.1-7.3) が透けて見えるよう intensity=24 で
 * 軽い blur、tint 0.22 で icon readability を担保。
 */

import React from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { BlurView } from "expo-blur";

import {
  COLOR,
  RADIUS,
  withAlpha,
} from "@workspace/lib/design-system";

import { SodaGlassIcon } from "../icons/HeaderIcons";
import { useIsWalletConnected } from "../../services/useWallet";

export interface WalletDrinkButtonProps {
  /** tap 時に WalletPopover を開くハンドラ (home が modal state を保持) */
  onPress: () => void;
  testID?: string;
}

export function WalletDrinkButton({ onPress, testID }: WalletDrinkButtonProps) {
  // Phase 7.4: dot は MWA 接続状態を反映 (fixture-driven activeWalletId は撤去)
  const hasActive = useIsWalletConnected();

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={hasActive ? "Wallet manager" : "Connect wallet"}
      accessibilityState={{ selected: hasActive }}
      onPress={onPress}
      style={styles.btn}
      testID={testID}
    >
      <BlurView
        intensity={24}
        tint="light"
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
      />
      <View style={styles.tint} pointerEvents="none" />
      <View style={styles.highlight} pointerEvents="none" />
      <SodaGlassIcon size={20} color={COLOR.caramel} />
      {hasActive && <View style={styles.statusDot} />}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  btn: {
    width: 40,
    height: 40,
    borderRadius: RADIUS.pill,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "transparent",
    borderWidth: 1,
    borderColor: withAlpha(COLOR.textOnColor, 0.55),
    overflow: "hidden",
  },
  tint: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(255,255,255,0.22)",
  },
  highlight: {
    position: "absolute",
    top: 0,
    left: 8,
    right: 8,
    height: 1,
    backgroundColor: "rgba(255,255,255,0.65)",
  },
  statusDot: {
    position: "absolute",
    right: 2,
    bottom: 2,
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: COLOR.melonText,
    borderWidth: 1,
    borderColor: COLOR.bgPrimary,
  },
});
