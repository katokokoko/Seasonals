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
  COLOR,
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
import { ActionModal } from "../components/action/ActionModal";
import { PortfolioSummary } from "../components/portfolio/PortfolioSummary";
import { SettingsDrawer } from "../components/drawer/SettingsDrawer";
import { MenuDrawer } from "../components/drawer/MenuDrawer";
import { ViewModeTogglePill } from "../components/header/ViewModeTogglePill";
import { WalletDrinkButton } from "../components/header/WalletDrinkButton";
import { WalletPopover } from "../components/wallet/WalletPopover";
import { useAllCustomEvents } from "../services/customEventsStore";
import {
  useAgentPlans,
  usePositions,
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

// MVP fixed reference date (CLAUDE.md auto-memory currentDate と整合)。
const MOCK_TODAY = new Date("2026-05-09T00:00:00.000Z");

export default function HomeScreen() {
  const [selectedDay, setSelectedDay] = useState<Date | null>(null);
  const [dayModalOpen, setDayModalOpen] = useState(false);
  const [pendingPlan, setPendingPlan] = useState<AgentPlan | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [servicesOpen, setServicesOpen] = useState(false);
  const [walletModalOpen, setWalletModalOpen] = useState(false);

  const insets = useSafeAreaInsets();

  const { data: events = [] } = useTimeEvents();
  const { data: positions = [] } = usePositions();
  const { data: protocols = [] } = useProtocols();
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
  const handleStartActionFromServices = (
    protocol: string,
    asset: string,
    _actionType: "deposit"
  ) => {
    const target = plans.find(
      (p) =>
        p.selected_action?.protocol === protocol &&
        p.selected_action?.asset === asset &&
        (p.status === AgentPlanStatus.Simulated ||
          p.status === AgentPlanStatus.PendingUser)
    );
    const fallback = plans.find(
      (p) =>
        p.status === AgentPlanStatus.Simulated ||
        p.status === AgentPlanStatus.PendingUser
    );
    setPendingPlan(target ?? fallback ?? null);
  };

  const dayEvents = selectedDay
    ? events.filter((e) => {
        const ts = e.triggerAt instanceof Date
          ? e.triggerAt
          : new Date(e.triggerAt);
        return (
          ts.getFullYear() === selectedDay.getFullYear() &&
          ts.getMonth() === selectedDay.getMonth() &&
          ts.getDate() === selectedDay.getDate()
        );
      })
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

  return (
    <SafeAreaView style={styles.safe} edges={["bottom"]}>
      {/* Row 1: Seasonals | toggle pill | wallet drink */}
      <View style={[styles.row1, { paddingTop: topPad }]}>
        <Pressable
          accessibilityRole="button"
          onPress={() => setSettingsOpen(true)}
          hitSlop={8}
          testID="home-brand"
        >
          <Text style={styles.brand}>Seasonals</Text>
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
              today={MOCK_TODAY}
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
      <PortfolioSummary
        positions={positions}
        protocols={protocols}
        today={MOCK_TODAY}
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

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: COLOR.bgPrimary,
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
    // Pacifico — per-screen brand wordmark (CLAUDE.md §6 brand-only) sodaText for Home
    fontFamily: FONT.script,
    fontSize: 32,
    color: COLOR.sodaText,
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
    color: COLOR.textPrimary,
  },
  monthLabelYear: {
    fontSize: FONT_SIZE.bodyLG,
    fontFamily: FONT.heading,
    fontWeight: WEIGHT.regular,
    color: COLOR.textMuted,
  },
  menuBtn: {
    paddingHorizontal: SPACE.md,
    paddingVertical: SPACE.xs + 2,
    borderRadius: RADIUS.pill,
    backgroundColor: withAlpha(COLOR.sodaLight, 0.7),
  },
  menuBtnText: {
    fontSize: FONT_SIZE.bodyMD,
    fontFamily: FONT.heading,
    fontWeight: WEIGHT.semibold,
    color: COLOR.sodaText,
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
