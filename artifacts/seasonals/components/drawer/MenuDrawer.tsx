/**
 * MenuDrawer — 右 slide-in panel (prototype `menu.png` 準拠、ServicesDrawer の置換)
 *
 * 構成 (per-screen brand color = sodaText):
 *   Header: Pacifico "Menu" (sodaText) + close
 *   Search bar: "Search protocols..."
 *   Filter chips: All / Lending / Staking / Restaking / Vault / LP / PT-YT / Stable
 *   Toggle: "Currently deposited only" (off default)
 *   Flat list grouped by category (LENDING / STAKING / RESTAKING / VAULT / LP / PT-YT / STABLE)
 *   各カード: icon (40px square + first letter) / 名前 + deposited badge / Category · TVL · Asset / APY / status dot
 *
 * Kamino-as-section / LEND-BORROW-UTIL 三列メトリクスは prototype 不在のため除去 (§4.5 / 4.6)。
 *
 * @see CLAUDE.md §32.2 整合性チェック (8 categories of time とは別軸の PositionCategory)
 */

import React, { useEffect, useMemo, useState } from "react";
import {
  Dimensions,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
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
  type Position,
} from "@workspace/lib/types";
import type { MenuListing } from "@workspace/lib/__fixtures__";

import { useMenuListings, usePositions } from "../../services/queries";

const SCREEN_WIDTH = Dimensions.get("window").width;
const DRAWER_WIDTH = Math.min(360, SCREEN_WIDTH * 0.86);
const ANIM_DURATION = 220;

/** Filter chip の値: "all" + 7 categories */
type FilterKey = "all" | PositionCategory;

/** prototype の category → 表示ラベル */
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

/** カテゴリ section のヘッダ表記 (uppercase) */
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

/** カード row 内の小さな category 表示 (Pascal-ish) */
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

/** prototype の chip 順序 (PositionCategory enum 順序と一致させる、Vesting/Governance/Other は除外) */
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

/** APY > 9% を high yield として melonText で強調 */
function apyAccent(apy: number): string {
  return apy > 0.09 ? COLOR.melonText : COLOR.sodaText;
}

function formatApy(apy: number): string {
  return `${(apy * 100).toFixed(2)}%`;
}

function formatTvl(msol: number): string {
  return `TVL ${msol.toFixed(1)}M SOL`;
}

/** status dot: green = deposited, yellow = available, gray = inactive (本層は inactive を出さない) */
function statusDotColor(deposited: boolean): string {
  return deposited ? COLOR.melonText : COLOR.straw;
}

export interface MenuDrawerProps {
  visible: boolean;
  onClose: () => void;
  /**
   * Card tap 時の callback (任意)。protocol_id / asset / "deposit" を渡す。
   * 既存 home の handleStartActionFromServices 互換 signature を維持。
   */
  onStartAction?: (
    protocol: string,
    asset: string,
    actionType: "deposit"
  ) => void;
  testID?: string;
}

