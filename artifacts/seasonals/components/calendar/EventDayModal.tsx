/**
 * EventDayModal — 特定日 tap 時の event 詳細 bottom sheet (CLAUDE.md §32.2 "one tap")
 *
 * @gorhom/bottom-sheet の BottomSheetModal で gesture pull / backdrop / snap points
 * 対応の native sheet。calendar day cell tap → present()、close → dismiss()。
 *
 * 親の visible boolean を imperative present/dismiss にブリッジして、API を
 * シンプルに保つ。
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import {
  BottomSheetBackdrop,
  BottomSheetModal,
  BottomSheetScrollView,
  // 8.86: 素の RN TextInput だと sheet の keyboard 追従 (keyboardBehavior) が
  // 発動しない — focus 検知が BottomSheetTextInput 経由のため
  BottomSheetTextInput,
  type BottomSheetBackdropProps,
} from "@gorhom/bottom-sheet";
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
  PositionCategory,
  TimeEventCategory,
  Urgency,
  type ActionDescriptor,
  type CustomEvent,
  type UnifiedTimeEvent,
} from "@workspace/lib/types";

import { DropletMarker } from "./DropletMarker";
import {
  dropletShapeForEvent,
  eventDirectionLabel,
  eventHeadline,
  sortEventsByUrgency,
} from "./event-display";
import {
  dateKey,
  useCustomEventsForDay,
  useCustomEventsStore,
} from "../../services/customEventsStore";
import {
  useThemeColors,
  useThemedStyles,
  type ThemeColors,
} from "../../stores/theme";
import { useSafeAreaInsets } from "react-native-safe-area-context";

const CATEGORY_LABELS: Record<TimeEventCategory, string> = {
  [TimeEventCategory.Maturity]: "Maturity",
  [TimeEventCategory.Epoch]: "Epoch",
  [TimeEventCategory.Claim]: "Claim",
  [TimeEventCategory.Health]: "Health",
  [TimeEventCategory.VestingCliff]: "Vesting cliff",
  [TimeEventCategory.VoteDeadline]: "Vote deadline",
  [TimeEventCategory.LockupEnd]: "Lockup end",
  [TimeEventCategory.ForecastMarker]: "Forecast",
};

// Phase 8.0: urgency 配色は active theme と連動。caller が themeColors を渡す。
function urgencyBg(c: ThemeColors, u: Urgency): string {
  switch (u) {
    case Urgency.Info:
      return withAlpha(c.sodaText, 0.18);
    case Urgency.Watch:
      return withAlpha(c.caramel, 0.18);
    case Urgency.Critical:
      return withAlpha(c.cherryDark, 0.2);
  }
}

function urgencyFg(c: ThemeColors, u: Urgency): string {
  switch (u) {
    case Urgency.Info:
      return c.sodaText;
    case Urgency.Watch:
      return c.caramel;
    case Urgency.Critical:
      return c.cherryDark;
  }
}

export interface EventDayModalProps {
  visible: boolean;
  day: Date | null;
  events: UnifiedTimeEvent[];
  onClose: () => void;
  onActionPress: (event: UnifiedTimeEvent, action: ActionDescriptor) => void;
  testID?: string;
}

function Backdrop(props: BottomSheetBackdropProps) {
  return (
    <BottomSheetBackdrop
      {...props}
      appearsOnIndex={0}
      disappearsOnIndex={-1}
      opacity={0.45}
    />
  );
}

export function EventDayModal({
  visible,
  day,
  events,
  onClose,
  onActionPress,
  testID,
}: EventDayModalProps) {
  // Phase 8.0: theme 連動 styles
  const styles = useThemedStyles(makeStyles);
  // 8.45: edge-to-edge の下端 inset
  const insets = useSafeAreaInsets();

  const ref = useRef<BottomSheetModal>(null);
  const snapPoints = useMemo(() => ["55%", "90%"], []);

  // visible boolean を imperative present/dismiss にブリッジ
  useEffect(() => {
    if (visible) ref.current?.present();
    else ref.current?.dismiss();
  }, [visible]);

  const handleChange = useCallback(
    (index: number) => {
      // dismiss (index=-1) 時に親の visible を false にする
      if (index === -1) onClose();
    },
    [onClose]
  );

  return (
    <BottomSheetModal
      ref={ref}
      // v5 は default true — content 高さ snap が混ざるため数値 snapPoints を優先
      enableDynamicSizing={false}
      snapPoints={snapPoints}
      index={0}
      onChange={handleChange}
      backdropComponent={Backdrop}
      backgroundStyle={styles.bg}
      handleIndicatorStyle={styles.grabber}
      enablePanDownToClose
      // 8.86: キーボードが custom event の入力欄を隠す対策。edge-to-edge
      // (decorFitsSystemWindows=false) では manifest の adjustResize が効かない
      // ため、sheet 自身の keyboard 追従が唯一の手段。extend = sheet を
      // キーボードの上まで引き上げる / blur で元の位置に戻す
      keyboardBehavior="extend"
      keyboardBlurBehavior="restore"
      android_keyboardInputMode="adjustResize"
    >
      <View style={styles.header}>
        <View>
          <Text style={styles.headerLabel}>Selected day</Text>
          <Text style={styles.headerDate}>
            {day ? format(day, "yyyy/MM/dd (EEE)") : "—"}
          </Text>
        </View>
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

      {/* 8.45 (edge-to-edge): この sheet は SafeArea 外の BottomSheetModalProvider が
          宿主なので、下端 inset を自前で足さないとジェスチャーバーに潜る */}
      <BottomSheetScrollView
        contentContainerStyle={[
          styles.bodyInner,
          { paddingBottom: SPACE.xl + insets.bottom },
        ]}
      >
        {events.length === 0 ? (
          <Text style={styles.emptyText}>No protocol events</Text>
        ) : (
          // §5.3: urgency-first — critical を先頭に (8.21)
          sortEventsByUrgency(events).map((event) => (
            <EventCard
              key={event.id}
              event={event}
              onActionPress={(action) => onActionPress(event, action)}
              testID={testID ? `${testID}-event-${event.id}` : undefined}
            />
          ))
        )}

        <CustomEventsSection day={day} testID={testID} />
      </BottomSheetScrollView>
    </BottomSheetModal>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// CustomEventsSection — user 作成 marker の list + Add form
