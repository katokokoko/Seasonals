/**
 * DailyView — 5-card carousel (Phase 5A.7 retake、prototype DailyView.tsx 準拠)
 *
 * 構造:
 *   OFFSETS [-2, -1, 0, 1, 2] の 5 cards を absolute 配置で同時 render
 *   各 card は per-card animated style で position + scale + opacity を計算
 *   tx (SharedValue) は user の drag 量を保持
 *
 * Animation (prototype 値):
 *   cardWidth = containerWidth * 0.66
 *   STEP = cardWidth * 0.7  (card center 間距離)
 *   scale interp:   dist [0, step, step*2] → [1, 0.65, 0.45]
 *   opacity interp: dist [0, step, step*2] → [1, 0.55, 0.2]
 *   center card 常に scale=1 + opacity=1 + zIndex=10 (絶対に見える)
 *
 * Gesture:
 *   activeOffsetX([-8, 8]) failOffsetY([-15, 15])
 *   onUpdate: rubber-band overshoot beyond ±MAX_TX (= step*2)
 *   onEnd: projected = tx + velocityX*0.18、step = round(-projected / STEP) clamp [-2, 2]
 *   commit:
 *     0 → withSpring(0, {damping:18, stiffness:140})
 *     ±n → re-base tx + steps*STEP、then withSpring(0, {damping:20, stiffness:160})
 *     haptic tick × min(2, |steps|) (55ms 間隔)
 *
 * Card content (Phase 5A.6 視覚維持):
 *   1px melonDeep@38% border / subtle shadow / 24px padding / verb color map
 *   absolute "Tap to open →" / 内部 ScrollView / sticky header
 *   高さは sheetPosition 由来 heightSV (5A.3 reactive height 維持)
 */

import React, { useState } from "react";
import {
  Dimensions,
  LayoutChangeEvent,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import * as Haptics from "expo-haptics";
import {
  Gesture,
  GestureDetector,
} from "react-native-gesture-handler";
import Animated, {
  Extrapolation,
  interpolate,
  runOnJS,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withSpring,
  type SharedValue,
} from "react-native-reanimated";
import { addDays, format } from "date-fns";

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
  TimeEventCategory,
  type UnifiedTimeEvent,
} from "@workspace/lib/types";

import {
  dateToIso,
  isoToDate,
  useCalendarDayStore,
} from "../../stores/calendarDay";
import {
  useThemeColors,
  useThemedStyles,
  type ThemeColors,
} from "../../stores/theme";

// 5-card strip
const OFFSETS = [-2, -1, 0, 1, 2] as const;

// 5A.3 spec verb mapping
const VERB_BY_CATEGORY: Record<TimeEventCategory, string> = {
  [TimeEventCategory.Maturity]: "matures",
  [TimeEventCategory.Claim]: "claims rewards",
  [TimeEventCategory.LockupEnd]: "unlocks",
  [TimeEventCategory.VestingCliff]: "vests",
  [TimeEventCategory.Epoch]: "epoch boundary",
  [TimeEventCategory.Health]: "health alert",
  [TimeEventCategory.VoteDeadline]: "vote due",
  [TimeEventCategory.ForecastMarker]: "expected",
};

const CATEGORY_HEADLINE: Record<TimeEventCategory, string> = {
  [TimeEventCategory.Maturity]: "Maturity",
  [TimeEventCategory.Claim]: "Claim",
  [TimeEventCategory.LockupEnd]: "Lockup",
  [TimeEventCategory.VestingCliff]: "Vesting",
  [TimeEventCategory.Epoch]: "Epoch",
  [TimeEventCategory.Health]: "Health",
  [TimeEventCategory.VoteDeadline]: "Vote",
  [TimeEventCategory.ForecastMarker]: "Forecast",
};

/**
 * Phase 5A.6.1 verb color: maturity/lockup_end → caramel, health → cherryDark, others → melonText
 * Phase 8.0: theme から派生する 3 色を直接渡して色解決。
 */
function verbColorOf(category: TimeEventCategory, c: ThemeColors): string {
  switch (category) {
    case TimeEventCategory.Maturity:
    case TimeEventCategory.LockupEnd:
      return c.caramel;
    case TimeEventCategory.Health:
      return c.cherryDark;
    case TimeEventCategory.Claim:
    case TimeEventCategory.VestingCliff:
    case TimeEventCategory.VoteDeadline:
    case TimeEventCategory.Epoch:
    case TimeEventCategory.ForecastMarker:
      return c.melonText;
  }
}

function localDayKey(day: Date): string {
  return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
}

