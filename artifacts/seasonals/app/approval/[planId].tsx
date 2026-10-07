/**
 * Approval deep-link route — `/approval/[planId]` (旧形式 `?token=<tokenId>` も受ける)
 *
 * Push notification tap → expo-router がこの screen に遷移。
 * useAgentPlan で BFF から plan を取得 → MCPApprovalPushCard を render。
 *
 * ナビゲーション仕様 (agent-plan 契約 2026-10):
 *   - planId は dynamic segment (path)。BFF の push payload は `{ type, plan_id }` だけ
 *   - approval token は approve の応答で発行される。旧 deep link の `?token=` は
 *     URL としては受ける (開けなくしない) が、2026-10-08 から使わない
 *     (token の TTL count-down は撤去。期限は plan の expires_at を card が出す)
 *   - 承認後の署名・送信は Seasonals web (Seeker は承認まで)
 *   - live な status (pending_user / approved / executing) の間は 5 秒で polling し、
 *     web での送信 / 却下を数秒で反映する (web の useSolanaAgentPlans と同じ間隔)
 *   - header を出さない画面なので ✕ で閉じられる (2026-10-08 実機: 戻れなかった)
 *
 * @see CLAUDE.md §10 task #7
 * @see ../../components/action/MCPApprovalPushCard.tsx
 * @see ../../services/push.ts
 */

import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";

import {
  COLOR,
  FONT,
  FONT_SIZE,
  RADIUS,
  SPACE,
  WEIGHT,
  withAlpha,
} from "@workspace/lib/design-system";
import { AgentPlanStatus, type AgentPlan } from "@workspace/lib/types";

import { MCPApprovalPushCard } from "../../components/action/MCPApprovalPushCard";
import { useAgentPlan } from "../../services/queries";

/** 状態が変わり得る status (web / Agent 側の操作待ち)。この間だけ polling する */
const LIVE_PLAN_STATUSES: ReadonlySet<AgentPlanStatus> = new Set([
  AgentPlanStatus.PendingUser,
  AgentPlanStatus.Approved,
  AgentPlanStatus.Executing,
]);

/** live な status の polling 間隔 (web の useSolanaAgentPlans と揃える) */
const LIVE_POLL_MS = 5_000;

function approvalRefetchInterval(
  plan: AgentPlan | undefined
): number | false {
  return plan && LIVE_PLAN_STATUSES.has(plan.status) ? LIVE_POLL_MS : false;
}

export default function ApprovalScreen() {
  const router = useRouter();
  // `token` は旧 deep link 互換で受けるだけ (使わない)
  const params = useLocalSearchParams<{ planId: string; token?: string }>();
  const planId = typeof params.planId === "string" ? params.planId : null;

  const planQuery = useAgentPlan(planId, {
    refetchInterval: approvalRefetchInterval,
  });

  // planId 欠落は useAgentPlan(null) も disabled なので、pending を待たず invalid 表示
  const isPending = planId !== null && planQuery.isPending;
  // polling 中の一時的な取得失敗で card を消さない (data がある間は card を出し続ける)
  const error = planQuery.data ? null : planQuery.error;

  const handleClose = () => {
    if (router.canGoBack()) router.back();
    else router.replace("/");
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
      <Stack.Screen options={{ title: "Approval", headerShown: false }} />

      <View style={styles.topBar}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close"
          onPress={handleClose}
          hitSlop={12}
          style={styles.closeBtn}
          testID="approval-screen-close"
        >
          <Text style={styles.closeIcon}>✕</Text>
        </Pressable>
      </View>

      {isPending && (
        <View style={styles.center}>
          <ActivityIndicator color={COLOR.sodaText} size="large" />
          <Text style={styles.loadingText}>Loading…</Text>
        </View>
      )}

      {planId === null && (
        <View style={styles.center} testID="approval-screen-invalid-link">
          <Text style={styles.errorTitle}>Invalid approval link</Text>
          <Text style={styles.errorBody}>
            This link is missing its plan id. Open the approval from the
            notification again.
          </Text>
        </View>
      )}

      {!isPending && error && (
        <View style={styles.center}>
          <Text style={styles.errorTitle}>Fetch failed</Text>
          <Text style={styles.errorBody}>{error.message}</Text>
        </View>
      )}

      {!isPending && planQuery.data && (
        <MCPApprovalPushCard
          plan={planQuery.data}
          testID="approval-screen-card"
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: COLOR.bgPrimary,
  },
  topBar: {
    flexDirection: "row",
    justifyContent: "flex-end",
    paddingHorizontal: SPACE.md,
    paddingTop: SPACE.sm,
  },
  // ActionModal の ✕ と同じ見た目 (32×32 pill)
  closeBtn: {
    width: 32,
    height: 32,
    borderRadius: RADIUS.pill,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: withAlpha(COLOR.textMuted, 0.12),
  },
  closeIcon: {
    fontSize: 16,
    color: COLOR.textSubtitle,
    fontWeight: WEIGHT.bold,
  },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: SPACE.lg,
    gap: SPACE.md,
  },
  loadingText: {
    fontSize: FONT_SIZE.bodyMD,
    fontFamily: FONT.body,
    color: COLOR.textMuted,
  },
  errorTitle: {
    fontSize: FONT_SIZE.headingMD,
    fontFamily: FONT.heading,
    fontWeight: WEIGHT.bold,
    color: COLOR.cherryDark,
  },
  errorBody: {
    fontSize: FONT_SIZE.bodyMD,
    fontFamily: FONT.body,
    color: COLOR.textSubtitle,
    textAlign: "center",
  },
});
