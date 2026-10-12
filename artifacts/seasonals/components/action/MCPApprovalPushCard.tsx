/**
 * MCPApprovalPushCard — 仕様書 §8.7 (push tap → 専用 approval screen)
 *
 * push notification の deep link を踏んで開かれる full-screen approval。
 * WarningArea を必ず内蔵する (oracle warning 専用、CLAUDE.md §5)。
 *
 * agent-plan 契約 (2026-10): push は `{ type, plan_id }` だけで、approval token は
 * approve の応答 (`{ ...plan, approval_token }`) で初めて発行される。Seeker は承認まで、
 * 人が承認した plan の署名・送信は Seasonals web が行う。
 *
 * 2026-10-08 (実機確認の修正):
 * - approval token の TTL count-down (5 分) は撤去。web が token を再発行するので、
 *   人に意味があるのは plan の 24h 期限 (`plan.expires_at`) だけ → 「Valid until <日時>」
 * - `plan.status` を読んで 1 行で状態を出す (web で送信 / 却下されたら反映する。
 *   承認画面は live な status の間 5 秒 polling — app/approval/[planId].tsx)
 * - `expires_at` を過ぎたら、サーバーの status が未更新でも expired 扱い (fail-closed)
 * - Est. out / fee は lib/derive/simulation-display の文言 (web の inbox と共通)
 *
 * 設計原則:
 * - oracle warning は CTA 直上に強警告として表示 (WarningArea に委譲)。
 *   simulate の `warnings` (fair value 等) は oracle ではないので muted な 1 行で出す
 * - Approve / Reject は `simulated | pending_user` かつ期限内の時だけ出す
 * - approve / reject 両方を内蔵 (services/queries の mutation 経由)
 * - bundle_hash 検証は BFF 側責務、本層では行わない
 *
 * @see CLAUDE.md §5 / §32.2 (warning は素通りしない / fail-closed safety)
 * @see ./WarningArea.tsx (oracle warning + CTA grayout)
 */

import React, { useEffect, useRef, useState } from "react";
import {
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
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
  TOKEN_DECIMALS,
  toHumanReadable,
} from "@workspace/lib/utils/numeric";
import { AgentPlanStatus, type AgentPlan } from "@workspace/lib/types";
import {
  describeSimulationFailure,
  describeSimulationFee,
  describeSimulationOut,
  describeSimulationWarning,
} from "@workspace/lib/derive/simulation-display";

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

/** 承認 / 却下を受け付ける status (§11.7) */
const APPROVABLE_STATUSES: ReadonlySet<AgentPlanStatus> = new Set([
  AgentPlanStatus.Simulated,
  AgentPlanStatus.PendingUser,
]);

/** 期限で expired に倒れない終端 status (BFF の expiry 判定と同じ) */
const TERMINAL_STATUSES: ReadonlySet<AgentPlanStatus> = new Set([
  AgentPlanStatus.Broadcasted,
  AgentPlanStatus.Failed,
  AgentPlanStatus.Rejected,
  AgentPlanStatus.Expired,
]);

/** setTimeout の上限 (≈ 24.8 日)。これより先の期限は分割して待つ */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

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

/**
 * plan.expires_at の ms。無ければ null、parse 不能なら NaN
 * (NaN は呼び手で expired 扱い = fail-closed。8.37 M3 と同じ方針)
 */
function planExpiresMs(plan: AgentPlan): number | null {
  if (plan.expires_at === undefined) return null;
  return new Date(plan.expires_at).getTime();
}

/**
 * 画面に出す status。
 * - 承認 / 却下の mutation が成功した直後は、refetch が追いつくまで local の結果を優先
 * - 終端以外で expires_at を過ぎていれば expired (サーバー未更新でも止める、fail-closed)
 */
export function resolveDisplayStatus(
  plan: AgentPlan,
  nowMs: number,
  local: { approved: boolean; rejected: boolean }
): AgentPlanStatus {
  let status = plan.status;
  if (APPROVABLE_STATUSES.has(status)) {
    if (local.rejected) status = AgentPlanStatus.Rejected;
    else if (local.approved) status = AgentPlanStatus.Approved;
  }
  if (!TERMINAL_STATUSES.has(status)) {
    const expiresMs = planExpiresMs(plan);
    if (expiresMs !== null && (!Number.isFinite(expiresMs) || expiresMs <= nowMs)) {
      return AgentPlanStatus.Expired;
    }
  }
  return status;
}

