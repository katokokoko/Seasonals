/**
 * Autonomous 管制盤 (Phase 8.30) — Seeker 上で自律オプションを観測/停止/束縛する。
 *
 * 自律エンジンは BFF (bounded 委任署名 / devnet) で走る。本画面はその「管制盤」で、
 * 人間が (1) status を観測、(2) kill switch で停止、(3) 実 UserPolicy を編集して
 * AI が動ける範囲を決める、(4) 監査ログで「何をしたか」を確認する。web 版は将来
 * これを大画面でなぞる (same source of truth = 同じ BFF REST / lib 型)。
 *
 * server state は全て TanStack Query hook 経由 (CLAUDE.md §5)。
 */

import { ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Link } from "expo-router";

import {
  COLOR,
  FONT,
  FONT_SIZE,
  SPACE,
  WEIGHT,
} from "@workspace/lib/design-system";

import { AutonomousStatusCard } from "../components/autonomous/AutonomousStatusCard";
import { AutonomousLogList } from "../components/autonomous/AutonomousLogList";
import { PolicyEditor } from "../components/autonomous/PolicyEditor";
import {
  useAutonomousLog,
  useAutonomousStatus,
  useKillAutonomous,
  useMenuListings,
  usePatchUserPolicy,
  useResumeAutonomous,
  useUserPolicy,
} from "../services/queries";

export default function Autonomous(): React.JSX.Element {
  const statusQ = useAutonomousStatus();
  const logQ = useAutonomousLog();
  const policyQ = useUserPolicy();
  const menuQ = useMenuListings();

  const kill = useKillAutonomous();
  const resume = useResumeAutonomous();
  const patchPolicy = usePatchUserPolicy();

  // policy editor の選択肢を live menu から導出 (fallback は policy 自身の enabled)
  const menu = menuQ.data ?? [];
  const protocolUniverse = Array.from(
    new Set(menu.map((e) => e.protocol_id))
  );
  const assetUniverse = Array.from(
    new Set(
      menu.flatMap((e) => e.pools.map((p) => p.deposit_asset ?? p.asset))
    )
  );

  return (
    <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
      <ScrollView contentContainerStyle={styles.container}>
        <View style={styles.headerRow}>
          <Link href="/" asChild>
            <Text style={styles.backLink}>← home</Text>
          </Link>
        </View>

        <Text style={styles.title}>自律オプション</Text>
        <Text style={styles.subtitle}>
          AI が policy 内・ハード上限内で自動運用する設定と履歴 (devnet)
        </Text>

        {statusQ.isLoading ? (
          <Text style={styles.muted}>状態を読み込み中…</Text>
        ) : statusQ.data ? (
          <AutonomousStatusCard
            status={statusQ.data}
            onKill={() => kill.mutate()}
            onResume={() => resume.mutate()}
            busy={kill.isPending || resume.isPending}
          />
        ) : (
          <Text style={styles.error}>状態を取得できませんでした</Text>
        )}

        <Text style={styles.sectionTitle}>ポリシー</Text>
        {policyQ.isLoading ? (
          <Text style={styles.muted}>ポリシーを読み込み中…</Text>
        ) : policyQ.data ? (
          <PolicyEditor
            policy={policyQ.data}
            protocolUniverse={protocolUniverse}
            assetUniverse={assetUniverse}
            onSave={(patch) => patchPolicy.mutate(patch)}
            busy={patchPolicy.isPending}
          />
        ) : (
          <Text style={styles.error}>ポリシーを取得できませんでした</Text>
        )}
        {patchPolicy.isError && (
          <Text style={styles.error} testID="policy-save-error">
            保存に失敗しました: {patchPolicy.error.message}
          </Text>
        )}
        {patchPolicy.isSuccess && !patchPolicy.isPending && (
          <Text style={styles.saved} testID="policy-saved">
            ✓ ポリシーを保存しました
          </Text>
        )}

        <Text style={styles.sectionTitle}>監査ログ</Text>
        {logQ.isLoading ? (
          <Text style={styles.muted}>ログを読み込み中…</Text>
        ) : (
          <AutonomousLogList records={logQ.data ?? []} />
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: COLOR.bgPrimary },
  container: { padding: SPACE.md, gap: SPACE.md, paddingBottom: SPACE.xxl },
  headerRow: { flexDirection: "row", alignItems: "center" },
  backLink: {
    fontFamily: FONT.body,
    fontSize: FONT_SIZE.bodyMD,
    color: COLOR.sodaText,
    fontWeight: WEIGHT.semibold,
  },
  title: {
    fontFamily: FONT.heading,
    fontSize: FONT_SIZE.displaySM,
    fontWeight: WEIGHT.bold,
    color: COLOR.textPrimary,
  },
  subtitle: {
    fontFamily: FONT.body,
    fontSize: FONT_SIZE.bodyMD,
    color: COLOR.textSubtitle,
    marginTop: -SPACE.sm,
  },
  sectionTitle: {
    fontFamily: FONT.heading,
    fontSize: FONT_SIZE.headingLG,
    fontWeight: WEIGHT.bold,
    color: COLOR.textPrimary,
    marginTop: SPACE.sm,
  },
  muted: {
    fontFamily: FONT.body,
    fontSize: FONT_SIZE.bodyMD,
    color: COLOR.textMuted,
  },
  error: {
    fontFamily: FONT.body,
    fontSize: FONT_SIZE.bodyMD,
    color: COLOR.cherryDark,
  },
  saved: {
    fontFamily: FONT.body,
    fontSize: FONT_SIZE.bodySM,
    color: COLOR.melonText,
    fontWeight: WEIGHT.semibold,
  },
});
