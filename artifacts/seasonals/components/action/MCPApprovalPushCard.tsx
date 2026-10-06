/**
 * MCPApprovalPushCard — 仕様書 §8.7 (push tap → 専用 approval screen)
 *
 * push notification の deep link を踏んで開かれる full-screen approval。
 * WarningArea を必ず内蔵し、ApprovalToken があれば expires_at まで count-down を出す。
 *
 * agent-plan 契約 (2026-10): push は `{ type, plan_id }` だけで、approval token は
 * approve の応答 (`{ ...plan, approval_token }`) で初めて発行される。Seeker は承認まで、
 * 人が承認した plan の署名・送信は Seasonals web が行う (承認後にその案内を 1 行出す)。
 *
 * 設計原則:
 * - oracle warning は CTA 直上に強警告として表示 (WarningArea に委譲)
 * - token (旧 deep link の ?token= / approve 応答) があれば TTL を 1 秒刻みで count-down。
 *   承認前に渡された token が 0 / 不正なら CTA disabled (fail-closed)
 * - token が無い (push から開いた) 場合は count-down を出さず、CTA は有効
 * - approve / reject 両方を内蔵 (services/queries の mutation 経由)
 * - bundle_hash 検証は BFF 側責務、本層では行わない
 *
 * @see CLAUDE.md §5 / §32.2 (warning は素通りしない / fail-closed safety)
 * @see ./WarningArea.tsx (oracle warning + CTA grayout)
 */

import React, { useEffect, useRef, useState } from "react";
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
  // primary が pyth 以外 (secondary) なら pyth が stale で fallback されている
  if (oracle.primary !== "pyth") {
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
  /** 旧 deep link (?token=) 由来の token。無ければ approve 応答の token で TTL を出す */
  token?: ApprovalToken;
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

  // 承認後は応答の approval_token (BFF 発行、TTL 300 秒) を優先して TTL を出す
  const approved = approve.isSuccess;
  const activeToken: ApprovalToken | null =
    approve.data?.approval_token ?? token ?? null;

  // Phase 8.37 (M3): expires_at が不正/欠落だと getTime() が NaN になり
  // 「NaN <= 0 === false」で TTL が無効化されていた — 不正は expired 扱い
  // (fail-closed。TTL は §29.3 のセキュリティ制御)。token が無ければ TTL 判定なし
  const expiresMs = activeToken
    ? new Date(activeToken.expires_at).getTime()
    : Number.NaN;
  const remainingMs = Number.isFinite(expiresMs) ? expiresMs - currentMs : 0;
  const isExpired = activeToken !== null && remainingMs <= 0;

  // `now` は呼び手が inline arrow で渡し得るので ref 経由で読む (deps に入れると
  // 毎 render で effect が回り、即時 setState と合わせて render loop になる)
  const nowRef = useRef(now);
  nowRef.current = now;
  const activeTokenId = activeToken?.token_id ?? null;
  const hasActiveToken = activeToken !== null;

  useEffect(() => {
    if (!hasActiveToken || isExpired) return;
    // token が差し替わった (approve 応答) 直後に現在時刻を取り直す
    setCurrentMs(nowRef.current());
    const id = setInterval(() => setCurrentMs(nowRef.current()), 1000);
    return () => clearInterval(id);
  }, [activeTokenId, hasActiveToken, isExpired]);

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
    if (isExpired || isBusy || approved) return;
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
          const ctaDisabled = disabled || isExpired || isBusy || approved;
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
                  ? "Approving…"
                  : approved
                  ? "Approved"
                  : isExpired
                  ? "Expired"
                  : "Approve"}
              </Text>
            </Pressable>
          );
        }}
        testID={testID ? `${testID}-warning` : undefined}
      />

      {approved && (
        <Text
          style={styles.webHint}
          testID={testID ? `${testID}-web-hint` : undefined}
        >
          Sign & send from the Seasonals web app.
        </Text>
      )}

      <View style={styles.footer}>
        <Pressable
          accessibilityRole="button"
          disabled={isBusy || approved}
          onPress={handleReject}
          style={[styles.ctaReject, (isBusy || approved) && styles.ctaDisabled]}
          testID={testID ? `${testID}-reject` : undefined}
        >
          <Text style={styles.ctaRejectText}>
            {reject.isPending ? "Rejecting…" : "Reject"}
          </Text>
        </Pressable>
        {activeToken && (
          <Text
            style={[styles.expiresText, isExpired && styles.expiresExpired]}
            testID={testID ? `${testID}-expires` : undefined}
          >
            {isExpired ? "Expired" : `Expires in ${formatRemaining(remainingMs)}`}
          </Text>
        )}
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
  webHint: {
    fontSize: FONT_SIZE.bodySM,
    fontFamily: FONT.body,
    color: COLOR.textSubtitle,
    textAlign: "center",
  },
  expiresExpired: {
    color: COLOR.cherryDark,
    fontWeight: WEIGHT.bold,
  },
});
