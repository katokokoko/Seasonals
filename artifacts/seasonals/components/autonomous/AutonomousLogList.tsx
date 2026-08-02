/**
 * AutonomousLogList — 自律実行の監査ログ (Phase 8.30)
 *
 * BFF `/autonomous/log` の `AutonomousExecutionRecord[]` (newest-first) を描画。
 * decision を色分け (executed=melon / dry_run=soda / rejected=cherry)、
 * confirmed 署名は devnet explorer リンク、reject は violations を示す。
 * 「留守中に AI が何をしたか」を人が確認する面。
 */

import { Linking, Pressable, StyleSheet, Text, View } from "react-native";

import {
  COLOR,
  FONT,
  FONT_SIZE,
  RADIUS,
  SPACE,
  WEIGHT,
} from "@workspace/lib/design-system";
import type { AutonomousExecutionRecord } from "@workspace/lib/types";
import { formatUsd } from "@workspace/lib/utils/numeric";

function decisionColor(decision: AutonomousExecutionRecord["decision"]): string {
  switch (decision) {
    case "executed":
      return COLOR.melonText;
    case "dry_run":
      return COLOR.sodaText;
    case "rejected":
    default:
      return COLOR.cherryDark;
  }
}

function shortTime(iso: string): string {
  // ISO 8601 → "YYYY-MM-DD HH:MM" (表示のみ、tz 変換なし)
  return iso.length >= 16 ? iso.slice(0, 16).replace("T", " ") : iso;
}

function LogRow({
  rec,
}: {
  rec: AutonomousExecutionRecord;
}): React.JSX.Element {
  const color = decisionColor(rec.decision);
  const target =
    rec.protocol && rec.asset
      ? `${rec.protocol} · ${rec.asset}`
      : (rec.protocol ?? rec.asset ?? "—");

  const openExplorer = (): void => {
    if (!rec.tx_signature) return;
    void Linking.openURL(
      `https://explorer.solana.com/tx/${rec.tx_signature}?cluster=devnet`
    );
  };

  return (
    <View style={styles.row} testID={`autonomous-log-${rec.record_id}`}>
      <View style={styles.rowHeader}>
        <View style={[styles.decisionDot, { backgroundColor: color }]} />
        <Text style={[styles.decision, { color }]}>{rec.decision}</Text>
        <Text style={styles.time}>{shortTime(rec.created_at)}</Text>
      </View>

      <View style={styles.rowBody}>
        <Text style={styles.target}>{target}</Text>
        <Text style={styles.amount}>{formatUsd(rec.amount_usd8)}</Text>
      </View>

      {rec.tx_signature ? (
        <Pressable
          accessibilityRole="link"
          onPress={openExplorer}
          testID={`autonomous-log-sig-${rec.record_id}`}
        >
          <Text style={styles.sig}>
            sig {rec.tx_signature.slice(0, 8)}… ↗ explorer
          </Text>
        </Pressable>
      ) : rec.reason ? (
        <Text style={styles.reason}>{rec.reason}</Text>
      ) : null}

      {rec.violations.length > 0 && (
        <Text style={styles.violations}>
          {rec.violations.join(", ")}
        </Text>
      )}
    </View>
  );
}

export interface AutonomousLogListProps {
  records: AutonomousExecutionRecord[];
}

export function AutonomousLogList({
  records,
}: AutonomousLogListProps): React.JSX.Element {
  if (records.length === 0) {
    return (
      <View style={styles.empty} testID="autonomous-log-empty">
        <Text style={styles.emptyText}>No autonomous runs recorded yet</Text>
      </View>
    );
  }
  return (
    <View style={styles.list} testID="autonomous-log-list">
      {records.map((rec) => (
        <LogRow key={rec.record_id} rec={rec} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  list: { gap: SPACE.sm },
  row: {
    backgroundColor: COLOR.textOnColor,
    borderRadius: RADIUS.md,
    borderWidth: 1,
    borderColor: COLOR.border,
    padding: SPACE.sm + 2,
    gap: 4,
  },
  rowHeader: { flexDirection: "row", alignItems: "center", gap: SPACE.xs },
  decisionDot: { width: 8, height: 8, borderRadius: 4 },
  decision: {
    fontFamily: FONT.body,
    fontSize: FONT_SIZE.bodySM,
    fontWeight: WEIGHT.bold,
    textTransform: "uppercase",
    letterSpacing: 0.3,
  },
  time: {
    marginLeft: "auto",
    fontFamily: FONT.mono,
    fontSize: FONT_SIZE.caption,
    color: COLOR.textMuted,
  },
  rowBody: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  target: {
    fontFamily: FONT.body,
    fontSize: FONT_SIZE.bodyMD,
    fontWeight: WEIGHT.semibold,
    color: COLOR.textPrimary,
  },
  amount: {
    fontFamily: FONT.body,
    fontSize: FONT_SIZE.bodyMD,
    fontWeight: WEIGHT.bold,
    color: COLOR.textSubtitle,
  },
  sig: {
    fontFamily: FONT.mono,
    fontSize: FONT_SIZE.caption,
    color: COLOR.sodaText,
  },
  reason: {
    fontFamily: FONT.body,
    fontSize: FONT_SIZE.bodySM,
    color: COLOR.textMuted,
  },
  violations: {
    fontFamily: FONT.body,
    fontSize: FONT_SIZE.caption,
    color: COLOR.cherryDark,
  },
  empty: {
    padding: SPACE.lg,
    alignItems: "center",
  },
  emptyText: {
    fontFamily: FONT.body,
    fontSize: FONT_SIZE.bodyMD,
    color: COLOR.textMuted,
  },
});
