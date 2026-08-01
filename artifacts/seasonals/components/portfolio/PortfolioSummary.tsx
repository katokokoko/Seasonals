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
import { format } from "date-fns";
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
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  useThemeColors,
  useThemedStyles,
  type ThemeColors,
} from "../../stores/theme";
import {
  usePortfolioHistory,
  usePrices,
  useJupiterLendMarkets,
} from "../../services/queries";
import { AllocationDonut } from "./AllocationDonut";
import { Charts } from "./Charts";
import { SponsoredCard } from "./SponsoredCard";
import {
  aggregateAllocation,
  positionUsdValue,
  solUsdPrice,
  totalUsdValue,
  type AllocationSegment,
  type CurrencyUnit,
} from "./allocation";
// 8.55: holdings 行の表示モデル (純関数、単体テスト済)
import { conversionLine, holdingView, rateLine } from "./holding-view";
import {
  buildPortfolioTimeSeries,
  hasHistory as seriesHasHistory,
  coverageFromKnownStart,
  historyCoverage,
  rangeExceedsCoverage,
  rangeToDays,
  serverHistoryToPoints,
  totalSolValue,
  type PortfolioPoint,
  type RangeKey,
} from "./portfolioTimeSeries";
// 8.56: 端末に貯めた日次スナップショット (実測のみ)
import { usePortfolioHistoryStore } from "../../stores/portfolioHistory";
import { dayKeyToDate } from "./history";

const RANGE_KEYS: RangeKey[] = ["1W", "1M", "3M", "1Y", "ALL"];

// Phase 8.57: SOL/USD は固定値をやめ oracle の実価格 (usePrices) を使う。

const SNAP_INDEX_KEY = "home:bottomSheetSnapIndex"; // Phase 5B.1 persist