/** status ごとの 1 行。承認待ち (simulated / pending_user) は出さない */
function statusLine(status: AgentPlanStatus, plan: AgentPlan): string | null {
  switch (status) {
    case AgentPlanStatus.Approved:
      return "Approved — sign & send from the Seasonals web app.";
    case AgentPlanStatus.Executing:
      return "Being signed in the web app…";
    case AgentPlanStatus.Signed:
      return "Signed — sending from the web app…";
    case AgentPlanStatus.Broadcasted:
      return "Sent";
    case AgentPlanStatus.Failed:
      return plan.failure_reason ? `Failed: ${plan.failure_reason}` : "Failed";
    case AgentPlanStatus.Rejected:
      return "Rejected";
    case AgentPlanStatus.Expired:
      return "Expired";
    case AgentPlanStatus.Draft:
      return "Waiting for the simulation";
    default:
      return null;
  }
}

/**
 * Solscan の tx URL。web 経由の送信は mainnet、autonomous は devnet の lamport 送金
 * (BFF autonomous.ts) なので cluster を付ける
 */
function solscanTxUrl(signature: string, devnet: boolean): string {
  return `https://solscan.io/tx/${signature}${devnet ? "?cluster=devnet" : ""}`;
}

function shortenSig(sig: string): string {
  return sig.length > 12 ? `${sig.slice(0, 6)}…${sig.slice(-6)}` : sig;
}

// ─────────────────────────────────────────────────────────────────────────────
// Props
// ─────────────────────────────────────────────────────────────────────────────

export interface MCPApprovalPushCardProps {
  plan: AgentPlan;
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

  // `now` は呼び手が inline arrow で渡し得るので ref 経由で読む (deps に入れない)
  const nowRef = useRef(now);
  nowRef.current = now;

  // 期限の瞬間に 1 回だけ再描画する (1 秒 interval の count-down はしない)。
  // 期限前に開いた画面が、期限を過ぎても Approve を出し続けないため
  const expiresMs = planExpiresMs(plan);
  const [expiryTick, setExpiryTick] = useState(0);
  useEffect(() => {
    if (expiresMs === null || !Number.isFinite(expiresMs)) return;
    const delay = expiresMs - nowRef.current();
    if (delay <= 0) return;
    const id = setTimeout(
      () => setExpiryTick((t) => t + 1),
      Math.min(delay + 50, MAX_TIMEOUT_MS)
    );
    return () => clearTimeout(id);
  }, [expiresMs, expiryTick]);

  const status = resolveDisplayStatus(plan, now(), {
    approved: approve.isSuccess,
    rejected: reject.isSuccess,
  });
  const canAct = APPROVABLE_STATUSES.has(status);
  const line = statusLine(status, plan);

  const action = plan.selected_action;
  const sim = plan.simulation_result;
  const decimals = resolveDecimals(action?.asset);
  const legacy = { decimals, unitSymbol: action?.asset ?? "" };
  // 旧形式 (estimate_kind 無し) は入力 asset の単位で出すので asset 必須 (従来どおり)
  const simDisplayable =
    sim !== null && (sim.estimate_kind !== undefined || Boolean(action?.asset));

  const amountText =
    action?.amount && action.asset
      ? `${toHumanReadable(action.amount, decimals)} ${action.asset}`
      : "—";
  const estimatedOutText =
    sim && sim.failure_reason !== undefined
      ? describeSimulationFailure(sim.failure_reason)
      : sim && simDisplayable
      ? describeSimulationOut(sim, legacy) ?? "—"
      : "—";
  const feeText =
    sim && simDisplayable ? describeSimulationFee(sim, legacy) ?? "—" : "—";
  const simWarningsText =
    sim?.warnings && sim.warnings.length > 0
      ? sim.warnings.map(describeSimulationWarning).join(" · ")
      : null;

