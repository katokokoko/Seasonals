/**
 * MCPClientApprovalCard — 仕様書 §8.6 (in-app inline approval card)
 *
 * Calendar / Action 画面に inline で並ぶ compact card。Agent 提案を
 * **アプリを開いている時** に確認するための要約表示 + 1-tap approve。
 *
 * 設計原則:
 * - compact (高さ 1/3 ほど)、複数並ぶことを前提
 * - oracle 乖離は subtle indicator のみ (full warning は MCPApprovalPushCard 側)
 * - CTA は「実行」「詳細」の 2 種。reject は詳細 sheet または PushCard で扱う
 * - approve は services/queries の useApproveAgentPlan mutation 経由 (component から
 *   直接 fetch は禁止 / CLAUDE.md §5)
 *
 * @see CLAUDE.md §5 (services 経由 / TanStack Query 経由)
 * @see CLAUDE.md §32.2 (one tap / policy-aware execution)
 */

import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

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
  TOKEN_DECIMALS,
  formatPercentage,
  toHumanReadable,
} from "@workspace/lib/utils/numeric";
import {
  AgentPlanStatus,
  type AgentPlan,
} from "@workspace/lib/types";

import { useApproveAgentPlan } from "../../services/queries";

// ─────────────────────────────────────────────────────────────────────────────
// 共有定数
// ─────────────────────────────────────────────────────────────────────────────

/** approve 可能な status (§11.7) */
const APPROVABLE_STATUSES: ReadonlyArray<AgentPlanStatus> = [
  AgentPlanStatus.Simulated,
  AgentPlanStatus.PendingUser,
];

/** asset_symbol から decimals を解決 (table 未登録時は 6 を fallback) */
function resolveDecimals(asset?: string): number {
  if (asset && asset in TOKEN_DECIMALS) {
    return (TOKEN_DECIMALS as Record<string, number>)[asset]!;
  }
  return 6;
}

// ─────────────────────────────────────────────────────────────────────────────
// Props
// ─────────────────────────────────────────────────────────────────────────────

