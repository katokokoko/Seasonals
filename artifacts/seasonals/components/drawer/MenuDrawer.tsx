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

import { useMenuListings, usePositions } from "../../services/queries";

const SCREEN_WIDTH = Dimensions.get("window").width;
const DRAWER_WIDTH = Math.min(360, SCREEN_WIDTH * 0.86);
const ANIM_DURATION = 220;

const ICON_BY_ID: Record<string, ImageRequireSource> = {
  jupiter: require("../../assets/brands/jupiter.png"),
  kamino: require("../../assets/brands/kamino.png"),
  solstice: require("../../assets/brands/solstice.png"),
  sanctum: require("../../assets/brands/sanctum.png"),
  drift: require("../../assets/brands/drift.png"),
  perena: require("../../assets/brands/perena.png"),
  savefi: require("../../assets/brands/savefi.png"),
  marinade: require("../../assets/brands/marinade.png"),
  meteora: require("../../assets/brands/meteora.png"),
  jito: require("../../assets/brands/jito.png"),
  orca: require("../../assets/brands/orca.png"),
};

// Phase 6.3: per-protocol icon visual balance 微調整。
// 元 PNG の内側 padding / aspect 比のバラつきを吸収するため transform scale を適用。
// 他 protocol は default 1.0。
const ICON_SCALE_BY_ID: Record<string, number> = {
  jupiter: 1.5,
  drift: 0.9,
  sanctum: 1.2,
};

function scaleOf(id: string): number {
  return ICON_SCALE_BY_ID[id] ?? 1.0;
}

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

export interface MenuDrawerProps {
  visible: boolean;
  onClose: () => void;
  /** pool tap 時 (protocol_id / asset / "deposit") */
  onStartAction?: (
    protocol: string,
    asset: string,
    actionType: "deposit"
  ) => void;
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
  earnPositions,
  testID,
}: MenuDrawerProps) {
  const translateX = useSharedValue(DRAWER_WIDTH);
  const backdropOpacity = useSharedValue(0);

  const { data: listings = [] } = useMenuListings();
  const { data: positions = [] } = usePositions();

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
  const selectedEntry = useMemo(
    () => listings.find((l) => l.protocol_id === selectedProtocolId) ?? null,
    [listings, selectedProtocolId]
  );

  const handlePoolTap = useCallback(
    (entry: ProtocolMenuEntry, pool: ProtocolPool) => {
      onClose();
      const asset = pool.deposit_asset ?? pool.asset;
      onStartAction?.(entry.protocol_id, asset, "deposit");
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
  earnPositions: EarnPositionsResponse | undefined
): EarnPosition[] {
  if (!earnPositions) return [];
  switch (protocolId) {
    case "jupiter":
      return earnPositions.jupiterLend;
    case "kamino":
      return earnPositions.kaminoBestEffort;
    default:
      return [];
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
  testID?: string;
}

function YourPositionRow({ position, testID }: YourPositionRowProps) {
  const amount = formatUnderlyingAmount(
    position.underlying_amount,
    position.underlying_decimals
  );
  return (
    <View style={styles.earnRow} testID={testID}>
      <View style={styles.earnBadge}>
        <Text style={styles.earnBadgeText}>
          {position.protocol_id === "jupiter_lend" ? "J" : "K"}
        </Text>
      </View>
      <View style={styles.earnBody}>
        <Text style={styles.earnLabel} numberOfLines={1}>
          {position.protocol_name} · {position.market_symbol}
        </Text>
        <Text style={styles.earnSubtitle} numberOfLines={1}>
          {amount} {position.asset_symbol}
        </Text>
      </View>
      <Text style={styles.earnApy}>{formatApyBps(position.supply_rate_bps)}</Text>
    </View>
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
  testID?: string;
}

function PoolDetailPane({
  entry,
  onBack,
  onPoolTap,
  earnPositions,
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
            earnPositions
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
            accessibilityRole="button"
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
              </View>
            </View>
          </Pressable>
        ))}
      </ScrollView>
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
});
