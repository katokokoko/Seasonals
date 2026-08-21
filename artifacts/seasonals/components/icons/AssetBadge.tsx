/**
 * AssetBadge — asset symbol → 丸トークンロゴ (Phase 8.92 で MenuDrawer から共有化)
 *
 * 公式ロゴ PNG (assets/brands/tokens/) があれば丸抜き Image、なければ
 * brand 色の丸 + 頭文字に fallback する。MenuDrawer の vault 行 (Phase 8.12) と
 * PortfolioSummary の Wallet holdings 行が共用。
 */

import React from "react";
import { Image, Text, View, type ImageRequireSource } from "react-native";

import { COLOR, FONT, WEIGHT } from "@workspace/lib/design-system";

/** per-asset brand color (asset 固有 branding、CLAUDE.md §6 例外として AssetBadge 内に閉じ込め) */
const ASSET_BADGE_COLOR: Record<string, string> = {
  USDC: "#2775CA",
  USDT: "#26A17B",
  USDS: "#F59E0B",
  USDG: "#4F46E5",
  EURC: "#3578E5",
  JupUSD: "#F97316",
  jupUSD: "#F97316",
  SOL: "#7C3AED",
};

function assetBadgeColor(asset: string): string {
  return ASSET_BADGE_COLOR[asset] ?? COLOR.sodaText;
}

/** Phase 8.12: per-asset 公式ロゴ PNG (assets/brands/tokens/) */
const ASSET_ICON_BY_SYMBOL: Record<string, ImageRequireSource> = {
  USDC: require("../../assets/brands/tokens/usdc.png"),
  USDT: require("../../assets/brands/tokens/usdt.png"),
  SOL: require("../../assets/brands/tokens/sol.png"),
  EURC: require("../../assets/brands/tokens/eurc.png"),
  USDS: require("../../assets/brands/tokens/usds.png"),
  USDG: require("../../assets/brands/tokens/usdg.png"),
  JupUSD: require("../../assets/brands/tokens/jupusd.png"),
};

export function AssetBadge({ asset, size = 36 }: { asset: string; size?: number }) {
  const iconSrc = ASSET_ICON_BY_SYMBOL[asset];
  if (iconSrc) {
    return (
      <Image
        source={iconSrc}
        resizeMode="contain"
        style={{
          width: size,
          height: size,
          borderRadius: size / 2,
        }}
      />
    );
  }
  // Fallback: per-asset brand color circle + letter
  const bg = assetBadgeColor(asset);
  const letter = (asset[0] ?? "?").toUpperCase();
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: bg,
      }}
    >
      <Text
        style={{
          fontSize: size * 0.42,
          fontFamily: FONT.heading,
          fontWeight: WEIGHT.bold,
          color: COLOR.textOnColor,
          includeFontPadding: false,
        }}
      >
        {letter}
      </Text>
    </View>
  );
}
