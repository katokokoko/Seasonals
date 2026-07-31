/**
 * MenuDrawer — protocol → pools 階層 (Phase 6.2: 2-pane drill-down に再設計)
 *
 * 旧 accordion (LayoutAnimation で下方向展開) を廃止し、iOS Settings 風の drill-down
 * に置換。protocol tap → 右から pool detail pane が 220ms slide-in、戻る時は逆向き。
 *
 * 構成:
 *   Drawer 内に 2 pane の horizontal strip (width = DRAWER_WIDTH × 2):
 *     pane 0 = Protocol list (Menu header + search + chips + toggle + list)
 *     pane 1 = Pool detail   ("‹ Menu" back row + protocol header + scrollable pool list)
 *   selectedProtocolId 状態に応じて strip を translateX で切替 (0 / -DRAWER_WIDTH)
 *
 * Gesture / 戻る:
 *   - Detail pane 中の "‹ Menu" tap → list に戻る
 *   - Android hardware back: detail なら list へ / list なら drawer 閉
 *   - Drawer close 時に detail state を auto reset
 *   - 既存の swipe-to-close は detail 表示中は無効化 (誤発火防止)
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  BackHandler,
  Dimensions,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type ImageRequireSource,
} from "react-native";
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
import {
  PositionCategory,
  type EarnPosition,
  type EarnPositionsResponse,
  type Position,
  type ProtocolMenuEntry,
  type ProtocolPool,
} from "@workspace/lib/types";
import { formatUsd } from "@workspace/lib/utils/numeric";
import {
  findMarketByShareMint,
  heldSwapEarnPositions,
} from "@workspace/lib/config/swap-earn-markets";
import {
  findKaminoMarketByReserve,
  findKaminoVaultByAddress,
} from "@workspace/lib/config/kamino-markets";
import {
  findSaveMarketByCToken,
  heldSavePositions,
} from "@workspace/lib/config/save-markets";
import { findExponentMarketByPtMint } from "@workspace/lib/config/exponent-markets";

import type { JupiterLendMarketDTO } from "../../services/api";
import {
  useJupiterLendMarkets,
  useMenuListings,
  usePositions,
} from "../../services/queries";
// 8.44: protocol ロゴの require マップは登録漏れをテストで防ぐため別モジュールへ
import { ICON_BY_ID, scaleOf } from "./protocol-icons";

const SCREEN_WIDTH = Dimensions.get("window").width;
const DRAWER_WIDTH = Math.min(360, SCREEN_WIDTH * 0.86);
const ANIM_DURATION = 220;

type FilterKey = "all" | PositionCategory;

const CATEGORY_LABEL_FILTER: Record<FilterKey, string> = {
  all: "All",
  lending: "Lending",
  staking: "Staking",
  restaking: "Restaking",
  vault: "Vault",
  lp: "LP",
  pt_yt: "PT-YT",
  stable: "Stable",
  vesting: "Vesting",
  governance: "Governance",
  other: "Other",
};

const SECTION_HEADER: Record<PositionCategory, string> = {
  lending: "LENDING",
  staking: "STAKING",
  restaking: "RESTAKING",
  vault: "VAULT",
  lp: "LP",
  pt_yt: "PT-YT",
  stable: "STABLE",
  vesting: "VESTING",
  governance: "GOVERNANCE",
  other: "OTHER",
};

const CATEGORY_INLINE_LABEL: Record<PositionCategory, string> = {
  lending: "Lending",
  staking: "Staking",
  restaking: "Restaking",
  vault: "Vault",
  lp: "LP",
  pt_yt: "PT-YT",
  stable: "Stable",
  vesting: "Vesting",
  governance: "Governance",
  other: "Other",
};

const FILTER_ORDER: readonly FilterKey[] = [
  "all",
  PositionCategory.Lending,
  PositionCategory.Staking,
  PositionCategory.Restaking,
  PositionCategory.Vault,
  PositionCategory.LP,
  PositionCategory.PTYT,
  PositionCategory.Stable,
] as const;

const SECTION_ORDER: readonly PositionCategory[] = [
  PositionCategory.Lending,
  PositionCategory.Staking,
  PositionCategory.Restaking,
  PositionCategory.Vault,
  PositionCategory.LP,
  PositionCategory.PTYT,
  PositionCategory.Stable,
] as const;

function apyAccent(apy: number): string {
  return apy > 0.09 ? COLOR.melonText : COLOR.sodaText;
}

function formatApy(apy: number): string {
  return `${(apy * 100).toFixed(2)}%`;
}

function formatTvlUsd(usd: number): string {
  if (usd >= 1_000_000_000) {
    return `$${(usd / 1_000_000_000).toFixed(2)}B`;
  }
  if (usd >= 1_000_000) {
    return `$${(usd / 1_000_000).toFixed(2)}M`;
  }
  if (usd >= 1_000) {
    return `$${(usd / 1_000).toFixed(0)}K`;
  }
  return `$${usd.toFixed(0)}`;
}

function formatBorrowedUsd(usd: number): string {
  return formatTvlUsd(usd);
}

/**
 * Phase 8.26: lending market の稼働率表示。≥0.9 は「貸出満杯に近く withdraw が
 * 流動性不足で滞る可能性」の警告シグナルとして cherryDark、それ未満は textMuted。
 */
