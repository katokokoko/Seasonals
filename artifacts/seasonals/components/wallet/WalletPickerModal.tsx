/**
 * WalletPickerModal — 新規接続時の wallet アプリ選択カード (Phase 8.76)
 *
 * 背景: MWA の association intent は素の `solana-wallet://` scheme を投げるため、
 * wallet アプリが複数あると Android の「このアプリで開く (一度だけ/常時)」チューザーが
 * 出る。「常時」を選ぶと以後ほかの wallet を開けなくなる。事前にどの wallet を開くか
 * ここで選び、`connect({ baseUri })` → `transact(cb, { baseUri })` で直接開く。
 *
 * "Other wallet…" は baseUri なし = 従来どおり OS チューザーに委ねる escape hatch
 * (リスト外の wallet / Seed Vault 用)。
 *
 * インストール済み wallet の列挙は RN bridge に API が無いため行わない —
 * 既知 wallet の固定リストで足りる (選んだ wallet が無ければ mwa.ts 側が
 * ERROR_WALLET_NOT_FOUND → チューザーへ fallback する)。
 *
 * 見た目 / motion は WalletPopover と同型 (glass card + spring enter)。
 */

import React, { useEffect, useState } from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
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

import { useThemedStyles, type ThemeColors } from "../../stores/theme";

export interface KnownWalletApp {
  id: string;
  label: string;
  /** MWA association intent の宛先。null = OS チューザーに任せる */
  baseUri: string | null;
  /** 行の下段に出す一言 */
  hint: string;
}

/**
 * baseUri は各 wallet の verified app-link ドメイン。実機で domain 直下が
 * app-link 未検証だった場合は、実際の authorize が返す wallet_uri_base の値に
 * 合わせて更新する (docs/confirm.md 8.76 項)。
 */
export const KNOWN_WALLET_APPS: KnownWalletApp[] = [
  {
    id: "phantom",
    label: "Phantom",
    baseUri: "https://phantom.app",
    hint: "Opens Phantom directly",
  },
  {
    id: "solflare",
    label: "Solflare",
    baseUri: "https://solflare.com",
    hint: "Opens Solflare directly",
  },
  {
    id: "other",
    label: "Other wallet…",
    baseUri: null,
    hint: "Choose from installed apps",
  },
];

export interface WalletPickerModalProps {
  visible: boolean;
  onClose: () => void;
  /** 選択された wallet の baseUri (Other は null)。呼び手が connect({ baseUri }) する */
  onSelect: (baseUri: string | null) => void;
  testID?: string;
}

export function WalletPickerModal({
  visible,
  onClose,
  onSelect,
  testID,
}: WalletPickerModalProps) {
  const styles = useThemedStyles(makeStyles);

  // WalletPopover / ActionModal と同じ renderModal lifecycle
  const [renderModal, setRenderModal] = useState(visible);
  const enter = useSharedValue(0);

  useEffect(() => {
    if (visible) {
      setRenderModal(true);
      enter.value = withSpring(1, { damping: 18, stiffness: 220, mass: 0.6 });
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
    transform: [{ scale: 0.92 + 0.08 * enter.value }],
  }));

  const backdropAnim = useAnimatedStyle(() => ({
    opacity: enter.value * 0.24,
  }));

  return (
    <Modal
      visible={renderModal}
      transparent
      animationType="none"
      onRequestClose={onClose}
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
        accessibilityLabel="Close wallet picker"
      />
      <View style={styles.centerWrap} pointerEvents="box-none">
        <Animated.View style={[styles.card, cardAnim]}>
          <BlurView
            intensity={60}
            tint="light"
            style={styles.cardBlur}
            pointerEvents="none"
          />
          <View style={styles.cardTint} pointerEvents="none" />
          <View style={styles.cardHighlight} pointerEvents="none" />

          <Text style={styles.heading}>Connect with</Text>

          {KNOWN_WALLET_APPS.map((app) => (
            <Pressable
              key={app.id}
              accessibilityRole="button"
              onPress={() => onSelect(app.baseUri)}
              style={styles.row}
              testID={testID ? `${testID}-${app.id}` : undefined}
            >
              <View style={styles.badge}>
                <Text style={styles.badgeLetter}>
                  {app.label.charAt(0).toUpperCase()}
                </Text>
              </View>
              <View style={styles.rowMain}>
                <Text style={styles.rowLabel}>{app.label}</Text>
                <Text style={styles.rowHint}>{app.hint}</Text>
              </View>
              <Text style={styles.chevron}>›</Text>
            </Pressable>
          ))}
        </Animated.View>
      </View>
    </Modal>
  );
}

function makeStyles(c: ThemeColors) {
  return StyleSheet.create({
    backdropBase: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: "#000",
    },
    centerWrap: {
      ...StyleSheet.absoluteFillObject,
      alignItems: "center",
      justifyContent: "center",
      padding: SPACE.lg,
    },
    card: {
      width: "100%",
      maxWidth: 320,
      backgroundColor: c.bgCard,
      borderRadius: RADIUS.lg,
      padding: 14,
      borderWidth: 1,
      borderColor: c.border,
      overflow: "hidden",
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
    row: {
      flexDirection: "row",
      alignItems: "center",
      backgroundColor: withAlpha(c.textOnColor, 0.5),
      borderRadius: RADIUS.md,
      padding: 10,
      borderWidth: 1,
      borderColor: c.border,
      marginBottom: SPACE.xs,
    },
    badge: {
      width: 36,
      height: 36,
      borderRadius: RADIUS.md,
      backgroundColor: c.sodaLight,
      alignItems: "center",
      justifyContent: "center",
      marginRight: 12,
    },
    badgeLetter: {
      fontSize: FONT_SIZE.bodyLG,
      fontFamily: FONT.heading,
      fontWeight: WEIGHT.bold,
      color: c.sodaText,
    },
    rowMain: {
      flex: 1,
      gap: 1,
    },
    rowLabel: {
      color: c.textPrimary,
      fontFamily: FONT.heading,
      fontWeight: WEIGHT.bold,
      fontSize: FONT_SIZE.bodyMD,
    },
    rowHint: {
      color: c.textMuted,
      fontFamily: FONT.body,
      fontSize: 11,
    },
    chevron: {
      color: c.textMuted,
      fontSize: FONT_SIZE.bodyLG,
      marginLeft: SPACE.xs,
    },
  });
}
