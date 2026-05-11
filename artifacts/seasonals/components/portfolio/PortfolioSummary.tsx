/**
 * PortfolioSummary — home screen 下部の glassmorphism bottom sheet
 *
 * 構造:
 *   Handle (grabber + PORTFOLIO label + USDC↔SOL toggle 同行)
 *   Total (大文字値 + 通貨)
 *   Yield row (+15.49 SOL (5.70%) + AVG YIELD pill)
 *   Range selector (1W / 1M / 3M / 1Y / ALL)
 *   Chart (Charts.tsx native / Charts.web.tsx web)
 *
 * 背景: GLASS_RN tokens + expo-blur BlurView (intensity 50, tint "light")。
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Dimensions,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import BottomSheet, {
  BottomSheetScrollView,
  type BottomSheetMethods,
  type BottomSheetBackgroundProps,
} from "@gorhom/bottom-sheet";
import type { SharedValue } from "react-native-reanimated";

import {
  FONT,
  FONT_SIZE,
  GLASS_RN,
  RADIUS,
  SPACE,
  WEIGHT,
  withAlpha,
} from "@workspace/lib/design-system";
import type { Position, Protocol } from "@workspace/lib/types";

import {
  useThemeColors,
  useThemedStyles,
  type ThemeColors,
} from "../../stores/theme";
import { AllocationDonut } from "./AllocationDonut";
import { Charts } from "./Charts";
import { SponsoredCard } from "./SponsoredCard";
import {
  aggregateAllocation,
  positionUsdValue,
  positionSolValue,
  totalUsdValue,
  SOL_USD_PRICE,
  type AllocationSegment,
  type CurrencyUnit,
} from "./allocation";
import {
  buildPortfolioTimeSeries,
  totalSolValue,
  type PortfolioPoint,
  type RangeKey,
} from "./portfolioTimeSeries";

const RANGE_KEYS: RangeKey[] = ["1W", "1M", "3M", "1Y", "ALL"];

// Phase 8.4.1: SOL/USD は allocation.ts SOL_USD_PRICE に集約 (import で参照)。

const SNAP_INDEX_KEY = "home:bottomSheetSnapIndex"; // Phase 5B.1 persist


export interface PortfolioSummaryProps {
  positions: Position[];
  /** Allocation 集計に使う protocol registry。未指定なら donut は表示しない */
  protocols?: Protocol[];
  isPending?: boolean;
  /** 今日として扱う日 (chart の time-series 起点) */
  today?: Date;
  /**
   * BottomSheet の animatedPosition を外部に exposeし、DailyView の card 高さ
   * 計算に使えるようにする (Phase 5A.3)。SheetPosition は top からの px。
   */
  animatedPosition?: SharedValue<number>;
  testID?: string;
}

