/**
 * Theme Shop screen (Phase 5C.1)
 *
 * 構成 (prototype `setting-theme-afterpurchace.png` 準拠、初期状態は purchase ボタン):
 *   Header: "‹ Back" pill (left) + Pacifico "Theme Shop" melonText (center)
 *   Subtitle: "Pick the seasonal palette that fits your mood. Owned themes can be applied any time."
 *   Promo card (melonLight): "All themes are included with Seasonals+. ..."
 *   Theme cards (4):
 *     - Cream Soda: Active pill + In use 表示 (default、free、always owned)
 *     - Other:      Active 時 → Active pill + In use / Owned (not active) → Apply / Not owned → Purchase ($0.99)
 *   Footer: "Prototype only — purchases are mocked and stored locally."
 *
 * 永続化: AsyncStorage themes:owned / themes:active (stores/theme.ts)
 */

import React, { useEffect } from "react";
import {
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";

import {
  FONT,
  FONT_SIZE,
  RADIUS,
  SPACE,
  WEIGHT,
  withAlpha,
} from "@workspace/lib/design-system";

import {
  DEFAULT_THEME_ID,
  THEME_CATALOG,
  useThemeStore,
  useThemedStyles,
  type ThemeColors,
  type ThemeMeta,
} from "../stores/theme";

export default function ThemeShopScreen() {
  const router = useRouter();
  const activeThemeId = useThemeStore((s) => s.activeThemeId);
  const isOwned = useThemeStore((s) => s.isOwned);
  const setActive = useThemeStore((s) => s.setActive);
  const purchase = useThemeStore((s) => s.purchase);
  const hydrate = useThemeStore((s) => s.hydrate);

  // Phase 7.9: theme 連動 styles (theme shop 内で Purchase/Apply 直後に即時切替を視認)
  const styles = useThemedStyles(makeStyles);

  // 起動時に AsyncStorage から復元
  useEffect(() => {
    hydrate();
  }, [hydrate]);

  const handlePurchase = (theme: ThemeMeta) => {
    // Phase 7.8: demo purchase は即 apply (確認後すぐ画面色が切替わる "instant
    // gratification")。実 payment は走らず AsyncStorage に owned 追加のみ。
    Alert.alert(
      "Purchase & Apply",
      `Purchase ${theme.name} for ${theme.price}?\n\nThis is a prototype — no real payment will be charged.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Confirm",
          onPress: () => {
            purchase(theme.id);
            setActive(theme.id);
          },
        },
      ]
    );
  };

  const handleApply = (theme: ThemeMeta) => {
    setActive(theme.id);
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
      {/* Header */}
      <View style={styles.header}>
        <Pressable
          accessibilityRole="button"
          onPress={() => router.back()}
          hitSlop={8}
          style={styles.backBtn}
          testID="theme-back"
        >
          <Text style={styles.backText}>‹ Back</Text>
        </Pressable>
        <Text style={styles.title}>Theme Shop</Text>
        <View style={styles.headerSpacer} />
      </View>

      <ScrollView
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
      >
        <Text style={styles.subtitle}>
          Pick the seasonal palette that fits your mood. Owned themes can be
          applied any time.
        </Text>

        {/* Promo card */}
        <View style={styles.promoCard}>
          <Text style={styles.promoHeadline}>
            All themes are included with Seasonals+
          </Text>
          <Text style={styles.promoBody}>
            Skip individual purchases — every palette unlocks the moment you
            upgrade.
          </Text>
        </View>

        {/* Theme cards */}
        {THEME_CATALOG.map((theme) => {
          const owned = isOwned(theme.id);
          const active = activeThemeId === theme.id;
          return (
            <View
              key={theme.id}
              style={[styles.card, active && styles.cardActive]}
              testID={`theme-card-${theme.id}`}
            >
              {/* Swatches */}
              <View style={styles.swatchCol}>
                {theme.swatches.map((color, i) => (
                  <View
                    key={i}
                    style={[styles.swatch, { backgroundColor: color }]}
                  />
                ))}
              </View>

              {/* Body */}
              <View style={styles.cardBody}>
                <View style={styles.nameRow}>
                  <Text style={styles.themeName}>{theme.name}</Text>
                  {active && (
                    <View style={styles.activePill}>
                      <Text style={styles.activePillText}>Active</Text>
                    </View>
                  )}
                </View>
                <Text style={styles.themeDesc}>{theme.description}</Text>
                <View style={styles.actionRow}>
                  {active ? (
                    <View
                      style={styles.inUseBtn}
                      testID={`theme-${theme.id}-in-use`}
                    >
                      <Text style={styles.inUseText}>In use</Text>
                    </View>
                  ) : owned ? (
                    <Pressable
                      accessibilityRole="button"
                      onPress={() => handleApply(theme)}
                      style={styles.applyBtn}
                      testID={`theme-${theme.id}-apply`}
                    >
                      <Text style={styles.applyText}>Apply</Text>
                    </Pressable>
                  ) : (
                    <>
                      <Pressable
                        accessibilityRole="button"
                        onPress={() => handlePurchase(theme)}
                        style={styles.purchaseBtn}
                        testID={`theme-${theme.id}-purchase`}
                      >
                        <Text style={styles.purchaseText}>Purchase</Text>
                      </Pressable>
                      <Text style={styles.priceText}>{theme.price}</Text>
                    </>
                  )}
                </View>
              </View>
            </View>
          );
        })}

        {/* Footer */}
        <Text style={styles.footerNote}>
          Prototype only — purchases are mocked and stored locally.
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

// ヘッダの空 spacer 用 (空 export 警告を抑制するため未使用 const は出さない)
void DEFAULT_THEME_ID;

// Phase 7.9: theme 連動 styles factory
function makeStyles(c: ThemeColors) {
  return StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: c.bgPrimary,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: SPACE.md,
    paddingTop: SPACE.sm,
    paddingBottom: SPACE.sm,
  },
  backBtn: {
    paddingHorizontal: SPACE.md,
    paddingVertical: SPACE.xs + 2,
    borderRadius: RADIUS.pill,
    backgroundColor: withAlpha(c.textMuted, 0.1),
  },
  backText: {
    fontSize: FONT_SIZE.bodyMD,
    fontFamily: FONT.heading,
    fontWeight: WEIGHT.semibold,
    color: c.textPrimary,
  },
  title: {
    fontFamily: FONT.script,
    fontSize: 32,
    color: c.melonText,
    lineHeight: 44,
    includeFontPadding: false,
  },
  headerSpacer: {
    width: 80,
  },
  scroll: {
    paddingHorizontal: SPACE.md,
    paddingBottom: SPACE.xl,
  },
  subtitle: {
    fontSize: FONT_SIZE.bodyMD,
    fontFamily: FONT.body,
    color: c.textSubtitle,
    marginTop: SPACE.sm,
    marginBottom: SPACE.md,
    lineHeight: 20,
  },
  promoCard: {
    backgroundColor: withAlpha(c.melonLight, 0.4),
    borderWidth: 1,
    borderColor: withAlpha(c.melonText, 0.3),
    borderRadius: RADIUS.lg,
    padding: SPACE.md,
    gap: SPACE.xs,
    marginBottom: SPACE.md,
  },
  promoHeadline: {
    fontSize: FONT_SIZE.bodyMD,
    fontFamily: FONT.heading,
    fontWeight: WEIGHT.bold,
    color: c.melonText,
  },
  promoBody: {
    fontSize: FONT_SIZE.bodySM,
    fontFamily: FONT.body,
    color: c.textSubtitle,
    lineHeight: 18,
  },
  // Theme card
  card: {
    flexDirection: "row",
    gap: SPACE.md,
    backgroundColor: withAlpha(c.textOnColor, 0.6),
    borderRadius: RADIUS.lg,
    borderWidth: 1,
    borderColor: c.border,
    padding: SPACE.md,
    marginBottom: SPACE.md,
  },
  cardActive: {
    borderColor: withAlpha(c.sodaText, 0.5),
    backgroundColor: withAlpha(c.sodaLight, 0.18),
  },
  swatchCol: {
    width: 50,
    gap: SPACE.xs,
    justifyContent: "center",
  },
  swatch: {
    height: 22,
    borderRadius: RADIUS.pill,
  },
  cardBody: {
    flex: 1,
    gap: SPACE.xs,
  },
  nameRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: SPACE.sm,
  },
  themeName: {
    fontSize: FONT_SIZE.headingMD,
    fontFamily: FONT.heading,
    fontWeight: WEIGHT.bold,
    color: c.textPrimary,
  },
  activePill: {
    paddingHorizontal: SPACE.sm,
    paddingVertical: 2,
    borderRadius: RADIUS.pill,
    backgroundColor: withAlpha(c.sodaText, 0.18),
  },
  activePillText: {
    fontSize: FONT_SIZE.bodySM,
    fontFamily: FONT.heading,
    fontWeight: WEIGHT.bold,
    color: c.sodaText,
  },
  themeDesc: {
    fontSize: FONT_SIZE.bodySM,
    fontFamily: FONT.body,
    color: c.textSubtitle,
    lineHeight: 18,
  },
  actionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: SPACE.sm,
    marginTop: SPACE.xs,
  },
  // Apply (owned, not active) — sodaText filled
  applyBtn: {
    paddingHorizontal: SPACE.lg,
    paddingVertical: SPACE.xs + 2,
    borderRadius: RADIUS.pill,
    backgroundColor: c.sodaText,
  },
  applyText: {
    fontSize: FONT_SIZE.bodyMD,
    fontFamily: FONT.heading,
    fontWeight: WEIGHT.bold,
    color: c.textOnColor,
  },
  // In use (active) — outlined
  inUseBtn: {
    paddingHorizontal: SPACE.lg,
    paddingVertical: SPACE.xs + 2,
    borderRadius: RADIUS.pill,
    borderWidth: 1,
    borderColor: c.borderStrong,
  },
  inUseText: {
    fontSize: FONT_SIZE.bodyMD,
    fontFamily: FONT.heading,
    fontWeight: WEIGHT.semibold,
    color: c.textPrimary,
  },
  // Purchase (not owned) — sodaText filled + price
  purchaseBtn: {
    paddingHorizontal: SPACE.lg,
    paddingVertical: SPACE.xs + 2,
    borderRadius: RADIUS.pill,
    backgroundColor: c.sodaText,
  },
  purchaseText: {
    fontSize: FONT_SIZE.bodyMD,
    fontFamily: FONT.heading,
    fontWeight: WEIGHT.bold,
    color: c.textOnColor,
  },
  priceText: {
    fontSize: FONT_SIZE.bodyMD,
    fontFamily: FONT.heading,
    fontWeight: WEIGHT.semibold,
    color: c.textSubtitle,
  },
  footerNote: {
    fontSize: FONT_SIZE.caption,
    fontFamily: FONT.body,
    color: c.textMuted,
    textAlign: "center",
    marginTop: SPACE.lg,
  },
  });
}