// ─────────────────────────────────────────────────────────────────────────────

function CustomEventsSection({
  day,
  testID,
}: {
  day: Date | null;
  testID?: string;
}) {
  // Phase 8.0: sub-component で theme 連動 styles
  const styles = useThemedStyles(makeStyles);
  const themeColors = useThemeColors();

  const customs = useCustomEventsForDay(day);
  const add = useCustomEventsStore((s) => s.add);
  const remove = useCustomEventsStore((s) => s.remove);

  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [emoji, setEmoji] = useState("⭐");
  const [amount, setAmount] = useState("");

  const reset = () => {
    setAdding(false);
    setTitle("");
    setEmoji("⭐");
    setAmount("");
  };

  const handleAdd = () => {
    if (!day || !title.trim()) return;
    const amt = parseFloat(amount);
    add({
      date: dateKey(day),
      title: title.trim(),
      amount_usd: Number.isFinite(amt) && amt > 0 ? amt : undefined,
      category: PositionCategory.Other,
      marker: emoji ? "emoji" : "circle",
      emoji: emoji || undefined,
    });
    reset();
  };

  return (
    <View style={styles.customSection}>
      <View style={styles.customHeader}>
        <Text style={styles.customSectionLabel}>Custom events</Text>
        {!adding && (
          <Pressable
            accessibilityRole="button"
            onPress={() => setAdding(true)}
            style={styles.customAddBtn}
            testID={testID ? `${testID}-custom-add` : undefined}
          >
            <Text style={styles.customAddBtnText}>+ Add</Text>
          </Pressable>
        )}
      </View>

      {customs.length === 0 && !adding && (
        <Text style={styles.customEmpty}>No custom events</Text>
      )}

      {customs.map((ce) => (
        <CustomRow
          key={ce.id}
          ce={ce}
          onRemove={() => remove(ce.id)}
          testID={testID ? `${testID}-custom-${ce.id}` : undefined}
        />
      ))}

      {adding && (
        <View style={styles.customForm}>
          <View style={styles.customFormRow}>
            <BottomSheetTextInput
              accessibilityLabel="emoji"
              value={emoji}
              onChangeText={setEmoji}
              maxLength={2}
              style={[styles.customInput, styles.customInputEmoji]}
              testID={testID ? `${testID}-custom-emoji` : undefined}
            />
            <BottomSheetTextInput
              accessibilityLabel="title"
              value={title}
              onChangeText={setTitle}
              placeholder="Title (e.g., tax memo)"
              placeholderTextColor={themeColors.textMuted}
              style={[styles.customInput, styles.customInputTitle]}
              testID={testID ? `${testID}-custom-title` : undefined}
            />
          </View>
          <BottomSheetTextInput
            accessibilityLabel="amount usd"
            value={amount}
            onChangeText={setAmount}
            placeholder="USD amount (optional)"
            placeholderTextColor={themeColors.textMuted}
            keyboardType="decimal-pad"
            style={styles.customInput}
            testID={testID ? `${testID}-custom-amount` : undefined}
          />
          <View style={styles.customFormCtaRow}>
            <Pressable
              accessibilityRole="button"
              onPress={reset}
              style={[styles.customFormBtn, styles.customFormBtnSecondary]}
            >
              <Text style={styles.customFormBtnSecondaryText}>Cancel</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={handleAdd}
              disabled={!title.trim()}
              style={[
                styles.customFormBtn,
                styles.customFormBtnPrimary,
                !title.trim() && styles.customFormBtnDisabled,
              ]}
              testID={testID ? `${testID}-custom-save` : undefined}
            >
              <Text style={styles.customFormBtnPrimaryText}>Save</Text>
            </Pressable>
          </View>
        </View>
      )}
    </View>
  );
}

