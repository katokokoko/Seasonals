/**
 * CooldownEventDetail — Calendar の SKR lockup_end event 詳細 (docs/skr-r0-implementation.md §4)
 *
 * - event id に対応する read response の position を直接解決する (positionRef は null のまま)
 * - 量・状態は StakingRow と同じ表示規則 (cooldown-display.ts)。stale なら断定しない
 * - 公式ポータルへの link と、BFF を再取得する Refresh
 */
import React from "react";
import { Linking, Pressable, StyleSheet, Text, View } from "react-native";

import { SKR_STAKING_PORTAL_URL } from "@workspace/lib/config/skr-staking";
import { FONT, FONT_SIZE, RADIUS, SPACE, WEIGHT, withAlpha } from "@workspace/lib/design-system";

import { useThemedStyles, type ThemeColors } from "../../stores/theme";
import type { SkrStakingView } from "../../services/useSkrStakingView";
import { cooldownDisplay } from "../portfolio/cooldown-display";

export interface CooldownEventDetailProps {
  view: SkrStakingView | null;
  eventId: string;
  testID?: string;
}

export function CooldownEventDetail({ view, eventId, testID }: CooldownEventDetailProps) {
  const styles = useThemedStyles(makeStyles);
  const matches = view?.state?.events.some((e) => e.event.id === eventId) ?? false;
  const d = view && matches ? cooldownDisplay(view) : null;

  return (
    <View style={styles.box} testID={testID}>
      <View style={styles.headerRow}>
        <Text style={styles.title}>SKR staking cooldown</Text>
        {d?.isDemo && (
          <Text style={styles.pill} testID={testID ? `${testID}-demo` : undefined}>
            Demo
          </Text>
        )}
      </View>
      {d ? (
        <>
          <Text style={styles.line} testID={testID ? `${testID}-status` : undefined}>
            {d.status}
          </Text>
          <Text style={styles.line} testID={testID ? `${testID}-amounts` : undefined}>
            {`Unstaking ${d.pending} · Staked (est.) ${d.stakedEstimate}`}
          </Text>
          {d.observed && <Text style={styles.muted}>{d.observed}</Text>}
        </>
      ) : (
        <Text style={styles.muted} testID={testID ? `${testID}-unresolved` : undefined}>
          Latest status unavailable · tap Refresh
        </Text>
      )}
      <View style={styles.actions}>
        <Pressable
          accessibilityRole="button"
          onPress={() => void view?.refetch()}
          disabled={!view}
          style={styles.button}
          testID={testID ? `${testID}-refresh` : undefined}
        >
          <Text style={styles.buttonText}>{view?.isFetching ? "Refreshing…" : "Refresh"}</Text>
        </Pressable>
        <Pressable
          accessibilityRole="link"
          onPress={() => void Linking.openURL(SKR_STAKING_PORTAL_URL)}
          style={styles.button}
          testID={testID ? `${testID}-portal` : undefined}
        >
          <Text style={styles.buttonText}>Official portal ↗</Text>
        </Pressable>
      </View>
    </View>
  );
}

function makeStyles(c: ThemeColors) {
  return StyleSheet.create({
    box: {
      marginTop: SPACE.sm,
      gap: SPACE.xs,
      padding: SPACE.sm,
      borderRadius: RADIUS.md,
      backgroundColor: withAlpha(c.caramel, 0.08),
    },
    headerRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
    },
    title: {
      fontSize: FONT_SIZE.bodySM,
      fontFamily: FONT.heading,
      fontWeight: WEIGHT.semibold,
      color: c.textPrimary,
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
    line: {
      fontSize: FONT_SIZE.bodySM,
      fontFamily: FONT.body,
      color: c.textSubtitle,
    },
    muted: {
      fontSize: FONT_SIZE.caption,
      fontFamily: FONT.body,
      color: c.textMuted,
    },
    actions: {
      flexDirection: "row",
      gap: SPACE.sm,
      paddingTop: SPACE.xs,
    },
    button: {
      paddingHorizontal: SPACE.sm,
      paddingVertical: 4,
      borderRadius: RADIUS.pill,
      borderWidth: 1,
      borderColor: c.border,
    },
    buttonText: {
      fontSize: FONT_SIZE.caption,
      fontFamily: FONT.heading,
      fontWeight: WEIGHT.semibold,
      color: c.sodaText,
    },
  });
}
