/**
 * Home screen — Seasonals 主画面 (CLAUDE.md §0 / §32.2 "tab-hopping ゼロ")
 *
 * 単一画面で完結する calendar-centric UX。Phase 5A で 2-row header に再構築:
 *   Row 1: Seasonals (Pacifico sodaText) | view-mode toggle pill (grid + phone) | wallet drink button
 *   Row 2: Month + Year label | "Open Menu →" pill
 *   Body:  viewMode='monthly' → MonthGrid / 'daily' → DailyView (5A.3)
 *   Bottom: PortfolioSummary (collapsible bottom sheet)
 *
 * @see Phase 5A spec / docs/visual-reference/header.png
 */

import React, { useEffect, useMemo, useState } from "react";
import {
  Dimensions,
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import {
  SafeAreaView,
  useSafeAreaInsets,
} from "react-native-safe-area-context";
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
import { format } from "date-fns";

import {
  FONT,
  FONT_SIZE,
  RADIUS,
  SPACE,
  WEIGHT,
  withAlpha,
} from "@workspace/lib/design-system";
import {
  AgentPlanStatus,
  type ActionDescriptor,
  type AgentPlan,
  type UnifiedTimeEvent,
} from "@workspace/lib/types";

import { MonthGrid } from "../components/calendar/MonthGrid";
import { DailyView } from "../components/calendar/DailyView";
import { EventDayModal } from "../components/calendar/EventDayModal";
import { syntheticPlanFromEventAction } from "../components/calendar/event-action";
import { ActionModal } from "../components/action/ActionModal";
import { PortfolioSummary } from "../components/portfolio/PortfolioSummary";
import { SettingsDrawer } from "../components/drawer/SettingsDrawer";
import { MenuDrawer } from "../components/drawer/MenuDrawer";
import { ViewModeTogglePill } from "../components/header/ViewModeTogglePill";
import { WalletDrinkButton } from "../components/header/WalletDrinkButton";
import { WalletPopover } from "../components/wallet/WalletPopover";
import { GlassLayer } from "../components/glass/GlassLayer";
import { useAllCustomEvents } from "../services/customEventsStore";
import {
  useAgentPlans,
  useEarnPositions,
  usePositions,
  usePrices,
  useWalletTimeEvents,
  useProtocols,
  useTimeEvents,
} from "../services/queries";
import { useCalendarViewStore } from "../stores/calendarView";
import {
  useCalendarMonthStore,
  ymToDate,
  dateToYm,
} from "../stores/calendarMonth";
import {
  useCalendarDayStore,
  isoToDate,
  dateToIso,
} from "../stores/calendarDay";
import {
  useActiveTheme,
  useThemedStyles,
  type ThemeColors,
} from "../stores/theme";
import { useWallet } from "../services/useWallet";
import { USE_ONCHAIN } from "../services/config";
import { mergeEarnPositions } from "../services/earn-to-position";
// 8.56: portfolio chart の実履歴 (1 日 1 点の実測スナップショット)
import { usePortfolioHistoryStore } from "../stores/portfolioHistory";
import { totalSolValue } from "../components/portfolio/portfolioTimeSeries";

function localDayKey(day: Date): string {
  return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
}

function eventDayKey(triggerAt: UnifiedTimeEvent["triggerAt"]): string {
  // Phase 8.3.1: local TZ で日付 key を生成。cell の localDayKey と TZ 一致させる。
  const ts = triggerAt instanceof Date ? triggerAt : new Date(triggerAt);
  return `${ts.getFullYear()}-${String(ts.getMonth() + 1).padStart(2, "0")}-${String(ts.getDate()).padStart(2, "0")}`;
}

export default function HomeScreen() {
  const [selectedDay, setSelectedDay] = useState<Date | null>(null);
  const [dayModalOpen, setDayModalOpen] = useState(false);
  const [pendingPlan, setPendingPlan] = useState<AgentPlan | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [servicesOpen, setServicesOpen] = useState(false);
  const [walletModalOpen, setWalletModalOpen] = useState(false);

  const insets = useSafeAreaInsets();

  const { data: fixtureEvents = [] } = useTimeEvents();
  // Phase 8.1: onchain variant + 接続済 wallet なら address を渡して
  // Helius DAS 経由の実 mainnet 保有を取得。それ以外は fixture。
  const { authorization } = useWallet();
  const onchainAddress =
    USE_ONCHAIN && authorization?.address ? authorization.address : null;
  const { data: basePositions = [] } = usePositions(onchainAddress);
  // Phase 8.2: onchain APK で接続済みなら Jupiter Lend / Kamino positions を取得、
  // MenuDrawer "Your Positions" section に渡す
  const { data: earnPositionsData } = useEarnPositions(onchainAddress);
  // Phase 8.3: wallet tx 履歴から派生する deposit/withdraw time events を取得し、
  // 既存 fixture events と merge して calendar に渡す
  const { data: walletEvents = [] } = useWalletTimeEvents(onchainAddress);
  const { data: protocols = [] } = useProtocols();

  // Phase 8.3 Part A: earn positions を Position に変換して portfolio donut に計上
  const positions = useMemo(
    () => mergeEarnPositions(basePositions, earnPositionsData),
    [basePositions, earnPositionsData]
  );
  // Phase 8.56: 評価額を 1 日 1 点だけ記録する (chart の実履歴)。
  // 8.57: 実価格が揃ってから記録する (SOL 価格が無いと 0 になり、store 側で捨てられる)
  const { data: priceStrings } = usePrices();
  useEffect(() => {
    if (positions.length === 0) return;
    const prices: Record<string, number> = {};
    for (const [symbol, value] of Object.entries(priceStrings ?? {})) {
      const n = Number(value);
      if (Number.isFinite(n) && n > 0) prices[symbol] = n;
    }
    usePortfolioHistoryStore.getState().record(totalSolValue(positions, prices));
  }, [positions, priceStrings]);

  // Phase 8.3 Part B: wallet tx 由来 events + fixture events を merge
  const events = useMemo(
    () => [...fixtureEvents, ...walletEvents],
    [fixtureEvents, walletEvents]
  );
  const { data: plans = [] } = useAgentPlans();
  const customEvents = useAllCustomEvents();

  const viewMode = useCalendarViewStore((s) => s.viewMode);
  const currentMonth = useCalendarMonthStore((s) => s.currentMonth);
  const setCurrentMonth = useCalendarMonthStore((s) => s.setCurrentMonth);
  const monthDate = useMemo(() => ymToDate(currentMonth), [currentMonth]);

  const selectedIsoDay = useCalendarDayStore((s) => s.selectedDate);
  const setSelectedIsoDay = useCalendarDayStore((s) => s.setSelectedDate);

  // BottomSheet animatedPosition を上層で保持し、DailyView の card 高さ計算に渡す
  const sheetPosition = useSharedValue(0);

  // Phase 5A.6.3: mascot は monthly view 限定 (daily 時 fade out 200ms)
  const mascotOpacity = useSharedValue(viewMode === "monthly" ? 1 : 0);
  useEffect(() => {
    mascotOpacity.value = withTiming(viewMode === "monthly" ? 1 : 0, {
      duration: 200,
    });
  }, [viewMode, mascotOpacity]);
  const mascotAnimStyle = useAnimatedStyle(() => ({
    opacity: mascotOpacity.value,
  }));

  // 左 edge から右 swipe で SettingsDrawer 開閉
  const edgeLeftGesture = Gesture.Pan()
    .activeOffsetX([-15, 15])
    .onEnd((e) => {
      if (e.translationX > 60) runOnJS(setSettingsOpen)(true);
    });

  // 右 edge から左 swipe で MenuDrawer 開閉
  const edgeRightGesture = Gesture.Pan()
    .activeOffsetX([-15, 15])
    .onEnd((e) => {
      if (e.translationX < -60) runOnJS(setServicesOpen)(true);
    });

  // MenuDrawer から start action: 該当 protocol/asset の plan を解決
  //
  // Phase 7.7 choreography: drawer close (220ms) と ActionModal enter (240ms) を
  // 完全同時に発火すると別 motion が並走する印象になるため、modal open を 130ms
  // 遅延させて drawer が約 60% 閉じた頃に modal を立ち上げる連続シーケンスにする。
  const handleStartActionFromServices = (
    protocol: string,
    asset: string,
    actionType: "deposit",
    poolId?: string
  ) => {
    // Phase 8.5: synthetic AgentPlan を生成 — fixture からの lookup は廃止し、
    // pool tap context (protocol / asset / actionType) を直接 plan に詰める。
    // amount は Phase 8.5 MVP で固定 0.1 USDC (= 100000 smallest unit) 等、
    // 小額 mainnet test 用 default。将来 ActionModal で edit 可能にする予定。
    const defaultAmountByAsset: Record<string, string> = {
      USDC: "100000",      // 0.1 USDC
      USDT: "100000",      // 0.1 USDT
      SOL: "1000000",      // 0.001 SOL
    };
    const amount = defaultAmountByAsset[asset] ?? "100000";

    const syntheticPlan = {
      plan_id: `synthetic_${Date.now()}`,
      status: AgentPlanStatus.PendingUser,
      objective: "increase_yield",
      candidate_actions: [],
      selected_action: {
        protocol,
        asset,
        action_type: actionType,
        amount,
        // Phase 8.15d: 同一 asset の reserve/vault pool を判別する dispatch キー
        metadata: poolId ? { pool_id: poolId } : undefined,
      },
      simulation_result: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    } as unknown as AgentPlan;

    setTimeout(() => setPendingPlan(syntheticPlan), 130);
  };

  // Phase 8.9: Your Positions row tap → withdraw 起動 (synthetic plan)
  const handleWithdrawPosition = (position: import("@workspace/lib/types").EarnPosition) => {
    setServicesOpen(false);
    const syntheticPlan = {
      plan_id: `synthetic_withdraw_${Date.now()}`,
      status: AgentPlanStatus.PendingUser,
      objective: "rebalance",
      candidate_actions: [],
      selected_action: {
        protocol: position.protocol_id,
        asset: position.asset_symbol,
        action_type: "withdraw",
        // amount = shares smallest unit (jlToken 全量 withdraw)
        amount: position.shares,
        metadata: {
          share_mint: position.share_mint,
          share_decimals: position.share_decimals,
          underlying_decimals: position.underlying_decimals,
          // Phase 8.16: 部分 withdraw の ≈underlying 換算表示用 (display-only)
          underlying_amount: position.underlying_amount,
        },
      },
      simulation_result: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    } as unknown as AgentPlan;
    setTimeout(() => setPendingPlan(syntheticPlan), 130);
  };

  const dayEvents = selectedDay
    ? events.filter((e) => eventDayKey(e.triggerAt) === localDayKey(selectedDay))
    : [];

  const handleDayPress = (day: Date) => {
    setSelectedDay(day);
    setSelectedIsoDay(dateToIso(day));
    setDayModalOpen(true);
  };

  const handleMonthChange = (next: Date) => {
    setCurrentMonth(dateToYm(next));
  };

  const handleActionPress = (
    event: UnifiedTimeEvent,
    action: ActionDescriptor
  ) => {
    // Phase 8.20 (§29.1 event-driven action): claim イベント等の metadata から
    // synthetic plan を組めるなら、カレンダーから直接 ActionModal を起動する。
    // day modal close → 130ms 遅延は drawer と同じ choreography (Phase 7.7)。
    const synthetic = syntheticPlanFromEventAction(event, action);
    if (synthetic) {
      setDayModalOpen(false);
      setTimeout(() => setPendingPlan(synthetic), 130);
      return;
    }
    // fallback: fixture plan lookup (旧経路)
    const exact = plans.find(
      (p) =>
        p.selected_action?.protocol === event.protocol &&
        p.selected_action?.action_type === action.actionType
    );
    const fallback = plans.find(
      (p) =>
        p.status === AgentPlanStatus.Simulated ||
        p.status === AgentPlanStatus.PendingUser
    );
    const target = exact ?? fallback ?? null;
    if (!target) return;
    setDayModalOpen(false);
    setPendingPlan(target);
  };

  // SafeAreaView の inset top に加えて Pacifico の ascender 分の余裕 + 12px
  const topPad = insets.top + SPACE.md + 12;

  // DailyView の card 上端 (Row1 + Row2 の高さ + topPad)
  const headerApproxHeight = topPad + 56 + 56; // Row1 56 + Row2 56 (近似値、card 高さは clamp で安全)

  // WalletPopover anchor: drink button (Row 1) のすぐ下
  const walletAnchorTop = topPad + 48;

  // Phase 7.8: active theme の logo color (Seasonals wordmark)
  const logoColor = useActiveTheme().accent.logo;

  // Phase 7.9: theme 連動 styles
  const styles = useThemedStyles(makeStyles);

  return (
    // 8.45 (edge-to-edge): edges=[] で全面表示にする。bottom padding があると
    // GlassLayer / MelonSodaBackground (中の absoluteFill) が下端 inset 分だけ
    // クリップされ、液面キャンバスがジェスチャーバー手前で切れてしまう。
    // 下端 inset は各サーフェス側 (シート・トースト等) で個別に消化する
    <SafeAreaView style={styles.safe} edges={[]}>
      {/* Phase 7.1: melon-soda gravity-aware ambient bg (touch 透過、最背面) */}
      {/* Phase 8.36: 液体演出 (off/reduce-motion 時は内部で MelonSodaBackground static へ退避) */}
      <GlassLayer />

      {/* Row 1: Seasonals | toggle pill | wallet drink */}
      <View style={[styles.row1, { paddingTop: topPad }]}>
        <Pressable
          accessibilityRole="button"
          onPress={() => setSettingsOpen(true)}
          hitSlop={8}
          testID="home-brand"
        >
          <Text style={[styles.brand, { color: logoColor }]}>Seasonals</Text>
        </Pressable>
        <View style={styles.row1Right}>
          <ViewModeTogglePill testID="home-view-toggle" />
          <WalletDrinkButton
            onPress={() => setWalletModalOpen(true)}
            testID="home-wallet-btn"
          />
        </View>
      </View>

      {/* Row 2: Month label | Open Menu → */}
      <View style={styles.row2}>
        <View style={styles.monthLabelRow}>
          <Text style={styles.monthLabelMonth}>
            {format(monthDate, "MMMM")}
          </Text>
          <Text style={styles.monthLabelYear}>
            {format(monthDate, "yyyy")}
          </Text>
        </View>
        <Pressable
          accessibilityRole="button"
          onPress={() => setServicesOpen(true)}
          hitSlop={8}
          style={styles.menuBtn}
          testID="home-open-menu"
        >
          <Text style={styles.menuBtnText}>Open Menu →</Text>
        </Pressable>
      </View>

      {/* Body: monthly grid OR daily view (with edge-left/right gesture overlay) */}
      <GestureDetector gesture={Gesture.Race(edgeLeftGesture, edgeRightGesture)}>
        <View style={styles.bodyWrap}>
          {viewMode === "monthly" ? (
            <MonthGrid
              month={monthDate}
              onChangeMonth={handleMonthChange}
              events={events}
              customEvents={customEvents}
              selectedDay={selectedDay}
              onDayPress={handleDayPress}
              today={new Date()}
              testID="home-calendar"
            />
          ) : (
            <DailyView
              events={events}
              sheetPosition={sheetPosition}
              topInset={headerApproxHeight}
              onSelectEvent={(event) => {
                // 1 event 時の単一遷移 — TODO Phase 5+: /action-confirm route
                setSelectedDay(isoToDate(selectedIsoDay));
                handleActionPress(event, {
                  actionType: "deposit",
                } as unknown as ActionDescriptor);
              }}
              onOpenDay={(day) => {
                // 複数 event 時 — TODO Phase 5+: /event-list/[date]
                setSelectedDay(day);
                setDayModalOpen(true);
              }}
              testID="home-daily"
            />
          )}
        </View>
      </GestureDetector>

      {/* Day events modal (one-tap entry) */}
      <EventDayModal
        visible={dayModalOpen}
        day={selectedDay}
        events={dayEvents}
        onClose={() => setDayModalOpen(false)}
        onActionPress={handleActionPress}
        testID="home-day-modal"
      />

      {/* Mascot decoration — monthly のみ表示 (daily fade out 200ms)、sheet collapsed 時に visible */}
      <Animated.View
        pointerEvents="none"
        style={[styles.mascotWrap, mascotAnimStyle]}
      >
        <Image
          source={require("../assets/images/seasonals-mascots.png")}
          resizeMode="contain"
          style={styles.mascotImage}
        />
      </Animated.View>

      {/* Bottom portfolio panel (glass + chart) */}
      {/* 8.55: today は実時刻 (旧 MOCK_TODAY=2026-05-09 は chart 右端が 5/9 で止まっていた) */}
      <PortfolioSummary
        positions={positions}
        protocols={protocols}
        today={new Date()}
        walletAddress={onchainAddress}
        animatedPosition={sheetPosition}
        testID="home-portfolio"
      />

      {/* Action approval */}
      <ActionModal
        plan={pendingPlan}
        onClose={() => setPendingPlan(null)}
        testID="home-action-modal"
      />

      {/* Settings drawer */}
      <SettingsDrawer
        visible={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        testID="home-settings-drawer"
      />

      {/* Menu drawer */}
      <MenuDrawer
        visible={servicesOpen}
        onClose={() => setServicesOpen(false)}
        onStartAction={handleStartActionFromServices}
        onWithdrawPosition={handleWithdrawPosition}
        earnPositions={earnPositionsData}
        testID="home-menu-drawer"
      />

      {/* Wallet popover (drink button から fade-in、右上 anchor) */}
      <WalletPopover
        visible={walletModalOpen}
        anchorTop={walletAnchorTop}
        onClose={() => setWalletModalOpen(false)}
        testID="home-wallet-popover"
      />
    </SafeAreaView>
  );
}

// Phase 7.9: theme 連動 styles factory (useThemedStyles から呼ばれる)
function makeStyles(c: ThemeColors) {
  return StyleSheet.create({
    safe: {
      flex: 1,
      backgroundColor: c.bgPrimary,
    },
    // Row 1: Seasonals | toggle pill | wallet drink
    row1: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: SPACE.lg,
      paddingBottom: SPACE.xs,
    },
    row1Right: {
      flexDirection: "row",
      alignItems: "center",
      gap: SPACE.sm,
    },
    brand: {
      // Pacifico — per-screen brand wordmark。color は inline で active theme logo を上書き
      fontFamily: FONT.script,
      fontSize: 32,
      color: c.sodaText,
      lineHeight: 44,
      includeFontPadding: false,
    },
    // Row 2: Month label | Open Menu →
    row2: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: SPACE.lg,
      paddingTop: SPACE.sm,
      paddingBottom: SPACE.sm,
    },
    monthLabelRow: {
      flexDirection: "row",
      alignItems: "baseline",
      gap: 8,
    },
    monthLabelMonth: {
      fontSize: FONT_SIZE.displayMD,
      fontFamily: FONT.heading,
      fontWeight: WEIGHT.bold,
      color: c.textPrimary,
    },
    monthLabelYear: {
      fontSize: FONT_SIZE.bodyLG,
      fontFamily: FONT.heading,
      fontWeight: WEIGHT.regular,
      color: c.textMuted,
    },
    menuBtn: {
      paddingHorizontal: SPACE.md,
      paddingVertical: SPACE.xs + 2,
      borderRadius: RADIUS.pill,
      backgroundColor: withAlpha(c.sodaLight, 0.7),
    },
    menuBtnText: {
      fontSize: FONT_SIZE.bodyMD,
      fontFamily: FONT.heading,
      fontWeight: WEIGHT.semibold,
      color: c.sodaText,
    },
    bodyWrap: {
      flex: 1,
      paddingTop: SPACE.xs,
    },
    // Phase 5B.1: mascot は collapsed sheet (25%) のすぐ上に配置、展開時は sheet が overlap
    mascotWrap: {
      position: "absolute",
      left: 0,
      right: 0,
      bottom: Dimensions.get("window").height * 0.25 + 8,
      alignItems: "center",
    },
    mascotImage: {
      width: Math.min(280, Dimensions.get("window").width * 0.7),
      height: 180,
      opacity: 0.92,
    },
  });
}