export function MenuDrawer({
  visible,
  onClose,
  onStartAction,
  testID,
}: MenuDrawerProps) {
  const translateX = useSharedValue(DRAWER_WIDTH);
  const backdropOpacity = useSharedValue(0);

  const { data: listings = [] } = useMenuListings();
  const { data: positions = [] } = usePositions();

  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<FilterKey>("all");
  const [depositedOnly, setDepositedOnly] = useState(false);

  // 現 wallet で持っている protocol_id を Set にしておき、deposited 判定を O(1) に
  const depositedProtocolIds = useMemo(() => {
    const set = new Set<string>();
    for (const p of positions as Position[]) {
      set.add(p.protocol_id);
    }
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

  // 右 swipe で close する gesture
  const swipeGesture = Gesture.Pan()
    .activeOffsetX([-10, 10])
    .onEnd((e) => {
      if (e.translationX > 50) runOnJS(onClose)();
    });

  const drawerStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }],
  }));
  const backdropStyle = useAnimatedStyle(() => ({
    opacity: backdropOpacity.value,
  }));

  // search / filter / depositedOnly を組み合わせて絞り込み
  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return listings.filter((l) => {
      if (filter !== "all" && l.category !== filter) return false;
      if (depositedOnly && !depositedProtocolIds.has(l.protocol_id)) return false;
      if (term && !l.display_name.toLowerCase().includes(term)) return false;
      return true;
    });
  }, [listings, search, filter, depositedOnly, depositedProtocolIds]);

  // category 単位に group 化
  const grouped = useMemo(() => {
    const map = new Map<PositionCategory, MenuListing[]>();
    for (const l of filtered) {
      if (!map.has(l.category)) map.set(l.category, []);
      map.get(l.category)!.push(l);
    }
    return SECTION_ORDER.map((cat) => ({
      category: cat,
      items: map.get(cat) ?? [],
    })).filter((g) => g.items.length > 0);
  }, [filtered]);

  if (!visible && translateX.value >= DRAWER_WIDTH - 1) {
    return null;
  }

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
          {/* Header — Pacifico sodaText */}
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

          {/* Filter chips — Phase 5B.2: 行高さを 44px に固定し chip の vertical 伸縮を抑制 */}
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

          {/* Deposited-only toggle */}
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

          {/* Grouped list */}
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
                {group.items.map((item) => {
                  const deposited = depositedProtocolIds.has(item.protocol_id);
                  return (
                    <Pressable
                      key={item.protocol_id}
                      accessibilityRole="button"
                      onPress={() => {
                        onClose();
                        onStartAction?.(item.protocol_id, item.asset, "deposit");
                      }}
                      style={styles.card}
                      testID={
                        testID
                          ? `${testID}-card-${item.protocol_id}`
                          : undefined
                      }
                    >
                      {/* Icon */}
                      <View
                        style={[
                          styles.iconBox,
                          { backgroundColor: item.icon_color },
                        ]}
                      >
                        <Text style={styles.iconLetter}>
                          {item.display_name.charAt(0).toUpperCase()}
                        </Text>
                      </View>

                      {/* Center: name + meta */}
                      <View style={styles.center}>
                        <View style={styles.nameRow}>
                          <Text style={styles.name} numberOfLines={1}>
                            {item.display_name}
                          </Text>
                          {deposited && (
                            <Text style={styles.depositedBadge}>
                              · deposited
                            </Text>
                          )}
                        </View>
                        <Text style={styles.meta} numberOfLines={1}>
                          <Text style={styles.metaCategory}>
                            {CATEGORY_INLINE_LABEL[item.category]}
                          </Text>
                          {`  ·  ${formatTvl(item.tvl_msol)}  ·  ${item.asset}`}
                        </Text>
                      </View>

                      {/* Right: APY + status dot */}
                      <View style={styles.right}>
                        <Text
                          style={[
                            styles.apy,
                            { color: apyAccent(item.apy) },
                          ]}
                        >
                          {formatApy(item.apy)}
                        </Text>
                        <View
                          style={[
                            styles.statusDot,
                            { backgroundColor: statusDotColor(deposited) },
                          ]}
                        />
                      </View>
                    </Pressable>
                  );
                })}
              </View>
            ))}

            {grouped.length === 0 && (
              <Text style={styles.empty}>No protocols match.</Text>
            )}
          </ScrollView>
        </Animated.View>
      </GestureDetector>
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
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: SPACE.md,
    paddingBottom: SPACE.sm,
  },
  // Pacifico sodaText (per-screen brand color)
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
  // Search bar
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
  searchIcon: {
    fontSize: 14,
  },
  searchInput: {
    flex: 1,
    fontSize: FONT_SIZE.bodyMD,
    fontFamily: FONT.body,
    color: COLOR.textPrimary,
    padding: 0,
  },
  // Filter chips (Phase 5B.2 spec: 行 44 / chip 36)
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
  chipTextActive: {
    color: COLOR.textOnColor,
  },
  // Deposited toggle row
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
  switchTrackOn: {
    backgroundColor: COLOR.sodaText,
  },
  switchThumb: {
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: COLOR.textOnColor,
    alignSelf: "flex-start",
  },
  switchThumbOn: {
    alignSelf: "flex-end",
  },
  // List
  list: {
    flex: 1,
  },
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
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: SPACE.md,
    paddingHorizontal: SPACE.md,
    paddingVertical: SPACE.md - 2,
    borderRadius: RADIUS.lg,
    backgroundColor: withAlpha(COLOR.textOnColor, 0.7),
    borderWidth: 1,
    borderColor: COLOR.border,
  },
  iconBox: {
    width: 40,
    height: 40,
    borderRadius: RADIUS.md,
    alignItems: "center",
    justifyContent: "center",
  },
  iconLetter: {
    fontSize: FONT_SIZE.headingMD,
    fontFamily: FONT.heading,
    fontWeight: WEIGHT.bold,
    color: COLOR.textOnColor,
  },
  center: {
    flex: 1,
    gap: 2,
  },
  nameRow: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: SPACE.xs,
  },
  name: {
    fontSize: FONT_SIZE.bodyMD,
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
  right: {
    alignItems: "flex-end",
    gap: 6,
  },
  apy: {
    fontSize: FONT_SIZE.bodyLG,
    fontFamily: FONT.heading,
    fontWeight: WEIGHT.bold,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  empty: {
    fontSize: FONT_SIZE.bodyMD,
    fontFamily: FONT.body,
    color: COLOR.textMuted,
    textAlign: "center",
    paddingVertical: SPACE.xl,
  },
});
