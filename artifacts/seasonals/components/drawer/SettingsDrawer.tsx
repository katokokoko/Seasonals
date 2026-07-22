/**
 * SettingsDrawer — 左 slide-in panel (prototype `settings-top.png` / `settings-bottom.png` 準拠)
 *
 * セクション順 (per-screen brand color = melonText):
 *   APPEARANCE: Theme dropdown / Base currency toggle
 *   SUBSCRIPTION: "You're on Free" + Upgrade
 *   SEASONAL STAKING: Staked status + Stake now CTA
 *   REWARDS: Points
 *   REFERRALS: Referrals count + code
 *   AGENT: Policy dropdown + Ask Agent (coming soon)
 *   WALLET: Connected status + Add Wallet/Subscription/Sign out
 *   DEVELOPER (__DEV__ only): MWA probe + BFF URL
 *   Footer: Seasonals · v0.0.1 (dev)
 *
 * brand wordmark tap または edge swipe (右へ) で開く。reanimated で translation アニメ、
 * backdrop tap or 左 swipe で close。
 *
 * @see CLAUDE.md §6 デザインシステム規約
 * @see docs/spec.md §11.6 UserPolicy / Objective
 */

import React, { useEffect, useMemo, useState } from "react";
import {
  Dimensions,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Link, useRouter } from "expo-router";
import {
  Gesture,
  GestureDetector,
} from "react-native-gesture-handler";
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
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
import { OBJECTIVES, type Objective } from "@workspace/lib/types";

import { useWallet } from "../../services/useWallet";
import { BFF_BASE_URL } from "../../services/config";
import {
  formatTimeOfDay,
  useDevFallbackLog,
} from "../../stores/devFallbackLog";
import {
  THEME_CATALOG,
  useThemeStore,
  useThemedStyles,
  type ThemeColors,
} from "../../stores/theme";
import { useComingSoon } from "../../stores/comingSoon";
import { usePrefsStore } from "../../stores/prefs";

const SCREEN_WIDTH = Dimensions.get("window").width;
const DRAWER_WIDTH = Math.min(360, SCREEN_WIDTH * 0.85);
const ANIM_DURATION = 220;

export interface SettingsDrawerProps {
  visible: boolean;
  onClose: () => void;
  testID?: string;
}

