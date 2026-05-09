/**
 * WarningArea — 仕様書 §8.5 / §8.7
 *
 * 実行確認モーダルおよび MCP Approval Push において、oracle 異常 / simulation
 * 警告をユーザーが**確実に視認できる位置**に表示するコンポーネント。
 *
 * §32.2 整合性チェック「warning は素通りしない」を実装で担保する核要素。
 *
 * 設計原則:
 * - oracle_warning は CTA 直上に強警告として表示 (アイコン + 見出し + 本文)
 * - simulation_warning は subtle 表示 (詳細セクション内)
 * - oracle_warning がある場合、CTA を `grayoutMs` (default 1000ms) グレーアウト
 * - CTA は本コンポーネントの `renderCta` prop 経由でしか出せない (誤用防止)
 * - oracle_block (>5% 乖離 / 両 stale) は §4.6 で execute 自体が拒否されるため、
 *   そもそもモーダルに到達しない → 本コンポーネントでは扱わない
 *
 * 計測フック (§29.2 / §17.2 安全運用 KPI):
 * - 警告理解率 = onWarningShown 〜 onWarningDismissed 間の時間
 * - 実行完了率 = onCtaEnabled 後の CTA タップ率 (親側で計測)
 * - CTA グレーアウト時間別の実行完了率 (grayoutMs A/B テスト用)
 *
 * @see docs/spec.md §8.5 (実行確認モーダル / Warning area の表示規約)
 * @see docs/spec.md §8.7 (MCP Approval Push Screen)
 * @see docs/spec.md §4.6 (oracle 規約 / fail-closed)
 * @see docs/spec.md §29.2 (UX テスト)
 */