export function PortfolioSummary({
  positions,
  protocols = [],
  isPending,
  today = new Date(),
  animatedPosition,
  testID,
}: PortfolioSummaryProps) {
  // Phase 7.9: theme 連動 styles
  const styles = useThemedStyles(makeStyles);

  const sheetRef = useRef<BottomSheetMethods>(null);
  // Phase 5B.1: 3 snap points
  //   25% = collapsed (PORTFOLIO + total + yield + USDC/SOL toggle のみ、上に mascot 露出)
  //   50% = default (range selector + chart まで visible)
  //   85% = expanded (Allocation + Sponsored まで visible)
  const snapPoints = useMemo(() => ["25%", "50%", "85%"], []);

  // 前回 snap を AsyncStorage から復元 (default index = 1 = "50%")
  useEffect(() => {
    AsyncStorage.getItem(SNAP_INDEX_KEY)
      .then((v) => {
        if (v == null) return;
        const idx = Number(v);
        if (Number.isFinite(idx) && idx >= 0 && idx < 3) {
          sheetRef.current?.snapToIndex(idx);
        }
      })
      .catch(() => {
        /* noop — 永続化失敗は無害 */
      });
  }, []);

  const handleSheetChange = useCallback((idx: number) => {
    if (idx < 0) return; // close 状態は記録しない
    AsyncStorage.setItem(SNAP_INDEX_KEY, String(idx)).catch(() => {
      /* noop */
    });
  }, []);

  const [currency, setCurrency] = useState<CurrencyUnit>("USDC");
  const [range, setRange] = useState<RangeKey>("1M");

  // Phase 8.4.1: total を asset_symbol price table から直接計算 (allocation.ts と同じロジック)
  const totalUsd = useMemo(() => totalUsdValue(positions), [positions]);
  const totalSol = totalUsd / SOL_USD_PRICE;

  // 単純 yield: APY 5.7% × range 日数 / 365 × 現在値 (mock、Phase 8.5 で
  // earn position の supply_rate_bps 加重平均に差替予定)
  const yieldRatio = 0.057;
  const yieldDays = 90;
  const yieldUsd = totalUsd * yieldRatio * (yieldDays / 365);
  const yieldSol = yieldUsd / SOL_USD_PRICE;
  const avgYieldDisplay = "—"; // 本物 yield は別 phase で計算

  const series: PortfolioPoint[] = useMemo(
    () => buildPortfolioTimeSeries(positions, range, today),
    [positions, range, today]
  );

  // Phase 8.4.1: currency 駆動で donut value も切替
  const allocation: AllocationSegment[] = useMemo(
    () => aggregateAllocation(positions, protocols, currency),
    [positions, protocols, currency]
  );

  // Phase 8.7: wallet 直接保有 (raw token) を separate section で list 表示
  const walletHoldings = useMemo(
    () =>
      positions.filter(
        (p) =>
          p.protocol_id === "wallet_stable" ||
          p.protocol_id === "wallet_sol" ||
          p.protocol_id === "wallet_holding"
      ),
    [positions]
  );

  const screenWidth = Dimensions.get("window").width;
  const chartWidth = screenWidth - SPACE.md * 2;
  const chartHeight = 180;
  const donutSize = 160;

  const handleSelectRange = useCallback((r: RangeKey) => setRange(r), []);

  return (
    <BottomSheet
      ref={sheetRef}
      index={1}
      snapPoints={snapPoints}
      enablePanDownToClose={false}
      animatedPosition={animatedPosition}
      onChange={handleSheetChange}
      backgroundComponent={GlassBackground}
      handleComponent={() => (
        <View style={styles.handle}>
          <View style={styles.grabber} />
        </View>
      )}
      testID={testID}
    >
      <BottomSheetScrollView
        contentContainerStyle={styles.body}
        showsVerticalScrollIndicator={false}
      >
        {/* Top row: PORTFOLIO label + USDC↔SOL toggle */}
        <View style={styles.topRow}>
          <Text style={styles.portfolioLabel}>Portfolio</Text>
          <View style={styles.toggle} testID={testID ? `${testID}-toggle` : undefined}>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ selected: currency === "USDC" }}
              onPress={() => setCurrency("USDC")}
              style={[
                styles.toggleBtn,
                currency === "USDC" && styles.toggleBtnActive,
              ]}
            >
              <Text
                style={[
                  styles.toggleText,
                  currency === "USDC" && styles.toggleTextActive,
                ]}
              >
                USDC
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ selected: currency === "SOL" }}
              onPress={() => setCurrency("SOL")}
              style={[
                styles.toggleBtn,
                currency === "SOL" && styles.toggleBtnActive,
              ]}
            >
              <Text
                style={[
                  styles.toggleText,
                  currency === "SOL" && styles.toggleTextActive,
                ]}
              >
                SOL
              </Text>
            </Pressable>
          </View>
        </View>

        {/* Total */}
        <Text style={styles.total} testID={testID ? `${testID}-total` : undefined}>
          {currency === "SOL"
            ? `${totalSol.toFixed(4)} SOL`
            : `${totalUsd.toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 })} USDC`}
        </Text>

        {/* Yield row — Phase 8.4.1: 表示単位を currency に追従 (mock APY 5.7%) */}
        <View style={styles.yieldRow}>
          <Text style={styles.yieldText}>
            +
            {currency === "SOL"
              ? `${yieldSol.toFixed(4)} SOL`
              : `${yieldUsd.toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 })} USDC`}{" "}
            ({(yieldRatio * 100).toFixed(2)}%)
          </Text>
          <View style={styles.avgYieldPill}>
            <Text style={styles.avgYieldLabel}>AVG YIELD</Text>
            <Text style={styles.avgYieldValue}>{avgYieldDisplay}</Text>
          </View>
        </View>

        {/* Range selector */}
        <View style={styles.rangeRow}>
          {RANGE_KEYS.map((k) => (
            <Pressable
              key={k}
              accessibilityRole="button"
              accessibilityState={{ selected: range === k }}
              onPress={() => handleSelectRange(k)}
              style={[styles.rangeBtn, range === k && styles.rangeBtnActive]}
            >
              <Text
                style={[
                  styles.rangeText,
                  range === k && styles.rangeTextActive,
                ]}
              >
                {k}
              </Text>
            </Pressable>
          ))}
        </View>

        {/* Chart — Phase 8.4: history は wallet tx index 後の phase で実装。
            positions 空 / series 空 の時は empty state を出して、過去データの
            偽造をやめる (旧 APY 5.7% mock 撤去済)。 */}
        {series.length > 0 ? (
          <Charts
            data={series}
            width={chartWidth}
            height={chartHeight}
            testID={testID ? `${testID}-chart` : undefined}
          />
        ) : (
          <View
            style={[styles.section, { paddingVertical: SPACE.lg }]}
            testID={testID ? `${testID}-chart-empty` : undefined}
          >
            <Text style={styles.empty}>
              {positions.length === 0
                ? "Connect a wallet to see your positions"
                : "Time-series history will appear once tx activity is indexed"}
            </Text>
          </View>
        )}

        {/* Allocation section — donut + legend */}
        {allocation.length > 0 && (
          <View style={styles.section} testID={testID ? `${testID}-allocation` : undefined}>
            <Text style={styles.sectionLabel}>Allocation</Text>
            <View style={styles.allocRow}>
              <AllocationDonut
                segments={allocation}
                size={donutSize}
                testID={testID ? `${testID}-allocation-donut` : undefined}
              />
              <View style={styles.legend}>
                {allocation.map((seg) => (
                  <View key={seg.category} style={styles.legendRow}>
                    <View style={styles.legendLeft}>
                      <View
                        style={[styles.swatch, { backgroundColor: seg.color }]}
                      />
                      <Text style={styles.legendLabel}>{seg.label}</Text>
                    </View>
                    <Text style={styles.legendValue}>
                      {currency === "SOL"
                        ? `${seg.value.toFixed(4)} SOL`
                        : `${seg.value.toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 })} USDC`}
                    </Text>
                  </View>
                ))}
              </View>
            </View>
          </View>
        )}

        {/* Phase 8.7: Wallet holdings — Allocation section の下に individual token list */}
        {walletHoldings.length > 0 && (
          <View
            style={styles.section}
            testID={testID ? `${testID}-wallet-holdings` : undefined}
          >
            <Text style={styles.sectionLabel}>Wallet holdings</Text>
            <View style={styles.legend}>
              {walletHoldings.map((h) => (
                <View key={h.position_id} style={styles.legendRow}>
                  <View style={styles.legendLeft}>
                    <View
                      style={[
                        styles.holdingBadge,
                        {
                          backgroundColor:
                            h.asset_symbol === "SOL" ||
                            h.asset_symbol === "WSOL"
                              ? styles.holdingBadgeSol.backgroundColor
                              : styles.holdingBadgeStable.backgroundColor,
                        },
                      ]}
                    >
                      <Text style={styles.holdingBadgeText}>
                        {h.asset_symbol.charAt(0)}
                      </Text>
                    </View>
                    <Text style={styles.legendLabel} numberOfLines={1}>
                      {h.asset_symbol === "WSOL" ? "SOL" : h.asset_symbol}
                    </Text>
                  </View>
                  <Text style={styles.legendValue}>
                    {currency === "SOL"
                      ? `${positionSolValue(h).toFixed(4)} SOL`
                      : `${positionUsdValue(h).toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 })} USDC`}
                  </Text>
                </View>
              ))}
            </View>
          </View>
        )}

        {/* Sponsored slot (dummy fixture) */}
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>Sponsored</Text>
          <SponsoredCard testID={testID ? `${testID}-sponsored` : undefined} />
        </View>

        {isPending && positions.length === 0 && (
          <Text style={styles.empty}>Loading…</Text>
        )}
      </BottomSheetScrollView>
    </BottomSheet>
  );
}