function CustomRow({
  ce,
  onRemove,
  testID,
}: {
  ce: CustomEvent;
  onRemove: () => void;
  testID?: string;
}) {
  // Phase 8.0: sub-component で theme 連動 styles
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.customRow} testID={testID}>
      <Text style={styles.customRowEmoji}>
        {ce.marker === "emoji" && ce.emoji ? ce.emoji : "⭐"}
      </Text>
      <View style={styles.customRowMain}>
        <Text style={styles.customRowTitle}>{ce.title}</Text>
        {ce.amount_usd != null && (
          <Text style={styles.customRowAmount}>
            ${ce.amount_usd.toFixed(2)}
          </Text>
        )}
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Delete custom event"
        onPress={onRemove}
        hitSlop={8}
        style={styles.customRowDelete}
        testID={testID ? `${testID}-delete` : undefined}
      >
        <Text style={styles.customRowDeleteText}>✕</Text>
      </Pressable>
    </View>
  );
}

function EventCard({
  event,
  onActionPress,
  testID,
}: {
  event: UnifiedTimeEvent;
  onActionPress: (action: ActionDescriptor) => void;
  testID?: string;
}) {
  // Phase 8.0: sub-component で theme 連動 styles + urgency 配色
  const styles = useThemedStyles(makeStyles);
  const themeColors = useThemeColors();
  // Phase 8.16: tx 履歴イベントは deposit_history 形状 + "Deposit"/"Withdraw" ラベル
  const headline = eventHeadline(event);
  return (
    <View style={styles.eventCard} testID={testID}>
      <View style={styles.eventHeader}>
        <DropletMarker
          category={dropletShapeForEvent(event)}
          urgency={event.urgency}
          size={18}
        />
        <View style={styles.eventTitle}>
          <Text style={styles.eventProtocol}>{event.protocol}</Text>
          <Text style={styles.eventCategory}>
            {eventDirectionLabel(event) ?? CATEGORY_LABELS[event.category]}
          </Text>
        </View>
        <View
          style={[
            styles.urgencyBadge,
            { backgroundColor: urgencyBg(themeColors, event.urgency) },
          ]}
        >
          <Text
            style={[
              styles.urgencyBadgeText,
              { color: urgencyFg(themeColors, event.urgency) },
            ]}
          >
            {event.urgency}
          </Text>
        </View>
      </View>

      {/* Phase 8.16: BFF 由来の headline ("Deposited 1.5 jlUSDC on Jupiter Lend" 等) */}
      {headline && (
        <Text
          style={styles.eventHeadline}
          numberOfLines={2}
          testID={testID ? `${testID}-headline` : undefined}
        >
          {headline}
        </Text>
      )}

      {event.actions.length > 0 && (
        <View style={styles.actionRow}>
          {event.actions.map((action) => (
            <Pressable
              key={action.actionType}
              accessibilityRole="button"
              onPress={() => onActionPress(action)}
              style={[
                styles.actionBtn,
                action.riskLevel === "high" && styles.actionBtnRisky,
              ]}
              testID={
                testID ? `${testID}-action-${action.actionType}` : undefined
              }
            >
              <Text
                style={[
                  styles.actionBtnText,
                  action.riskLevel === "high" && styles.actionBtnRiskyText,
                ]}
              >
                {action.label}
              </Text>
            </Pressable>
          ))}
        </View>
      )}
    </View>
  );
}

