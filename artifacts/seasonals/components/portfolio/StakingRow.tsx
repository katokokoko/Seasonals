/**
 * StakingRow — SKR staking の専用 row (docs/skr-r0-implementation.md §4)
 *
 * - 「ステーク中（推定）」と「解除待ち / 引き出し可能」を表示。元本 / 収益 / USD / ROI は —
 * - portfolio 合計・allocation・履歴には入れない (Position ではない専用型、「Not in totals」ラベル)
 * - demo source は必ず Demo pill を出す。stale なら観測時刻と「awaiting update」を出す
 * - 解除・引き出しは公式ポータル (Seasonals は署名しない)
 */
import React from "react";
import { Linking, Pressable, StyleSheet, Text, View } from "react-native";

import { SKR_STAKING_PORTAL_URL } from "@workspace/lib/config/skr-staking";
import {
  FONT,
  FONT_SIZE,
  RADIUS,
  SPACE,
  WEIGHT,
  withAlpha,
} from "@workspace/lib/design-system";

import { useThemedStyles, type ThemeColors } from "../../stores/theme";
import type { SkrStakingView } from "../../services/useSkrStakingView";
import { cooldownDisplay, NOT_AVAILABLE, type CooldownStatusTone } from "./cooldown-display";

export interface StakingRowProps {
  view: SkrStakingView;
  testID?: string;
}

export function StakingRow({ view, testID }: StakingRowProps) {
  const styles = useThemedStyles(makeStyles);
  const d = cooldownDisplay(view);
  const toneStyle = toneStyleOf(styles, d.statusTone);

  return (
    <View style={styles.card} testID={testID}>
      <View style={styles.headerRow}>
        <Text style={styles.title}>SKR staking</Text>
        <View style={styles.pills}>
          {d.isDemo && (
            <Text style={styles.pill} testID={testID ? `${testID}-demo` : undefined}>
              Demo
            </Text>
          )}
          <Text style={styles.pill} testID={testID ? `${testID}-excluded` : undefined}>
            Not in totals
          </Text>
        </View>
      </View>

      {d.kind === "position" && (
        <>
          <View style={styles.row}>
            <Text style={styles.label}>Staked (est.)</Text>
            <Text style={styles.value} testID={testID ? `${testID}-staked` : undefined}>
              {d.stakedEstimate}
            </Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.label}>Unstaking</Text>
            <Text style={styles.value} testID={testID ? `${testID}-pending` : undefined}>
              {d.pending}
            </Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.label}>Principal · Yield · USD</Text>
            <Text style={styles.valueMuted}>{`${NOT_AVAILABLE} · ${NOT_AVAILABLE} · ${NOT_AVAILABLE}`}</Text>
          </View>
        </>
      )}

      <Text style={[styles.status, toneStyle]} testID={testID ? `${testID}-status` : undefined}>
        {d.status}
      </Text>
      {d.observed && (
        <Text style={styles.observed} testID={testID ? `${testID}-observed` : undefined}>
          {view.isFetching ? `${d.observed} · updating…` : d.observed}
        </Text>
      )}

      <Pressable
        accessibilityRole="link"
        onPress={() => void Linking.openURL(SKR_STAKING_PORTAL_URL)}
        style={styles.portal}
        testID={testID ? `${testID}-portal` : undefined}
      >
        <Text style={styles.portalText}>Unstake or withdraw on the official portal ↗</Text>
      </Pressable>
    </View>
  );
}

function toneStyleOf(styles: ReturnType<typeof makeStyles>, tone: CooldownStatusTone) {
  switch (tone) {
    case "positive":
      return styles.statusPositive;
    case "muted":
      return styles.statusMuted;
    case "neutral":
      return styles.statusNeutral;
  }
}

function makeStyles(c: ThemeColors) {
  return StyleSheet.create({
    card: {
      gap: SPACE.xs + 2,
      paddingVertical: SPACE.sm,
      paddingHorizontal: SPACE.sm,
      borderRadius: RADIUS.lg,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: withAlpha(c.bgCard, 0.35),
    },
    headerRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: SPACE.sm,
    },
    title: {
      fontSize: FONT_SIZE.bodyMD,
      fontFamily: FONT.heading,
      fontWeight: WEIGHT.semibold,
      color: c.textPrimary,
    },
    pills: {
      flexDirection: "row",
      gap: SPACE.xs,
    },
    pill: {
      fontSize: FONT_SIZE.caption,
      fontFamily: FONT.heading,
      fontWeight: WEIGHT.semibold,
      color: c.textMuted,
      backgroundColor: withAlpha(c.textMuted, 0.12),
      paddingHorizontal: 8,
      paddingVertical: 2,
      borderRadius: RADIUS.pill,
      overflow: "hidden",
    },
    row: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      gap: SPACE.sm,
    },
    label: {
      fontSize: FONT_SIZE.bodySM,
      fontFamily: FONT.body,
      color: c.textSubtitle,
    },
    value: {
      fontSize: FONT_SIZE.bodyMD,
      fontFamily: FONT.heading,
      fontWeight: WEIGHT.bold,
      color: c.textPrimary,
    },
    valueMuted: {
      fontSize: FONT_SIZE.bodySM,
      fontFamily: FONT.heading,
      color: c.textMuted,
    },
    status: {
      fontSize: FONT_SIZE.bodySM,
      fontFamily: FONT.heading,
      fontWeight: WEIGHT.semibold,
    },
    statusPositive: { color: c.melonText },
    statusNeutral: { color: c.caramel },
    statusMuted: { color: c.textMuted },
    observed: {
      fontSize: FONT_SIZE.caption,
      fontFamily: FONT.body,
      color: c.textMuted,
    },
    portal: {
      paddingTop: SPACE.xs,
    },
    portalText: {
      fontSize: FONT_SIZE.bodySM,
      fontFamily: FONT.heading,
      fontWeight: WEIGHT.semibold,
      color: c.sodaText,
    },
  });
}
