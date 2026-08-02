/**
 * WalletPopover — drink button から起動する 右上 pop-out popover (Phase 5A.8 / 7.6)
 *
 * 構成 (anchor: top: anchorTop, right: 14, width: 280):
 *   "Wallets" overline
 *   MWA 接続済 wallet の row (label + truncated address + status dot)
 *   "+ Add Wallet" row (tap → useWallet().connect()、MWA はここからのみ起動)
 *   "Subscription" full-width pill button
 *
 * 5A.8.5 empty state: 未接続 → wallet section を完全省略。
 *
 * Phase 7.6 motion: Modal animationType="none" + SharedValue enter (0→1) で
 * card を transformOrigin "top right" の scale + opacity、backdrop を同期 fade。
 * ActionModal (Phase 6.4) と同じ renderModal lifecycle パターン。
 */

import React, { useEffect, useState } from "react";
import {
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useRouter } from "expo-router";
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
  FONT,
  FONT_SIZE,
  RADIUS,
  SPACE,
  WEIGHT,
  withAlpha,
} from "@workspace/lib/design-system";

import { useWallet } from "../../services/useWallet";
import { useComingSoon } from "../../stores/comingSoon";
import {
  useThemedStyles,
  type ThemeColors,
} from "../../stores/theme";

function shortenAddress(addr: string): string {
  if (addr.length <= 10) return addr;
  return `…${addr.slice(-6)}`;
}

function initialOf(label: string | null | undefined): string {
  if (!label) return "S"; // Seeker default
  return label.charAt(0).toUpperCase();
}

export interface WalletPopoverProps {
  visible: boolean;
  /** screen top からの px。drink button のすぐ下に配置するため home から計算して渡す */
  anchorTop: number;
  onClose: () => void;
  testID?: string;
}