const UTILIZATION_WARN_THRESHOLD = 0.9;
function formatUtilization(utilization: number): string {
  return `Util ${(utilization * 100).toFixed(0)}%`;
}
function utilizationColor(utilization: number): string {
  return utilization >= UTILIZATION_WARN_THRESHOLD
    ? COLOR.cherryDark
    : COLOR.textMuted;
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 8.11: Jupiter drill-down redesign — unified vault list helpers
// ─────────────────────────────────────────────────────────────────────────────

interface JupiterVaultRow {
  jlMint: string;
  assetSymbol: string;
  apyBps: number;
  tvlUsd: number;
  underlyingDecimals: number;
  isDeposited: boolean;
  /** smallest unit string (underlying decimals 基準) */
  userUnderlyingAmount: string;
  /** display only — Phase 8.4.1 carve-out (UI direct presentation) */
  userUnderlyingHuman: number;
  userUnderlyingUsd: number;
  /** signed USD earned (loss は負)。display only。unknown 時は APR 概算 */
  userEarnedUsd: number;
  /** Phase 8.13: earned が実 cost-basis 由来か (false = APR 概算 fallback) */
  userEarnedKnown: boolean;
  /** Phase 8.13: earned 符号 (unknown 時は概算なので "gain" 相当に倒す) */
  userEarnedSign: "gain" | "loss" | "unknown";
  earnPosition?: EarnPosition;
}

const JUPITER_STABLE_ASSETS = new Set([
  "USDC",
  "USDT",
  "USDS",
  "USDG",
  "EURC",
  "jupUSD",
  "JupUSD",
]);

/** Phase 8.12: 大 list で直接見せる primary vaults。それ以外は Others に折りたたむ。 */
const JUPITER_PRIMARY_ASSETS: readonly string[] = [
  "JupUSD",
  "USDC",
  "SOL",
] as const;

function isJupiterPrimaryAsset(asset: string): boolean {
  return JUPITER_PRIMARY_ASSETS.includes(asset);
}

function sortByPrimaryOrder(rows: JupiterVaultRow[]): JupiterVaultRow[] {
  const indexOf = (s: string) => JUPITER_PRIMARY_ASSETS.indexOf(s);
  return [...rows].sort((a, b) => indexOf(a.assetSymbol) - indexOf(b.assetSymbol));
}

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

function displayJupiterAsset(symbol: string): string {
  if (symbol === "WSOL") return "SOL";
  if (symbol === "jupUSD") return "JupUSD";
  return symbol;
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

function buildJupiterVaultRows(
  markets: JupiterLendMarketDTO[],
  earnPositions?: EarnPositionsResponse
): JupiterVaultRow[] {
  const byShareMint = new Map<string, EarnPosition>();
  for (const p of earnPositions?.jupiterLend ?? []) {
    byShareMint.set(p.share_mint, p);
  }
  return markets.map((m) => {
    const assetSymbol = displayJupiterAsset(m.underlyingSymbol);
    const tvlUsd =
      (Number(m.tvlUnderlying) / Math.pow(10, m.underlyingDecimals)) *
      m.underlyingPriceUsd;
    const pos = byShareMint.get(m.jlMint);
    if (!pos) {
      return {
        jlMint: m.jlMint,
        assetSymbol,
        apyBps: m.supplyRateBps,
        tvlUsd,
        underlyingDecimals: m.underlyingDecimals,
        isDeposited: false,
        userUnderlyingAmount: "0",
        userUnderlyingHuman: 0,
        userUnderlyingUsd: 0,
        userEarnedUsd: 0,
        userEarnedKnown: false,
        userEarnedSign: "unknown",
      };
    }
    const human =
      Number(pos.underlying_amount) /
      Math.pow(10, pos.underlying_decimals);
    const usd = Number(pos.underlying_usd);
    const usdSafe = Number.isFinite(usd) ? usd : 0;
    // Phase 8.13: cost-basis 既知なら実 accrued yield を USD 換算 (損失は負)。
    // 不明 (sign === "unknown") はフェイクの APR 概算を出さず earned 不明 (UI は "—")。
    // (display 専用計算、Phase 8.4.1 UI carve-out)
    const earnedKnown = pos.accrued_yield_sign !== "unknown";
    let earnedUsd = 0;
    if (earnedKnown) {
      const perUnitUsd = human > 0 ? usdSafe / human : 0;
      const earnedHuman =
        Number(pos.accrued_yield_amount) /
        Math.pow(10, pos.underlying_decimals);
      const magnitudeUsd = earnedHuman * perUnitUsd;
      earnedUsd = pos.accrued_yield_sign === "loss" ? -magnitudeUsd : magnitudeUsd;
    }
    return {
      jlMint: m.jlMint,
      assetSymbol,
      apyBps: m.supplyRateBps,
      tvlUsd,
      underlyingDecimals: pos.underlying_decimals,
      isDeposited: true,
      userUnderlyingAmount: pos.underlying_amount,
      userUnderlyingHuman: human,
      userUnderlyingUsd: usdSafe,
      userEarnedUsd: earnedUsd,
      userEarnedKnown: earnedKnown,
      userEarnedSign: pos.accrued_yield_sign,
      earnPosition: pos,
    };
  });
}

interface JupiterSummary {
  depositedUsd: number;
  earningsUsd: number;
  /** Phase 8.13: cost-basis 既知の earned が 1 件でもあるか (false なら earnings は "—") */
  hasKnownEarnings: boolean;
  avgApyBps: number | null;
}

function computeJupiterSummary(rows: JupiterVaultRow[]): JupiterSummary {
  let depositedUsd = 0;
  let earningsUsd = 0;
  let weighted = 0;
  let hasKnownEarnings = false;
  for (const r of rows) {
    if (!r.isDeposited) continue;
    depositedUsd += r.userUnderlyingUsd;
    // Phase 8.13: cost-basis 既知の実 earned のみ合算 (符号付き)。
    // 不明は概算を混ぜず除外し、全件不明なら "—" 表示にする。
    if (r.userEarnedKnown) {
      earningsUsd += r.userEarnedUsd;
      hasKnownEarnings = true;
    }
    weighted += r.userUnderlyingUsd * (r.apyBps / 10000);
  }
  const avgApyBps =
    depositedUsd > 0 ? Math.round((weighted / depositedUsd) * 10000) : null;
  return { depositedUsd, earningsUsd, hasKnownEarnings, avgApyBps };
}

/** Number (USD, 表示専用) → "$1,234.56" 形式 */
function formatUsdDisplay(usd: number, fractionDigits = 2): string {
  if (!Number.isFinite(usd)) return "—";
  const fixed = usd.toFixed(fractionDigits);
  return formatUsd(fixed);
}

function formatHumanAmount(amount: number): string {
  if (!Number.isFinite(amount)) return "0";
  if (amount === 0) return "0";
  if (amount >= 1) return amount.toFixed(2);
  return amount.toFixed(4);
}

function AssetBadge({ asset, size = 36 }: { asset: string; size?: number }) {
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

type JupiterFilter = "all" | "stable" | "sol" | "deposited";

const JUPITER_FILTER_ORDER: readonly JupiterFilter[] = [
  "all",
  "stable",
  "sol",
  "deposited",
] as const;

const JUPITER_FILTER_LABEL: Record<JupiterFilter, string> = {
  all: "All",
  stable: "Stable",
  sol: "SOL",
  deposited: "Deposited",
};

function applyJupiterFilter(
  rows: JupiterVaultRow[],
  filter: JupiterFilter
): JupiterVaultRow[] {
  switch (filter) {
    case "all":
      return rows;
    case "stable":
      return rows.filter((r) => JUPITER_STABLE_ASSETS.has(r.assetSymbol));
    case "sol":
      return rows.filter((r) => r.assetSymbol === "SOL");
    case "deposited":
      return rows.filter((r) => r.isDeposited);
  }
}

export interface MenuDrawerProps {
  visible: boolean;
  onClose: () => void;
  /**
   * pool tap 時 (protocol_id / asset / "deposit" / pool_id)。
   * Phase 8.15d: 同一 asset に reserve 系と vault 系 pool が並ぶ protocol (Kamino) を
   * 判別するため pool_id を渡す。
   */
  onStartAction?: (
    protocol: string,
    asset: string,
    actionType: "deposit",
    poolId?: string
  ) => void;
  /** Phase 8.9: Your Positions row tap で withdraw */
  onWithdrawPosition?: (position: EarnPosition) => void;
  /**
   * Phase 8.2: 接続済 wallet の Jupiter Lend / Kamino positions。
   * undefined or 空配列なら "Your Positions" section を hide。
   */
  earnPositions?: EarnPositionsResponse | undefined;
  testID?: string;
}

export function MenuDrawer({
  visible,
  onClose,
  onStartAction,
  onWithdrawPosition,
  earnPositions,
  testID,
}: MenuDrawerProps) {
  const translateX = useSharedValue(DRAWER_WIDTH);
  const backdropOpacity = useSharedValue(0);

  const { data: listings = [] } = useMenuListings();
  const { data: positions = [] } = usePositions();
  // Phase 8.6: Jupiter Lend live markets (drill-down で fixture pools を上書き)
  const { data: jlMarkets = [] } = useJupiterLendMarkets();

  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<FilterKey>("all");
  const [depositedOnly, setDepositedOnly] = useState(false);

  // Phase 6.2: 2-pane drill-down state
  const [selectedProtocolId, setSelectedProtocolId] = useState<string | null>(
    null
  );
  const paneTx = useSharedValue(0); // 0 = list pane, -DRAWER_WIDTH = detail pane

  // protocol_id Set (deposited 判定 O(1))
  const depositedProtocolIds = useMemo(() => {
    const set = new Set<string>();
    for (const p of positions as Position[]) set.add(p.protocol_id);
    return set;
  }, [positions]);

  useEffect(() => {
    translateX.value = withTiming(visible ? 0 : DRAWER_WIDTH, {
      duration: ANIM_DURATION,
    });
    backdropOpacity.value = withTiming(visible ? 0.45 : 0, {
      duration: ANIM_DURATION,
    });
  }, [visible, translateX, backdropOpacity]);

  // Drawer close 時に detail state を auto reset
  useEffect(() => {
    if (!visible) {
      paneTx.value = 0;
      setSelectedProtocolId(null);
    }
  }, [visible, paneTx]);

  // Drill-down: protocol → pool detail pane
  const showDetail = useCallback(
    (id: string) => {
      setSelectedProtocolId(id);
      paneTx.value = withTiming(-DRAWER_WIDTH, { duration: ANIM_DURATION });
    },
    [paneTx]
  );

  const goBackToList = useCallback(() => {
    paneTx.value = withTiming(
      0,
      { duration: ANIM_DURATION },
      (finished) => {
        "worklet";
        if (finished) runOnJS(setSelectedProtocolId)(null);
      }
    );
  }, [paneTx]);

  // Android hardware back: detail なら list へ / list なら drawer 閉
  useEffect(() => {
    if (!visible) return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      if (selectedProtocolId !== null) {
        goBackToList();
      } else {
        onClose();
      }
      return true;
    });
    return () => sub.remove();
  }, [visible, selectedProtocolId, goBackToList, onClose]);

  // Swipe-to-close gesture (detail 表示中は無効化)
  const swipeGesture = Gesture.Pan()
    .activeOffsetX([-10, 10])
    .onEnd((e) => {
      "worklet";
      if (selectedProtocolId !== null) return;
      if (e.translationX > 50) runOnJS(onClose)();
    });

  const drawerStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }],
  }));
  const backdropStyle = useAnimatedStyle(() => ({
    opacity: backdropOpacity.value,
  }));
  const paneStripStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: paneTx.value }],
  }));

  // ─── Filter / search ─────────────────────────────────────
  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return listings.filter((l) => {
      if (filter !== "all" && l.primary_category !== filter) return false;
      if (depositedOnly && !depositedProtocolIds.has(l.protocol_id)) return false;
      if (term) {
        const nameMatch = l.display_name.toLowerCase().includes(term);
        const poolMatch = l.pools.some((p) =>
          p.name.toLowerCase().includes(term)
        );
        if (!nameMatch && !poolMatch) return false;
      }
      return true;
    });
  }, [listings, search, filter, depositedOnly, depositedProtocolIds]);

  const grouped = useMemo(() => {
    const map = new Map<PositionCategory, ProtocolMenuEntry[]>();
    for (const l of filtered) {
      if (!map.has(l.primary_category)) map.set(l.primary_category, []);
      map.get(l.primary_category)!.push(l);
    }
    return SECTION_ORDER.map((cat) => ({
      category: cat,
      items: map.get(cat) ?? [],
    })).filter((g) => g.items.length > 0);
  }, [filtered]);

  // 現在 detail pane で表示中の protocol entry
  const baseSelectedEntry = useMemo(
    () => listings.find((l) => l.protocol_id === selectedProtocolId) ?? null,
    [listings, selectedProtocolId]
  );

  // Phase 8.6: Jupiter drill-down の pools を Jupiter Lend live markets で上書き
  const selectedEntry = useMemo<ProtocolMenuEntry | null>(() => {
    if (!baseSelectedEntry) return null;
    if (baseSelectedEntry.protocol_id !== "jupiter") return baseSelectedEntry;
    if (jlMarkets.length === 0) return baseSelectedEntry; // fetch 前は fixture
    const liveSupportedAssets = Array.from(
      new Set(
        jlMarkets.map((m) =>
          m.underlyingSymbol === "WSOL" ? "SOL" : m.underlyingSymbol
        )
      )
    );
    const livePools: ProtocolPool[] = jlMarkets.map((m) => {
      const displayAsset =
        m.underlyingSymbol === "WSOL" ? "SOL" : m.underlyingSymbol;
      const tvlUsd =
        (Number(m.tvlUnderlying) / Math.pow(10, m.underlyingDecimals)) *
        m.underlyingPriceUsd;
      return {
        pool_id: `jl_${displayAsset}`,
        name: `Jupiter Lend ${displayAsset}`,
        category: PositionCategory.Stable,
        asset: displayAsset,
        apy: m.supplyRateBps / 10000,
        tvl_usd: tvlUsd,
      };
    });
    return {
      ...baseSelectedEntry,
      supported_assets: liveSupportedAssets,
      pools: livePools,
    };
  }, [baseSelectedEntry, jlMarkets]);

  const handlePoolTap = useCallback(
    (entry: ProtocolMenuEntry, pool: ProtocolPool) => {
      // Phase 8.33: read-only listing (Exponent PT 等) は deposit 経路なし — tap 無効
      if (pool.display_only) return;
      onClose();
      const asset = pool.deposit_asset ?? pool.asset;
      onStartAction?.(entry.protocol_id, asset, "deposit", pool.pool_id);
    },
    [onClose, onStartAction]
  );

  if (!visible && translateX.value >= DRAWER_WIDTH - 1) return null;

  return (
    <View
      pointerEvents={visible ? "auto" : "none"}
      style={StyleSheet.absoluteFill}
      testID={testID}
    >
      <Pressable
        accessibilityLabel="Close menu"
        onPress={onClose}
        style={StyleSheet.absoluteFill}
      >
        <Animated.View style={[styles.backdrop, backdropStyle]} />
      </Pressable>

      <GestureDetector gesture={swipeGesture}>
        <Animated.View style={[styles.drawer, drawerStyle]}>
          {/* 2-pane horizontal strip (Phase 6.2) */}
          <Animated.View style={[styles.pageStrip, paneStripStyle]}>
            {/* ─── Pane 0: Protocol list ─────────────────────────── */}
            <View style={styles.pane}>
              {/* Header */}
              <View style={styles.header}>
                <Text style={styles.title}>Menu</Text>
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

              {/* Search */}
              <View style={styles.searchWrap}>
                <Text style={styles.searchIcon}>🔍</Text>
                <TextInput
                  placeholder="Search protocols..."
                  placeholderTextColor={COLOR.textMuted}
                  value={search}
                  onChangeText={setSearch}
                  style={styles.searchInput}
                  testID={testID ? `${testID}-search` : undefined}
                />
              </View>

              {/* Filter chips */}
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                style={styles.chipsScroll}
                contentContainerStyle={styles.chipsRow}
              >
                {FILTER_ORDER.map((k) => {
                  const active = filter === k;
                  return (
                    <Pressable
                      key={k}
                      accessibilityRole="button"
                      accessibilityState={{ selected: active }}
                      onPress={() => setFilter(k)}
                      style={[styles.chip, active && styles.chipActive]}
                      testID={testID ? `${testID}-chip-${k}` : undefined}
                    >
                      <Text
                        style={[
                          styles.chipText,
                          active && styles.chipTextActive,
                        ]}
                      >
                        {CATEGORY_LABEL_FILTER[k]}
                      </Text>
                    </Pressable>
                  );
                })}
              </ScrollView>

              {/* Deposited toggle */}
              <Pressable
                accessibilityRole="switch"
                accessibilityState={{ checked: depositedOnly }}
                onPress={() => setDepositedOnly((v) => !v)}
                style={styles.depositToggleRow}
                testID={testID ? `${testID}-deposited-toggle` : undefined}
              >
                <Text style={styles.depositToggleLabel}>
                  Currently deposited only
                </Text>
                <View
                  style={[
                    styles.switchTrack,
                    depositedOnly && styles.switchTrackOn,
                  ]}
                >
                  <View
                    style={[
                      styles.switchThumb,
                      depositedOnly && styles.switchThumbOn,
                    ]}
                  />
                </View>
              </Pressable>

              {/* List */}
              <ScrollView
                style={styles.list}
                contentContainerStyle={styles.listInner}
                showsVerticalScrollIndicator={false}
              >
                {grouped.map((group) => (
                  <View key={group.category} style={styles.section}>
                    <Text style={styles.sectionHeader}>
                      {SECTION_HEADER[group.category]}
                    </Text>
                    {group.items.map((entry) => (
                      <ProtocolCard
                        key={entry.protocol_id}
                        entry={entry}
                        onPress={() => showDetail(entry.protocol_id)}
                        deposited={depositedProtocolIds.has(entry.protocol_id)}
                        testID={
                          testID
                            ? `${testID}-card-${entry.protocol_id}`
                            : undefined
                        }
                      />
                    ))}
                  </View>
                ))}

                {grouped.length === 0 && (
                  <Text style={styles.empty}>No protocols match.</Text>
                )}
              </ScrollView>
            </View>

            {/* ─── Pane 1: Pool detail ──────────────────────────── */}
            <View style={styles.pane}>
              {selectedEntry && (
                <PoolDetailPane
                  entry={selectedEntry}
                  onBack={goBackToList}
                  onPoolTap={(pool) => handlePoolTap(selectedEntry, pool)}
                  earnPositions={earnPositions}
                  positions={positions as Position[]}
                  onWithdrawPosition={onWithdrawPosition}
                  jlMarkets={jlMarkets}
                  testID={testID ? `${testID}-detail` : undefined}
                />
              )}
            </View>
          </Animated.View>
        </Animated.View>
      </GestureDetector>
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Your Positions helpers (Phase 8.2 → 8.2.1: drill-down 内表示に移動)
// ─────────────────────────────────────────────────────────────────────────────

/** Menu fixture の protocol_id → EarnPosition 配列を解決 */
function positionsForProtocol(
  protocolId: string,
  earnPositions: EarnPositionsResponse | undefined,
  positions: Position[]
): EarnPosition[] {
  switch (protocolId) {
    case "jupiter":
      return earnPositions?.jupiterLend ?? [];
    case "kamino":
      return earnPositions?.kaminoBestEffort ?? [];
    case "savefi":
      // Phase 8.15.x: BFF の enriched 配列を優先 (underlying/USD/earned 実値)。
      // undefined (旧 BFF / fixture) のみ client 側 mint 解決に fallback。
      return earnPositions?.save ?? heldSavePositions(positions, protocolId);
    case "exponent":
      // Phase 8.33: PT 保有 (read-only) — BFF (DAS + registry) の配列のみ。
      return earnPositions?.exponent ?? [];
    case "meteora":
      // Phase 8.17: DLMM position は account 型 — BFF (SDK read) の配列のみ。
      return earnPositions?.meteora ?? [];
    case "orca":
      // Phase 8.18: Whirlpool position は NFT — BFF (SDK read) の配列のみ。
      return earnPositions?.orca ?? [];
    default:
      // Phase 8.15/8.15.x: swap-earn protocol (jito/marinade/sanctum/perena)。
      // BFF enriched 配列 (protocol 混載) を protocol_id で絞る。
      return (
        earnPositions?.swapEarn?.filter((p) => p.protocol_id === protocolId) ??
        heldSwapEarnPositions(positions, protocolId)
      );
  }
}

function formatUnderlyingAmount(
  amount: string,
  decimals: number
): string {
  // smallest unit string → human-readable. 大雑把に integer/fraction で表示。
  // §4.5: parse はしない、文字列分割で humanize。
  if (decimals === 0) return amount;
  if (amount.length <= decimals) {
    const padded = amount.padStart(decimals + 1, "0");
    const head = padded.slice(0, -decimals) || "0";
    const tail = padded.slice(-decimals).replace(/0+$/, "");
    return tail ? `${head}.${tail.slice(0, 4)}` : head;
  }
  const head = amount.slice(0, amount.length - decimals);
  const tail = amount.slice(-decimals).replace(/0+$/, "");
  return tail ? `${head}.${tail.slice(0, 4)}` : head;
}

function formatApyBps(bps: number | null): string {
  if (bps === null) return "—";
  return `${(bps / 100).toFixed(2)}% APY`;
}

interface YourPositionRowProps {
  position: EarnPosition;
  onWithdraw?: (position: EarnPosition) => void;
  testID?: string;
}

function YourPositionRow({
  position,
  onWithdraw,
  testID,
}: YourPositionRowProps) {
  const amount = formatUnderlyingAmount(
    position.underlying_amount,
    position.underlying_decimals
  );
  // Phase 8.15: registry の share_mint に hit する position は withdraw 経路を持つ。
  //   swap-earn (Jupiter Lend / Jito / Marinade / Sanctum): share_mint = token mint
  //   Kamino (8.15b): share_mint = reserve address (obligation withdraw)
  //   Save (8.15c): share_mint = cToken mint (redeem)
  //   Kamino kVault (8.15d): share_mint = vault address (share 建て withdraw)
  // いずれにも hit しない (Kamino best-effort 等) は withdraw disable のまま。
  const canWithdraw =
    (findMarketByShareMint(position.share_mint) !== undefined ||
      findKaminoMarketByReserve(position.share_mint) !== undefined ||
      findSaveMarketByCToken(position.share_mint) !== undefined ||
      findKaminoVaultByAddress(position.share_mint) !== undefined ||
      // Exponent PT (8.34): 満期済のみ redeem 可 (満期前は server も 400 で拒否)
      (findExponentMarketByPtMint(position.share_mint) !== undefined &&
        position.maturity_at != null &&
        new Date(position.maturity_at).getTime() <= Date.now()) ||
      // Meteora (8.17) / Orca (8.18): share_mint = position 実 pubkey — protocol で判定
      position.protocol_id === "meteora" ||
      position.protocol_id === "orca") &&
    onWithdraw !== undefined;
  return (
    <Pressable
      accessibilityRole={canWithdraw ? "button" : "none"}
      onPress={canWithdraw ? () => onWithdraw!(position) : undefined}
      style={styles.earnRow}
      testID={testID}
    >
      <View style={styles.earnBadge}>
        <Text style={styles.earnBadgeText}>
          {position.protocol_id.charAt(0).toUpperCase()}
        </Text>
      </View>
      <View style={styles.earnBody}>
        <Text style={styles.earnLabel} numberOfLines={1}>
          {position.protocol_name} · {position.market_symbol}
        </Text>
        <Text style={styles.earnSubtitle} numberOfLines={1}>
          {amount} {position.asset_symbol}
          {canWithdraw ? " · Tap to withdraw" : ""}
        </Text>
        {/* Phase 8.15.x: 実 USD + 実 earned (unknown は "—"、フェイク値を出さない)。
            display 専用 Number 変換 (§4.5 適用外、Jupiter row と同 precedent)。 */}
        {(() => {
          const usdNum = Number(position.underlying_usd);
          const usdKnown = Number.isFinite(usdNum) && usdNum > 0;
          const earnedKnown = position.accrued_yield_sign !== "unknown";
          const earnedText = earnedKnown
            ? `${position.accrued_yield_sign === "loss" ? "−" : "+"}${formatHumanAmount(
                Number(position.accrued_yield_amount) /
                  Math.pow(10, position.underlying_decimals)
              )} ${position.asset_symbol}`
            : "—";
          if (!usdKnown && !earnedKnown) return null;
          return (
            <Text style={styles.earnSubtitle} numberOfLines={1}>
              {usdKnown ? `${formatUsdDisplay(usdNum)} · ` : ""}Earned {earnedText}
            </Text>
          );
        })()}
      </View>
      <Text style={styles.earnApy}>{formatApyBps(position.supply_rate_bps)}</Text>
    </Pressable>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ProtocolCard (collapsed only — drill-down trigger)
// ─────────────────────────────────────────────────────────────────────────────

interface ProtocolCardProps {
  entry: ProtocolMenuEntry;
  deposited: boolean;
  onPress: () => void;
  testID?: string;
}

function ProtocolCard({
  entry,
  deposited,
  onPress,
  testID,
}: ProtocolCardProps) {
  const iconSrc = ICON_BY_ID[entry.icon_id];

  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={styles.card}
      testID={testID}
    >
      <View style={styles.cardHeader}>
        {iconSrc ? (
          <View style={[styles.iconBox, { backgroundColor: entry.icon_bg }]}>
            <Image
              source={iconSrc}
              resizeMode="contain"
              style={[
                styles.iconImg,
                { transform: [{ scale: scaleOf(entry.icon_id) }] },
              ]}
            />
          </View>
        ) : (
          <View style={[styles.iconBox, { backgroundColor: entry.icon_bg }]}>
            <Text style={styles.iconLetter}>
              {entry.display_name.charAt(0).toUpperCase()}
            </Text>
          </View>
        )}

        <View style={styles.headerMain}>
          <View style={styles.nameRow}>
            <Text style={styles.name} numberOfLines={1}>
              {entry.display_name}
            </Text>
            {deposited && (
              <Text style={styles.depositedBadge}>· deposited</Text>
            )}
          </View>
          <Text style={styles.meta} numberOfLines={1}>
            <Text style={styles.metaCategory}>
              {CATEGORY_INLINE_LABEL[entry.primary_category]}
            </Text>
            {`  ·  ${entry.supported_assets.join(", ")}`}
          </Text>
        </View>

        {/* drill-down chevron (右向き) */}
        <Text style={styles.chevron}>›</Text>
      </View>
    </Pressable>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PoolDetailPane (右 pane: back row + protocol header + pool list)
// ─────────────────────────────────────────────────────────────────────────────

interface PoolDetailPaneProps {
  entry: ProtocolMenuEntry;
  onBack: () => void;
  onPoolTap: (pool: ProtocolPool) => void;
  /** Phase 8.2.1: drill-down 内に "Your Positions" subsection を出すための data */
  earnPositions?: EarnPositionsResponse;
  /** Phase 8.15: 保有 LST を protocol 別に解決するための raw positions */
  positions: Position[];
  /** Phase 8.9: Your Positions row tap で withdraw 起動 */
  onWithdrawPosition?: (position: EarnPosition) => void;
  /** Phase 8.11: Jupiter drill-down で vault rows を構築するための raw markets */
  jlMarkets?: JupiterLendMarketDTO[];
  testID?: string;
}

function PoolDetailPane(props: PoolDetailPaneProps) {
  // Phase 8.11: Jupiter は専用 pane (unified vault list)
  if (props.entry.protocol_id === "jupiter") {
    return <JupiterDetailPane {...props} />;
  }
  return <DefaultPoolDetailPane {...props} />;
}

function DefaultPoolDetailPane({
  entry,
  onBack,
  onPoolTap,
  earnPositions,
  positions,
  onWithdrawPosition,
  testID,
}: PoolDetailPaneProps) {
  const iconSrc = ICON_BY_ID[entry.icon_id];

  return (
    <View style={styles.detailPane}>
      {/* Back row (iOS-style "‹ Menu") */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Back to menu"
        onPress={onBack}
        style={styles.backRow}
        hitSlop={8}
        testID={testID ? `${testID}-back` : undefined}
      >
        <Text style={styles.backChevron}>‹</Text>
        <Text style={styles.backLabel}>Menu</Text>
      </Pressable>

      {/* Protocol header */}
      <View style={styles.detailHeader}>
        {iconSrc ? (
          <View style={[styles.iconBoxLg, { backgroundColor: entry.icon_bg }]}>
            <Image
              source={iconSrc}
              resizeMode="contain"
              style={[
                styles.iconImgLg,
                { transform: [{ scale: scaleOf(entry.icon_id) }] },
              ]}
            />
          </View>
        ) : (
          <View style={[styles.iconBoxLg, { backgroundColor: entry.icon_bg }]}>
            <Text style={styles.iconLetterLg}>
              {entry.display_name.charAt(0).toUpperCase()}
            </Text>
          </View>
        )}
        <View style={styles.detailHeaderMain}>
          <Text style={styles.detailName}>{entry.display_name}</Text>
          <Text style={styles.detailMeta}>
            <Text style={styles.metaCategory}>
              {CATEGORY_INLINE_LABEL[entry.primary_category]}
            </Text>
            {`  ·  ${entry.supported_assets.join(", ")}`}
          </Text>
        </View>
      </View>

      {/* Pool list */}
      <ScrollView
        style={styles.list}
        contentContainerStyle={styles.detailListInner}
        showsVerticalScrollIndicator={false}
      >
        {/* Phase 8.2.1: Your Positions subsection (該当 protocol の position があれば) */}
        {(() => {
          const myPositions = positionsForProtocol(
            entry.protocol_id,
            earnPositions,
            positions
          );
          if (myPositions.length === 0) return null;
          return (
            <View
              style={styles.detailEarnSection}
              testID={testID ? `${testID}-earn` : undefined}
            >
              <Text style={styles.detailEarnHeader}>Your Positions</Text>
              {myPositions.map((pos) => (
                <YourPositionRow
                  key={`${pos.protocol_id}-${pos.share_mint}`}
                  position={pos}
                  onWithdraw={onWithdrawPosition}
                  testID={
                    testID
                      ? `${testID}-earn-row-${pos.share_mint}`
                      : undefined
                  }
                />
              ))}
            </View>
          );
        })()}

        {entry.pools.map((pool, idx) => (
          <Pressable
            key={pool.pool_id}
            // Phase 8.33: read-only pool (Exponent PT 等) は tap 無効 (deposit 経路なし)
            accessibilityRole={pool.display_only ? "none" : "button"}
            disabled={pool.display_only === true}
            onPress={() => onPoolTap(pool)}
            style={[
              styles.detailPoolRow,
              idx > 0 && styles.detailPoolRowDivider,
            ]}
            testID={
              testID ? `${testID}-pool-${pool.pool_id}` : undefined
            }
          >
            <View style={styles.poolMain}>
              <View style={styles.poolNameRow}>
                <Text style={styles.detailPoolName} numberOfLines={2}>
                  {pool.name}
                </Text>
                <Text style={styles.poolAsset}>·  {pool.asset}</Text>
              </View>
              <View style={styles.poolMetricsRow}>
                <Text
                  style={[styles.detailPoolApy, { color: apyAccent(pool.apy) }]}
                >
                  APY {formatApy(pool.apy)}
                </Text>
                <Text style={styles.poolMeta}>
                  {`TVL ${formatTvlUsd(pool.tvl_usd)}`}
                </Text>
                {pool.borrowed_usd != null && (
                  <Text style={styles.poolMeta}>
                    {`borrowed ${formatBorrowedUsd(pool.borrowed_usd)}`}
                  </Text>
                )}
                {pool.utilization != null && (
                  <Text
                    style={[
                      styles.poolMeta,
                      { color: utilizationColor(pool.utilization) },
                    ]}
                    testID={`pool-util-${pool.pool_id}`}
                  >
                    {formatUtilization(pool.utilization)}
                  </Text>
                )}
                {/* Phase 8.33: read-only pool (deposit 経路なし) の明示 */}
                {pool.display_only === true && (
                  <Text
                    style={styles.poolMeta}
                    testID={`pool-viewonly-${pool.pool_id}`}
                  >
                    View only
                  </Text>
                )}
              </View>
              {/* 8.26: 満杯市場は withdraw が滞る可能性を明示 */}
              {pool.utilization != null && pool.utilization >= 0.95 && (
                <Text style={styles.poolUtilWarning}>
                  High utilization — withdrawals may be limited
                </Text>
              )}
            </View>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 8.11: JupiterDetailPane — unified vault list
// ─────────────────────────────────────────────────────────────────────────────

function JupiterDetailPane({
  entry,
  onBack,
  onPoolTap,
  earnPositions,
  onWithdrawPosition,
  jlMarkets,
  testID,
}: PoolDetailPaneProps) {
  const iconSrc = ICON_BY_ID[entry.icon_id];
  const [filter, setFilter] = useState<JupiterFilter>("all");
  const [othersExpanded, setOthersExpanded] = useState(false);

  const rows = useMemo(
    () => buildJupiterVaultRows(jlMarkets ?? [], earnPositions),
    [jlMarkets, earnPositions]
  );
  const summary = useMemo(() => computeJupiterSummary(rows), [rows]);
  const filteredRows = useMemo(
    () => applyJupiterFilter(rows, filter),
    [rows, filter]
  );

  // Phase 8.12: "All" filter 時のみ primary / others partition
  const { primaryRows, otherRows } = useMemo(() => {
    if (filter !== "all") {
      return { primaryRows: filteredRows, otherRows: [] as JupiterVaultRow[] };
    }
    const primary = sortByPrimaryOrder(
      filteredRows.filter((r) => isJupiterPrimaryAsset(r.assetSymbol))
    );
    const others = filteredRows.filter(
      (r) => !isJupiterPrimaryAsset(r.assetSymbol)
    );
    return { primaryRows: primary, otherRows: others };
  }, [filteredRows, filter]);
  const showOthersExpander = filter === "all" && otherRows.length > 0;

  const assetList = useMemo(() => {
    const assets = Array.from(new Set(rows.map((r) => r.assetSymbol)));
    return assets.length > 0 ? assets.join(", ") : "—";
  }, [rows]);

  const handleDeposit = useCallback(
    (row: JupiterVaultRow) => {
      const pool: ProtocolPool = {
        pool_id: `jl_${row.assetSymbol}`,
        name: `Jupiter Lend ${row.assetSymbol}`,
        category: PositionCategory.Stable,
        asset: row.assetSymbol,
        apy: row.apyBps / 10000,
        tvl_usd: row.tvlUsd,
      };
      onPoolTap(pool);
    },
    [onPoolTap]
  );

  const handleManage = useCallback(
    (row: JupiterVaultRow) => {
      if (row.earnPosition) {
        onWithdrawPosition?.(row.earnPosition);
      }
    },
    [onWithdrawPosition]
  );

  return (
    <View style={styles.detailPane}>
      {/* Back row */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Back to menu"
        onPress={onBack}
        style={styles.backRow}
        hitSlop={8}
        testID={testID ? `${testID}-back` : undefined}
      >
        <Text style={styles.backChevron}>‹</Text>
        <Text style={styles.backLabel}>Menu</Text>
      </Pressable>

      {/* Protocol header — "Jupiter / Lending · N vaults / assets" */}
      <View style={styles.detailHeader}>
        {iconSrc ? (
          <View style={[styles.iconBoxLg, { backgroundColor: entry.icon_bg }]}>
            <Image
              source={iconSrc}
              resizeMode="contain"
              style={[
                styles.iconImgLg,
                { transform: [{ scale: scaleOf(entry.icon_id) }] },
              ]}
            />
          </View>
        ) : (
          <View style={[styles.iconBoxLg, { backgroundColor: entry.icon_bg }]}>
            <Text style={styles.iconLetterLg}>
              {entry.display_name.charAt(0).toUpperCase()}
            </Text>
          </View>
        )}
        <View style={styles.detailHeaderMain}>
          <Text style={styles.detailName}>Jupiter</Text>
          <Text style={styles.detailMeta}>
            <Text style={styles.metaCategory}>Lending</Text>
            {`  ·  ${rows.length} vault${rows.length === 1 ? "" : "s"}`}
          </Text>
          <Text style={styles.jupAssetLine} numberOfLines={2}>
            {assetList}
          </Text>
        </View>
      </View>

      <ScrollView
        style={styles.list}
        contentContainerStyle={styles.detailListInner}
        showsVerticalScrollIndicator={false}
      >
        {/* Summary card — Your Jupiter Balance */}
        <View
          style={styles.jupSummaryCard}
          testID={testID ? `${testID}-summary` : undefined}
        >
          <Text style={styles.jupSummaryTitle}>Your Balance</Text>
          <View style={styles.jupSummaryMetricsRow}>
            <View style={styles.jupSummaryMetric}>
              <Text style={styles.jupSummaryMetricLabel}>Deposited</Text>
              <Text style={styles.jupSummaryMetricValue}>
                {summary.depositedUsd > 0
                  ? formatUsdDisplay(summary.depositedUsd)
                  : "—"}
              </Text>
            </View>
            <View style={styles.jupSummaryDivider} />
            <View style={styles.jupSummaryMetric}>
              <Text style={styles.jupSummaryMetricLabel}>Earnings</Text>
              <Text
                style={[
                  styles.jupSummaryMetricValue,
                  // Phase 8.13: 実 earned の符号で着色 (gain=melon / loss=cherry)
                  summary.hasKnownEarnings &&
                    summary.earningsUsd > 0 && { color: COLOR.melonText },
                  summary.hasKnownEarnings &&
                    summary.earningsUsd < 0 && { color: COLOR.cherryDark },
                ]}
              >
                {summary.hasKnownEarnings
                  ? `${summary.earningsUsd < 0 ? "−" : "+"}${formatUsdDisplay(
                      Math.abs(summary.earningsUsd),
                      4
                    )}`
                  : "—"}
              </Text>
            </View>
            <View style={styles.jupSummaryDivider} />
            <View style={styles.jupSummaryMetric}>
              <Text style={styles.jupSummaryMetricLabel}>Avg APY</Text>
              <Text style={styles.jupSummaryMetricValue}>
                {summary.avgApyBps !== null
                  ? `${(summary.avgApyBps / 100).toFixed(2)}%`
                  : "—"}
              </Text>
            </View>
          </View>
        </View>

        {/* Filter chips */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.jupFilterScroll}
          contentContainerStyle={styles.jupFilterRow}
        >
          {JUPITER_FILTER_ORDER.map((k) => {
            const active = filter === k;
            return (
              <Pressable
                key={k}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                onPress={() => setFilter(k)}
                style={[styles.chip, active && styles.chipActive]}
                testID={
                  testID ? `${testID}-filter-${k}` : undefined
                }
              >
                <Text
                  style={[
                    styles.chipText,
                    active && styles.chipTextActive,
                  ]}
                >
                  {JUPITER_FILTER_LABEL[k]}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>

        {/* All vaults section header */}
        <Text style={styles.jupSectionHeader}>ALL VAULTS</Text>

        {filteredRows.length === 0 && (
          <Text style={styles.empty}>No vaults match.</Text>
        )}

        {primaryRows.map((row) => (
          <JupiterVaultRowView
            key={row.jlMint}
            row={row}
            onDeposit={() => handleDeposit(row)}
            onManage={() => handleManage(row)}
            testID={
              testID ? `${testID}-vault-${row.assetSymbol}` : undefined
            }
          />
        ))}

        {showOthersExpander && (
          <OthersExpanderRow
            others={otherRows}
            expanded={othersExpanded}
            onToggle={() => setOthersExpanded((v) => !v)}
            testID={testID ? `${testID}-others-expander` : undefined}
          />
        )}

        {showOthersExpander &&
          othersExpanded &&
          otherRows.map((row) => (
            <JupiterVaultRowView
              key={row.jlMint}
              row={row}
              onDeposit={() => handleDeposit(row)}
              onManage={() => handleManage(row)}
              testID={
                testID ? `${testID}-vault-${row.assetSymbol}` : undefined
              }
            />
          ))}
      </ScrollView>
    </View>
  );
}

function OthersExpanderRow({
  others,
  expanded,
  onToggle,
  testID,
}: {
  others: JupiterVaultRow[];
  expanded: boolean;
  onToggle: () => void;
  testID?: string;
}) {
  const stackIcons = others.slice(0, 3);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ expanded }}
      onPress={onToggle}
      style={styles.jupOthersRow}
      testID={testID}
    >
      <View style={styles.jupOthersIconStack}>
        {stackIcons.map((r, idx) => (
          <View
            key={r.jlMint}
            style={[
              styles.jupOthersIconBubble,
              { left: idx * 16, zIndex: stackIcons.length - idx },
            ]}
          >
            <AssetBadge asset={r.assetSymbol} size={28} />
          </View>
        ))}
      </View>
      <View style={styles.jupOthersLabelBlock}>
        <Text style={styles.jupOthersLabel}>Others</Text>
        <Text style={styles.jupOthersCount}>
          {`${others.length} vault${others.length === 1 ? "" : "s"}`}
        </Text>
      </View>
      <Text style={styles.jupOthersChevron}>{expanded ? "⌄" : "›"}</Text>
    </Pressable>
  );
}

function JupiterVaultRowView({
  row,
  onDeposit,
  onManage,
  testID,
}: {
  row: JupiterVaultRow;
  onDeposit: () => void;
  onManage: () => void;
  testID?: string;
}) {
  const deposited = row.isDeposited;
  return (
    <View
      style={[
        styles.jupVaultRow,
        deposited ? styles.jupVaultRowDeposited : styles.jupVaultRowDefault,
      ]}
      testID={testID}
    >
      <View style={styles.jupVaultTopRow}>
        <AssetBadge asset={row.assetSymbol} />
        <View style={styles.jupVaultMain}>
          <View style={styles.jupVaultTitleRow}>
            <Text style={styles.jupVaultAsset}>{row.assetSymbol}</Text>
            {deposited && (
              <Text style={styles.jupDepositedBadge}>Deposited</Text>
            )}
          </View>
          <Text style={styles.jupVaultSubtitle}>
            {`Jupiter Lend  ·  TVL ${formatTvlUsd(row.tvlUsd)}`}
          </Text>
        </View>
        <View style={styles.jupVaultApyBlock}>
          <Text
            style={[styles.jupVaultApy, { color: apyAccent(row.apyBps / 10000) }]}
          >
            {`${(row.apyBps / 100).toFixed(2)}%`}
          </Text>
          <Text style={styles.jupVaultApyLabel}>APY</Text>
        </View>
      </View>

      <View style={styles.jupVaultBottomRow}>
        <Text style={styles.jupVaultDepositLine} numberOfLines={1}>
          {deposited
            ? `You: ${formatHumanAmount(row.userUnderlyingHuman)} ${row.assetSymbol} · Earned ${
                row.userEarnedKnown
                  ? `${row.userEarnedUsd < 0 ? "−" : "+"}${formatHumanAmount(
                      Math.abs(row.userEarnedUsd)
                    )} USD`
                  : "— USD"
              }`
            : "No deposit yet"}
        </Text>
        <Pressable
          accessibilityRole="button"
          onPress={deposited ? onManage : onDeposit}
          style={[
            styles.jupVaultCta,
            deposited ? styles.jupVaultCtaManage : styles.jupVaultCtaDeposit,
          ]}
          testID={
            testID
              ? `${testID}-cta-${deposited ? "manage" : "deposit"}`
              : undefined
          }
        >
          <Text
            style={[
              styles.jupVaultCtaText,
              deposited
                ? styles.jupVaultCtaTextManage
                : styles.jupVaultCtaTextDeposit,
            ]}
          >
            {deposited ? "Manage" : "Deposit"}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: COLOR.textPrimary,
  },
  drawer: {
    position: "absolute",
    right: 0,
    top: 0,
    bottom: 0,
    width: DRAWER_WIDTH,
    backgroundColor: COLOR.bgPrimary,
    paddingTop: SPACE.xl + SPACE.lg,
    borderLeftWidth: 1,
    borderLeftColor: COLOR.borderStrong,
    shadowColor: COLOR.shadowStrong,
    shadowOffset: { width: -4, height: 0 },
    shadowOpacity: 1,
    shadowRadius: 16,
    elevation: 12,
    overflow: "hidden",
  },
  // 2-pane horizontal strip
  pageStrip: {
    flex: 1,
    flexDirection: "row",
    width: DRAWER_WIDTH * 2,
  },
  pane: {
    width: DRAWER_WIDTH,
    flexShrink: 0,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: SPACE.md,
    paddingBottom: SPACE.sm,
  },
  title: {
    fontSize: FONT_SIZE.displayMD,
    fontFamily: FONT.script,
    color: COLOR.sodaText,
    lineHeight: 44,
    includeFontPadding: false,
  },
  closeBtn: {
    width: 32,
    height: 32,
    borderRadius: RADIUS.pill,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: withAlpha(COLOR.textMuted, 0.12),
  },
  closeIcon: {
    fontSize: 14,
    color: COLOR.textSubtitle,
    fontWeight: WEIGHT.bold,
  },
  // Search
  searchWrap: {
    marginHorizontal: SPACE.md,
    marginTop: SPACE.sm,
    flexDirection: "row",
    alignItems: "center",
    gap: SPACE.sm,
    paddingHorizontal: SPACE.md,
    paddingVertical: SPACE.sm,
    borderRadius: RADIUS.pill,
    backgroundColor: withAlpha(COLOR.textOnColor, 0.7),
    borderWidth: 1,
    borderColor: COLOR.border,
  },
  searchIcon: { fontSize: 14 },
  searchInput: {
    flex: 1,
    fontSize: FONT_SIZE.bodyMD,
    fontFamily: FONT.body,
    color: COLOR.textPrimary,
    padding: 0,
  },
  // Filter chips
  chipsScroll: {
    height: 44,
    flexGrow: 0,
    flexShrink: 0,
    marginVertical: SPACE.xs,
  },
  chipsRow: {
    flexDirection: "row",
    alignItems: "center",
    columnGap: 8,
    height: 44,
    paddingHorizontal: SPACE.md,
  },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    height: 36,
    borderRadius: 18,
    backgroundColor: withAlpha(COLOR.textOnColor, 0.7),
    borderWidth: 1,
    borderColor: COLOR.border,
  },
  chipActive: {
    backgroundColor: COLOR.sodaText,
    borderColor: COLOR.sodaText,
  },
  chipText: {
    fontSize: FONT_SIZE.bodyMD,
    fontFamily: FONT.heading,
    fontWeight: WEIGHT.semibold,
    color: COLOR.textSubtitle,
  },
  chipTextActive: { color: COLOR.textOnColor },
  // Deposited toggle
  depositToggleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: SPACE.md,
    paddingVertical: SPACE.xs,
  },
  depositToggleLabel: {
    fontSize: FONT_SIZE.bodyMD,
    fontFamily: FONT.heading,
    fontWeight: WEIGHT.semibold,
    color: COLOR.textPrimary,
  },
  switchTrack: {
    width: 44,
    height: 26,
    borderRadius: 13,
    padding: 3,
    backgroundColor: withAlpha(COLOR.textMuted, 0.25),
    justifyContent: "center",
  },
  switchTrackOn: { backgroundColor: COLOR.sodaText },
  switchThumb: {
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: COLOR.textOnColor,
    alignSelf: "flex-start",
  },
  switchThumbOn: { alignSelf: "flex-end" },
  // List
  list: { flex: 1 },
  listInner: {
    paddingHorizontal: SPACE.md,
    paddingTop: SPACE.sm,
    paddingBottom: SPACE.xl,
  },
  section: {
    marginTop: SPACE.md,
    gap: SPACE.sm,
  },
  sectionHeader: {
    fontSize: FONT_SIZE.overline,
    fontFamily: FONT.body,
    fontWeight: WEIGHT.bold,
    color: COLOR.textMuted,
    letterSpacing: 1.2,
    marginBottom: SPACE.xs,
  },
  // Phase 8.2 — Your Positions row (Jupiter Lend / Kamino best-effort)
  earnRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: SPACE.md,
    paddingVertical: SPACE.sm + 2,
    borderRadius: RADIUS.lg,
    backgroundColor: withAlpha(COLOR.sodaLight, 0.45),
    borderWidth: 1,
    borderColor: withAlpha(COLOR.sodaText, 0.25),
    gap: SPACE.sm,
  },
  earnBadge: {
    width: 32,
    height: 32,
    borderRadius: RADIUS.pill,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: COLOR.sodaText,
  },
  earnBadgeText: {
    fontSize: FONT_SIZE.bodyMD,
    fontFamily: FONT.heading,
    fontWeight: WEIGHT.bold,
    color: COLOR.textOnColor,
  },
  earnBody: {
    flex: 1,
    gap: 2,
  },
  earnLabel: {
    fontSize: FONT_SIZE.bodyMD,
    fontFamily: FONT.heading,
    fontWeight: WEIGHT.bold,
    color: COLOR.textPrimary,
  },
  earnSubtitle: {
    fontSize: FONT_SIZE.bodySM,
    fontFamily: FONT.body,
    color: COLOR.textSubtitle,
  },
  earnApy: {
    fontSize: FONT_SIZE.bodySM,
    fontFamily: FONT.heading,
    fontWeight: WEIGHT.semibold,
    color: COLOR.melonText,
  },
  // Phase 8.2.1: drill-down 内 Your Positions subsection
  detailEarnSection: {
    paddingBottom: SPACE.md,
    gap: SPACE.sm,
  },
  detailEarnHeader: {
    fontSize: FONT_SIZE.overline,
    fontFamily: FONT.body,
    fontWeight: WEIGHT.bold,
    color: COLOR.textMuted,
    letterSpacing: 1.2,
    marginBottom: SPACE.xs,
  },
  // Card (1 protocol、collapsed only)
  card: {
    borderRadius: RADIUS.lg,
    backgroundColor: withAlpha(COLOR.textOnColor, 0.7),
    borderWidth: 1,
    borderColor: COLOR.border,
    overflow: "hidden",
  },
  cardHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: SPACE.md,
    paddingHorizontal: SPACE.md,
    paddingVertical: SPACE.md - 2,
  },
  iconBox: {
    width: 40,
    height: 40,
    borderRadius: RADIUS.md,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  iconImg: {
    width: 40,
    height: 40,
  },
  iconLetter: {
    fontSize: FONT_SIZE.headingMD,
    fontFamily: FONT.heading,
    fontWeight: WEIGHT.bold,
    color: COLOR.textOnColor,
  },
  headerMain: {
    flex: 1,
    gap: 2,
  },
  nameRow: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: SPACE.xs,
  },
  name: {
    fontSize: FONT_SIZE.bodyLG,
    fontFamily: FONT.heading,
    fontWeight: WEIGHT.bold,
    color: COLOR.textPrimary,
    flexShrink: 1,
  },
  depositedBadge: {
    fontSize: FONT_SIZE.bodySM,
    fontFamily: FONT.heading,
    fontWeight: WEIGHT.semibold,
    color: COLOR.melonText,
  },
  meta: {
    fontSize: FONT_SIZE.bodySM,
    fontFamily: FONT.body,
    color: COLOR.textMuted,
  },
  metaCategory: {
    color: COLOR.melonText,
    fontWeight: WEIGHT.semibold,
  },
  chevron: {
    fontSize: 22,
    color: COLOR.textMuted,
    fontFamily: FONT.heading,
    fontWeight: WEIGHT.bold,
    width: 16,
    textAlign: "center",
    lineHeight: 22,
  },
  empty: {
    fontSize: FONT_SIZE.bodyMD,
    fontFamily: FONT.body,
    color: COLOR.textMuted,
    textAlign: "center",
    paddingVertical: SPACE.xl,
  },
  // ─── Detail pane (Phase 6.2) ─────────────────────────────────
  detailPane: {
    flex: 1,
  },
  backRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: SPACE.md,
    paddingVertical: SPACE.sm,
    height: 44,
    gap: 4,
  },
  backChevron: {
    fontSize: 28,
    fontFamily: FONT.heading,
    fontWeight: WEIGHT.bold,
    color: COLOR.sodaText,
    lineHeight: 28,
    includeFontPadding: false,
  },
  backLabel: {
    fontSize: FONT_SIZE.bodyLG,
    fontFamily: FONT.heading,
    fontWeight: WEIGHT.semibold,
    color: COLOR.sodaText,
  },
  detailHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: SPACE.md,
    paddingHorizontal: SPACE.md,
    paddingTop: SPACE.sm,
    paddingBottom: SPACE.md,
    borderBottomWidth: 1,
    borderBottomColor: COLOR.divider,
  },
  iconBoxLg: {
    width: 56,
    height: 56,
    borderRadius: RADIUS.md,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  iconImgLg: {
    width: 56,
    height: 56,
  },
  iconLetterLg: {
    fontSize: FONT_SIZE.displaySM,
    fontFamily: FONT.heading,
    fontWeight: WEIGHT.bold,
    color: COLOR.textOnColor,
  },
  detailHeaderMain: {
    flex: 1,
    gap: 4,
  },
  detailName: {
    fontSize: FONT_SIZE.headingLG,
    fontFamily: FONT.heading,
    fontWeight: WEIGHT.bold,
    color: COLOR.textPrimary,
  },
  detailMeta: {
    fontSize: FONT_SIZE.bodyMD,
    fontFamily: FONT.body,
    color: COLOR.textMuted,
  },
  detailListInner: {
    paddingHorizontal: SPACE.md,
    paddingTop: SPACE.sm,
    paddingBottom: SPACE.xl,
  },
  detailPoolRow: {
    paddingVertical: SPACE.md,
  },
  detailPoolRowDivider: {
    borderTopWidth: 1,
    borderTopColor: COLOR.divider,
  },
  detailPoolName: {
    fontSize: FONT_SIZE.bodyLG,
    fontFamily: FONT.heading,
    fontWeight: WEIGHT.bold,
    color: COLOR.textPrimary,
  },
  detailPoolApy: {
    fontSize: FONT_SIZE.bodyLG,
    fontFamily: FONT.heading,
    fontWeight: WEIGHT.bold,
  },
  // ─── Pool row shared ─────────────────────────────────────────
  poolMain: {
    gap: 4,
  },
  poolNameRow: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: SPACE.xs,
    flexWrap: "wrap",
  },
  poolAsset: {
    fontSize: FONT_SIZE.bodySM,
    fontFamily: FONT.heading,
    fontWeight: WEIGHT.regular,
    color: COLOR.textSubtitle,
  },
  poolMetricsRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: SPACE.md,
    flexWrap: "wrap",
    marginTop: 2,
  },
  poolMeta: {
    fontSize: FONT_SIZE.bodySM,
    fontFamily: FONT.body,
    color: COLOR.textMuted,
  },
  // 8.26: 稼働率 ≥95% の withdraw 流動性注意 (pool 行下の小テキスト)
  poolUtilWarning: {
    fontSize: FONT_SIZE.bodySM,
    fontFamily: FONT.body,
    color: COLOR.cherryDark,
    marginTop: 2,
  },
  // ─── Phase 8.11 — Jupiter drill-down (unified vault list) ──────────────
  jupAssetLine: {
    fontSize: FONT_SIZE.bodySM,
    fontFamily: FONT.body,
    color: COLOR.textSubtitle,
    marginTop: 2,
  },
  jupSummaryCard: {
    borderRadius: RADIUS.lg,
    backgroundColor: withAlpha(COLOR.sodaLight, 0.45),
    borderWidth: 1,
    borderColor: withAlpha(COLOR.sodaText, 0.25),
    paddingHorizontal: SPACE.md,
    paddingVertical: SPACE.md,
    marginBottom: SPACE.md,
  },
  jupSummaryTitle: {
    fontSize: FONT_SIZE.bodySM,
    fontFamily: FONT.heading,
    fontWeight: WEIGHT.bold,
    color: COLOR.textSubtitle,
    letterSpacing: 0.5,
    marginBottom: SPACE.sm,
  },
  jupSummaryMetricsRow: {
    flexDirection: "row",
    alignItems: "center",
  },
  jupSummaryMetric: {
    flex: 1,
    alignItems: "flex-start",
    gap: 2,
  },
  jupSummaryMetricLabel: {
    fontSize: FONT_SIZE.bodySM,
    fontFamily: FONT.body,
    color: COLOR.textMuted,
  },
  jupSummaryMetricValue: {
    fontSize: FONT_SIZE.bodyLG,
    fontFamily: FONT.heading,
    fontWeight: WEIGHT.bold,
    color: COLOR.textPrimary,
  },
  jupSummaryDivider: {
    width: 1,
    alignSelf: "stretch",
    backgroundColor: withAlpha(COLOR.sodaText, 0.2),
    marginHorizontal: SPACE.xs,
  },
  jupFilterScroll: {
    height: 44,
    flexGrow: 0,
    flexShrink: 0,
    marginHorizontal: -SPACE.md,
    marginBottom: SPACE.xs,
  },
  jupFilterRow: {
    flexDirection: "row",
    alignItems: "center",
    columnGap: 8,
    height: 44,
    paddingHorizontal: SPACE.md,
  },
  jupSectionHeader: {
    fontSize: FONT_SIZE.overline,
    fontFamily: FONT.body,
    fontWeight: WEIGHT.bold,
    color: COLOR.textMuted,
    letterSpacing: 1.2,
    marginTop: SPACE.sm,
    marginBottom: SPACE.sm,
  },
  jupVaultRow: {
    borderRadius: RADIUS.lg,
    borderWidth: 1,
    paddingHorizontal: SPACE.md,
    paddingVertical: SPACE.sm + 2,
    marginBottom: SPACE.sm,
    gap: SPACE.sm,
  },
  jupVaultRowDefault: {
    backgroundColor: withAlpha(COLOR.textOnColor, 0.6),
    borderColor: COLOR.border,
  },
  jupVaultRowDeposited: {
    backgroundColor: withAlpha(COLOR.melonLight, 0.55),
    borderColor: withAlpha(COLOR.melonText, 0.4),
  },
  jupVaultTopRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: SPACE.sm,
  },
  jupVaultMain: {
    flex: 1,
    gap: 2,
  },
  jupVaultTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: SPACE.xs,
  },
  jupVaultAsset: {
    fontSize: FONT_SIZE.bodyLG,
    fontFamily: FONT.heading,
    fontWeight: WEIGHT.bold,
    color: COLOR.textPrimary,
  },
  jupDepositedBadge: {
    fontSize: FONT_SIZE.bodySM,
    fontFamily: FONT.heading,
    fontWeight: WEIGHT.semibold,
    color: COLOR.melonText,
    backgroundColor: withAlpha(COLOR.melonText, 0.15),
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: RADIUS.pill,
    overflow: "hidden",
  },
  jupVaultSubtitle: {
    fontSize: FONT_SIZE.bodySM,
    fontFamily: FONT.body,
    color: COLOR.textSubtitle,
  },
  jupVaultApyBlock: {
    alignItems: "flex-end",
    gap: 2,
  },
  jupVaultApy: {
    fontSize: FONT_SIZE.bodyLG,
    fontFamily: FONT.heading,
    fontWeight: WEIGHT.bold,
  },
  jupVaultApyLabel: {
    fontSize: FONT_SIZE.bodySM,
    fontFamily: FONT.body,
    color: COLOR.textMuted,
  },
  jupVaultBottomRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: SPACE.sm,
  },
  jupVaultDepositLine: {
    flex: 1,
    fontSize: FONT_SIZE.bodySM,
    fontFamily: FONT.body,
    color: COLOR.textSubtitle,
  },
  jupVaultCta: {
    paddingHorizontal: SPACE.md,
    paddingVertical: SPACE.xs + 2,
    borderRadius: RADIUS.pill,
  },
  jupVaultCtaDeposit: {
    backgroundColor: COLOR.sodaText,
  },
  jupVaultCtaManage: {
    backgroundColor: COLOR.melonText,
  },
  jupVaultCtaText: {
    fontSize: FONT_SIZE.bodyMD,
    fontFamily: FONT.heading,
    fontWeight: WEIGHT.bold,
  },
  jupVaultCtaTextDeposit: {
    color: COLOR.textOnColor,
  },
  jupVaultCtaTextManage: {
    color: COLOR.textOnColor,
  },
  // Phase 8.12 — Others expander row
  jupOthersRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: SPACE.md,
    paddingVertical: SPACE.sm + 2,
    borderRadius: RADIUS.lg,
    backgroundColor: withAlpha(COLOR.textOnColor, 0.6),
    borderWidth: 1,
    borderColor: COLOR.border,
    marginBottom: SPACE.sm,
    gap: SPACE.md,
  },
  jupOthersIconStack: {
    width: 28 + 16 * 2,
    height: 28,
    position: "relative",
  },
  jupOthersIconBubble: {
    position: "absolute",
    top: 0,
    width: 28,
    height: 28,
    borderRadius: 14,
    borderWidth: 2,
    borderColor: COLOR.bgPrimary,
    overflow: "hidden",
  },
  jupOthersLabelBlock: {
    flex: 1,
    gap: 2,
  },
  jupOthersLabel: {
    fontSize: FONT_SIZE.bodyLG,
    fontFamily: FONT.heading,
    fontWeight: WEIGHT.bold,
    color: COLOR.textPrimary,
  },
  jupOthersCount: {
    fontSize: FONT_SIZE.bodySM,
    fontFamily: FONT.body,
    color: COLOR.textSubtitle,
  },
  jupOthersChevron: {
    fontSize: 24,
    fontFamily: FONT.heading,
    fontWeight: WEIGHT.bold,
    color: COLOR.textMuted,
    width: 24,
    textAlign: "center",
    lineHeight: 24,
    includeFontPadding: false,
  },
});