export interface MCPClientApprovalCardProps {
  /** 対象 AgentPlan (selected_action / simulation_result が埋まっている前提) */
  plan: AgentPlan;
  /** 詳細 sheet を開く callback (PushCard / 別 sheet を host が出す) */
  onPressDetail?: () => void;
  /** approve 成功時の callback */
  onApproveSuccess?: (updated: AgentPlan) => void;
  /** approve 失敗時の callback */
  onApproveError?: (error: Error) => void;
  testID?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export function MCPClientApprovalCard({
  plan,
  onPressDetail,
  onApproveSuccess,
  onApproveError,
  testID,
}: MCPClientApprovalCardProps) {
  const approve = useApproveAgentPlan();

  const action = plan.selected_action;
  const sim = plan.simulation_result;

  const isApprovable = APPROVABLE_STATUSES.includes(plan.status);
  const isBusy = approve.isPending;

  const decimals = resolveDecimals(action?.asset);
  const amountText =
    action?.amount && action.asset
      ? `${toHumanReadable(action.amount, decimals)} ${action.asset}`
      : "—";

  // candidate_actions から estimated_apy を解決 (selected_action と同じ spec のもの)
  const matchedCandidate = action
    ? plan.candidate_actions.find(
        (c) =>
          c.action_spec.action_type === action.action_type &&
          c.action_spec.protocol === action.protocol
      )
    : undefined;
  const apyText =
    matchedCandidate?.estimated_apy != null
      ? formatPercentage(matchedCandidate.estimated_apy)
      : "—";

  // §4.6 oracle 乖離 — 2-5% の warning 帯のみ subtle 表示 (>5% は execute 側で拒否)
  const divergencePct = sim?.oracle?.divergence_pct ?? 0;
  const hasOracleWarning = divergencePct >= 2 && divergencePct <= 5;

  const handleApprove = () => {
    approve.mutate(
      { plan_id: plan.plan_id },
      { onSuccess: onApproveSuccess, onError: onApproveError }
    );
  };

  const ctaDisabled = !isApprovable || isBusy;

  return (
    <View
      style={styles.container}
      accessible
      accessibilityLabel={`${action?.protocol ?? "agent"} proposal`}
      testID={testID}
    >
      <View style={styles.header}>
        <Text
          style={styles.protocolText}
          testID={testID ? `${testID}-protocol` : undefined}
        >
          {action?.protocol ?? "—"}
        </Text>
        <Text
          style={styles.actionTypeText}
          testID={testID ? `${testID}-action-type` : undefined}
        >
          {action?.action_type ?? "—"}
        </Text>
      </View>

      <View style={styles.mainRow}>
        <Text
          style={styles.amountText}
          testID={testID ? `${testID}-amount` : undefined}
        >
          {amountText}
        </Text>
        <Text
          style={styles.apyText}
          testID={testID ? `${testID}-apy` : undefined}
        >
          {apyText}
        </Text>
      </View>

      {hasOracleWarning && (
        <View
          style={styles.warningIndicator}
          testID={testID ? `${testID}-oracle-indicator` : undefined}
        >
          <Text style={styles.warningIcon}>⚠️</Text>
          <Text style={styles.warningText}>
            {`Oracle divergence ${divergencePct.toFixed(1)}%`}
          </Text>
        </View>
      )}

      <View style={styles.ctaRow}>
        <Pressable
          accessibilityRole="button"
          disabled={ctaDisabled}
          onPress={handleApprove}
          style={[
            styles.cta,
            styles.ctaApprove,
            ctaDisabled && styles.ctaDisabled,
          ]}
          testID={testID ? `${testID}-approve` : undefined}
        >
          <Text style={styles.ctaApproveText}>
            {approve.isPending ? "Executing…" : "Execute"}
          </Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          disabled={isBusy}
          onPress={onPressDetail}
          style={[
            styles.cta,
            styles.ctaSecondary,
            isBusy && styles.ctaDisabled,
          ]}
          testID={testID ? `${testID}-detail` : undefined}
        >
          <Text style={styles.ctaSecondaryText}>Details</Text>
        </Pressable>
      </View>
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    width: "100%",
    paddingHorizontal: SPACE.md,
    paddingVertical: SPACE.md,
    borderRadius: RADIUS.lg,
    backgroundColor: COLOR.bgCard,
    borderWidth: 1,
    borderColor: COLOR.border,
    gap: SPACE.sm,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: SPACE.sm,
  },
  protocolText: {
    fontSize: FONT_SIZE.headingMD,
    fontFamily: FONT.heading,
    fontWeight: WEIGHT.bold,
    color: COLOR.textPrimary,
  },
  actionTypeText: {
    fontSize: FONT_SIZE.caption,
    fontFamily: FONT.body,
    fontWeight: WEIGHT.medium,
    color: COLOR.textMuted,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  mainRow: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: SPACE.sm,
  },
  amountText: {
    flex: 1,
    fontSize: FONT_SIZE.headingLG,
    fontFamily: FONT.heading,
    fontWeight: WEIGHT.bold,
    color: COLOR.textPrimary,
  },
  apyText: {
    fontSize: FONT_SIZE.bodyMD,
    fontFamily: FONT.heading,
    fontWeight: WEIGHT.semibold,
    color: COLOR.melonText,
  },
  warningIndicator: {
    flexDirection: "row",
    alignItems: "center",
    gap: SPACE.xs,
    paddingHorizontal: SPACE.sm,
    paddingVertical: SPACE.xs,
    borderRadius: RADIUS.sm,
    backgroundColor: withAlpha(COLOR.caramel, 0.12),
    alignSelf: "flex-start",
  },
  warningIcon: {
    fontSize: 12,
    lineHeight: 16,
  },
  warningText: {
    fontSize: FONT_SIZE.caption,
    fontFamily: FONT.body,
    fontWeight: WEIGHT.medium,
    color: COLOR.caramelDark,
  },
  ctaRow: {
    flexDirection: "row",
    gap: SPACE.sm,
  },
  cta: {
    flex: 1,
    paddingHorizontal: SPACE.md,
    paddingVertical: SPACE.sm,
    borderRadius: RADIUS.md,
    alignItems: "center",
    justifyContent: "center",
    minHeight: 40,
  },
  ctaApprove: {
    backgroundColor: COLOR.sodaText,
  },
  ctaApproveText: {
    fontSize: FONT_SIZE.bodyMD,
    fontFamily: FONT.heading,
    fontWeight: WEIGHT.bold,
    color: COLOR.textOnColor,
  },
  ctaSecondary: {
    backgroundColor: "transparent",
    borderWidth: 1,
    borderColor: COLOR.borderStrong,
  },
  ctaSecondaryText: {
    fontSize: FONT_SIZE.bodyMD,
    fontFamily: FONT.heading,
    fontWeight: WEIGHT.semibold,
    color: COLOR.textSubtitle,
  },
  ctaDisabled: {
    opacity: 0.5,
  },
});