// Phase 8.0: theme 連動 styles factory。straw/strawDark/cherry は palette 外 → 静的。
function makeStyles(c: ThemeColors) {
  return StyleSheet.create({
    bg: {
      backgroundColor: c.bgPrimary,
      borderTopLeftRadius: RADIUS.xl,
      borderTopRightRadius: RADIUS.xl,
    },
    grabber: {
      width: 44,
      height: 4,
      borderRadius: 2,
      backgroundColor: c.borderStrong,
    },
    header: {
      flexDirection: "row",
      alignItems: "flex-start",
      justifyContent: "space-between",
      paddingHorizontal: SPACE.md,
      paddingTop: SPACE.sm,
      paddingBottom: SPACE.sm,
      marginBottom: SPACE.sm,
      borderBottomWidth: 1,
      borderBottomColor: c.divider,
    },
    headerLabel: {
      fontSize: FONT_SIZE.caption,
      fontFamily: FONT.body,
      fontWeight: WEIGHT.medium,
      color: c.textMuted,
      textTransform: "uppercase",
      letterSpacing: 1,
    },
    headerDate: {
      fontSize: FONT_SIZE.headingMD,
      fontFamily: FONT.heading,
      fontWeight: WEIGHT.bold,
      color: c.textPrimary,
    },
    closeBtn: {
      width: 32,
      height: 32,
      borderRadius: RADIUS.pill,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: withAlpha(c.textMuted, 0.12),
    },
    closeIcon: {
      fontSize: 16,
      color: c.textSubtitle,
      fontWeight: WEIGHT.bold,
    },
    bodyInner: {
      paddingHorizontal: SPACE.md,
      paddingBottom: SPACE.xl,
      gap: SPACE.sm,
    },
    emptyText: {
      fontSize: FONT_SIZE.bodyMD,
      color: c.textMuted,
      textAlign: "center",
      paddingVertical: SPACE.xl,
    },
    eventCard: {
      paddingHorizontal: SPACE.md,
      paddingVertical: SPACE.md,
      borderRadius: RADIUS.lg,
      backgroundColor: c.bgCard,
      borderWidth: 1,
      borderColor: c.border,
      gap: SPACE.sm,
    },
    eventHeader: {
      flexDirection: "row",
      alignItems: "center",
      gap: SPACE.sm,
    },
    eventTitle: {
      flex: 1,
      gap: 2,
    },
    eventProtocol: {
      fontSize: FONT_SIZE.bodyLG,
      fontFamily: FONT.heading,
      fontWeight: WEIGHT.bold,
      color: c.textPrimary,
      textTransform: "capitalize",
    },
    eventCategory: {
      fontSize: FONT_SIZE.bodySM,
      fontFamily: FONT.body,
      color: c.textSubtitle,
    },
    // Phase 8.16: BFF headline ("Deposited 1.5 jlUSDC on Jupiter Lend" 等)
    eventHeadline: {
      marginTop: SPACE.xs,
      fontSize: FONT_SIZE.bodySM,
      fontFamily: FONT.body,
      color: c.textSubtitle,
    },
    urgencyBadge: {
      paddingHorizontal: SPACE.sm,
      paddingVertical: 2,
      borderRadius: RADIUS.sm,
    },
    urgencyBadgeText: {
      fontSize: FONT_SIZE.overline,
      fontFamily: FONT.body,
      fontWeight: WEIGHT.bold,
      textTransform: "uppercase",
      letterSpacing: 0.5,
    },
    actionRow: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: SPACE.xs,
      marginTop: SPACE.xs,
    },
    actionBtn: {
      paddingHorizontal: SPACE.md,
      paddingVertical: SPACE.sm,
      borderRadius: RADIUS.md,
      backgroundColor: c.sodaText,
    },
    actionBtnText: {
      fontSize: FONT_SIZE.bodyMD,
      fontFamily: FONT.heading,
      fontWeight: WEIGHT.semibold,
      color: c.textOnColor,
    },
    actionBtnRisky: {
      backgroundColor: c.cherryDark,
    },
    actionBtnRiskyText: {
      color: c.textOnColor,
    },
    customSection: {
      marginTop: SPACE.md,
      paddingTop: SPACE.md,
      borderTopWidth: 1,
      borderTopColor: c.divider,
      gap: SPACE.sm,
    },
    customHeader: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
    },
    customSectionLabel: {
      fontSize: FONT_SIZE.overline,
      fontFamily: FONT.body,
      fontWeight: WEIGHT.bold,
      color: c.textMuted,
      textTransform: "uppercase",
      letterSpacing: 1,
    },
    customAddBtn: {
      paddingHorizontal: SPACE.sm,
      paddingVertical: 4,
      borderRadius: RADIUS.pill,
      backgroundColor: withAlpha(c.sodaText, 0.1),
      borderWidth: 1,
      borderColor: withAlpha(c.sodaText, 0.3),
    },
    customAddBtnText: {
      fontSize: FONT_SIZE.caption,
      fontFamily: FONT.heading,
      fontWeight: WEIGHT.bold,
      color: c.sodaText,
    },
    customEmpty: {
      fontSize: FONT_SIZE.bodySM,
      fontFamily: FONT.body,
      color: c.textMuted,
      textAlign: "center",
      paddingVertical: SPACE.sm,
    },
    customRow: {
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: SPACE.sm,
      paddingVertical: SPACE.sm,
      borderRadius: RADIUS.md,
      backgroundColor: withAlpha(COLOR.straw, 0.15),
      borderWidth: 1,
      borderColor: withAlpha(COLOR.strawDark, 0.4),
      gap: SPACE.sm,
    },
    customRowEmoji: {
      fontSize: 22,
    },
    customRowMain: {
      flex: 1,
    },
    customRowTitle: {
      fontSize: FONT_SIZE.bodyMD,
      fontFamily: FONT.heading,
      fontWeight: WEIGHT.semibold,
      color: c.textPrimary,
    },
    customRowAmount: {
      fontSize: FONT_SIZE.caption,
      fontFamily: FONT.body,
      color: c.textSubtitle,
    },
    customRowDelete: {
      width: 28,
      height: 28,
      borderRadius: 14,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: withAlpha(c.cherryDark, 0.15),
    },
    customRowDeleteText: {
      fontSize: 14,
      color: c.cherryDark,
      fontWeight: WEIGHT.bold,
    },
    customForm: {
      paddingHorizontal: SPACE.sm,
      paddingVertical: SPACE.sm,
      borderRadius: RADIUS.md,
      backgroundColor: withAlpha(c.sodaLight, 0.4),
      borderWidth: 1,
      borderColor: c.border,
      gap: SPACE.sm,
    },
    customFormRow: {
      flexDirection: "row",
      gap: SPACE.sm,
    },
    customInput: {
      paddingHorizontal: SPACE.sm,
      paddingVertical: SPACE.xs,
      borderRadius: RADIUS.sm,
      backgroundColor: c.bgPrimary,
      borderWidth: 1,
      borderColor: c.border,
      fontSize: FONT_SIZE.bodyMD,
      fontFamily: FONT.body,
      color: c.textPrimary,
    },
    customInputEmoji: {
      width: 56,
      textAlign: "center",
      fontSize: 20,
    },
    customInputTitle: {
      flex: 1,
    },
    customFormCtaRow: {
      flexDirection: "row",
      gap: SPACE.sm,
    },
    customFormBtn: {
      flex: 1,
      paddingVertical: SPACE.sm,
      borderRadius: RADIUS.md,
      alignItems: "center",
      justifyContent: "center",
    },
    customFormBtnPrimary: {
      backgroundColor: c.sodaText,
    },
    customFormBtnPrimaryText: {
      fontSize: FONT_SIZE.bodyMD,
      fontFamily: FONT.heading,
      fontWeight: WEIGHT.bold,
      color: c.textOnColor,
    },
    customFormBtnSecondary: {
      backgroundColor: "transparent",
      borderWidth: 1,
      borderColor: c.borderStrong,
    },
    customFormBtnSecondaryText: {
      fontSize: FONT_SIZE.bodyMD,
      fontFamily: FONT.heading,
      fontWeight: WEIGHT.semibold,
      color: c.textSubtitle,
    },
    customFormBtnDisabled: {
      opacity: 0.5,
    },
  });
}
