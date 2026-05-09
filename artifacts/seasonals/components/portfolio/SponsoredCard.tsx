/**
 * SponsoredCard — Portfolio expanded sheet 内の sponsored slot (dummy fixture)
 *
 * prototype の "Jupiter Lend · JupUSD APY +0.5% — an offer just for you" を
 * 黒地カード + melonLight pill ボタンで再現。実 sponsored slot の枠組みは後続で。
 */

import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import {
  COLOR,
  FONT,
  FONT_SIZE,
  RADIUS,
  SPACE,
  WEIGHT,
} from "@workspace/lib/design-system";

export interface SponsoredOffer {
  /** 短い tag (例: "Sponsored") */
  tag: string;
  /** Headline (例: "Jupiter Lend · JupUSD APY +0.5% — an offer just for you") */
  headline: string;
  /** CTA label (例: "Claim offer") */
  cta: string;
}

const FIXTURE_OFFER: SponsoredOffer = {
  tag: "— Sponsored",
  headline: "Jupiter Lend · JupUSD APY +0.5% — an offer just for you",
  cta: "Claim offer",
};

export interface SponsoredCardProps {
  offer?: SponsoredOffer;
  onClaim?: () => void;
  testID?: string;
}

export function SponsoredCard({
  offer = FIXTURE_OFFER,
  onClaim,
  testID,
}: SponsoredCardProps) {
  return (
    <View style={styles.card} testID={testID}>
      <Text style={styles.tag}>{offer.tag}</Text>
      <Text style={styles.headline}>{offer.headline}</Text>
      <Pressable
        accessibilityRole="button"
        onPress={onClaim}
        style={({ pressed }) => [
          styles.cta,
          pressed && { opacity: 0.85 },
        ]}
        testID={testID ? `${testID}-cta` : undefined}
      >
        <Text style={styles.ctaText}>{offer.cta}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    // prototype の black sponsored card 背景。brand palette には black token がないため
    // sponsored 専用 literal として閉じ込め (他箇所からは参照しない)。
    backgroundColor: "#0E1418",
    borderRadius: RADIUS.lg,
    padding: SPACE.lg,
    gap: SPACE.sm,
  },
  tag: {
    fontSize: FONT_SIZE.bodySM,
    fontFamily: FONT.heading,
    fontWeight: WEIGHT.semibold,
    color: COLOR.melonDeep,
  },
  headline: {
    fontSize: FONT_SIZE.bodyLG,
    fontFamily: FONT.heading,
    fontWeight: WEIGHT.bold,
    color: COLOR.textOnColor,
    lineHeight: 22,
  },
  cta: {
    alignSelf: "flex-start",
    marginTop: SPACE.sm,
    paddingHorizontal: SPACE.md,
    paddingVertical: SPACE.xs + 2,
    borderRadius: RADIUS.pill,
    backgroundColor: COLOR.melonLight,
  },
  ctaText: {
    fontSize: FONT_SIZE.bodyMD,
    fontFamily: FONT.heading,
    fontWeight: WEIGHT.bold,
    color: COLOR.textPrimary,
  },
});
