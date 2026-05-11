/**
 * Approval deep-link route — `/approval/[planId]?token=<tokenId>`
 *
 * Push notification tap → expo-router がこの screen に遷移。
 * useAgentPlan + useApprovalToken で BFF から状態取得 → MCPApprovalPushCard を render。
 *
 * ナビゲーション仕様:
 *   - planId は dynamic segment (path)
 *   - token は query string で渡す (例: /approval/plan_003?token=tok_active_001)
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
  const tokenQuery = useApprovalToken(tokenId);

  const isPending = planQuery.isPending || tokenQuery.isPending;
  const error = planQuery.error ?? tokenQuery.error;

  return (
    <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
      <Stack.Screen options={{ title: "Approval", headerShown: false }} />

      {isPending && (
        <View style={styles.center}>
          <ActivityIndicator color={COLOR.sodaText} size="large" />
          <Text style={styles.loadingText}>Loading…</Text>
        </View>
      )}

      {!isPending && error && (
        <View style={styles.center}>
          <Text style={styles.errorTitle}>Fetch failed</Text>
          <Text style={styles.errorBody}>{error.message}</Text>
        </View>
      )}

      {!isPending &&
        !error &&
        planQuery.data &&
        tokenQuery.data && (
          <MCPApprovalPushCard
            plan={planQuery.data}
            token={tokenQuery.data}
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