  const validUntilText =
    expiresMs !== null &&
    Number.isFinite(expiresMs) &&
    status !== AgentPlanStatus.Broadcasted &&
    status !== AgentPlanStatus.Failed &&
    status !== AgentPlanStatus.Rejected
      ? `Valid until ${format(new Date(expiresMs), "yyyy/MM/dd HH:mm")}`
      : null;

  const signatures =
    status === AgentPlanStatus.Broadcasted
      ? plan.execution?.signatures ?? []
      : [];
  const devnetExplorer = plan.execution?.via === "autonomous";

  const oracleWarnings = deriveOracleWarnings(plan);

  const isBusy = approve.isPending || reject.isPending;

  const handleApprove = () => {
    if (!canAct || isBusy) return;
    approve.mutate(
      { plan_id: plan.plan_id },
      { onSuccess: onApproveSuccess, onError: onApproveError }
    );
  };
  const handleReject = () => {
    if (!canAct || isBusy) return;
    reject.mutate(
      { plan_id: plan.plan_id },
      { onSuccess: onRejectSuccess, onError: onRejectError }
    );
  };

  const isNegative =
    status === AgentPlanStatus.Failed ||
    status === AgentPlanStatus.Rejected ||
    status === AgentPlanStatus.Expired;

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

      {simWarningsText !== null && (
        <Text
          style={styles.simWarnings}
          testID={testID ? `${testID}-sim-warnings` : undefined}
        >
          {simWarningsText}
        </Text>
      )}

      <WarningArea
        oracleWarnings={oracleWarnings}
        hapticsEnabled={hapticsEnabled}
        grayoutMs={warningGrayoutMs}
        renderCta={({ disabled }) => {
          if (!canAct) return null;
          const ctaDisabled = disabled || isBusy;
          return (
            <Pressable
              accessibilityRole="button"
              disabled={ctaDisabled}
              onPress={handleApprove}
              style={[styles.ctaApprove, ctaDisabled && styles.ctaDisabled]}
              testID={testID ? `${testID}-approve` : undefined}
            >
              <Text style={styles.ctaApproveText}>
                {approve.isPending ? "Approving…" : "Approve"}
              </Text>
            </Pressable>
          );
        }}
        testID={testID ? `${testID}-warning` : undefined}
      />

      {line !== null && (
        <Text
          style={[styles.statusLine, isNegative && styles.statusNegative]}
          testID={testID ? `${testID}-status` : undefined}
        >
          {line}
        </Text>
      )}

      {signatures.map((sig, i) => (
        <Pressable
          key={sig}
          accessibilityRole="link"
          onPress={() =>
            Linking.openURL(solscanTxUrl(sig, devnetExplorer)).catch(
              () => undefined
            )
          }
          style={styles.sigLink}
          testID={testID ? `${testID}-signature-${i}` : undefined}
        >
          <Text style={styles.sigLinkText}>
            {`${shortenSig(sig)} · Solscan ↗`}
          </Text>
        </Pressable>
      ))}

      <View style={styles.footer}>
        {canAct ? (
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
        ) : (
          <View />
        )}
        {validUntilText !== null && (
          <Text
            style={styles.validUntil}
            testID={testID ? `${testID}-valid-until` : undefined}
          >
            {validUntilText}
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
  simWarnings: {
    fontSize: FONT_SIZE.caption,
    fontFamily: FONT.body,
    color: COLOR.textMuted,
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
  statusLine: {
    fontSize: FONT_SIZE.bodySM,
    fontFamily: FONT.body,
    fontWeight: WEIGHT.semibold,
    color: COLOR.textSubtitle,
    textAlign: "center",
  },
  statusNegative: {
    color: COLOR.cherryDark,
  },
  sigLink: {
    alignSelf: "center",
    paddingVertical: SPACE.xs,
  },
  sigLinkText: {
    fontSize: FONT_SIZE.bodySM,
    fontFamily: FONT.mono,
    color: COLOR.sodaText,
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
  validUntil: {
    fontSize: FONT_SIZE.caption,
    fontFamily: FONT.body,
    fontWeight: WEIGHT.medium,
    color: COLOR.textMuted,
    textAlign: "right",
    flex: 1,
  },
});
