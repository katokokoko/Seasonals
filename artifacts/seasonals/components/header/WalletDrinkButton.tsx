/**
 * WalletDrinkButton — home Row 1 右端の circular wallet button (Phase 5A.4 / 5A.8.1)
 *
 * 動作:
 *   - tap → WalletPopover を開く (MWA は modal 内 "+ Add Wallet" でのみ起動)
 *   - active wallet あり: drink emoji + 8px melonText status dot (右下)
 *   - active wallet なし: drink emoji のみ
 *
 * status dot は stores/wallet.ts の activeWalletId を読み取る (5A.8 spec)。
 */

import React from "react";
import { Pressable, StyleSheet, View } from "react-native";

import {
  COLOR,
  RADIUS,
  withAlpha,
} from "@workspace/lib/design-system";

import { SodaGlassIcon } from "../icons/HeaderIcons";
import { useWalletSelectionStore } from "../../stores/wallet";

export interface WalletDrinkButtonProps {
  /** tap 時に WalletPopover を開くハンドラ (home が modal state を保持) */
  onPress: () => void;
  testID?: string;
}

export function WalletDrinkButton({ onPress, testID }: WalletDrinkButtonProps) {
  const activeWalletId = useWalletSelectionStore((s) => s.activeWalletId);
  const hasActive = activeWalletId !== null;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={hasActive ? "Wallet manager" : "Connect wallet"}
      accessibilityState={{ selected: hasActive }}
      onPress={onPress}
      style={styles.btn}
      testID={testID}
    >
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
    backgroundColor: withAlpha(COLOR.bgSecondary, 0.7),
    borderWidth: 1,
    borderColor: COLOR.border,
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
