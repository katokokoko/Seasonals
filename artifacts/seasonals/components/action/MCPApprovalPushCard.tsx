/**
 * MCPApprovalPushCard — 仕様書 §8.7 (push tap → 専用 approval screen)
 *
 * push notification の deep link を踏んで開かれる full-screen approval。
 * WarningArea を必ず内蔵し、ApprovalToken の expires_at まで count-down を出す。
 *
 * 設計原則:
 * - oracle warning は CTA 直上に強警告として表示 (WarningArea に委譲)
 * - approval_token TTL を 1 秒刻みで count-down、0 で CTA disabled
 * - approve / reject 両方を内蔵 (services/queries の mutation 経由)
 * - bundle_hash 検証は BFF 側責務、本層では行わない
 *
 * @see CLAUDE.md §5 / §32.2 (warning は素通りしない / fail-closed safety)
 * @see ./WarningArea.tsx (oracle warning + CTA grayout)
 */

import React, { useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

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
  toHumanReadable,
} from "@workspace/lib/utils/numeric";
import type {
  AgentPlan,
  ApprovalToken,
} from "@workspace/lib/types";

import {
  useApproveAgentPlan,
  useRejectAgentPlan,
} from "../../services/queries";
import {
  WarningArea,
  type OracleWarning,
} from "./WarningArea";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function formatRemaining(ms: number): string {
  if (ms <= 0) return "0:00";
  const totalSec = Math.floor(ms / 1000);
  const mm = Math.floor(totalSec / 60);
  const ss = totalSec % 60;
  return `${mm}:${String(ss).padStart(2, "0")}`;
}

/** §4.6 oracle 規約: 2-5% 乖離は warning、>5% は execute 側で拒否 (本画面に到達しない) */
function deriveOracleWarnings(plan: AgentPlan): OracleWarning[] {
  const oracle = plan.simulation_result?.oracle;
  if (!oracle) return [];
  const out: OracleWarning[] = [];
  if (
    oracle.divergence_pct != null &&
    oracle.divergence_pct >= 2 &&
    oracle.divergence_pct <= 5
  ) {
    out.push({
      kind: "oracle_divergence_warning",
      divergencePct: oracle.divergence_pct,
    });
  }
  // primary が switchboard なら pyth が stale で fallback されている
  if (oracle.primary === "switchboard") {
    out.push({
      kind: "oracle_pyth_stale",
      pythAgeSeconds: oracle.primary_age_seconds,
    });
  }
  return out;
}

function resolveDecimals(asset?: string): number {
  if (asset && asset in TOKEN_DECIMALS) {
    return (TOKEN_DECIMALS as Record<string, number>)[asset]!;
  }
  return 6;
}

// ─────────────────────────────────────────────────────────────────────────────
// Props
// ─────────────────────────────────────────────────────────────────────────────

