/**
 * ViewModeTogglePill — home Row 1 中央の monthly/daily 切替 (Phase 5A.1 / 5A.2)
 *
 * 構造: 1 つの pill 内に grid icon + phone icon の 2 つだけ。drink button は外側に
 * 別の circular button として置く (prototype `header.png` 準拠)。
 *
 * Active visual:    sodaLight bg + sodaText icon
 * Inactive visual:  transparent + textSubtitle icon
 */

import React from "react";
import { Pressable, StyleSheet, View } from "react-native";

import {
  COLOR,
  RADIUS,
  SPACE,
  withAlpha,
} from "@workspace/lib/design-system";

import { GridIcon, PhoneIcon } from "../icons/HeaderIcons";
import {
  useCalendarViewStore,
  type CalendarViewMode,
} from "../../stores/calendarView";

export interface ViewModeTogglePillProps {
  testID?: string;
}

export function ViewModeTogglePill({ testID }: ViewModeTogglePillProps) {
  const viewMode = useCalendarViewStore((s) => s.viewMode);
  const setViewMode = useCalendarViewStore((s) => s.setViewMode);

  return (
    <View style={styles.pill} testID={testID}>
      <ToggleSlot
        active={viewMode === "monthly"}
        onPress={() => setViewMode("monthly")}
        accessibilityLabel="Monthly view"
        testID={testID ? `${testID}-monthly` : undefined}
      >
        <GridIcon
          size={18}
          color={viewMode === "monthly" ? COLOR.sodaText : COLOR.textSubtitle}
        />
      </ToggleSlot>
      <ToggleSlot
        active={viewMode === "daily"}
        onPress={() => setViewMode("daily")}
        accessibilityLabel="Daily view"
        testID={testID ? `${testID}-daily` : undefined}
      >
        <PhoneIcon
          size={18}
          color={viewMode === "daily" ? COLOR.sodaText : COLOR.textSubtitle}
        />
      </ToggleSlot>
    </View>
  );
}

interface ToggleSlotProps {
  active: boolean;
  onPress: () => void;
  accessibilityLabel: string;
  testID?: string;
  children: React.ReactNode;
}

function ToggleSlot({
  active,
  onPress,
  accessibilityLabel,
  testID,
  children,
}: ToggleSlotProps) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={[styles.slot, active && styles.slotActive]}
      hitSlop={6}
      testID={testID}
    >
      {children}
    </Pressable>
  );
}

/** test 用に viewMode を読み出すためのヘルパ (test では別 export を直接 import 推奨) */
export type { CalendarViewMode };

const styles = StyleSheet.create({
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 6,
    paddingVertical: 4,
    borderRadius: RADIUS.pill,
    backgroundColor: withAlpha(COLOR.bgSecondary, 0.7),
    borderWidth: 1,
    borderColor: COLOR.border,
  },
  slot: {
    width: 32,
    height: 28,
    borderRadius: RADIUS.pill,
    alignItems: "center",
    justifyContent: "center",
  },
  slotActive: {
    backgroundColor: COLOR.sodaLight,
  },
});