function eventDayKey(triggerAt: UnifiedTimeEvent["triggerAt"]): string {
  const ts = triggerAt instanceof Date ? triggerAt : new Date(triggerAt);
  return `${ts.getUTCFullYear()}-${String(ts.getUTCMonth() + 1).padStart(2, "0")}-${String(ts.getUTCDate()).padStart(2, "0")}`;
}

function eventsOnDay(events: UnifiedTimeEvent[], day: Date): UnifiedTimeEvent[] {
  const key = localDayKey(day);
  return events.filter((e) => eventDayKey(e.triggerAt) === key);
}

function dayOrdinalSuffix(d: number): string {
  if (d >= 11 && d <= 13) return "th";
  switch (d % 10) {
    case 1:
      return "st";
    case 2:
      return "nd";
    case 3:
      return "rd";
    default:
      return "th";
  }
}

function tickHaptic(steps: number): void {
  if (steps === 0) return;
  if (Platform.OS === "web") return;
  const count = Math.min(2, Math.abs(steps));
  for (let i = 0; i < count; i++) {
    setTimeout(() => {
      Haptics.selectionAsync().catch(() => undefined);
    }, i * 55);
  }
}

export interface DailyViewProps {
  events: UnifiedTimeEvent[];
  /** BottomSheet animatedPosition (top からの px)。card 高さに連動 */
  sheetPosition?: SharedValue<number>;
  screenHeight?: number;
  topInset?: number;
  onSelectEvent?: (event: UnifiedTimeEvent) => void;
  onOpenDay?: (day: Date) => void;
  testID?: string;
}

export function DailyView({
  events,
  sheetPosition,
  screenHeight = Dimensions.get("window").height,
  topInset = 0,
  onSelectEvent,
  onOpenDay,
  testID,
}: DailyViewProps) {
  // Phase 8.0: theme 連動 styles
  const styles = useThemedStyles(makeStyles);

  const selectedIso = useCalendarDayStore((s) => s.selectedDate);
  const setSelectedDate = useCalendarDayStore((s) => s.setSelectedDate);

  const selectedDate = isoToDate(selectedIso);

  const [containerWidth, setContainerWidth] = useState(
    Dimensions.get("window").width
  );
  const onLayout = (e: LayoutChangeEvent) => {
    setContainerWidth(e.nativeEvent.layout.width);
  };

  const cardWidth = Math.round(containerWidth * 0.66);
  const STEP = Math.round(cardWidth * 0.7);
  const MAX_TX = STEP * 2;

  // ── Card height: BottomSheet animatedPosition に追随 (5A.3 reactive height) ──
  const HINT_RESERVE = 56;
  const MIN_HEIGHT = 180;
  const FALLBACK_HEIGHT = 360;

  const heightSV = useDerivedValue(() => {
    if (!sheetPosition) return FALLBACK_HEIGHT;
    const available = sheetPosition.value - topInset - HINT_RESERVE;
    return Math.max(MIN_HEIGHT, Math.min(available, screenHeight * 0.7));
  }, [sheetPosition, topInset, screenHeight]);

  const viewportHeightStyle = useAnimatedStyle(() => ({
    height: heightSV.value,
  }));

  // ── Pan gesture ────────────────────────────────────────────────────────
  const tx = useSharedValue(0);

  const commit = (steps: number) => {
    if (steps === 0) {
      tx.value = withSpring(0, { damping: 18, stiffness: 140 });
      return;
    }
    tickHaptic(steps);
    setSelectedDate(dateToIso(addDays(selectedDate, steps)));
    // re-base: 新中央が user release 位置に来るよう tx を ずらす → settle to 0
    tx.value = tx.value + steps * STEP;
    tx.value = withSpring(0, { damping: 20, stiffness: 160 });
  };

  const pan = Gesture.Pan()
    .activeOffsetX([-8, 8])
    .failOffsetY([-15, 15])
    .onUpdate((e) => {
      "worklet";
      const t = e.translationX;
      const abs = Math.abs(t);
      if (abs <= MAX_TX) {
        tx.value = t;
      } else {
        // rubber-band: ±2 step を超えると徐々に抵抗
        const overshoot = abs - MAX_TX;
        const resisted = MAX_TX + overshoot / (1 + overshoot / STEP);
        tx.value = Math.sign(t) * resisted;
      }
    })
    .onEnd((e) => {
      "worklet";
      const projected = e.translationX + e.velocityX * 0.18;
      let steps = Math.round(-projected / STEP);
      if (steps > 2) steps = 2;
      if (steps < -2) steps = -2;
      runOnJS(commit)(steps);
    });

  // ── Center card tap ────────────────────────────────────────────────────
  const handleCenterTap = () => {
    const dayEvents = eventsOnDay(events, selectedDate);
    if (dayEvents.length === 0) return;
    if (dayEvents.length === 1 && onSelectEvent) {
      onSelectEvent(dayEvents[0]!);
      return;
    }
    if (onOpenDay) onOpenDay(selectedDate);
  };

  return (
    <View style={styles.wrap} onLayout={onLayout} testID={testID}>
      <GestureDetector gesture={pan}>
        <Animated.View style={[styles.viewport, viewportHeightStyle]}>
          {OFFSETS.map((offset) => {
            const date = addDays(selectedDate, offset);
            const dayEvents = eventsOnDay(events, date);
            const isCenter = offset === 0;
            return (
              <DayCard
                key={offset}
                date={date}
                offsetIndex={offset}
                tx={tx}
                step={STEP}
                cardWidth={cardWidth}
                heightSV={heightSV}
                isCenter={isCenter}
                dayEvents={dayEvents}
                onPress={isCenter ? handleCenterTap : undefined}
                testID={
                  isCenter && testID ? `${testID}-card` : undefined
                }
              />
            );
          })}
        </Animated.View>
      </GestureDetector>

      <Text style={styles.hint}>Drag ← → to scrub days · tap card to open</Text>
    </View>
  );
}

