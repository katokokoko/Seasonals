/**
 * AutonomousStatusCard — 自律オプションの現在状態 + kill/resume (Phase 8.30)
 *
 * BFF `/autonomous/status` を描画する管制盤の最上段。「AI は今 armed か / 今日
 * いくら動いたか / 絶対上限は」を一目で示し、緊急停止 (kill) / 再開 (resume) の
 * ボタンを内包する。§32.2: delegate_pubkey は pubkey のみ表示 (secret 非表示)。
 *
 * ハード上限は user policy と独立 (policy が無制限でも超えられない、§29.3)。
 */

import { Pressable, StyleSheet, Text, View } from "react-native";

import {
  COLOR,
  FONT,
  FONT_SIZE,
  RADIUS,
  SPACE,
  WEIGHT,
} from "@workspace/lib/design-system";
import type { AutonomousStatus } from "@workspace/lib/types";
import { formatUsd, toHumanReadable } from "@workspace/lib/utils/numeric";

function truncPubkey(pubkey: string | null): string {
  if (!pubkey) return "—";
  return pubkey.length > 12
    ? `${pubkey.slice(0, 4)}…${pubkey.slice(-4)}`
    : pubkey;
}

function StatusChip({
  label,
  tone,
}: {
  label: string;
  tone: "armed" | "stopped" | "muted";
}): React.JSX.Element {
  const color =
    tone === "armed"
      ? COLOR.melonText
      : tone === "stopped"
        ? COLOR.cherryDark
        : COLOR.textMuted;
  return (
    <View style={[styles.chip, { borderColor: color }]}>
      <Text style={[styles.chipText, { color }]}>{label}</Text>
    </View>
  );
}

function Row({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}): React.JSX.Element {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={[styles.rowValue, mono && styles.mono]}>{value}</Text>
    </View>
  );
}

export interface AutonomousStatusCardProps {
  status: AutonomousStatus;
  onKill: () => void;
  onResume: () => void;
  busy?: boolean;
}

export function AutonomousStatusCard({
  status,
  onKill,
  onResume,
  busy = false,
}: AutonomousStatusCardProps): React.JSX.Element {
  const chip = status.killed
    ? { label: "STOPPED", tone: "stopped" as const }
    : status.enabled
      ? { label: "ARMED", tone: "armed" as const }
      : { label: "DISARMED", tone: "muted" as const };

  const maxSol = toHumanReadable(status.hard_caps.max_lamports, 9);

  return (
    <View style={styles.card} testID="autonomous-status-card">
      <View style={styles.headerRow}>
        <Text style={styles.title}>Autonomous status</Text>
        <StatusChip label={chip.label} tone={chip.tone} />
      </View>

      <Row
        label="Feature flag"
        value={status.feature_flag ? "ON" : "OFF"}
      />
      <Row label="Network" value={status.devnet ? "devnet" : "⚠ non-devnet"} />
      <Row label="Delegate key" value={truncPubkey(status.delegate_pubkey)} mono />
      <Row
        label="Executions today"
        value={`${status.daily_count} / ${status.daily_limit}`}
      />

      <View style={styles.capsBox}>
        <Text style={styles.capsTitle}>Hard caps (independent of policy)</Text>
        <Row label="Per tx" value={formatUsd(status.hard_caps.max_tx_usd8)} />
        <Row label="Per day" value={`${status.hard_caps.max_daily}`} />
        <Row label="Per tx (lamports)" value={`${maxSol} SOL`} />
      </View>

      {status.killed ? (
        <Pressable
          accessibilityRole="button"
          disabled={busy}
          onPress={onResume}
          style={[styles.cta, styles.ctaResume, busy && styles.ctaDisabled]}
          testID="autonomous-resume"
        >
          <Text style={styles.ctaResumeText}>
            {busy ? "…" : "Resume"}
          </Text>
        </Pressable>
      ) : (
        <Pressable
          accessibilityRole="button"
          disabled={busy}
          onPress={onKill}
          style={[styles.cta, styles.ctaKill, busy && styles.ctaDisabled]}
          testID="autonomous-kill"
        >
          <Text style={styles.ctaKillText}>
            {busy ? "…" : "Kill switch"}
          </Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: COLOR.textOnColor,
    borderRadius: RADIUS.lg,
    borderWidth: 1,
    borderColor: COLOR.border,
    padding: SPACE.md,
    gap: SPACE.xs,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: SPACE.xs,
  },
  title: {
    fontFamily: FONT.heading,
    fontSize: FONT_SIZE.headingMD,
    fontWeight: WEIGHT.bold,
    color: COLOR.textPrimary,
  },
  chip: {
    borderWidth: 1.5,
    borderRadius: RADIUS.pill,
    paddingHorizontal: SPACE.sm,
    paddingVertical: 2,
  },
  chipText: {
    fontFamily: FONT.body,
    fontSize: FONT_SIZE.caption,
    fontWeight: WEIGHT.bold,
    letterSpacing: 0.5,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 3,
  },
  rowLabel: {
    fontFamily: FONT.body,
    fontSize: FONT_SIZE.bodyMD,
    color: COLOR.textSubtitle,
  },
  rowValue: {
    fontFamily: FONT.body,
    fontSize: FONT_SIZE.bodyMD,
    fontWeight: WEIGHT.semibold,
    color: COLOR.textPrimary,
  },
  mono: { fontFamily: FONT.mono, fontSize: FONT_SIZE.bodySM },
  capsBox: {
    marginTop: SPACE.sm,
    padding: SPACE.sm,
    borderRadius: RADIUS.md,
    backgroundColor: COLOR.divider,
    gap: 2,
  },
  capsTitle: {
    fontFamily: FONT.body,
    fontSize: FONT_SIZE.caption,
    fontWeight: WEIGHT.semibold,
    color: COLOR.textMuted,
    marginBottom: SPACE.xs,
  },
  cta: {
    marginTop: SPACE.md,
    borderRadius: RADIUS.md,
    paddingVertical: SPACE.sm + 2,
    alignItems: "center",
  },
  ctaKill: { backgroundColor: COLOR.cherryDark },
  ctaKillText: {
    fontFamily: FONT.heading,
    fontSize: FONT_SIZE.bodyLG,
    fontWeight: WEIGHT.bold,
    color: COLOR.textOnColor,
  },
  ctaResume: { backgroundColor: COLOR.melonText },
  ctaResumeText: {
    fontFamily: FONT.heading,
    fontSize: FONT_SIZE.bodyLG,
    fontWeight: WEIGHT.bold,
    color: COLOR.textOnColor,
  },
  ctaDisabled: { opacity: 0.5 },
});
