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
  COLOR,
  FONT,
  FONT_SIZE,
  GLASS_RN,
  RADIUS,
  SPACE,
  WEIGHT,
  withAlpha,
} from "@workspace/lib/design-system";
import type { Position, Protocol } from "@workspace/lib/types";

import { AllocationDonut } from "./AllocationDonut";
import { Charts } from "./Charts";
import { SponsoredCard } from "./SponsoredCard";
import {
  aggregateAllocation,
  type AllocationSegment,
} from "./allocation";
import {
  buildPortfolioTimeSeries,
  totalSolValue,
  type PortfolioPoint,
  type RangeKey,
} from "./portfolioTimeSeries";

const RANGE_KEYS: RangeKey[] = ["1W", "1M", "3M", "1Y", "ALL"];

const SOL_TO_USD = 168.5; // mock pricing — Phase C5 / 将来 Pyth に差替

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

  const [currency, setCurrency] = useState<"USDC" | "SOL">("SOL");
  const [range, setRange] = useState<RangeKey>("1M");

  const totalSol = useMemo(() => totalSolValue(positions), [positions]);
  const totalUsd = totalSol * SOL_TO_USD;

  // 単純 yield: APY 5.7% × range 日数 / 365 × 現在値
  // 表示は固定式 (prototype の "+15.49 SOL (5.70%)" を再現)
  const yieldRatio = 0.057;
  const yieldDays = 90; // 既得 yield の対象期間 (mock、約 3 ヶ月)
  const yieldSol = totalSol * yieldRatio * (yieldDays / 365);
  const yieldUsd = yieldSol * SOL_TO_USD;
  const avgYieldDisplay = "9.67%"; // prototype 値、mock

  const series: PortfolioPoint[] = useMemo(
    () => buildPortfolioTimeSeries(positions, range, today),
    [positions, range, today]
  );

  const allocation: AllocationSegment[] = useMemo(
    () => aggregateAllocation(positions, protocols),
    [positions, protocols]
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
            ? `${totalSol.toFixed(2)} SOL`
            : `$${totalUsd.toLocaleString("en-US", { maximumFractionDigits: 2 })}`}
        </Text>

        {/* Yield row */}
        <View style={styles.yieldRow}>
          <Text style={styles.yieldText}>
            +
            {currency === "SOL"
              ? `${yieldSol.toFixed(2)} SOL`
              : `$${yieldUsd.toLocaleString("en-US", { maximumFractionDigits: 2 })}`}{" "}
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

        {/* Chart */}
        <Charts
          data={series}
          width={chartWidth}
          height={chartHeight}
          testID={testID ? `${testID}-chart` : undefined}
        />

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
                      {seg.sol.toFixed(2)} SOL
                    </Text>
                  </View>
                ))}
              </View>
            </View>
          </View>
        )}

        {/* Sponsored slot (dummy fixture) */}
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>Sponsored</Text>
          <SponsoredCard testID={testID ? `${testID}-sponsored` : undefined} />
        </View>

        {isPending && positions.length === 0 && (
          <Text style={styles.empty}>読み込み中…</Text>
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
      {/* Opaque cream bg — sheet 拡張時に home の header / weekday が透けないよう不透明化 */}
      <View
        style={[
          StyleSheet.absoluteFill,
          { backgroundColor: COLOR.bgPrimary },
        ]}
      />
      {/* Phase 5B.1: mascot は sheet 内ではなく home 階層に配置し、collapsed 時に上に露出 */}
    </View>
  );
}

const styles = StyleSheet.create({
  handle: {
    paddingTop: SPACE.sm,
    paddingBottom: SPACE.xs,
    alignItems: "center",
  },
  grabber: {
    width: 44,
    height: 4,
    borderRadius: 2,
    backgroundColor: COLOR.borderStrong,
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
    color: COLOR.textMuted,
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
    color: COLOR.textPrimary,
    flexShrink: 1,
  },
  legendValue: {
    fontSize: FONT_SIZE.bodySM,
    fontFamily: FONT.heading,
    fontWeight: WEIGHT.regular,
    color: COLOR.textSubtitle,
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
    color: COLOR.textMuted,
    textTransform: "uppercase",
    letterSpacing: 1.2,
  },
  total: {
    fontSize: FONT_SIZE.displayMD,
    fontFamily: FONT.heading,
    fontWeight: WEIGHT.bold,
    color: COLOR.textPrimary,
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
    color: COLOR.melonText,
  },
  avgYieldPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: SPACE.sm,
    paddingVertical: 2,
    borderRadius: RADIUS.pill,
    backgroundColor: withAlpha(COLOR.sodaLight, 0.7),
  },
  avgYieldLabel: {
    fontSize: FONT_SIZE.overline,
    fontFamily: FONT.body,
    fontWeight: WEIGHT.bold,
    color: COLOR.textMuted,
    letterSpacing: 0.5,
  },
  avgYieldValue: {
    fontSize: FONT_SIZE.bodySM,
    fontFamily: FONT.heading,
    fontWeight: WEIGHT.bold,
    color: COLOR.sodaText,
  },
  // USDC ↔ SOL toggle
  toggle: {
    flexDirection: "row",
    backgroundColor: withAlpha(COLOR.textMuted, 0.08),
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
    backgroundColor: COLOR.sodaText,
  },
  toggleText: {
    fontSize: FONT_SIZE.bodySM,
    fontFamily: FONT.heading,
    fontWeight: WEIGHT.bold,
    color: COLOR.textMuted,
  },
  toggleTextActive: {
    color: COLOR.textOnColor,
  },
  // Range selector
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
    backgroundColor: withAlpha(COLOR.sodaLight, 0.85),
  },
  rangeText: {
    fontSize: FONT_SIZE.bodySM,
    fontFamily: FONT.heading,
    fontWeight: WEIGHT.regular,
    color: COLOR.textMuted,
  },
  rangeTextActive: {
    fontWeight: WEIGHT.bold,
    color: COLOR.textPrimary,
  },
  empty: {
    fontSize: FONT_SIZE.bodyMD,
    color: COLOR.textMuted,
    textAlign: "center",
    paddingVertical: SPACE.lg,
  },
});