interface DayCardProps {
  date: Date;
  offsetIndex: number;
  tx: SharedValue<number>;
  step: number;
  cardWidth: number;
  heightSV: SharedValue<number>;
  isCenter: boolean;
  dayEvents: UnifiedTimeEvent[];
  onPress?: () => void;
  testID?: string;
}

function DayCard({
  date,
  offsetIndex,
  tx,
  step,
  cardWidth,
  heightSV,
  isCenter,
  dayEvents,
  onPress,
  testID,
}: DayCardProps) {
  // Phase 8.0: sub-component が parent の styles を参照していたので自身で取得
  const styles = useThemedStyles(makeStyles);

  const zIndex = isCenter ? 10 : 5 - Math.abs(offsetIndex);

  const animStyle = useAnimatedStyle(() => {
    const visual = offsetIndex * step + tx.value;
    const dist = Math.abs(visual);
    const scale = interpolate(
      dist,
      [0, step, step * 2],
      [1, 0.65, 0.45],
      Extrapolation.CLAMP
    );
    const opacity = interpolate(
      dist,
      [0, step, step * 2],
      [1, 0.55, 0.2],
      Extrapolation.CLAMP
    );
    return {
      position: "absolute",
      left: "50%",
      top: 0,
      width: cardWidth,
      height: heightSV.value,
      transform: [
        { translateX: -cardWidth / 2 + visual },
        { scale },
      ],
      opacity,
      zIndex,
    };
  });

  return (
    <Animated.View style={animStyle}>
      <Pressable
        onPress={onPress}
        disabled={!isCenter}
        style={({ pressed }) => [
          styles.card,
          pressed && isCenter && styles.cardPressed,
        ]}
        testID={testID}
      >
        <DayCardContent date={date} dayEvents={dayEvents} compact={!isCenter} />
      </Pressable>
    </Animated.View>
  );
}

interface DayCardContentProps {
  date: Date;
  dayEvents: UnifiedTimeEvent[];
  compact?: boolean;
}

function DayCardContent({ date, dayEvents, compact }: DayCardContentProps) {
  // Phase 8.0: sub-component が parent の styles を参照していたので自身で取得
  const styles = useThemedStyles(makeStyles);
  const themeColors = useThemeColors();
  const dayNum = date.getDate();
  const ordinalLabel = `${dayNum}${dayOrdinalSuffix(dayNum)}`;
  const subtitle = `${format(date, "EEEE")} · ${format(date, "MMM yyyy")}`;

  return (
    <View style={styles.cardInner}>
      {/* Sticky top: 日数 + date subtitle */}
      <View style={styles.cardHeader}>
        <Text style={styles.dayNum}>{ordinalLabel}</Text>
        <Text
          style={styles.dateSubtitle}
          numberOfLines={1}
          ellipsizeMode="tail"
        >
          {subtitle}
        </Text>
      </View>

      {/* Middle: events list (vertical scroll if overflow) */}
      {dayEvents.length === 0 ? (
        <View style={styles.emptyWrap}>
          <Text style={styles.emptyText}>No events</Text>
        </View>
      ) : (
        <ScrollView
          style={styles.eventsScroll}
          contentContainerStyle={styles.eventsScrollContent}
          showsVerticalScrollIndicator={false}
          nestedScrollEnabled
          scrollEnabled={!compact}
        >
          {dayEvents.map((e, idx) => (
            <View
              key={e.id}
              style={[
                styles.eventRow,
                idx > 0 && styles.eventRowDivider,
              ]}
            >
              <View style={styles.protocolIcon}>
                <Text style={styles.protocolLetter}>
                  {e.protocol.charAt(0).toUpperCase()}
                </Text>
              </View>
              <View style={styles.eventMain}>
                <Text style={styles.eventName} numberOfLines={1}>
                  {capitalize(e.protocol)}
                </Text>
                <Text
                  style={[styles.eventVerb, { color: verbColorOf(e.category, themeColors) }]}
                  numberOfLines={1}
                >
                  {VERB_BY_CATEGORY[e.category]} ·{" "}
                  {CATEGORY_HEADLINE[e.category]}
                </Text>
              </View>
            </View>
          ))}
        </ScrollView>
      )}

      {/* Sticky bottom-right: Tap to open → */}
      {!compact && dayEvents.length > 0 && (
        <View style={styles.tapToOpenAbsolute} pointerEvents="none">
          <Text style={styles.tapToOpen}>Tap to open →</Text>
        </View>
      )}
    </View>
  );
}