/**
 * GlassBackground — BottomSheet の background slot に置く glass-effect view。
 * BlurView で背景を blur + GLASS_RN.background の半透明 overlay。
 */
function GlassBackground({
  style,
  pointerEvents,
}: BottomSheetBackgroundProps) {
  // Phase 7.9: sheet 拡張時の opaque bg を theme 連動に
  const themeColors = useThemeColors();
  return (
    <View
      pointerEvents={pointerEvents}
      style={[
        style,
        {
          borderTopLeftRadius: RADIUS.xl,
          borderTopRightRadius: RADIUS.xl,
          overflow: "hidden",
          borderTopWidth: GLASS_RN.borderWidth,
          borderColor: GLASS_RN.borderColor,
          shadowColor: GLASS_RN.shadowColor,
          shadowOffset: GLASS_RN.shadowOffset,
          shadowOpacity: GLASS_RN.shadowOpacity,
          shadowRadius: GLASS_RN.shadowRadius,
          elevation: GLASS_RN.elevation,
        },
      ]}
    >
      {/* Opaque themed bg — sheet 拡張時に home の header / weekday が透けないよう不透明化 */}
      <View
        style={[
          StyleSheet.absoluteFill,
          { backgroundColor: themeColors.bgPrimary },
        ]}
      />
      {/* Phase 5B.1: mascot は sheet 内ではなく home 階層に配置し、collapsed 時に上に露出 */}
    </View>
  );
}