export function WalletPopover({
  visible,
  anchorTop,
  onClose,
  testID,
}: WalletPopoverProps) {
  const router = useRouter();
  // Phase 7.4: fixture wallets を撤去、MWA authorization のみを表示
  // Phase 8.5.1: disconnect も使えるように expose
  const { authorization, connect, disconnect } = useWallet();
  // Phase 7.9: theme 連動 styles
  const styles = useThemedStyles(makeStyles);

  // Phase 7.6 motion: ActionModal と同型の renderModal lifecycle で
  // close 完了後に Modal を unmount する (中断時は finished===false で安全)。
  const [renderModal, setRenderModal] = useState(visible);
  const enter = useSharedValue(0);

  useEffect(() => {
    if (visible) {
      setRenderModal(true);
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
          if (finished) runOnJS(setRenderModal)(false);
        }
      );
    }
  }, [visible, enter]);

  const cardAnim = useAnimatedStyle(() => ({
    opacity: enter.value,
    transform: [{ scale: 0.88 + 0.12 * enter.value }],
  }));

  const backdropAnim = useAnimatedStyle(() => ({
    opacity: enter.value * 0.18,
  }));

  const handleAddWallet = async () => {
    // Phase 7.8: 接続済 wallet がある状態での "+ Add Wallet" は multi-wallet
    // 機能 (未実装) の入口として扱い、Coming Soon を表示。未接続なら初回
    // connect の動線として既存通り MWA connect を起動。
    if (authorization) {
      onClose();
      useComingSoon
        .getState()
        .show("Multi-wallet support is coming soon");
      return;
    }
    onClose();
    try {
      await connect();
    } catch {
      // useWallet 内部で error state を持つので silent
    }
  };

  const handleSubscription = () => {
    onClose();
    // /settings/subscription route 未実装 — TODO Phase 5+
    router.push("/theme-shop");
  };

  // Phase 8.5.1: 接続済 wallet を切断 (mainnet 接続切替 / disconnect 用)
  const handleDisconnect = async () => {
    onClose();
    try {
      await disconnect();
    } catch {
      /* silent */
    }
  };

  return (
    <Modal
      visible={renderModal}
      transparent
      animationType="none"
      onRequestClose={onClose}
      // 8.45: ActionModal と同じく全画面 window にする。これが無いと Modal の座標系が
      // ステータスバーを含まず、anchorTop (画面ルート座標) との差分だけ popover が下にズレる
      statusBarTranslucent
      testID={testID}
    >
      <Animated.View
        style={[styles.backdropBase, backdropAnim]}
        pointerEvents="none"
      />
      <Pressable
        style={StyleSheet.absoluteFill}
        onPress={onClose}
        accessibilityLabel="Close wallet menu"
      />
      <Animated.View style={[styles.card, { top: anchorTop }, cardAnim]}>
        <BlurView
          intensity={60}
          tint="light"
          style={styles.cardBlur}
          pointerEvents="none"
        />
        <View style={styles.cardTint} pointerEvents="none" />
        <View style={styles.cardHighlight} pointerEvents="none" />

        <Text style={styles.heading}>Wallets</Text>

        {/* Phase 7.4: 接続済 MWA wallet 1 行のみ。未接続なら section 全省略 (5A.8.5) */}
        {authorization && (
          <View style={styles.walletsSection}>
            <Pressable
              accessibilityRole="button"
              onPress={onClose}
              style={styles.walletRow}
              testID={testID ? `${testID}-wallet-current` : undefined}
            >
              <View style={styles.iconDark}>
                <Text style={styles.iconLetter}>
                  {initialOf(authorization.label)}
                </Text>
              </View>
              <View style={styles.walletMain}>
                <Text style={styles.walletLabel}>Connected wallet</Text>
                <Text style={styles.walletProvider} numberOfLines={1}>
                  {authorization.label ?? "Seeker wallet"}
                </Text>
                <Text style={styles.walletAddress} numberOfLines={1}>
                  {shortenAddress(authorization.address)}
                </Text>
              </View>
              <View style={styles.statusDot} />
            </Pressable>
          </View>
        )}

        {/* + Add Wallet (MWA fires here only) */}
        <Pressable
          accessibilityRole="button"
          onPress={handleAddWallet}
          style={styles.addRow}
          testID={testID ? `${testID}-add-wallet` : undefined}
        >
          <View style={styles.addBadge}>
            <Text style={styles.addBadgePlus}>+</Text>
          </View>
          <View style={styles.walletMain}>
            <Text style={styles.walletProvider}>+ Add Wallet</Text>
            <Text style={styles.walletLabel}>Track another Solana wallet</Text>
          </View>
        </Pressable>

        {/* Subscription footer */}
        <Pressable
          accessibilityRole="button"
          onPress={handleSubscription}
          style={styles.subBtn}
          testID={testID ? `${testID}-subscription` : undefined}
        >
          <Text style={styles.subBtnText}>Subscription</Text>
        </Pressable>

        {/* Phase 8.5.1: Disconnect (接続済時のみ表示) */}
        {authorization && (
          <Pressable
            accessibilityRole="button"
            onPress={handleDisconnect}
            style={styles.disconnectRow}
            testID={testID ? `${testID}-disconnect` : undefined}
          >
            <Text style={styles.disconnectText}>Disconnect</Text>
          </Pressable>
        )}
      </Animated.View>
    </Modal>
  );
}