function capitalize(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Phase 8.0: theme 連動 styles factory。melonDeep / shadow は palette 外なので static。
function makeStyles(c: ThemeColors) {
  return StyleSheet.create({
    wrap: {
      flex: 1,
      paddingTop: SPACE.md,
      alignItems: "center",
    },
    viewport: {
      width: "100%",
      position: "relative",
    },
    card: {
      flex: 1,
      borderRadius: 16,
      borderWidth: 1,
      borderColor: withAlpha(COLOR.melonDeep, 0.38),
      backgroundColor: c.bgPrimary,
      shadowColor: COLOR.shadow,
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.04,
      shadowRadius: 8,
      elevation: 2,
      overflow: "hidden",
    },
    cardPressed: {
      opacity: 0.85,
    },
    cardInner: {
      flex: 1,
      paddingHorizontal: 24,
      paddingTop: 24,
      paddingBottom: 24,
    },
    cardHeader: {
      gap: 2,
    },
    dayNum: {
      fontSize: 40,
      fontFamily: FONT.heading,
      fontWeight: WEIGHT.bold,
      color: c.textPrimary,
      lineHeight: 44,
      includeFontPadding: false,
    },
    dateSubtitle: {
      marginTop: 2,
      fontSize: FONT_SIZE.bodyMD,
      fontFamily: FONT.heading,
      fontWeight: WEIGHT.medium,
      color: c.textSubtitle,
    },
    eventsScroll: {
      flex: 1,
      marginTop: SPACE.md,
    },
    eventsScrollContent: {
      paddingBottom: 32,
    },
    eventRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: SPACE.sm,
      paddingVertical: SPACE.sm,
    },
    eventRowDivider: {
      borderTopWidth: 1,
      borderTopColor: c.divider,
    },
    protocolIcon: {
      width: 40,
      height: 40,
      borderRadius: RADIUS.md,
      backgroundColor: c.melonText,
      alignItems: "center",
      justifyContent: "center",
    },
    protocolLetter: {
      fontSize: FONT_SIZE.headingMD,
      fontFamily: FONT.heading,
      fontWeight: WEIGHT.bold,
      color: c.textOnColor,
    },
    eventMain: {
      flex: 1,
      gap: 2,
    },
    eventName: {
      fontSize: FONT_SIZE.bodyMD,
      fontFamily: FONT.heading,
      fontWeight: WEIGHT.bold,
      color: c.textPrimary,
    },
    eventVerb: {
      fontSize: FONT_SIZE.bodySM,
      fontFamily: FONT.heading,
      fontWeight: WEIGHT.semibold,
    },
    emptyWrap: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      paddingVertical: SPACE.xl,
    },
    emptyText: {
      fontSize: FONT_SIZE.bodyMD,
      fontFamily: FONT.heading,
      fontWeight: WEIGHT.semibold,
      color: c.textMuted,
    },
    tapToOpenAbsolute: {
      position: "absolute",
      right: 24,
      bottom: 24,
    },
    tapToOpen: {
      fontSize: FONT_SIZE.bodyMD,
      fontFamily: FONT.heading,
      fontWeight: WEIGHT.semibold,
      color: c.sodaText,
    },
    hint: {
      marginTop: SPACE.md,
      fontSize: FONT_SIZE.caption,
      fontFamily: FONT.body,
      color: c.textMuted,
      textAlign: "center",
    },
  });
}