// Phase 7.9: theme 連動 styles factory
function makeStyles(c: ThemeColors) {
  return StyleSheet.create({
    handle: {
      paddingTop: SPACE.sm,
      paddingBottom: SPACE.xs,
      alignItems: "center",
    },
    grabber: {
      width: 44,
      height: 4,
      borderRadius: 2,
      backgroundColor: c.borderStrong,
    },
    body: {
      paddingHorizontal: SPACE.md,
      paddingBottom: SPACE.xxl,
      gap: SPACE.sm,
    },
    section: {
      paddingTop: SPACE.lg,
      gap: SPACE.sm,
    },
    sectionLabel: {
      fontSize: FONT_SIZE.caption,
      fontFamily: FONT.body,
      fontWeight: WEIGHT.bold,
      color: c.textMuted,
      textTransform: "uppercase",
      letterSpacing: 1.2,
    },
    allocRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: SPACE.md,
    },
    legend: {
      flex: 1,
      gap: 6,
    },
    legendRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: SPACE.sm,
    },
    legendLeft: {
      flexDirection: "row",
      alignItems: "center",
      gap: SPACE.xs + 2,
      flex: 1,
    },
    swatch: {
      width: 10,
      height: 10,
      borderRadius: 5,
    },
    legendLabel: {
      fontSize: FONT_SIZE.bodyMD,
      fontFamily: FONT.heading,
      fontWeight: WEIGHT.semibold,
      color: c.textPrimary,
      flexShrink: 1,
    },
    legendValue: {
      fontSize: FONT_SIZE.bodySM,
      fontFamily: FONT.heading,
      fontWeight: WEIGHT.regular,
      color: c.textSubtitle,
    },
    topRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
    },
    portfolioLabel: {
      fontSize: FONT_SIZE.caption,
      fontFamily: FONT.body,
      fontWeight: WEIGHT.bold,
      color: c.textMuted,
      textTransform: "uppercase",
      letterSpacing: 1.2,
    },
    total: {
      fontSize: FONT_SIZE.displayMD,
      fontFamily: FONT.heading,
      fontWeight: WEIGHT.bold,
      color: c.textPrimary,
    },
    yieldRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: SPACE.sm,
    },
    yieldText: {
      fontSize: FONT_SIZE.bodyMD,
      fontFamily: FONT.heading,
      fontWeight: WEIGHT.semibold,
      color: c.melonText,
    },
    avgYieldPill: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      paddingHorizontal: SPACE.sm,
      paddingVertical: 2,
      borderRadius: RADIUS.pill,
      backgroundColor: withAlpha(c.sodaLight, 0.7),
    },
    avgYieldLabel: {
      fontSize: FONT_SIZE.overline,
      fontFamily: FONT.body,
      fontWeight: WEIGHT.bold,
      color: c.textMuted,
      letterSpacing: 0.5,
    },
    avgYieldValue: {
      fontSize: FONT_SIZE.bodySM,
      fontFamily: FONT.heading,
      fontWeight: WEIGHT.bold,
      color: c.sodaText,
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
      minWidth: 56,
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
    rangeRow: {
      flexDirection: "row",
      gap: 4,
      paddingTop: SPACE.xs,
    },
    rangeBtn: {
      paddingHorizontal: SPACE.sm,
      paddingVertical: 4,
      borderRadius: RADIUS.pill,
    },
    rangeBtnActive: {
      backgroundColor: withAlpha(c.sodaLight, 0.85),
    },
    rangeText: {
      fontSize: FONT_SIZE.bodySM,
      fontFamily: FONT.heading,
      fontWeight: WEIGHT.regular,
      color: c.textMuted,
    },
    rangeTextActive: {
      fontWeight: WEIGHT.bold,
      color: c.textPrimary,
    },
    empty: {
      fontSize: FONT_SIZE.bodyMD,
      color: c.textMuted,
      textAlign: "center",
      paddingVertical: SPACE.lg,
    },
    // Phase 8.7: Wallet holdings token badge
    holdingBadge: {
      width: 22,
      height: 22,
      borderRadius: 11,
      alignItems: "center",
      justifyContent: "center",
    },
    holdingBadgeStable: {
      backgroundColor: c.sodaText,
    },
    holdingBadgeSol: {
      backgroundColor: c.caramel,
    },
    holdingBadgeText: {
      fontSize: 11,
      fontFamily: FONT.heading,
      fontWeight: WEIGHT.bold,
      color: c.textOnColor,
    },
  });
}