export function SettingsDrawer({
  visible,
  onClose,
  testID,
}: SettingsDrawerProps) {
  // Phase 7.9: theme 連動 styles
  const styles = useThemedStyles(makeStyles);

  const translateX = useSharedValue(-DRAWER_WIDTH);
  const backdropOpacity = useSharedValue(0);

  const { authorization, isConnected, disconnect } = useWallet();

  const router = useRouter();

  // Active theme (Phase 5C.1) — store から表示名を解決
  const activeThemeId = useThemeStore((s) => s.activeThemeId);
  const themeHydrate = useThemeStore((s) => s.hydrate);
  const themeReset = useThemeStore((s) => s.reset);
  const activeTheme = useMemo(
    () =>
      THEME_CATALOG.find((t) => t.id === activeThemeId) ?? THEME_CATALOG[0]!,
    [activeThemeId]
  );

  useEffect(() => {
    themeHydrate();
  }, [themeHydrate]);

  // Phase 8.36: 液体演出 on/off (prefs store — 本 drawer 初の永続化設定)
  const liquidEffect = usePrefsStore((s) => s.liquidEffect);
  const setLiquidEffect = usePrefsStore((s) => s.setLiquidEffect);

  // Local UI state — 永続化は後続 phase で UserPolicy / preferences API へ
  const [baseCurrency, setBaseCurrency] = useState<"USDC" | "SOL">("SOL");
  const [policyIdx, setPolicyIdx] = useState<number>(0); // safety_first
  const policy: Objective = OBJECTIVES[policyIdx]!;

  // mock points / referrals (next phase で fixture-derived に差替)
  const points = 1240;
  const referrals = 0;
  const referralCode = "exseason";
  const stakedSol = 0;

  // Phase 5B.3: 直近の fixture fallback (dev only、UI 表示 1 row)
  const fallback = useDevFallbackLog((s) => s.last);

  useEffect(() => {
    translateX.value = withTiming(visible ? 0 : -DRAWER_WIDTH, {
      duration: ANIM_DURATION,
    });
    backdropOpacity.value = withTiming(visible ? 0.45 : 0, {
      duration: ANIM_DURATION,
    });
  }, [visible, translateX, backdropOpacity]);

  // 左 swipe で close する gesture
  const swipeGesture = Gesture.Pan()
    .activeOffsetX([-10, 10])
    .onEnd((e) => {
      if (e.translationX < -50) runOnJS(onClose)();
    });

  const drawerStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }],
  }));
  const backdropStyle = useAnimatedStyle(() => ({
    opacity: backdropOpacity.value,
  }));

  const handleSignOut = async () => {
    try {
      await disconnect();
    } catch {
      /* noop */
    }
    onClose();
  };

  const cyclePolicy = () =>
    setPolicyIdx((idx) => (idx + 1) % OBJECTIVES.length);

  const walletConnectedLabel = useMemo(() => {
    if (!isConnected || !authorization) return "Not connected";
    return authorization.label || "Seeker";
  }, [isConnected, authorization]);

  if (!visible && translateX.value <= -DRAWER_WIDTH + 1) {
    return null;
  }

  return (
    <View
      pointerEvents={visible ? "auto" : "none"}
      style={StyleSheet.absoluteFill}
      testID={testID}
    >
      {/* Backdrop */}
      <Pressable
        accessibilityLabel="Close settings"
        onPress={onClose}
        style={StyleSheet.absoluteFill}
      >
        <Animated.View style={[styles.backdrop, backdropStyle]} />
      </Pressable>

      {/* Drawer */}
      <GestureDetector gesture={swipeGesture}>
        <Animated.View style={[styles.drawer, drawerStyle]}>
          {/* Header — Pacifico melonText */}
          <View style={styles.header}>
            <Text style={styles.title}>Settings</Text>
            <Pressable
              accessibilityRole="button"
              onPress={onClose}
              hitSlop={12}
              style={styles.closeBtn}
              testID={testID ? `${testID}-close` : undefined}
            >
              <Text style={styles.closeIcon}>✕</Text>
            </Pressable>
          </View>

          <ScrollView
            contentContainerStyle={styles.scrollContent}
            showsVerticalScrollIndicator={false}
          >
            {/* APPEARANCE */}
            <SectionLabel>Appearance</SectionLabel>
            <View style={styles.card}>
              <Pressable
                accessibilityRole="button"
                onPress={() => {
                  onClose();
                  router.push("/theme-shop");
                }}
                style={styles.row}
                testID={testID ? `${testID}-theme` : undefined}
              >
                <Text style={styles.rowLabel}>Theme</Text>
                <View style={styles.rowRight}>
                  <Text style={styles.rowValueAccent}>{activeTheme.name}</Text>
                  <Text style={styles.chevron}>›</Text>
                </View>
              </Pressable>
              <View style={styles.divider} />
              <View style={styles.row}>
                <Text style={styles.rowLabel}>Base currency</Text>
                <View style={styles.toggle}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ selected: baseCurrency === "USDC" }}
                    onPress={() => setBaseCurrency("USDC")}
                    style={[
                      styles.toggleBtn,
                      baseCurrency === "USDC" && styles.toggleBtnActive,
                    ]}
                  >
                    <Text
                      style={[
                        styles.toggleText,
                        baseCurrency === "USDC" && styles.toggleTextActive,
                      ]}
                    >
                      USDC
                    </Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ selected: baseCurrency === "SOL" }}
                    onPress={() => setBaseCurrency("SOL")}
                    style={[
                      styles.toggleBtn,
                      baseCurrency === "SOL" && styles.toggleBtnActive,
                    ]}
                  >
                    <Text
                      style={[
                        styles.toggleText,
                        baseCurrency === "SOL" && styles.toggleTextActive,
                      ]}
                    >
                      SOL
                    </Text>
                  </Pressable>
                </View>
              </View>
              <View style={styles.divider} />
              {/* Phase 8.36: 液体演出 on/off (prefs store で永続化、§2.4) */}
              <View style={styles.row}>
                <Text style={styles.rowLabel}>Liquid effect</Text>
                <View style={styles.toggle}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ selected: liquidEffect }}
                    onPress={() => setLiquidEffect(true)}
                    style={[styles.toggleBtn, liquidEffect && styles.toggleBtnActive]}
                    testID={testID ? `${testID}-liquid-on` : undefined}
                  >
                    <Text
                      style={[
                        styles.toggleText,
                        liquidEffect && styles.toggleTextActive,
                      ]}
                    >
                      On
                    </Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ selected: !liquidEffect }}
                    onPress={() => setLiquidEffect(false)}
                    style={[styles.toggleBtn, !liquidEffect && styles.toggleBtnActive]}
                    testID={testID ? `${testID}-liquid-off` : undefined}
                  >
                    <Text
                      style={[
                        styles.toggleText,
                        !liquidEffect && styles.toggleTextActive,
                      ]}
                    >
                      Off
                    </Text>
                  </Pressable>
                </View>
              </View>
            </View>

            {/* SUBSCRIPTION */}
            <SectionLabel>Subscription</SectionLabel>
            <View style={styles.subCard}>
              <Text style={styles.subHeadline}>You're on Free</Text>
              <Text style={styles.subBody}>
                Upgrade to Seasonals+ for advanced rotation strategies and lower
                fees.
              </Text>
              <Pressable
                accessibilityRole="button"
                style={styles.subUpgradeBtn}
                onPress={() =>
                  useComingSoon
                    .getState()
                    .show("Subscription upgrade is coming soon")
                }
                testID={testID ? `${testID}-upgrade` : undefined}
              >
                <Text style={styles.subUpgradeText}>Upgrade</Text>
              </Pressable>
            </View>

            {/* SEASONAL STAKING */}
            <SectionLabel>Seasonal Staking</SectionLabel>
            <View style={styles.card}>
              <View style={styles.row}>
                <Text style={styles.rowLabel}>Staked</Text>
                <Text style={styles.rowValue}>{stakedSol} SOL</Text>
              </View>
              <Pressable
                accessibilityRole="button"
                style={styles.primaryCta}
                onPress={() =>
                  useComingSoon.getState().show("Staking is coming soon")
                }
                testID={testID ? `${testID}-stake` : undefined}
              >
                <Text style={styles.primaryCtaText}>Stake now</Text>
              </Pressable>
            </View>

            {/* REWARDS */}
            <SectionLabel>Rewards</SectionLabel>
            <View style={styles.card}>
              <View style={styles.row}>
                <Text style={styles.rowLabel}>Points</Text>
                <Text style={styles.rowValue}>
                  {points.toLocaleString("en-US")}
                </Text>
              </View>
            </View>

            {/* REFERRALS */}
            <SectionLabel>Referrals</SectionLabel>
            <View style={styles.card}>
              <View style={styles.row}>
                <Text style={styles.rowLabel}>Referrals</Text>
                <Text style={styles.rowValue}>{referrals}</Text>
              </View>
              <View style={styles.divider} />
              <View style={styles.row}>
                <Text style={styles.rowLabel}>Referral code</Text>
                <Text style={styles.rowValueMono}>{referralCode}</Text>
              </View>
            </View>

            {/* AGENT */}
            <SectionLabel>Agent</SectionLabel>
            <View style={styles.card}>
              <Pressable
                accessibilityRole="button"
                onPress={cyclePolicy}
                style={styles.row}
                testID={testID ? `${testID}-policy` : undefined}
              >
                <Text style={styles.rowLabel}>Policy</Text>
                <View style={styles.rowRight}>
                  <Text style={styles.rowValueMono}>{policy}</Text>
                  <Text style={styles.chevron}>▾</Text>
                </View>
              </Pressable>
              <View style={styles.divider} />
              {/* Phase 8.30: 自律オプションの管制盤 (status/log/kill + 実 policy 編集) */}
              <Pressable
                accessibilityRole="button"
                onPress={() => {
                  onClose();
                  router.push("/autonomous");
                }}
                style={styles.row}
                testID={testID ? `${testID}-autonomous` : undefined}
              >
                <Text style={styles.rowLabel}>自律オプション</Text>
                <Text style={styles.chevron}>›</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ disabled: true }}
                disabled
                style={styles.askAgentBtn}
                testID={testID ? `${testID}-ask-agent` : undefined}
              >
                <Text style={styles.askAgentText}>Ask Agent (coming soon)</Text>
              </Pressable>
            </View>

            {/* WALLET */}
            <SectionLabel>Wallet</SectionLabel>
            <View style={styles.card}>
              <View style={styles.row}>
                <Text style={styles.rowLabel}>Connected</Text>
                <Text style={styles.rowValue}>{walletConnectedLabel}</Text>
              </View>
              <View style={styles.walletBtnRow}>
                <Pressable
                  accessibilityRole="button"
                  style={[styles.walletBtn, styles.walletBtnFilled]}
                  testID={testID ? `${testID}-add-wallet` : undefined}
                >
                  <Text style={styles.walletBtnFilledText}>
                    + Add Wallet · PLUS
                  </Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  style={[styles.walletBtn, styles.walletBtnOutlined]}
                  testID={testID ? `${testID}-subscription` : undefined}
                >
                  <Text style={styles.walletBtnOutlinedText}>Subscription</Text>
                </Pressable>
              </View>
              {authorization && (
                <Pressable
                  accessibilityRole="button"
                  onPress={handleSignOut}
                  style={styles.signOutRow}
                  testID={testID ? `${testID}-signout` : undefined}
                >
                  <Text style={styles.signOutText}>Sign out</Text>
                </Pressable>
              )}
            </View>

            {/* DEVELOPER — dev build のみ */}
            {__DEV__ && (
              <>
                <SectionLabel>Developer (debug only)</SectionLabel>
                <View style={styles.card}>
                  <Link href="/probe" asChild>
                    <Pressable
                      accessibilityRole="button"
                      onPress={onClose}
                      style={styles.row}
                      testID={testID ? `${testID}-probe` : undefined}
                    >
                      <Text style={styles.rowLabel}>🔧 MWA probe</Text>
                      <Text style={styles.chevron}>›</Text>
                    </Pressable>
                  </Link>
                  <View style={styles.divider} />
                  <View style={styles.row}>
                    <Text style={styles.rowLabel}>BFF</Text>
                    <Text style={styles.rowValueMono}>{BFF_BASE_URL}</Text>
                  </View>
                  {fallback && (
                    <>
                      <View style={styles.divider} />
                      <View style={styles.row}>
                        <Text style={styles.rowLabel}>Last fallback</Text>
                        <Text
                          style={styles.rowValueMono}
                          numberOfLines={1}
                          testID={
                            testID ? `${testID}-last-fallback` : undefined
                          }
                        >
                          {formatTimeOfDay(fallback.timestamp)} —{" "}
                          {fallback.route}
                        </Text>
                      </View>
                    </>
                  )}
                  <View style={styles.divider} />
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => themeReset()}
                    style={styles.row}
                    testID={
                      testID ? `${testID}-reset-themes` : undefined
                    }
                  >
                    <Text style={styles.rowLabel}>
                      Reset theme purchases
                    </Text>
                    <Text style={styles.chevron}>›</Text>
                  </Pressable>
                </View>
              </>
            )}

            {/* Footer */}
            <View style={styles.footer}>
              <Text style={styles.footerText}>Seasonals · v0.0.1 (dev)</Text>
            </View>
          </ScrollView>
        </Animated.View>
      </GestureDetector>
    </View>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  // Phase 7.9: parent の styles は component scope に移動したので自分で hook 経由で取得
  const styles = useThemedStyles(makeStyles);
  return <Text style={styles.sectionLabel}>{children}</Text>;
}

