/**
 * Dev probe — wallet 接続 + テスト push 発射 (本番 UI からは hidden、home top-right の
 * 🔧 button から到達)。
 *
 * 元は app/(tabs)/probe.tsx。tab navigation 撤去に伴い top-level route に移管。
 */

import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Link } from "expo-router";

import {
  COLOR,
  FONT,
  FONT_SIZE,
  RADIUS,
  SPACE,
  WEIGHT,
} from "@workspace/lib/design-system";

import { useWallet } from "../services/useWallet";
import { scheduleLocalApprovalNotification } from "../services/push";

export default function Probe() {
  const { authorization, status, error, isConnected, connect, disconnect } =
    useWallet();

  const handleConnect = async () => {
    try {
      await connect();
    } catch {
      /* state に反映済 */
    }
  };

  const handleDisconnect = async () => {
    try {
      await disconnect();
    } catch {
      /* noop */
    }
  };

  const handleSendTestPush = async () => {
    try {
      await scheduleLocalApprovalNotification({});
    } catch {
      /* dev 用、握りつぶす */
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
      <ScrollView contentContainerStyle={styles.container}>
        <View style={styles.headerRow}>
          <Link href="/" asChild>
            <Pressable hitSlop={8} accessibilityRole="button">
              <Text style={styles.backLink}>← home</Text>
            </Pressable>
          </Link>
        </View>

        <Text style={styles.title}>MWA probe</Text>
        <Text style={styles.subtitle}>Devnet wallet connection check</Text>

        <View style={styles.card}>
          <Row label="Status" value={status} testID="probe-status" />
          {error && <Row label="Error" value={error} accent="error" />}
          {isConnected && authorization && (
            <>
              <Row
                label="Wallet label"
                value={authorization.label ?? "(no label)"}
              />
              <Row
                label="Address (base58)"
                value={authorization.address}
                mono
                testID="probe-address"
              />
              <Row label="Chain" value={authorization.chain} />
            </>
          )}
        </View>

        <View style={styles.ctaArea}>
          {!isConnected ? (
            <Pressable
              accessibilityRole="button"
              disabled={status === "connecting"}
              onPress={handleConnect}
              style={[
                styles.cta,
                styles.ctaPrimary,
                status === "connecting" && styles.ctaDisabled,
              ]}
              testID="probe-connect"
            >
              <Text style={styles.ctaPrimaryText}>
                {status === "connecting" ? "Connecting…" : "Connect wallet"}
              </Text>
            </Pressable>
          ) : (
            <Pressable
              accessibilityRole="button"
              onPress={handleDisconnect}
              style={[styles.cta, styles.ctaSecondary]}
              testID="probe-disconnect"
            >
              <Text style={styles.ctaSecondaryText}>Disconnect</Text>
            </Pressable>
          )}
        </View>

        {__DEV__ && (
          <View style={styles.devSection}>
            <Text style={styles.devLabel}>dev tools</Text>
            <Pressable
              accessibilityRole="button"
              onPress={handleSendTestPush}
              style={[styles.cta, styles.ctaSecondary]}
              testID="probe-test-push"
            >
              <Text style={styles.ctaSecondaryText}>Send test push</Text>
            </Pressable>
            <Text style={styles.hint}>
              Fires a local notification with a fixture AgentPlan /
              ApprovalToken. Tapping it opens /approval/[planId] and shows
              MCPApprovalPushCard.
            </Text>
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function Row({
  label,
  value,
  accent,
  mono,
  testID,
}: {
  label: string;
  value: string;
  accent?: "error";
  mono?: boolean;
  testID?: string;
}) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text
        style={[
          styles.rowValue,
          mono && styles.rowValueMono,
          accent === "error" && styles.rowValueError,
        ]}
        testID={testID}
        selectable
      >
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: COLOR.bgPrimary,
  },
  container: {
    paddingHorizontal: SPACE.lg,
    paddingVertical: SPACE.lg,
    gap: SPACE.md,
  },
  headerRow: {
    flexDirection: "row",
  },
  backLink: {
    fontSize: FONT_SIZE.bodyMD,
    fontFamily: FONT.heading,
    fontWeight: WEIGHT.semibold,
    color: COLOR.sodaText,
  },
  title: {
    fontSize: FONT_SIZE.displaySM,
    fontFamily: FONT.heading,
    fontWeight: WEIGHT.bold,
    color: COLOR.textPrimary,
  },
  subtitle: {
    fontSize: FONT_SIZE.bodyMD,
    fontFamily: FONT.body,
    fontWeight: WEIGHT.regular,
    color: COLOR.textSubtitle,
    marginBottom: SPACE.sm,
  },
  card: {
    paddingHorizontal: SPACE.md,
    paddingVertical: SPACE.md,
    borderRadius: RADIUS.lg,
    backgroundColor: COLOR.bgCard,
    borderWidth: 1,
    borderColor: COLOR.border,
    gap: SPACE.sm,
  },
  row: {
    gap: SPACE.xs,
  },
  rowLabel: {
    fontSize: FONT_SIZE.caption,
    fontFamily: FONT.body,
    fontWeight: WEIGHT.medium,
    color: COLOR.textMuted,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  rowValue: {
    fontSize: FONT_SIZE.bodyMD,
    fontFamily: FONT.heading,
    fontWeight: WEIGHT.semibold,
    color: COLOR.textPrimary,
  },
  rowValueMono: {
    fontFamily: FONT.mono,
    fontSize: FONT_SIZE.bodySM,
  },
  rowValueError: {
    color: COLOR.cherryDark,
  },
  ctaArea: {
    marginTop: SPACE.sm,
  },
  cta: {
    paddingVertical: SPACE.md,
    borderRadius: RADIUS.md,
    alignItems: "center",
    justifyContent: "center",
    minHeight: 48,
  },
  ctaPrimary: {
    backgroundColor: COLOR.sodaText,
  },
  ctaPrimaryText: {
    fontSize: FONT_SIZE.bodyLG,
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
    fontSize: FONT_SIZE.bodyLG,
    fontFamily: FONT.heading,
    fontWeight: WEIGHT.semibold,
    color: COLOR.textSubtitle,
  },
  ctaDisabled: {
    opacity: 0.5,
  },
  hint: {
    fontSize: FONT_SIZE.caption,
    fontFamily: FONT.body,
    fontWeight: WEIGHT.regular,
    color: COLOR.textMuted,
    lineHeight: 18,
  },
  devSection: {
    marginTop: SPACE.xl,
    paddingTop: SPACE.md,
    borderTopWidth: 1,
    borderTopColor: COLOR.divider,
    gap: SPACE.sm,
  },
  devLabel: {
    fontSize: FONT_SIZE.overline,
    fontFamily: FONT.body,
    fontWeight: WEIGHT.bold,
    color: COLOR.textMuted,
    textTransform: "uppercase",
    letterSpacing: 1,
  },
});
