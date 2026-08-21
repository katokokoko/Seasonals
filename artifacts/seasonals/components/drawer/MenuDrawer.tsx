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
import { TOKEN_DECIMALS, formatUsd } from "@workspace/lib/utils/numeric";
import {
  findMarketByShareMint,
  heldSwapEarnPositions,
} from "@workspace/lib/config/swap-earn-markets";
import {
  KAMINO_MARKETS,
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
import { AssetBadge } from "../icons/AssetBadge";
import { useSafeAreaInsets } from "react-native-safe-area-context";
// 8.51 の預入枠表示 (deposit-cap.ts) は 8.54 で vault-rows 経由に集約
// 8.54: カード行のモデルと出し分け判断 (純関数、単体テスト済)
import {
  applyVaultFilter,
  buildPoolVaultRows,
  computeVaultSummary,
  visibleFilters,
  VISIBLE_ROW_LIMIT,
  type VaultFilter,
  type VaultRow,
  type VaultSummary,
} from "./vault-rows";

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
 * (8.54: カード行ではメタ行全体の色でこのシグナルを出す)
 */
const UTILIZATION_WARN_THRESHOLD = 0.9;
function formatUtilization(utilization: number): string {
  return `Util ${(utilization * 100).toFixed(0)}%`;
}
/**
 * 8.51: 預入枠を human 表示するための decimals。Kamino registry を正とし、
 * 無ければ asset の既定 decimals へ fallback する (枠は現状 Kamino のみ)。
 */
function poolDecimals(pool: ProtocolPool): number {
  const kamino = KAMINO_MARKETS.find((m) => m.pool_id === pool.pool_id);
  if (kamino) return kamino.underlying_decimals;
  const asset = pool.deposit_asset ?? pool.asset;
  return asset in TOKEN_DECIMALS
    ? (TOKEN_DECIMALS as Record<string, number>)[asset]!
    : 6;
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 8.11: Jupiter drill-down redesign — unified vault list helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Phase 8.12: 大 list で直接見せる primary vaults。それ以外は Others に折りたたむ。 */
const JUPITER_PRIMARY_ASSETS: readonly string[] = [
  "JupUSD",
  "USDC",
  "SOL",
] as const;

function isJupiterPrimaryAsset(asset: string): boolean {
  return JUPITER_PRIMARY_ASSETS.includes(asset);
}

function sortByPrimaryOrder(rows: VaultRow[]): VaultRow[] {
  const indexOf = (s: string) => JUPITER_PRIMARY_ASSETS.indexOf(s);
  return [...rows].sort((a, b) => indexOf(a.assetSymbol) - indexOf(b.assetSymbol));
}

function displayJupiterAsset(symbol: string): string {
  if (symbol === "WSOL") return "SOL";
  if (symbol === "jupUSD") return "JupUSD";
  return symbol;
}

/**
 * Jupiter の行は fixture pool ではなく **live markets** から組む (8.6)。
 * 8.54: 出力は共有の `VaultRow` — 描画・集計・絞り込みを他 protocol と同じ経路に流す。
 */
function buildJupiterVaultRows(
  markets: JupiterLendMarketDTO[],
  earnPositions?: EarnPositionsResponse
): VaultRow[] {
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
    const apyBps = m.supplyRateBps;
    // deposit dispatch 用の pool (Jupiter の menu fixture は live 値で置換される)
    const pool: ProtocolPool = {
      pool_id: `jl_${assetSymbol}`,
      name: `Jupiter Lend ${assetSymbol}`,
      category: PositionCategory.Stable,
      asset: assetSymbol,
      apy: apyBps / 10000,
      tvl_usd: tvlUsd,
    };
    const base = {
      key: m.jlMint,
      assetSymbol,
      subtitle: "Jupiter Lend",
      apyBps,
      tvlUsd,
      pool,
      displayOnly: false,
      capView: null,
    };
    if (!pos) {
      return {
        ...base,
        isDeposited: false,
        userUnderlyingHuman: 0,
        userUnderlyingUsd: 0,
        userEarnedUsd: 0,
        userEarnedKnown: false,
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
      ...base,
      isDeposited: true,
      userUnderlyingHuman: human,
      userUnderlyingUsd: usdSafe,
      userEarnedUsd: earnedUsd,
      userEarnedKnown: earnedKnown,
      earnPosition: pos,
    };
  });
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

/**
 * Jupiter のチップは **常に 4 つ固定** (8.11 の設計、vault 数が多く常に選ぶ意味がある)。
 * 他 protocol は `visibleFilters()` で内容に応じて出し分ける (8.54)。
 */
const JUPITER_FILTER_ORDER: readonly VaultFilter[] = [
  "all",
  "stable",
  "sol",
  "deposited",
] as const;

const VAULT_FILTER_LABEL: Record<VaultFilter, string> = {
  all: "All",
  stable: "Stable",
  sol: "SOL",
  deposited: "Deposited",
};

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
  // 8.45: edge-to-edge の inset (drawer は絶対配置で SafeAreaView の padding が効かない)
  const insets = useSafeAreaInsets();
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
      // 8.51: 満杯 / 預入停止中も同様に落とす。BFF も 409 で弾くが、必ず失敗する
      // 導線をそもそも押させない (fail-closed、§32.2)
      if (pool.deposit_open === false) return;
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
        {/* 8.45: drawer は top:0 の絶対配置。edge-to-edge でステータスバーの裏まで
            伸びるので、固定 56 ではなく inset を基準にタイトルを逃がす */}
        <Animated.View
          style={[
            styles.drawer,
            { paddingTop: insets.top + SPACE.md, paddingBottom: insets.bottom },
            drawerStyle,
          ]}
        >
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

/**
 * Phase 8.15: registry の share_mint に hit する position は withdraw 経路を持つ。
 *   swap-earn (Jupiter Lend / Jito / Marinade / Sanctum): share_mint = token mint
 *   Kamino (8.15b): share_mint = reserve address (obligation withdraw)
 *   Save (8.15c): share_mint = cToken mint (redeem)
 *   Kamino kVault (8.15d): share_mint = vault address (share 建て withdraw)
 * いずれにも hit しない (Kamino best-effort 等) は withdraw disable のまま。
 *
 * 8.54: カード行の CTA (Manage / Redeem) と "Your Positions" 行で共用する。
 */
function canWithdrawPosition(position: EarnPosition): boolean {
  return (
    findMarketByShareMint(position.share_mint) !== undefined ||
    findKaminoMarketByReserve(position.share_mint) !== undefined ||
    findSaveMarketByCToken(position.share_mint) !== undefined ||
    findKaminoVaultByAddress(position.share_mint) !== undefined ||
    // Exponent PT (8.34): 満期済のみ redeem 可 (満期前は server も 400 で拒否)
    (findExponentMarketByPtMint(position.share_mint) !== undefined &&
      position.maturity_at != null &&
      new Date(position.maturity_at).getTime() <= Date.now()) ||
    // Meteora (8.17) / Orca (8.18): share_mint = position 実 pubkey — protocol で判定
    position.protocol_id === "meteora" ||
    position.protocol_id === "orca"
  );
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
  const canWithdraw = canWithdrawPosition(position) && onWithdraw !== undefined;
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
  const [filter, setFilter] = useState<VaultFilter>("all");
  const [othersExpanded, setOthersExpanded] = useState(false);

  // 8.54: pool → カード行。保有は行に統合し、紐付かない position だけ
  // "Your Positions" に残す (Meteora / Orca の LP 等)
  const { rows, unlinked } = useMemo(() => {
    const myPositions = positionsForProtocol(
      entry.protocol_id,
      earnPositions,
      positions
    );
    return buildPoolVaultRows(entry, myPositions, poolDecimals);
  }, [entry, earnPositions, positions]);

  const summary = useMemo(() => computeVaultSummary(rows), [rows]);
  const chips = useMemo(() => visibleFilters(rows), [rows]);
  // 選択中の filter が候補から消えた場合 (保有が無くなった等) は all に戻す
  const activeFilter = chips.includes(filter) ? filter : "all";
  const visibleRows = useMemo(
    () => applyVaultFilter(rows, activeFilter),
    [rows, activeFilter]
  );

  const shownRows = visibleRows.slice(0, VISIBLE_ROW_LIMIT);
  const otherRows = visibleRows.slice(VISIBLE_ROW_LIMIT);

  const handleDeposit = useCallback(
    (row: VaultRow) => {
      if (row.pool) onPoolTap(row.pool);
    },
    [onPoolTap]
  );
  const handleManage = useCallback(
    (row: VaultRow) => {
      if (row.earnPosition) onWithdrawPosition?.(row.earnPosition);
    },
    [onWithdrawPosition]
  );

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
        {/* 8.54: 保有があれば Your Balance サマリー (無い protocol では出さない) */}
        {summary.depositedUsd > 0 && (
          <BalanceSummaryCard
            summary={summary}
            testID={testID ? `${testID}-summary` : undefined}
          />
        )}

        {/* 8.54: 選ぶ意味がある時だけチップを出す (単一 asset の protocol では非表示) */}
        {chips.length > 1 && (
          <FilterChips
            filters={chips}
            active={activeFilter}
            onSelect={setFilter}
            testID={testID}
          />
        )}

        {/* Phase 8.2.1 → 8.54: 行に統合できなかった position だけ別枠に残す
            (Meteora / Orca の LP position、Kamino best-effort 等) */}
        {unlinked.length > 0 && (
          <View
            style={styles.detailEarnSection}
            testID={testID ? `${testID}-earn` : undefined}
          >
            <Text style={styles.detailEarnHeader}>Your Positions</Text>
            {unlinked.map((pos) => (
              <YourPositionRow
                key={`${pos.protocol_id}-${pos.share_mint}`}
                position={pos}
                onWithdraw={onWithdrawPosition}
                testID={
                  testID ? `${testID}-earn-row-${pos.share_mint}` : undefined
                }
              />
            ))}
          </View>
        )}

        {visibleRows.length === 0 && (
          <Text style={styles.empty}>No pools match.</Text>
        )}

        {shownRows.map((row) => (
          <VaultRowView
            key={row.key}
            row={row}
            onDeposit={() => handleDeposit(row)}
            onManage={() => handleManage(row)}
            testID={testID ? `${testID}-pool-${row.key}` : undefined}
          />
        ))}

        {otherRows.length > 0 && (
          <OthersExpanderRow
            others={otherRows}
            expanded={othersExpanded}
            onToggle={() => setOthersExpanded((v) => !v)}
            testID={testID ? `${testID}-others-expander` : undefined}
          />
        )}

        {othersExpanded &&
          otherRows.map((row) => (
            <VaultRowView
              key={row.key}
              row={row}
              onDeposit={() => handleDeposit(row)}
              onManage={() => handleManage(row)}
              testID={testID ? `${testID}-pool-${row.key}` : undefined}
            />
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
  const [filter, setFilter] = useState<VaultFilter>("all");
  const [othersExpanded, setOthersExpanded] = useState(false);

  const rows = useMemo(
    () => buildJupiterVaultRows(jlMarkets ?? [], earnPositions),
    [jlMarkets, earnPositions]
  );
  const summary = useMemo(() => computeVaultSummary(rows), [rows]);
  const filteredRows = useMemo(
    () => applyVaultFilter(rows, filter),
    [rows, filter]
  );

  // Phase 8.12: "All" filter 時のみ primary / others partition
  const { primaryRows, otherRows } = useMemo(() => {
    if (filter !== "all") {
      return { primaryRows: filteredRows, otherRows: [] as VaultRow[] };
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
    (row: VaultRow) => {
      // 8.54: pool は row 構築時に組んである (jl_<asset>)
      if (row.pool) onPoolTap(row.pool);
    },
    [onPoolTap]
  );

  const handleManage = useCallback(
    (row: VaultRow) => {
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
        {/* Summary card — Your Jupiter Balance (8.54: 共有 component) */}
        <BalanceSummaryCard
          summary={summary}
          testID={testID ? `${testID}-summary` : undefined}
        />

        {/* Filter chips — Jupiter は 4 つ固定 (vault 数が多く常に選ぶ意味がある) */}
        <FilterChips
          filters={JUPITER_FILTER_ORDER}
          active={filter}
          onSelect={setFilter}
          testID={testID}
        />

        {/* All vaults section header */}
        <Text style={styles.jupSectionHeader}>ALL VAULTS</Text>

        {filteredRows.length === 0 && (
          <Text style={styles.empty}>No vaults match.</Text>
        )}

        {primaryRows.map((row) => (
          <VaultRowView
            key={row.key}
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
            <VaultRowView
              key={row.key}
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
  others: VaultRow[];
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
            key={r.key}
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

// ─────────────────────────────────────────────────────────────────────────────
// Phase 8.54: 共有カード行 — Jupiter / 他 protocol で **1 つの視覚定義**を使う
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 行下段の CTA を決める。優先順位:
 *   1. 保有あり かつ withdraw 経路あり → Manage (Exponent の満期済 PT は Redeem)
 *   2. read-only listing (8.33) → CTA なし (タイトルに "View only" バッジ)
 *   3. 預入不可 (8.51/8.52 満杯・停止中・上流都合) → 無効 CTA + 理由
 *   4. それ以外 → Deposit
 */
function ctaForRow(row: VaultRow): {
  label: string;
  kind: "manage" | "deposit";
  disabled: boolean;
} | null {
  if (row.isDeposited && row.earnPosition) {
    if (!canWithdrawPosition(row.earnPosition)) return null;
    const redeem = row.displayOnly; // Exponent PT: 満期済のみここに来る
    return { label: redeem ? "Redeem" : "Manage", kind: "manage", disabled: false };
  }
  if (row.displayOnly) return null;
  if (row.capView?.closed) {
    const label =
      row.capView.reason === "paused"
        ? "Paused"
        : row.capView.reason === "full"
          ? "Full"
          : "Unavailable";
    return { label, kind: "deposit", disabled: true };
  }
  return { label: "Deposit", kind: "deposit", disabled: false };
}

/**
 * 保有が無い行の下段に出すメタ (稼働率 / 借入)。無ければ既定文言。
 * **預入枠はここに混ぜない** — CTA と同じ行で幅を取り合って省略される。
 * 枠は行を分けて出す (8.51/8.52 の情報を切らせないため)。
 */
function metaLineForRow(row: VaultRow): string {
  const parts: string[] = [];
  if (row.utilization != null) parts.push(formatUtilization(row.utilization));
  if (row.borrowedUsd != null) {
    parts.push(`borrowed ${formatBorrowedUsd(row.borrowedUsd)}`);
  }
  return parts.length > 0 ? parts.join("  ·  ") : "No deposit yet";
}

function VaultRowView({
  row,
  onDeposit,
  onManage,
  testID,
}: {
  row: VaultRow;
  onDeposit: () => void;
  onManage: () => void;
  testID?: string;
}) {
  const deposited = row.isDeposited;
  const cta = ctaForRow(row);
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
            {/* Phase 8.33: read-only listing (deposit 経路なし) の明示 */}
            {!deposited && row.displayOnly && (
              <Text
                style={styles.jupViewOnlyBadge}
                testID={`pool-viewonly-${row.key}`}
              >
                View only
              </Text>
            )}
          </View>
          {/* 8.54: pool 名は行の識別子 (Kamino は同一 asset に複数 pool) なので
              APY ブロックに押されても切らずに 2 行まで折り返す */}
          <Text style={styles.jupVaultSubtitle} numberOfLines={2}>
            {`${row.subtitle}  ·  TVL ${formatTvlUsd(row.tvlUsd)}`}
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

      {/* 8.51/8.52: 預入枠は CTA と幅を取り合わせず独立行で出す (省略させない) */}
      {!deposited && row.capView && (
        <Text
          style={[
            styles.jupVaultCapLine,
            row.capView.closed ? { color: COLOR.cherryDark } : null,
          ]}
          numberOfLines={1}
          testID={`pool-cap-${row.key}`}
        >
          {row.capView.label}
        </Text>
      )}

      <View style={styles.jupVaultBottomRow}>
        <Text
          style={[
            styles.jupVaultDepositLine,
            // 8.26: 高稼働率は警告色 (withdraw が流動性不足で滞り得る)
            !deposited &&
            row.utilization != null &&
            row.utilization >= UTILIZATION_WARN_THRESHOLD
              ? { color: COLOR.cherryDark }
              : null,
          ]}
          numberOfLines={1}
        >
          {deposited
            ? `You: ${formatHumanAmount(row.userUnderlyingHuman)} ${row.assetSymbol} · Earned ${
                row.userEarnedKnown
                  ? `${row.userEarnedUsd < 0 ? "−" : "+"}${formatHumanAmount(
                      Math.abs(row.userEarnedUsd)
                    )} USD`
                  : "— USD"
              }`
            : metaLineForRow(row)}
        </Text>
        {cta && (
          <Pressable
            accessibilityRole={cta.disabled ? "none" : "button"}
            disabled={cta.disabled}
            onPress={cta.kind === "manage" ? onManage : onDeposit}
            style={[
              styles.jupVaultCta,
              cta.kind === "manage"
                ? styles.jupVaultCtaManage
                : styles.jupVaultCtaDeposit,
              cta.disabled && styles.jupVaultCtaDisabled,
            ]}
            testID={testID ? `${testID}-cta-${cta.kind}` : undefined}
          >
            <Text
              style={[
                styles.jupVaultCtaText,
                cta.kind === "manage"
                  ? styles.jupVaultCtaTextManage
                  : styles.jupVaultCtaTextDeposit,
                cta.disabled && styles.jupVaultCtaTextDisabled,
              ]}
            >
              {cta.label}
            </Text>
          </Pressable>
        )}
      </View>

      {/* 8.26: 満杯市場は withdraw が滞る可能性を明示 */}
      {row.utilization != null && row.utilization >= 0.95 && (
        <Text style={styles.poolUtilWarning}>
          High utilization — withdrawals may be limited
        </Text>
      )}
    </View>
  );
}

/** "Your Balance" サマリー (Deposited / Earnings / Avg APY) */
function BalanceSummaryCard({
  summary,
  testID,
}: {
  summary: VaultSummary;
  testID?: string;
}) {
  return (
    <View style={styles.jupSummaryCard} testID={testID}>
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
  );
}

/** 絞り込みチップ行 (どのチップを出すかは呼び手が決める) */
function FilterChips({
  filters,
  active,
  onSelect,
  testID,
}: {
  filters: readonly VaultFilter[];
  active: VaultFilter;
  onSelect: (f: VaultFilter) => void;
  testID?: string;
}) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={styles.jupFilterScroll}
      contentContainerStyle={styles.jupFilterRow}
    >
      {filters.map((k) => {
        const selected = active === k;
        return (
          <Pressable
            key={k}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            onPress={() => onSelect(k)}
            style={[styles.chip, selected && styles.chipActive]}
            testID={testID ? `${testID}-filter-${k}` : undefined}
          >
            <Text style={[styles.chipText, selected && styles.chipTextActive]}>
              {VAULT_FILTER_LABEL[k]}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
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
  // 8.54: 旧 pool 行 (テキスト羅列) の style は Jupiter 版カード行に統合され消滅
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
  // 8.54: 預入枠 (8.51/8.52) の独立行 — CTA と幅を取り合わないので省略されない
  jupVaultCapLine: {
    marginTop: SPACE.xs,
    fontSize: FONT_SIZE.bodySM,
    fontFamily: FONT.body,
    color: COLOR.textMuted,
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
  // 8.54: 預入不可 (満杯 / 停止中 / 上流都合) の CTA — 押せないことを見た目で示す
  jupVaultCtaDisabled: {
    backgroundColor: withAlpha(COLOR.textMuted, 0.15),
  },
  jupVaultCtaTextDisabled: {
    color: COLOR.textMuted,
  },
  // 8.54: read-only listing (Exponent PT 等) のバッジ。Deposited と同じ形で色だけ中立
  jupViewOnlyBadge: {
    fontSize: FONT_SIZE.bodySM,
    fontFamily: FONT.heading,
    fontWeight: WEIGHT.semibold,
    color: COLOR.textMuted,
    backgroundColor: withAlpha(COLOR.textMuted, 0.12),
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: RADIUS.pill,
    overflow: "hidden",
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