export interface MCPApprovalPushCardProps {
  plan: AgentPlan;
  token: ApprovalToken;
  /** 現在時刻 (ms)。テスト用 override。default は () => Date.now() */
  now?: () => number;
  onApproveSuccess?: (updated: AgentPlan) => void;
  onApproveError?: (error: Error) => void;
  onRejectSuccess?: (updated: AgentPlan) => void;
  onRejectError?: (error: Error) => void;
  /** WarningArea が onCtaEnabled で発火する haptics を有効化するか (default true) */
  hapticsEnabled?: boolean;
  /** WarningArea の CTA grayout (ms)。テスト / A/B テスト用に override 可能 (default 1000、§8.5) */
  warningGrayoutMs?: number;
  testID?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export function MCPApprovalPushCard({
  plan,
  token,
  now = Date.now,
  onApproveSuccess,
  onApproveError,
  onRejectSuccess,
  onRejectError,
  hapticsEnabled,
  warningGrayoutMs,
  testID,
}: MCPApprovalPushCardProps) {
  const approve = useApproveAgentPlan();
  const reject = useRejectAgentPlan();

  const [currentMs, setCurrentMs] = useState<number>(() => now());

  // Phase 8.37 (M3): expires_at が不正/欠落だと getTime() が NaN になり
  // 「NaN <= 0 === false」で TTL が無効化されていた — 不正は expired 扱い
  // (fail-closed。TTL は §29.3 のセキュリティ制御)
  const expiresMs = new Date(token.expires_at).getTime();
  const remainingMs = Number.isFinite(expiresMs) ? expiresMs - currentMs : 0;
  const isExpired = remainingMs <= 0;

  useEffect(() => {
    if (isExpired) return;
    const id = setInterval(() => setCurrentMs(now()), 1000);
    return () => clearInterval(id);
  }, [isExpired, now]);

  const action = plan.selected_action;
  const sim = plan.simulation_result;
  const decimals = resolveDecimals(action?.asset);

  const amountText =
    action?.amount && action.asset
      ? `${toHumanReadable(action.amount, decimals)} ${action.asset}`
      : "—";
  const estimatedOutText =
    sim && action?.asset
      ? `${toHumanReadable(sim.estimated_out, decimals)} ${action.asset}`
      : "—";
  const feeText =
    sim && action?.asset
      ? `${toHumanReadable(sim.estimated_fee, decimals)} ${action.asset}`
      : "—";

  const oracleWarnings = deriveOracleWarnings(plan);

  const isBusy = approve.isPending || reject.isPending;

  const handleApprove = () => {
    if (isExpired || isBusy) return;
    approve.mutate(
      { plan_id: plan.plan_id },
      { onSuccess: onApproveSuccess, onError: onApproveError }
    );
  };
  const handleReject = () => {
    if (isBusy) return;
    reject.mutate(
      { plan_id: plan.plan_id },
      { onSuccess: onRejectSuccess, onError: onRejectError }
    );
  };

  return (
    <ScrollView
      contentContainerStyle={styles.container}
      testID={testID}
    >
      <View style={styles.header}>
        <Text
          style={styles.protocol}
          testID={testID ? `${testID}-protocol` : undefined}
        >
          {action?.protocol ?? "—"}
        </Text>
        <Text
          style={styles.actionType}
          testID={testID ? `${testID}-action-type` : undefined}
        >
          {action?.action_type ?? "—"}
        </Text>
      </View>

      <Text
        style={styles.amount}
        testID={testID ? `${testID}-amount` : undefined}
      >
        {amountText}
      </Text>

      <View style={styles.detailGrid}>
        <View style={styles.detailItem}>
          <Text style={styles.detailLabel}>Est. out</Text>
          <Text
            style={styles.detailValue}
            testID={testID ? `${testID}-estimated-out` : undefined}
          >
            {estimatedOutText}
          </Text>
        </View>
        <View style={styles.detailItem}>
          <Text style={styles.detailLabel}>Est. fee</Text>
          <Text
            style={styles.detailValue}
            testID={testID ? `${testID}-fee` : undefined}
          >
            {feeText}
          </Text>
        </View>
      </View>

      <WarningArea
        oracleWarnings={oracleWarnings}
        hapticsEnabled={hapticsEnabled}
        grayoutMs={warningGrayoutMs}
        renderCta={({ disabled }) => {
          const ctaDisabled = disabled || isExpired || isBusy;
          return (
            <Pressable
              accessibilityRole="button"
              disabled={ctaDisabled}
              onPress={handleApprove}
              style={[styles.ctaApprove, ctaDisabled && styles.ctaDisabled]}
              testID={testID ? `${testID}-approve` : undefined}
            >
              <Text style={styles.ctaApproveText}>
                {approve.isPending
                  ? "Executing…"
                  : isExpired
                  ? "Expired"
                  : "Sign & execute"}
              </Text>
            </Pressable>
          );
        }}
        testID={testID ? `${testID}-warning` : undefined}
      />

      <View style={styles.footer}>
        <Pressable
          accessibilityRole="button"
          disabled={isBusy}
          onPress={handleReject}
          style={[styles.ctaReject, isBusy && styles.ctaDisabled]}
          testID={testID ? `${testID}-reject` : undefined}
        >
          <Text style={styles.ctaRejectText}>
            {reject.isPending ? "Rejecting…" : "Reject"}
          </Text>
        </Pressable>
        <Text
          style={[styles.expiresText, isExpired && styles.expiresExpired]}
          testID={testID ? `${testID}-expires` : undefined}
        >
          {isExpired ? "Expired" : `Expires in ${formatRemaining(remainingMs)}`}
        </Text>
      </View>
    </ScrollView>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: SPACE.md,
    paddingVertical: SPACE.lg,
    gap: SPACE.md,
    backgroundColor: COLOR.bgPrimary,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: SPACE.sm,
  },
  protocol: {
    fontSize: FONT_SIZE.headingLG,
    fontFamily: FONT.heading,
    fontWeight: WEIGHT.bold,
    color: COLOR.textPrimary,
  },
  actionType: {
    fontSize: FONT_SIZE.caption,
    fontFamily: FONT.body,
    fontWeight: WEIGHT.medium,
    color: COLOR.textMuted,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  amount: {
    fontSize: FONT_SIZE.displaySM,
    fontFamily: FONT.heading,
    fontWeight: WEIGHT.bold,
    color: COLOR.textPrimary,
  },
  detailGrid: {
    flexDirection: "row",
    gap: SPACE.md,
  },
  detailItem: {
    flex: 1,
    paddingHorizontal: SPACE.md,
    paddingVertical: SPACE.sm,
    borderRadius: RADIUS.md,
    backgroundColor: withAlpha(COLOR.sodaLight, 0.4),
    borderWidth: 1,
    borderColor: COLOR.border,
    gap: SPACE.xs,
  },
  detailLabel: {
    fontSize: FONT_SIZE.caption,
    fontFamily: FONT.body,
    fontWeight: WEIGHT.medium,
    color: COLOR.textMuted,
    textTransform: "uppercase",
  },
  detailValue: {
    fontSize: FONT_SIZE.bodyMD,
    fontFamily: FONT.heading,
    fontWeight: WEIGHT.semibold,
    color: COLOR.textPrimary,
  },
  ctaApprove: {
    paddingVertical: SPACE.md,
    borderRadius: RADIUS.md,
    backgroundColor: COLOR.sodaText,
    alignItems: "center",
    justifyContent: "center",
    minHeight: 48,
  },
  ctaApproveText: {
    fontSize: FONT_SIZE.bodyLG,
    fontFamily: FONT.heading,
    fontWeight: WEIGHT.bold,
    color: COLOR.textOnColor,
  },
  ctaDisabled: {
    opacity: 0.5,
  },
  footer: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: SPACE.md,
    marginTop: SPACE.xs,
  },
  ctaReject: {
    paddingHorizontal: SPACE.md,
    paddingVertical: SPACE.sm,
    borderRadius: RADIUS.md,
    borderWidth: 1,
    borderColor: COLOR.borderStrong,
    backgroundColor: "transparent",
    minHeight: 40,
    minWidth: 96,
    alignItems: "center",
    justifyContent: "center",
  },
  ctaRejectText: {
    fontSize: FONT_SIZE.bodyMD,
    fontFamily: FONT.heading,
    fontWeight: WEIGHT.semibold,
    color: COLOR.textSubtitle,
  },
  expiresText: {
    fontSize: FONT_SIZE.caption,
    fontFamily: FONT.body,
    fontWeight: WEIGHT.medium,
    color: COLOR.textMuted,
    textAlign: "right",
    flex: 1,
  },
  expiresExpired: {
    color: COLOR.cherryDark,
    fontWeight: WEIGHT.bold,
  },
});
