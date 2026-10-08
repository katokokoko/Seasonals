/**
 * Approval deep-link route — `/approval/[planId]` (旧形式 `?token=<tokenId>` も受ける)
 *
 * Push notification tap → expo-router がこの screen に遷移。
 * useAgentPlan で BFF から plan を取得 → MCPApprovalPushCard を render。
 *
 * ナビゲーション仕様 (agent-plan 契約 2026-10):
 *   - planId は dynamic segment (path)。BFF の push payload は `{ type, plan_id }` だけ
 *   - approval token は approve の応答で発行される (TTL は card が応答から表示)。
 *     旧 deep link の `?token=` があれば従来どおり fetch して TTL を出す
 *   - 承認後の署名・送信は Seasonals web (Seeker は承認まで)
 *
 * @see CLAUDE.md §10 task #7
 * @see ../../components/action/MCPApprovalPushCard.tsx
 * @see ../../services/push.ts
 */

import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Stack, useLocalSearchParams } from "expo-router";

import {
  COLOR,
  FONT,
  FONT_SIZE,
  SPACE,
  WEIGHT,
} from "@workspace/lib/design-system";

import { MCPApprovalPushCard } from "../../components/action/MCPApprovalPushCard";
import {
  useAgentPlan,
  useApprovalToken,
} from "../../services/queries";

export default function ApprovalScreen() {
  const params = useLocalSearchParams<{ planId: string; token?: string }>();
  const planId = typeof params.planId === "string" ? params.planId : null;
  const tokenId = typeof params.token === "string" ? params.token : null;

  const planQuery = useAgentPlan(planId);
  // token は任意。無ければ useApprovalToken(null) は disabled query (fetch しない)
  const tokenQuery = useApprovalToken(tokenId);

  // Phase 8.37 (M2): disabled query の isPending は永久 true なので、
  // token がある時だけ token fetch の pending / error を見る
  const tokenPending = tokenId !== null && tokenQuery.isPending;
  // planId 欠落は useAgentPlan(null) も disabled なので、pending を待たず invalid 表示
  const isPending = planId !== null && (planQuery.isPending || tokenPending);
  const error =
    planQuery.error ?? (tokenId !== null ? tokenQuery.error : null);

  return (
    <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
      <Stack.Screen options={{ title: "Approval", headerShown: false }} />

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

      {!isPending && !error && planQuery.data && (
        <MCPApprovalPushCard
          plan={planQuery.data}
          token={tokenId !== null ? tokenQuery.data : undefined}
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