import React, { useEffect, useRef, useState, type ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";
import * as Haptics from "expo-haptics";

import {
  COLOR,
  FONT,
  FONT_SIZE,
  WEIGHT,
  SPACE,
  RADIUS,
  withAlpha,
} from "@workspace/lib/design-system";

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * oracle warning の種別 (§4.6)。
 * - `oracle_divergence_warning`: Pyth ↔ Switchboard の価格乖離が 2-5%
 * - `oracle_pyth_stale`: Pyth が >60秒 stale、Switchboard を fallback 使用中
 * - `oracle_switchboard_stale`: Switchboard が >60秒 stale、Pyth を使用中 (rare)
 *
 * NOTE: 両 stale / >5% 乖離は §4.6 fail-closed で execute 拒否されるため、
 *       本 component には到達しない。
 */
export type OracleWarningKind =
  | "oracle_divergence_warning"
  | "oracle_pyth_stale"
  | "oracle_switchboard_stale";

export interface OracleWarning {
  kind: OracleWarningKind;
  /** 乖離率 (%)。`oracle_divergence_warning` で必須 */
  divergencePct?: number;
  /** Pyth の最終更新からの経過秒数。`oracle_pyth_stale` で必須 */
  pythAgeSeconds?: number;
  /** Switchboard の最終更新からの経過秒数。`oracle_switchboard_stale` で必須 */
  switchboardAgeSeconds?: number;
}

export interface SimulationWarning {
  /** warning 種別の machine-readable identifier (analytics 用) */
  kind: string;
  /** 表示メッセージ (i18n 済み想定) */
  message: string;
}

export interface WarningAreaAnalytics {
  /** 警告が画面に表示された時 (kinds は oracle / simulation の混合) */
  onWarningShown?: (kinds: string[]) => void;
  /** 警告画面が unmount された時 (durationMs = 表示継続時間) */
  onWarningDismissed?: (durationMs: number) => void;
  /** CTA が grayout を抜けて enable された時 */
  onCtaEnabled?: () => void;
}

export interface WarningAreaProps {
  /** §4.6 oracle 由来の強警告 */
  oracleWarnings: OracleWarning[];
  /** simulation 由来の subtle 警告 (APY 変動 / forecast 不確実性等) */
  simulationWarnings?: SimulationWarning[];
  /**
   * CTA グレーアウト時間 (ms)。default 1000ms (§8.5)。
   * §17.2 / §29.2 で A/B テスト対象。本番では feature flag で動的に切り替え可能に
   * しておくこと。`oracleWarnings` が空の場合はグレーアウトされない。
   */
  grayoutMs?: number;
  /**
   * CTA を render する関数。WarningArea が grayout 状態を制御するため、
   * CTA は必ずこの prop 経由で出す (誤用防止)。
   *
   * @example
   *   <WarningArea
   *     oracleWarnings={...}
   *     renderCta={({ disabled }) => (
   *       <SignButton onPress={...} disabled={disabled} />
   *     )}
   *   />
   */
  renderCta: (state: { disabled: boolean }) => ReactNode;
  /** 計測フック (任意) */
  analytics?: WarningAreaAnalytics;
  /** test 用 ID */
  testID?: string;
  /** Haptics を発火するか (default true、test 環境で false にする想定) */
  hapticsEnabled?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal: 表示文の生成
// ─────────────────────────────────────────────────────────────────────────────

const ORACLE_WARNING_HEADLINE: Record<OracleWarningKind, string> = {
  oracle_divergence_warning: "価格 oracle に異常を検出",
  oracle_pyth_stale: "Pyth が古い価格を返しています",
  oracle_switchboard_stale: "Switchboard が古い価格を返しています",
};

function buildOracleWarningBody(w: OracleWarning): string {
  switch (w.kind) {
    case "oracle_divergence_warning":
      return w.divergencePct !== undefined
        ? `Pyth と Switchboard の価格が ${w.divergencePct.toFixed(1)}% 乖離しています`
        : "Pyth と Switchboard の価格が乖離しています";
    case "oracle_pyth_stale":
      return w.pythAgeSeconds !== undefined
        ? `Pyth の最終更新から ${Math.floor(w.pythAgeSeconds)} 秒経過。Switchboard を使用中`
        : "Pyth が古いため Switchboard を使用しています";
    case "oracle_switchboard_stale":
      return w.switchboardAgeSeconds !== undefined
        ? `Switchboard の最終更新から ${Math.floor(w.switchboardAgeSeconds)} 秒経過。Pyth を使用中`
        : "Switchboard が古いため Pyth を使用しています";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// WarningArea component
// ─────────────────────────────────────────────────────────────────────────────

export function WarningArea({
  oracleWarnings,
  simulationWarnings = [],
  grayoutMs = 1000,
  renderCta,
  analytics,
  testID,
  hapticsEnabled = true,
}: WarningAreaProps) {
  const hasOracleWarning = oracleWarnings.length > 0;
  const [isCtaReady, setIsCtaReady] = useState(!hasOracleWarning);
  const mountTimeRef = useRef<number>(Date.now());
  const hasFiredCtaEnabledRef = useRef<boolean>(false);

  // mount / unmount での analytics 発火
  useEffect(() => {
    const kinds = [
      ...oracleWarnings.map((w) => w.kind),
      ...simulationWarnings.map((w) => w.kind),
    ];
    if (kinds.length > 0) {
      analytics?.onWarningShown?.(kinds);
    }
    const mountedAt = mountTimeRef.current;
    return () => {
      if (kinds.length > 0) {
        const elapsed = Date.now() - mountedAt;
        analytics?.onWarningDismissed?.(elapsed);
      }
    };
    // 警告内容が動的に変わる UI ではないため mount/unmount のみで発火
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // CTA grayout タイマー
  useEffect(() => {
    if (!hasOracleWarning) {
      // oracle warning が無くなった場合は即時 enable
      setIsCtaReady(true);
      return;
    }
    setIsCtaReady(false);
    const timer = setTimeout(() => {
      setIsCtaReady(true);
      if (!hasFiredCtaEnabledRef.current) {
        hasFiredCtaEnabledRef.current = true;
        analytics?.onCtaEnabled?.();
        if (hapticsEnabled) {
          // CTA が押せるようになったことを subtle haptic で通知
          // expo-haptics が unavailable な環境 (Web 等) では catch して握りつぶす
          Haptics.selectionAsync().catch(() => {});
        }
      }
    }, grayoutMs);
    return () => clearTimeout(timer);
  }, [hasOracleWarning, grayoutMs, analytics, hapticsEnabled]);

  return (
    <View testID={testID} style={styles.container}>
      {/* simulation warnings (subtle / 詳細セクション内) */}
      {simulationWarnings.length > 0 && (
        <View
          style={styles.simulationContainer}
          testID={testID ? `${testID}-simulation` : undefined}
        >
          {simulationWarnings.map((w, i) => (
            <View
              key={`sim-${i}-${w.kind}`}
              style={styles.simulationItem}
              testID={testID ? `${testID}-simulation-${i}` : undefined}
            >
              <Text style={styles.simulationIcon}>ℹ️</Text>
              <Text style={styles.simulationText}>{w.message}</Text>
            </View>
          ))}
        </View>
      )}

      {/* oracle warnings (CTA 直上、強警告) */}
      {hasOracleWarning && (
        <View
          style={styles.oracleContainer}
          accessible
          accessibilityRole="alert"
          accessibilityLabel={`価格 oracle に ${oracleWarnings.length} 件の異常があります`}
          testID={testID ? `${testID}-oracle` : undefined}
        >
          {oracleWarnings.map((w, i) => (
            <View
              key={`oracle-${i}-${w.kind}`}
              style={[styles.oracleItem, i > 0 && styles.oracleItemSpaced]}
              testID={testID ? `${testID}-oracle-${i}` : undefined}
            >
              <View style={styles.oracleHeader}>
                <Text style={styles.oracleIcon}>⚠️</Text>
                <Text style={styles.oracleHeadline}>
                  {ORACLE_WARNING_HEADLINE[w.kind]}
                </Text>
              </View>
              <Text style={styles.oracleBody}>{buildOracleWarningBody(w)}</Text>
            </View>
          ))}
        </View>
      )}

      {/* CTA (warning area 直下に固定配置) */}
      <View
        style={styles.ctaContainer}
        testID={testID ? `${testID}-cta-slot` : undefined}
      >
        {renderCta({ disabled: !isCtaReady })}
      </View>
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    width: "100%",
  },

  // ── simulation (subtle) ──
  simulationContainer: {
    marginBottom: SPACE.md,
    paddingHorizontal: SPACE.sm,
    paddingVertical: SPACE.sm,
    borderRadius: RADIUS.sm,
    // sodaLight (#E0F7FA) を 40% alpha 重ねで subtle 背景に (旧 sodaLightBg と等価)
    backgroundColor: withAlpha(COLOR.sodaLight, 0.4),
    borderWidth: 1,
    borderColor: COLOR.border,
    gap: SPACE.xs,
  },
  simulationItem: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: SPACE.xs,
  },
  simulationIcon: {
    fontSize: 14,
    lineHeight: 18,
  },
  simulationText: {
    flex: 1,
    fontSize: FONT_SIZE.bodySM,
    fontFamily: FONT.body,
    fontWeight: WEIGHT.regular,
    color: COLOR.textSubtitle,
    lineHeight: 18,
  },

  // ── oracle (strong, CTA 直上) ──
  oracleContainer: {
    marginBottom: SPACE.md,
    padding: SPACE.md,
    borderRadius: RADIUS.md,
    // cherry (#E57373) を 12% alpha で淡赤背景に (旧 cherryLight と等価)
    backgroundColor: withAlpha(COLOR.cherry, 0.12),
    borderWidth: 1.5,
    borderColor: COLOR.cherry,
    // 視認性確保のため、最小高さを担保 (§8.5「必ず視認できる高さを確保」)
    minHeight: 56,
  },
  oracleItem: {
    width: "100%",
  },
  oracleItemSpaced: {
    marginTop: SPACE.sm,
    paddingTop: SPACE.sm,
    borderTopWidth: 1,
    borderTopColor: COLOR.borderStrong,
  },
  oracleHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: SPACE.sm,
    marginBottom: SPACE.xs,
  },
  oracleIcon: {
    fontSize: 20,
    lineHeight: 24,
  },
  oracleHeadline: {
    flex: 1,
    fontSize: FONT_SIZE.headingSM,
    fontFamily: FONT.heading,
    fontWeight: WEIGHT.bold,
    color: COLOR.cherryDark,
  },
  oracleBody: {
    fontSize: FONT_SIZE.bodyMD,
    fontFamily: FONT.body,
    fontWeight: WEIGHT.medium,
    color: COLOR.textPrimary,
    lineHeight: 20,
  },

  // ── CTA slot ──
  ctaContainer: {
    width: "100%",
  },
});
