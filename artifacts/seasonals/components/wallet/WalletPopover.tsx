/**
 * WalletPopover — drink button から起動する 右上 fade-in popover (Phase 5A.8 retake)
 *
 * Prototype `WalletPopover.tsx` 準拠 (slide-up sheet ではなく native Modal で fade)。
 *
 * 構成 (anchor: top: anchorTop, right: 14, width: 280):
 *   "Wallets" overline
 *   wallets 配列の各 row (active marker + label + truncated address)
 *   "+ Add Wallet" row (tap → useWallet().connect()、MWA はここからのみ起動)
 *   "Subscription" full-width pill button
 *
 * 5A.8.5 empty state: wallets.length === 0 → wallet section を完全省略。
 */

import React from "react";
import {
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useRouter } from "expo-router";
import { BlurView } from "expo-blur";

import {
  COLOR,
  FONT,
  FONT_SIZE,
  RADIUS,
  SPACE,
  WEIGHT,
  withAlpha,
} from "@workspace/lib/design-system";

import { useWallet } from "../../services/useWallet";

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
  const { authorization, connect } = useWallet();

  const handleAddWallet = async () => {
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

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
      testID={testID}
    >
      <Pressable style={styles.backdrop} onPress={onClose} />
      <View style={[styles.card, { top: anchorTop }]}>
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
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.18)",
  },
  card: {
    position: "absolute",
    right: 14,
    width: 280,
    backgroundColor: COLOR.bgCard,
    borderRadius: RADIUS.lg,
    padding: 14,
    borderWidth: 1,
    borderColor: COLOR.border,
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
    backgroundColor: COLOR.bgCard,
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
    color: COLOR.textMuted,
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
    backgroundColor: withAlpha(COLOR.textOnColor, 0.6),
    borderRadius: RADIUS.md,
    padding: 10,
    borderWidth: 1,
    borderColor: COLOR.border,
  },
  iconDark: {
    width: 36,
    height: 36,
    borderRadius: RADIUS.md,
    backgroundColor: COLOR.textPrimary,
    alignItems: "center",
    justifyContent: "center",
    marginRight: 12,
  },
  iconLetter: {
    fontSize: FONT_SIZE.bodyLG,
    fontFamily: FONT.heading,
    fontWeight: WEIGHT.bold,
    color: COLOR.textOnColor,
  },
  walletMain: {
    flex: 1,
    gap: 1,
  },
  walletLabel: {
    color: COLOR.textMuted,
    fontFamily: FONT.body,
    fontSize: 11,
  },
  walletProvider: {
    color: COLOR.textPrimary,
    fontFamily: FONT.heading,
    fontWeight: WEIGHT.bold,
    fontSize: FONT_SIZE.bodyMD,
  },
  walletAddress: {
    color: COLOR.textMuted,
    fontFamily: FONT.mono,
    fontSize: FONT_SIZE.bodySM,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: COLOR.melonText,
    marginLeft: SPACE.xs,
  },
  addRow: {
    flexDirection: "row",
    alignItems: "center",
    padding: 10,
    marginTop: SPACE.xs,
    borderRadius: RADIUS.md,
    borderWidth: 1,
    borderColor: COLOR.border,
    backgroundColor: withAlpha(COLOR.textOnColor, 0.4),
  },
  addBadge: {
    width: 36,
    height: 36,
    borderRadius: RADIUS.md,
    backgroundColor: COLOR.sodaLight,
    alignItems: "center",
    justifyContent: "center",
    marginRight: 12,
  },
  addBadgePlus: {
    fontSize: 22,
    fontFamily: FONT.heading,
    fontWeight: WEIGHT.bold,
    color: COLOR.sodaText,
    lineHeight: 24,
  },
  subBtn: {
    marginTop: SPACE.sm,
    paddingVertical: 10,
    borderRadius: RADIUS.pill,
    backgroundColor: COLOR.melonDeep,
    alignItems: "center",
  },
  subBtnText: {
    fontSize: FONT_SIZE.bodyMD,
    fontFamily: FONT.heading,
    fontWeight: WEIGHT.bold,
    color: COLOR.textOnColor,
  },
});