// Phase 7.9: theme 連動 styles factory (useThemedStyles から呼ばれる)
function makeStyles(c: ThemeColors) {
  return StyleSheet.create({
    backdrop: {
      flex: 1,
      backgroundColor: c.textPrimary,
    },
    drawer: {
      position: "absolute",
      left: 0,
      top: 0,
      bottom: 0,
      width: DRAWER_WIDTH,
      backgroundColor: c.bgPrimary,
      paddingTop: SPACE.xl + SPACE.lg,
      borderRightWidth: 1,
      borderRightColor: c.borderStrong,
      shadowColor: COLOR.shadowStrong,
      shadowOffset: { width: 4, height: 0 },
      shadowOpacity: 1,
      shadowRadius: 16,
      elevation: 12,
    },
    header: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: SPACE.md,
      paddingBottom: SPACE.md,
    },
    title: {
      fontSize: FONT_SIZE.displayMD,
      fontFamily: FONT.script,
      color: c.melonText,
      lineHeight: 44,
      includeFontPadding: false,
    },
    closeBtn: {
      width: 32,
      height: 32,
      borderRadius: RADIUS.pill,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: withAlpha(c.textMuted, 0.12),
    },
    closeIcon: {
      fontSize: 14,
      color: c.textSubtitle,
      fontWeight: WEIGHT.bold,
    },
    scrollContent: {
      paddingHorizontal: SPACE.md,
      paddingBottom: SPACE.xl,
    },
    sectionLabel: {
      fontSize: FONT_SIZE.overline,
      fontFamily: FONT.body,
      fontWeight: WEIGHT.bold,
      color: c.textMuted,
      textTransform: "uppercase",
      letterSpacing: 1.2,
      marginTop: SPACE.lg,
      marginBottom: SPACE.sm,
    },
    card: {
      backgroundColor: withAlpha(c.textOnColor, 0.6),
      borderRadius: RADIUS.lg,
      paddingVertical: SPACE.xs,
      borderWidth: 1,
      borderColor: c.border,
    },
    row: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: SPACE.md,
      paddingVertical: SPACE.md - 2,
    },
    rowLabel: {
      fontSize: FONT_SIZE.bodyMD,
      fontFamily: FONT.heading,
      fontWeight: WEIGHT.semibold,
      color: c.textPrimary,
    },
    rowValue: {
      fontSize: FONT_SIZE.bodyMD,
      fontFamily: FONT.heading,
      fontWeight: WEIGHT.semibold,
      color: c.textSubtitle,
    },
    rowValueMono: {
      fontSize: FONT_SIZE.bodyMD,
      fontFamily: FONT.mono,
      color: c.textSubtitle,
    },
    rowValueAccent: {
      fontSize: FONT_SIZE.bodyMD,
      fontFamily: FONT.heading,
      fontWeight: WEIGHT.semibold,
      color: c.sodaText,
    },
    rowRight: {
      flexDirection: "row",
      alignItems: "center",
      gap: SPACE.xs,
    },
    chevron: {
      fontSize: 16,
      color: c.textMuted,
      fontFamily: FONT.heading,
    },
    divider: {
      height: 1,
      backgroundColor: c.divider,
      marginHorizontal: SPACE.md,
    },
    toggle: {
      flexDirection: "row",
      backgroundColor: withAlpha(c.textMuted, 0.08),
      borderRadius: RADIUS.pill,
      padding: 2,
    },
    toggleBtn: {
      paddingHorizontal: SPACE.md,
      paddingVertical: 4,
      borderRadius: RADIUS.pill,
      minWidth: 52,
      alignItems: "center",
      justifyContent: "center",
    },
    toggleBtnActive: {
      backgroundColor: c.sodaText,
    },
    toggleText: {
      fontSize: FONT_SIZE.bodySM,
      fontFamily: FONT.heading,
      fontWeight: WEIGHT.bold,
      color: c.textMuted,
    },
    toggleTextActive: {
      color: c.textOnColor,
    },
    subCard: {
      backgroundColor: c.melonLight,
      borderRadius: RADIUS.lg,
      padding: SPACE.lg,
      gap: SPACE.sm,
    },
    subHeadline: {
      fontSize: FONT_SIZE.headingMD,
      fontFamily: FONT.heading,
      fontWeight: WEIGHT.bold,
      color: c.textPrimary,
    },
    subBody: {
      fontSize: FONT_SIZE.bodyMD,
      fontFamily: FONT.body,
      color: c.textSubtitle,
      lineHeight: 20,
    },
    subUpgradeBtn: {
      alignSelf: "flex-start",
      marginTop: SPACE.xs,
      paddingHorizontal: SPACE.lg,
      paddingVertical: SPACE.xs + 2,
      borderRadius: RADIUS.pill,
      backgroundColor: c.melonText,
    },
    subUpgradeText: {
      fontSize: FONT_SIZE.bodyMD,
      fontFamily: FONT.heading,
      fontWeight: WEIGHT.bold,
      color: c.textOnColor,
    },
    primaryCta: {
      marginHorizontal: SPACE.md,
      marginVertical: SPACE.sm,
      paddingVertical: SPACE.md - 2,
      borderRadius: RADIUS.pill,
      backgroundColor: c.sodaText,
      alignItems: "center",
    },
    primaryCtaText: {
      fontSize: FONT_SIZE.bodyLG,
      fontFamily: FONT.heading,
      fontWeight: WEIGHT.bold,
      color: c.textOnColor,
    },
    askAgentBtn: {
      marginHorizontal: SPACE.md,
      marginBottom: SPACE.sm,
      paddingVertical: SPACE.md - 2,
      borderRadius: RADIUS.pill,
      backgroundColor: c.melonLight,
      alignItems: "center",
      opacity: 0.85,
    },
    askAgentText: {
      fontSize: FONT_SIZE.bodyMD,
      fontFamily: FONT.heading,
      fontWeight: WEIGHT.bold,
      color: c.melonText,
    },
    walletBtnRow: {
      flexDirection: "row",
      gap: SPACE.sm,
      paddingHorizontal: SPACE.md,
      paddingTop: SPACE.xs,
      paddingBottom: SPACE.sm,
    },
    walletBtn: {
      flex: 1,
      paddingVertical: SPACE.sm + 2,
      borderRadius: RADIUS.pill,
      alignItems: "center",
      justifyContent: "center",
    },
    walletBtnFilled: {
      backgroundColor: c.melonText,
    },
    walletBtnFilledText: {
      fontSize: FONT_SIZE.bodySM,
      fontFamily: FONT.heading,
      fontWeight: WEIGHT.bold,
      color: c.textOnColor,
    },
    walletBtnOutlined: {
      borderWidth: 1,
      borderColor: c.borderStrong,
      backgroundColor: "transparent",
    },
    walletBtnOutlinedText: {
      fontSize: FONT_SIZE.bodySM,
      fontFamily: FONT.heading,
      fontWeight: WEIGHT.bold,
      color: c.textPrimary,
    },
    signOutRow: {
      paddingHorizontal: SPACE.md,
      paddingTop: SPACE.xs,
      paddingBottom: SPACE.md,
    },
    signOutText: {
      fontSize: FONT_SIZE.bodyMD,
      fontFamily: FONT.heading,
      fontWeight: WEIGHT.semibold,
      color: c.cherryDark,
    },
    footer: {
      marginTop: SPACE.xxl,
      paddingTop: SPACE.md,
      paddingBottom: SPACE.lg,
    },
    footerText: {
      fontSize: FONT_SIZE.caption,
      fontFamily: FONT.body,
      color: c.textMuted,
      textAlign: "center",
    },
  });
}