export interface PortfolioSummaryProps {
  positions: Position[];
  /** Allocation 集計に使う protocol registry。未指定なら donut は表示しない */
  protocols?: Protocol[];
  isPending?: boolean;
  /** 今日として扱う日 (chart の time-series 起点) */
  today?: Date;
  /** 8.58: 接続中の wallet (BFF から過去の評価額を復元するのに使う)。未接続は null */
  walletAddress?: string | null;
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
  walletAddress,
  animatedPosition,
  testID,
}: PortfolioSummaryProps) {
  // Phase 7.9: theme 連動 styles
  const styles = useThemedStyles(makeStyles);
  // 8.45: edge-to-edge の下端 inset (ジェスチャーバー分)
  const insets = useSafeAreaInsets();

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
  // 8.57: 実価格 map (native SOL は DAS に価格が無いので oracle から埋める)
  const { data: priceStrings } = usePrices();
  const prices = useMemo(() => {
    const out: Record<string, number> = {};
    for (const [symbol, value] of Object.entries(priceStrings ?? {})) {
      const n = Number(value);
      if (Number.isFinite(n) && n > 0) out[symbol] = n;
    }
    return out;
  }, [priceStrings]);
  const solUsd = solUsdPrice(prices);

  const totalUsd = useMemo(
    () => totalUsdValue(positions, prices),
    [positions, prices]
  );
  const totalSol = solUsd === null ? 0 : totalUsd / solUsd;

  // Phase 8.10: earn position (Jupiter Lend / Kamino) の supply_rate_bps を
  // USD 重みで加重平均して実効 APR を算出。range 日数で按分して period yield に。
  // Phase 8.10.1: position 側 supply_rate_bps が 0 / 欠落する場合は markets API
  // (useJupiterLendMarkets) の値を share_mint で fallback ルックアップ。
  const rangeDaysByKey: Record<RangeKey, number> = {
    "1W": 7,
    "1M": 30,
    "3M": 90,
    "1Y": 365,
    ALL: 730,
  };
  const { data: jlMarketsForYield = [] } = useJupiterLendMarkets();
  const bpsByJlMint = useMemo(() => {
    const m = new Map<string, number>();
    for (const mkt of jlMarketsForYield) {
      m.set(mkt.jlMint, mkt.supplyRateBps);
    }
    return m;
  }, [jlMarketsForYield]);
  const { yieldUsd, yieldSol, yieldRatio, avgYieldDisplay } = useMemo(() => {
    let weighted = 0;
    let earnUsd = 0;
    for (const p of positions) {
      // earn position の判定: protocol_id が "jupiter_lend" or "kamino"
      const isEarn =
        p.protocol_id === "jupiter_lend" || p.protocol_id === "kamino";
      if (!isEarn) continue;
      const rs = (p.raw_state ?? {}) as Record<string, unknown>;
      const fromRaw =
        typeof rs.supply_rate_bps === "number" ? rs.supply_rate_bps : 0;
      // fallback: share_mint で markets を引く
      const shareMint =
        typeof rs.share_mint === "string" ? rs.share_mint : null;
      const fromMarkets =
        shareMint && bpsByJlMint.has(shareMint)
          ? bpsByJlMint.get(shareMint)!
          : 0;
      const bps = fromRaw > 0 ? fromRaw : fromMarkets;
      if (bps <= 0) continue;
      // USD weight = positionUsdValue
      const usd = positionUsdValue(p, prices);
      if (!Number.isFinite(usd) || usd <= 0) continue;
      earnUsd += usd;
      weighted += usd * (bps / 10000);
    }
    const avgApr = earnUsd > 0 ? weighted / earnUsd : 0;
    const days = rangeDaysByKey[range];
    const yUsd = earnUsd * avgApr * (days / 365);
    return {
      yieldUsd: yUsd,
      yieldSol: solUsd === null ? 0 : yUsd / solUsd,
      yieldRatio: avgApr,
      avgYieldDisplay:
        avgApr > 0 ? `${(avgApr * 100).toFixed(2)}%` : "—",
    };
  }, [positions, range, bpsByJlMint, prices, solUsd]);

  // 8.55: 系列はトグル通貨建てで生成 (chart 縦軸をトグルと一致させる)
  // 8.56: 実測スナップショット + 今日の現在値。過去は捏造しない
  const snapshots = usePortfolioHistoryStore((s) => s.snapshots);
  // 8.58: BFF が wallet の tx から復元した履歴を優先し、無ければ端末の
  // 日次スナップショットに落ちる (未接続 / fixture / BFF 不通)
  const { data: serverHistory } = usePortfolioHistory(
    walletAddress,
    rangeToDays(range)
  );
  const localSeries: PortfolioPoint[] = useMemo(
    () =>
      buildPortfolioTimeSeries(
        snapshots,
        positions,
        range,
        today,
        currency,
        prices
      ),
    [snapshots, positions, range, today, currency, prices]
  );
  const serverSeries: PortfolioPoint[] = useMemo(
    () => serverHistoryToPoints(serverHistory?.points ?? [], currency),
    [serverHistory, currency]
  );
  const series = serverSeries.length >= 2 ? serverSeries : localSeries;
  const approximatedSymbols = serverHistory?.approximated_symbols ?? [];
  // 8.60: 履歴がどこまで遡れているか (3M と 1Y が同じに見える理由の説明)
  const coverage = useMemo(
    () => historyCoverage(serverHistory?.points ?? [], range),
    [serverHistory, range]
  );
  // 一度分かった開始日は覚えておく (絶対的な事実なので、短い range に
  // 切り替えて判定材料が無くなっても淡色表示を保つ)
  const [knownStart, setKnownStart] = useState<Date | null>(null);
  useEffect(() => {
    if (!coverage.partial || !coverage.from) return;
    setKnownStart((prev) =>
      prev === null || coverage.from!.getTime() < prev.getTime()
        ? coverage.from
        : prev
    );
  }, [coverage]);
  const chipCoverage = useMemo(
    () => coverageFromKnownStart(knownStart, today),
    [knownStart, today]
  );
  // 変動を観測できていない間は線を描かず現在値カードを出す
  const showChart = seriesHasHistory(series);
  const trackingSince = snapshots[0] ? dayKeyToDate(snapshots[0].day) : today;

  // Phase 8.4.1: currency 駆動で donut value も切替
  const allocation: AllocationSegment[] = useMemo(
    () => aggregateAllocation(positions, protocols, currency, prices),
    [positions, protocols, currency, prices]
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

  // 8.55: 展開中の holdings 行 (position_id の Set、複数展開可)
  const [expandedHoldings, setExpandedHoldings] = useState<Set<string>>(
    () => new Set()
  );
  const toggleHolding = useCallback((positionId: string) => {
    setExpandedHoldings((prev) => {
      const next = new Set(prev);
      if (next.has(positionId)) next.delete(positionId);
      else next.add(positionId);
      return next;
    });
  }, []);

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
        // 8.45 (edge-to-edge): 下端がジェスチャーバーの裏まで伸びるので、
        // 最下段が潜らないよう inset を足す
        contentContainerStyle={[
          styles.body,
          { paddingBottom: SPACE.xxl + insets.bottom },
        ]}
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

        {/* Phase 8.10: Yield row — earn position supply_rate_bps の加重平均から算出。
            earn 不在時は "—" で表示。 */}
        <View style={styles.yieldRow}>
          <Text style={styles.yieldText}>
            {yieldRatio > 0 ? (
              <>
                +
                {currency === "SOL"
                  ? `${yieldSol.toFixed(4)} SOL`
                  : `${yieldUsd.toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 })} USDC`}{" "}
                ({(yieldRatio * 100).toFixed(2)}%)
              </>
            ) : (
              "— no earn positions"
            )}
          </Text>
          <View style={styles.avgYieldPill}>
            <Text style={styles.avgYieldLabel}>AVG YIELD</Text>
            <Text style={styles.avgYieldValue}>{avgYieldDisplay}</Text>
          </View>
        </View>

        {/* Range selector */}
        <View style={styles.rangeRow}>
          {RANGE_KEYS.map((k) => {
            // 8.60: 履歴が届かない range は淡色に (押せば同じ全期間が出る)
            const beyond = rangeExceedsCoverage(k, chipCoverage);
            return (
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
                    beyond && range !== k && styles.rangeTextBeyond,
                  ]}
                >
                  {k}
                </Text>
              </Pressable>
            );
          })}
        </View>

        {/* Chart — Phase 8.4 / 8.56: 過去データを偽造しない。
            観測した変動が 2 点以上たまるまでは線を描かず、現在値と
            「いつから記録しているか」を出す (中身のない目盛りを作らない)。 */}
        {showChart ? (
          <Charts
            data={series}
            unit={currency}
            width={chartWidth}
            height={chartHeight}
            testID={testID ? `${testID}-chart` : undefined}
          />
        ) : (
          <View
            style={[styles.chartPlaceholder, { height: chartHeight }]}
            testID={testID ? `${testID}-chart-empty` : undefined}
          >
            {positions.length === 0 ? (
              <Text style={styles.empty}>
                Connect a wallet to see your positions
              </Text>
            ) : (
              <>
                <Text style={styles.placeholderValue}>
                  {currency === "SOL"
                    ? `${totalSol.toFixed(4)} SOL`
                    : `${totalUsd.toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 })} USDC`}
                </Text>
                <Text style={styles.empty}>
                  {`Tracking since ${format(trackingSince, "MMM d")} · history builds daily`}
                </Text>
              </>
            )}
          </View>
        )}

        {/* 8.60: 要求 range より履歴が短い時だけ、どこからの記録かを出す */}
        {showChart && coverage.partial && coverage.from && (
          <Text
            style={styles.approxNote}
            testID={testID ? `${testID}-coverage-note` : undefined}
          >
            {`履歴は ${format(coverage.from, "M/d")} から (それ以前は残高なし)`}
          </Text>
        )}

        {/* 8.58: 過去の実価格が無く現在価格で近似した asset がある時だけ注記 */}
        {showChart && approximatedSymbols.length > 0 && (
          <Text
            style={styles.approxNote}
            testID={testID ? `${testID}-approx-note` : undefined}
          >
            {`${approximatedSymbols.join(", ")} は現在価格で概算`}
          </Text>
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
                {(() => {
                  // Phase 8.8.4: 凡例は currency 単位の絶対値ではなく **割合 (%)** で表示。
                  const totalSegValue = allocation.reduce(
                    (sum, s) => sum + s.value,
                    0
                  );
                  return allocation.map((seg) => {
                    const pct =
                      totalSegValue > 0
                        ? (seg.value / totalSegValue) * 100
                        : 0;
                    return (
                      <View key={seg.category} style={styles.legendRow}>
                        <View style={styles.legendLeft}>
                          <View
                            style={[
                              styles.swatch,
                              { backgroundColor: seg.color },
                            ]}
                          />
                          <Text style={styles.legendLabel}>{seg.label}</Text>
                        </View>
                        <Text style={styles.legendValue}>{`${pct.toFixed(1)}%`}</Text>
                      </View>
                    );
                  });
                })()}
              </View>
            </View>
          </View>
        )}

        {/* Phase 8.7 → 8.55: Wallet holdings — 行はトークンそのものの量 (ネイティブ
            単位)。トグル通貨換算だと SOL の行に USDC が並ぶ不整合があった。
            タップで USDC / SOL 両換算 + 固定レート注記を展開する */}
        {walletHoldings.length > 0 && (
          <View
            style={styles.section}
            testID={testID ? `${testID}-wallet-holdings` : undefined}
          >
            <Text style={styles.sectionLabel}>Wallet holdings</Text>
            <View style={styles.legend}>
              {walletHoldings.map((h) => {
                const view = holdingView(h, prices);
                const expanded = expandedHoldings.has(h.position_id);
                return (
                  <View key={h.position_id}>
                    <Pressable
                      accessibilityRole={view.priced ? "button" : "none"}
                      accessibilityState={{ expanded }}
                      onPress={
                        view.priced
                          ? () => toggleHolding(h.position_id)
                          : undefined
                      }
                      style={styles.legendRow}
                      testID={
                        testID
                          ? `${testID}-holding-${view.symbol}`
                          : undefined
                      }
                    >
                      <View style={styles.legendLeft}>
                        <View
                          style={[
                            styles.holdingBadge,
                            {
                              backgroundColor:
                                view.symbol === "SOL"
                                  ? styles.holdingBadgeSol.backgroundColor
                                  : styles.holdingBadgeStable.backgroundColor,
                            },
                          ]}
                        >
                          <Text style={styles.holdingBadgeText}>
                            {view.symbol.charAt(0)}
                          </Text>
                        </View>
                        <Text style={styles.legendLabel} numberOfLines={1}>
                          {view.symbol}
                        </Text>
                      </View>
                      <Text style={styles.legendValue}>
                        {`${view.nativeAmount} ${view.symbol}`}
                        {view.priced ? (expanded ? "  ⌄" : "  ›") : ""}
                      </Text>
                    </Pressable>
                    {expanded && view.priced && (
                      <View
                        style={styles.holdingDetail}
                        testID={
                          testID
                            ? `${testID}-holding-${view.symbol}-detail`
                            : undefined
                        }
                      >
                        <Text style={styles.holdingDetailText}>
                          {conversionLine(view)}
                        </Text>
                        <Text style={styles.holdingDetailRate}>
                          {rateLine(prices)}
                        </Text>
                      </View>
                    )}
                  </View>
                );
              })}
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
    // 8.60: 履歴が届かない range のラベル (淡色。押せないわけではない)
    rangeTextBeyond: {
      opacity: 0.35,
    },
    // 8.58: 過去価格が無い asset の注記 (chart 下、控えめに)
    approxNote: {
      fontSize: FONT_SIZE.bodySM,
      fontFamily: FONT.body,
      color: c.textMuted,
      textAlign: "center",
      marginTop: SPACE.xs,
    },
    // 8.56: 履歴が貯まるまでの chart 代替 (高さを維持してレイアウトを揺らさない)
    chartPlaceholder: {
      alignItems: "center",
      justifyContent: "center",
      gap: SPACE.xs,
    },
    placeholderValue: {
      fontSize: FONT_SIZE.displaySM,
      fontFamily: FONT.heading,
      fontWeight: WEIGHT.bold,
      color: c.textPrimary,
    },
    // 8.55: holdings 行タップで出す換算の展開行 (badge 幅 + gap 分 indent)
    holdingDetail: {
      paddingLeft: 24 + SPACE.sm,
      paddingTop: 2,
      paddingBottom: SPACE.xs,
      gap: 2,
    },
    holdingDetailText: {
      fontSize: FONT_SIZE.bodySM,
      fontFamily: FONT.body,
      color: c.textSubtitle,
    },
    holdingDetailRate: {
      fontSize: FONT_SIZE.bodySM,
      fontFamily: FONT.body,
      color: c.textMuted,
    },
  });
}