// Phase 7.9: theme 連動 styles factory
function makeStyles(c: ThemeColors) {
  return StyleSheet.create({
    // Phase 7.6: backdrop は alpha を Animated で駆動するため不透明色 + opacity 分離
    backdropBase: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: "#000",
    },
    card: {
      position: "absolute",
      right: 14,
      width: 280,
      backgroundColor: c.bgCard,
      borderRadius: RADIUS.lg,
      padding: 14,
      borderWidth: 1,
      borderColor: c.border,
      overflow: "hidden",
      // Phase 7.6: drink button (右上) を支点に scale させる
      transformOrigin: "top right",
      shadowColor: "rgba(0,0,0,0.18)",
      shadowOffset: { width: 0, height: 8 },
      shadowOpacity: 1,
      shadowRadius: 18,
      elevation: 12,
    },
    cardBlur: {
      ...StyleSheet.absoluteFillObject,
      borderRadius: RADIUS.lg,
    },
    cardTint: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: c.bgCard,
      borderRadius: RADIUS.lg,
    },
    cardHighlight: {
      position: "absolute",
      top: 0,
      left: 0,
      right: 0,
      height: 1,
      backgroundColor: "rgba(255,255,255,0.65)",
    },
    heading: {
      color: c.textMuted,
      fontFamily: FONT.heading,
      fontSize: FONT_SIZE.overline,
      fontWeight: WEIGHT.bold,
      textTransform: "uppercase",
      letterSpacing: 0.8,
      marginBottom: SPACE.sm,
      marginLeft: 2,
    },
    walletsSection: {
      gap: SPACE.xs,
      marginBottom: SPACE.xs,
    },
    walletRow: {
      flexDirection: "row",
      alignItems: "center",
      backgroundColor: withAlpha(c.textOnColor, 0.6),
      borderRadius: RADIUS.md,
      padding: 10,
      borderWidth: 1,
      borderColor: c.border,
    },
    iconDark: {
      width: 36,
      height: 36,
      borderRadius: RADIUS.md,
      backgroundColor: c.textPrimary,
      alignItems: "center",
      justifyContent: "center",
      marginRight: 12,
    },
    iconLetter: {
      fontSize: FONT_SIZE.bodyLG,
      fontFamily: FONT.heading,
      fontWeight: WEIGHT.bold,
      color: c.textOnColor,
    },
    walletMain: {
      flex: 1,
      gap: 1,
    },
    walletLabel: {
      color: c.textMuted,
      fontFamily: FONT.body,
      fontSize: 11,
    },
    walletProvider: {
      color: c.textPrimary,
      fontFamily: FONT.heading,
      fontWeight: WEIGHT.bold,
      fontSize: FONT_SIZE.bodyMD,
    },
    walletAddress: {
      color: c.textMuted,
      fontFamily: FONT.mono,
      fontSize: FONT_SIZE.bodySM,
    },
    statusDot: {
      width: 8,
      height: 8,
      borderRadius: 4,
      backgroundColor: c.melonText,
      marginLeft: SPACE.xs,
    },
    addRow: {
      flexDirection: "row",
      alignItems: "center",
      padding: 10,
      marginTop: SPACE.xs,
      borderRadius: RADIUS.md,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: withAlpha(c.textOnColor, 0.4),
    },
    addBadge: {
      width: 36,
      height: 36,
      borderRadius: RADIUS.md,
      backgroundColor: c.sodaLight,
      alignItems: "center",
      justifyContent: "center",
      marginRight: 12,
    },
    addBadgePlus: {
      fontSize: 22,
      fontFamily: FONT.heading,
      fontWeight: WEIGHT.bold,
      color: c.sodaText,
      lineHeight: 24,
    },
    subBtn: {
      marginTop: SPACE.sm,
      paddingVertical: 10,
      borderRadius: RADIUS.pill,
      // Phase 7.9: melonDeep は theme palette 外なので melonText (CTA primary) にマップ
      backgroundColor: c.melonText,
      alignItems: "center",
    },
    subBtnText: {
      fontSize: FONT_SIZE.bodyMD,
      fontFamily: FONT.heading,
      fontWeight: WEIGHT.bold,
      color: c.textOnColor,
    },
    // Phase 8.5.1: Disconnect 行 (cherryDark で警告系)
    disconnectRow: {
      marginTop: SPACE.xs,
      paddingVertical: SPACE.xs + 2,
      alignItems: "center",
    },
    disconnectText: {
      fontSize: FONT_SIZE.bodySM,
      fontFamily: FONT.heading,
      fontWeight: WEIGHT.semibold,
      color: c.cherryDark,
    },
  });
}
