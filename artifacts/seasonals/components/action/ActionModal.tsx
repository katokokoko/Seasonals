/**
 * ActionModal — calendar から approve → MWA sign → Devnet broadcast までの flow
 *
 * 5 phase の state machine:
 *   review     : plan summary + 「署名して実行」 (default 表示)
 *   approving  : BFF へ POST /agent-plans/:id/approve
 *   signing    : Phantom / Seed Vault で sign + broadcast
 *   success    : Devnet signature + Explorer link
 *   error      : 失敗詳細 + retry
 *
 * BFF から返ってきた tx (base64) を Transaction.from で復元、MWA に渡して
 * Phantom が internally に Devnet RPC へ broadcast する (Mobile 側に Connection
 * を持たせない、CLAUDE.md §32.2 fail-closed safety 準拠)。
 */

import React, { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Dimensions,
  Linking,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { BlurView } from "expo-blur";
import { Transaction, VersionedTransaction } from "@solana/web3.js";

import {
  FONT,
  FONT_SIZE,
  RADIUS,
  SPACE,
  WEIGHT,
  withAlpha,
} from "@workspace/lib/design-system";
import {
  TOKEN_DECIMALS,
  formatPercentage,
  toHumanReadable,
} from "@workspace/lib/utils/numeric";
import type { AgentPlan } from "@workspace/lib/types";

import {
  useApproveAgentPlan,
  useJupiterQuote,
  useKaminoReserves,
} from "../../services/queries";
import { useWallet } from "../../services/useWallet";
import {
  signAndSendTransactions,
  signTransactions,
} from "../../services/mwa";
import { USE_ONCHAIN } from "../../services/config";
import * as api from "../../services/api";
import { useQueryClient } from "@tanstack/react-query";
import {
  JUPITER_MINTS,
  JUPITER_TOKEN_DECIMALS,
} from "@workspace/lib/adapters";
import {
  useThemeColors,
  useThemedStyles,
  type ThemeColors,
} from "../../stores/theme";

type Phase = "review" | "approving" | "signing" | "success" | "error";

// Phase 6.4: backdrop fade-in + blur、sheet slide-up、別々アニメ
const SCREEN_H = Dimensions.get("window").height;
const ENTER_MS = 240;
const EXIT_MS = 200;

function resolveDecimals(asset?: string): number {
  if (asset && asset in TOKEN_DECIMALS) {
    return (TOKEN_DECIMALS as Record<string, number>)[asset]!;
  }
  return 6;
}

function shortenSig(sig: string): string {
  if (sig.length <= 14) return sig;
  return `${sig.slice(0, 8)}…${sig.slice(-6)}`;
}

export interface ActionModalProps {
  /** 表示中の AgentPlan。null なら modal 非表示 */
  plan: AgentPlan | null;
  onClose: () => void;
  /** approve mutation 成功時、呼び出し側で flash / refresh トリガー用 */
  onSettled?: (updated: AgentPlan) => void;
  testID?: string;
}

export function ActionModal({
  plan,
  onClose,
  onSettled,
  testID,
}: ActionModalProps) {
  // Phase 8.0: theme 連動 styles
  const styles = useThemedStyles(makeStyles);

  const [phase, setPhase] = useState<Phase>("review");
  const [signature, setSignature] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const approveMutation = useApproveAgentPlan();
  const { authorization, isConnected } = useWallet();
  const queryClient = useQueryClient();

  const reset = useCallback(() => {
    setPhase("review");
    setSignature(null);
    setErrorMsg(null);
  }, []);

  const handleClose = useCallback(() => {
    reset();
    onClose();
  }, [onClose, reset]);

  const handleExecute = useCallback(async () => {
    if (!plan) return;
    setErrorMsg(null);

    const action = plan.selected_action;
    // Phase 8.5.1: Menu fixture の protocol_id は "jupiter" (catalog 上の単一エントリ)
    // で、EarnPosition では "jupiter_lend"。pool tap 由来の synthetic plan には
    // どちらが入っても deposit path を起動できるよう両方マッチさせる。
    const isJupiterLendAction =
      action?.protocol === "jupiter_lend" || action?.protocol === "jupiter";
    const isOnchainJupiterLendDeposit =
      USE_ONCHAIN &&
      isConnected &&
      authorization &&
      isJupiterLendAction &&
      action?.action_type === "deposit" &&
      action?.amount &&
      action?.asset;

    // ── Phase 8.5: onchain + Jupiter Lend deposit は実 mainnet swap path ──
    if (isOnchainJupiterLendDeposit) {
      // Phase 8.6: Jupiter Lend Earn の 7 markets underlying mint
      const ASSET_MINTS: Record<string, string> = {
        USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        SOL: "So11111111111111111111111111111111111111112",
        USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
        EURC: "HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr",
        USDS: "USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA",
        USDG: "2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH",
        JupUSD: "JuprjznTrTSp2UFa3ZBUFgwdAmtZCq4MQCwysN55USD",
      };
      const inputMint = ASSET_MINTS[action!.asset!];
      if (!inputMint) {
        setErrorMsg(`Unsupported asset for Jupiter Lend: ${action!.asset}`);
        setPhase("error");
        return;
      }
      setPhase("approving");
      try {
        const swap = await api.getJupiterDepositTx({
          user: authorization!.address,
          inputMint,
          amount: action!.amount!,
          slippageBps: 50,
        });
        // Phase 8.8: sign-only + Helius RPC submit。Phantom の signAndSend が
        // empty result を返す問題 (v0 versioned tx + lookup tables) を回避。
        setPhase("signing");
        const bytes = Buffer.from(swap.swapTransaction, "base64");
        const tx = VersionedTransaction.deserialize(bytes);
        const [signedTx] = await signTransactions(authorization!, [tx]);
        if (!signedTx) {
          throw new Error("Wallet did not return a signed transaction.");
        }
        const signedBase64 = Buffer.from(signedTx.serialize()).toString(
          "base64"
        );
        const { signature } = await api.submitSignedTx(signedBase64);
        setSignature(signature);
        setPhase("success");
        // Phase 8.8.2: deposit 成功後に portfolio / earn / wallet tx を refetch。
        // BFF cache 30s + tx confirmation のタイミングで反映されるよう少し待つ。
        setTimeout(() => {
          queryClient.invalidateQueries({ queryKey: ["positions"] });
          queryClient.invalidateQueries({ queryKey: ["earn-positions"] });
          queryClient.invalidateQueries({ queryKey: ["wallet-time-events"] });
        }, 5000);
      } catch (e) {
        // Phase 8.6.1: null / 空 message を可視化 (Phantom が無応答で戻った時等)
        const raw =
          e instanceof Error ? e.message : e == null ? "" : String(e);
        const detail = e instanceof Error && e.stack ? `\n${e.stack.split("\n")[0]}` : "";
        const msg =
          raw && raw !== "null"
            ? raw + detail
            : "Wallet returned no result. Try disconnecting and reconnecting.";
        setErrorMsg(msg);
        setPhase("error");
      }
      return;
    }

    // ── Fallback path: BFF memo tx (Phase 5 / 8 までの動作) ──
    const feePayer =
      isConnected && authorization ? authorization.address : undefined;

    setPhase("approving");
    try {
      const result = await approveMutation.mutateAsync({
        plan_id: plan.plan_id,
        fee_payer: feePayer,
      });
      onSettled?.(result);

      if (!result.tx || !authorization) {
        setPhase("success");
        return;
      }

      setPhase("signing");
      const bytes = Buffer.from(result.tx, "base64");
      const tx = Transaction.from(bytes);
      const sigs = await signAndSendTransactions(authorization, [tx]);
      setSignature(sigs[0] ?? null);
      setPhase("success");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setErrorMsg(msg);
      setPhase("error");
    }
  }, [plan, isConnected, authorization, approveMutation, onSettled]);

  const visible = plan !== null;

  // Phase 6.4: backdrop fade-in、sheet slide-up を分離
  const [renderModal, setRenderModal] = useState(false);
  const backdropOpacity = useSharedValue(0);
  const sheetTy = useSharedValue(SCREEN_H);

  useEffect(() => {
    if (visible) {
      // ENTER: 同時に backdrop fade-in (位置固定) + sheet slide-up
      setRenderModal(true);
      backdropOpacity.value = withTiming(1, { duration: ENTER_MS });
      sheetTy.value = withTiming(0, { duration: ENTER_MS });
    } else if (renderModal) {
      // EXIT: backdrop fade-out + sheet slide-down → 完了で Modal を unmount
      backdropOpacity.value = withTiming(0, { duration: EXIT_MS });
      sheetTy.value = withTiming(
        SCREEN_H,
        { duration: EXIT_MS },
        (finished) => {
          "worklet";
          if (finished) runOnJS(setRenderModal)(false);
        }
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const backdropAnimStyle = useAnimatedStyle(() => ({
    opacity: backdropOpacity.value,
  }));
  const sheetAnimStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: sheetTy.value }],
  }));

  return (
    <Modal
      visible={renderModal}
      animationType="none"
      transparent
      statusBarTranslucent
      onRequestClose={handleClose}
    >
      {/* Backdrop layer: 位置固定で fade-in、blur + dim を同時表現 */}
      <Animated.View
        pointerEvents={visible ? "auto" : "none"}
        style={[StyleSheet.absoluteFill, backdropAnimStyle]}
      >
        <BlurView intensity={28} tint="dark" style={StyleSheet.absoluteFill} />
        <Pressable
          accessibilityLabel="Close"
          onPress={handleClose}
          style={[StyleSheet.absoluteFill, styles.dimOverlay]}
        />
      </Animated.View>

      {/* Sheet wrap: 画面下端に固定、sheet 自体だけ translateY で下から上昇 */}
      <View style={styles.sheetWrap} pointerEvents="box-none">
        <Animated.View style={[styles.sheet, sheetAnimStyle]} testID={testID}>
        <View style={styles.header}>
          <View>
            <Text style={styles.headerLabel}>Approve & Execute</Text>
            <Text style={styles.headerTitle}>{phaseLabel(phase)}</Text>
          </View>
          <Pressable
            accessibilityRole="button"
            onPress={handleClose}
            hitSlop={12}
            style={styles.closeBtn}
            testID={testID ? `${testID}-close` : undefined}
          >
            <Text style={styles.closeIcon}>✕</Text>
          </Pressable>
        </View>

        {plan && phase === "review" && (
          <ReviewBody
            plan={plan}
            onExecute={handleExecute}
            isConnected={isConnected}
            testID={testID ? `${testID}-review` : undefined}
          />
        )}

        {phase === "approving" && <BusyBody label="Preparing transaction…" />}

        {phase === "signing" && (
          <BusyBody label="Approve in your wallet to sign the transaction" />
        )}

        {phase === "success" && (
          <SuccessBody
            signature={signature}
            onClose={handleClose}
            testID={testID ? `${testID}-success` : undefined}
          />
        )}

        {phase === "error" && (
          <ErrorBody
            message={errorMsg ?? "unknown error"}
            onRetry={() => setPhase("review")}
            onClose={handleClose}
            testID={testID ? `${testID}-error` : undefined}
          />
        )}
        </Animated.View>
      </View>
    </Modal>
  );
}

// Phase 8.6.1: English labels for consistency with rest of UI
function phaseLabel(p: Phase): string {
  switch (p) {
    case "review":
      return "Review & approve";
    case "approving":
      return "Preparing…";
    case "signing":
      return "Signing…";
    case "success":
      return "Done";
    case "error":
      return "Failed";
  }
}

// ─── Review ──────────────────────────────────────────────────────────────────

function ReviewBody({
  plan,
  onExecute,
  isConnected,
  testID,
}: {
  plan: AgentPlan;
  onExecute: () => void;
  isConnected: boolean;
  testID?: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const action = plan.selected_action;
  const sim = plan.simulation_result;
  const decimals = resolveDecimals(action?.asset);
  const amountText =
    action?.amount && action.asset
      ? `${toHumanReadable(action.amount, decimals)} ${action.asset}`
      : "—";
  const candidate = action
    ? plan.candidate_actions.find(
        (c) =>
          c.action_spec.action_type === action.action_type &&
          c.action_spec.protocol === action.protocol
      )
    : undefined;
  const apyText =
    candidate?.estimated_apy != null
      ? formatPercentage(candidate.estimated_apy)
      : "—";
  const divergencePct = sim?.oracle?.divergence_pct ?? 0;
  const hasOracleWarning = divergencePct >= 2 && divergencePct <= 5;

  // Kamino reserve metadata (lending action 時のみ表示)
  const isKamino = action?.protocol === "kamino";
  const { data: reserves } = useKaminoReserves();
  const matchedReserve = isKamino && action?.asset
    ? reserves?.find((r) => r.asset_symbol === action.asset)
    : undefined;

  // Jupiter quote (rotate / to_protocol = jupiter のとき表示)
  const isRotate = action?.action_type === "rotate";
  const jupiterInput =
    isRotate && action?.amount && action?.asset
      ? {
          input_mint: JUPITER_MINTS[action.asset] ?? JUPITER_MINTS.USDC!,
          output_mint: JUPITER_MINTS.SOL!,
          amount: action.amount,
          slippage_bps: 50,
        }
      : null;
  const { data: jupQuote } = useJupiterQuote(jupiterInput);

  return (
    <View style={styles.body}>
      <View style={styles.summaryCard}>
        <View style={styles.summaryRow}>
          <Text style={styles.summaryProtocol}>{action?.protocol ?? "—"}</Text>
          <Text style={styles.summaryAction}>{action?.action_type ?? "—"}</Text>
        </View>
        <Text style={styles.summaryAmount}>{amountText}</Text>
        <View style={styles.metaRow}>
          <Text style={styles.metaLabel}>推定 APY</Text>
          <Text style={styles.metaValue}>{apyText}</Text>
        </View>
      </View>

      {matchedReserve && (
        <View style={styles.adapterCard} testID={testID ? `${testID}-kamino` : undefined}>
          <Text style={styles.adapterLabel}>Kamino · {matchedReserve.name}</Text>
          <View style={styles.adapterRow}>
            <Text style={styles.adapterMeta}>
              Lend: {formatPercentage(matchedReserve.lend_apy)} ·
              Borrow: {formatPercentage(matchedReserve.borrow_apy)} ·
              Util: {formatPercentage(matchedReserve.utilization)}
            </Text>
          </View>
        </View>
      )}

      {jupQuote && action?.asset && (
        <JupiterQuoteCard
          quote={jupQuote}
          inputAsset={action.asset}
          testID={testID ? `${testID}-jupiter` : undefined}
        />
      )}

      {hasOracleWarning && (
        <View style={styles.warningCard} testID={testID ? `${testID}-warning` : undefined}>
          <Text style={styles.warningIcon}>⚠️</Text>
          <Text style={styles.warningText}>
            Pyth ↔ Switchboard 価格が {divergencePct.toFixed(1)}% 乖離。実行前に再確認推奨。
          </Text>
        </View>
      )}

      {!isConnected && (
        <View style={styles.notice} testID={testID ? `${testID}-not-connected` : undefined}>
          <Text style={styles.noticeText}>
            wallet 未接続のため approve のみ実行 (sign skip)。on-chain broadcast は wallet 接続後に有効。
          </Text>
        </View>
      )}

      <Pressable
        accessibilityRole="button"
        onPress={onExecute}
        style={styles.ctaPrimary}
        testID={testID ? `${testID}-execute` : undefined}
      >
        <Text style={styles.ctaPrimaryText}>
          {isConnected ? "署名して実行" : "Approve のみ実行"}
        </Text>
      </Pressable>
    </View>
  );
}

function JupiterQuoteCard({
  quote,
  inputAsset,
  testID,
}: {
  quote: import("../../services/api").JupiterQuoteResult;
  inputAsset: string;
  testID?: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const inDecimals = JUPITER_TOKEN_DECIMALS[inputAsset] ?? 6;
  // output mint から symbol 解決
  const outputSym = Object.keys(JUPITER_MINTS).find(
    (k) => JUPITER_MINTS[k] === quote.output_mint
  ) ?? "?";
  const outDecimals = JUPITER_TOKEN_DECIMALS[outputSym] ?? 6;

  const inHuman = (Number(quote.in_amount) / Math.pow(10, inDecimals)).toFixed(4);
  const outHuman = (Number(quote.out_amount) / Math.pow(10, outDecimals)).toFixed(4);
  const minOutHuman = (
    Number(quote.min_out_amount) / Math.pow(10, outDecimals)
  ).toFixed(4);

  return (
    <View style={styles.adapterCard} testID={testID}>
      <Text style={styles.adapterLabel}>Jupiter route</Text>
      <View style={styles.adapterRow}>
        <Text style={styles.adapterAmount}>
          {inHuman} {inputAsset}
        </Text>
        <Text style={styles.adapterArrow}>→</Text>
        <Text style={styles.adapterAmount}>
          {outHuman} {outputSym}
        </Text>
      </View>
      <Text style={styles.adapterMeta}>
        最小: {minOutHuman} {outputSym} (slippage {quote.slippage_bps / 100}%)
        {quote.route.length > 0 && ` · via ${quote.route[0]!.amm_key}`}
      </Text>
    </View>
  );
}

// ─── Busy (approving / signing) ──────────────────────────────────────────────

function BusyBody({ label }: { label: string }) {
  const styles = useThemedStyles(makeStyles);
  const themeColors = useThemeColors();
  return (
    <View style={styles.busyBody}>
      <ActivityIndicator color={themeColors.sodaText} size="large" />
      <Text style={styles.busyLabel}>{label}</Text>
    </View>
  );
}

// ─── Success ─────────────────────────────────────────────────────────────────

function SuccessBody({
  signature,
  onClose,
  testID,
}: {
  signature: string | null;
  onClose: () => void;
  testID?: string;
}) {
  const styles = useThemedStyles(makeStyles);
  // Phase 8.8.1: USE_ONCHAIN は mainnet で broadcast、default APK は devnet memo tx。
  // Explorer link の cluster param を variant に追従させる。
  const explorerUrl = signature
    ? `https://explorer.solana.com/tx/${signature}${
        USE_ONCHAIN ? "" : "?cluster=devnet"
      }`
    : null;

  return (
    <View style={styles.body}>
      <View style={styles.successIconWrap}>
        <Text style={styles.successIcon}>✓</Text>
      </View>
      <Text style={styles.successTitle}>Approved & executed</Text>
      {signature ? (
        <>
          <View style={styles.signatureCard}>
            <Text style={styles.signatureLabel}>Devnet Signature</Text>
            <Text
              style={styles.signatureValue}
              selectable
              testID={testID ? `${testID}-signature` : undefined}
            >
              {shortenSig(signature)}
            </Text>
          </View>
          <Pressable
            accessibilityRole="button"
            onPress={() => explorerUrl && Linking.openURL(explorerUrl).catch(() => undefined)}
            style={styles.ctaSecondary}
          >
            <Text style={styles.ctaSecondaryText}>Open in Solana Explorer ↗</Text>
          </Pressable>
        </>
      ) : (
        <Text style={styles.successHint}>
          Plan approved (no transaction was broadcast).
        </Text>
      )}
      <Pressable
        accessibilityRole="button"
        onPress={onClose}
        style={styles.ctaPrimary}
      >
        <Text style={styles.ctaPrimaryText}>Close</Text>
      </Pressable>
    </View>
  );
}

// ─── Error ───────────────────────────────────────────────────────────────────

function ErrorBody({
  message,
  onRetry,
  onClose,
  testID,
}: {
  message: string;
  onRetry: () => void;
  onClose: () => void;
  testID?: string;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.body}>
      <View style={styles.errorIconWrap}>
        <Text style={styles.errorIcon}>!</Text>
      </View>
      <Text style={styles.errorTitle}>Transaction failed</Text>
      <Text
        style={styles.errorMessage}
        selectable
        testID={testID ? `${testID}-message` : undefined}
      >
        {message}
      </Text>
      <Pressable
        accessibilityRole="button"
        onPress={onRetry}
        style={styles.ctaPrimary}
      >
        <Text style={styles.ctaPrimaryText}>Try again</Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        onPress={onClose}
        style={styles.ctaSecondary}
      >
        <Text style={styles.ctaSecondaryText}>Close</Text>
      </Pressable>
    </View>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────

// Phase 8.0: theme 連動 styles factory。cherry / caramelDark は palette 外なので静的。
function makeStyles(c: ThemeColors) {
  return StyleSheet.create({
    dimOverlay: {
      backgroundColor: withAlpha(c.textPrimary, 0.4),
    },
    sheetWrap: {
      flex: 1,
      justifyContent: "flex-end",
    },
    sheet: {
      backgroundColor: c.bgPrimary,
      borderTopLeftRadius: RADIUS.xl,
      borderTopRightRadius: RADIUS.xl,
      paddingHorizontal: SPACE.md,
      paddingTop: SPACE.md,
      paddingBottom: SPACE.xl,
      minHeight: 280,
    },
    header: {
      flexDirection: "row",
      alignItems: "flex-start",
      justifyContent: "space-between",
      paddingBottom: SPACE.md,
      marginBottom: SPACE.sm,
      borderBottomWidth: 1,
      borderBottomColor: c.divider,
    },
    headerLabel: {
      fontSize: FONT_SIZE.caption,
      fontFamily: FONT.body,
      fontWeight: WEIGHT.medium,
      color: c.textMuted,
      textTransform: "uppercase",
      letterSpacing: 1,
    },
    headerTitle: {
      fontSize: FONT_SIZE.headingMD,
      fontFamily: FONT.heading,
      fontWeight: WEIGHT.bold,
      color: c.textPrimary,
    },
    closeBtn: {
      width: 32,
      height: 32,
      borderRadius: RADIUS.pill,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: withAlpha(c.textMuted, 0.12),
    },
    closeIcon: {
      fontSize: 16,
      color: c.textSubtitle,
      fontWeight: WEIGHT.bold,
    },
    body: {
      gap: SPACE.md,
      paddingTop: SPACE.sm,
    },
    summaryCard: {
      paddingHorizontal: SPACE.md,
      paddingVertical: SPACE.md,
      borderRadius: RADIUS.lg,
      backgroundColor: withAlpha(c.sodaLight, 0.4),
      borderWidth: 1,
      borderColor: c.border,
      gap: SPACE.sm,
    },
    summaryRow: {
      flexDirection: "row",
      alignItems: "baseline",
      justifyContent: "space-between",
    },
    summaryProtocol: {
      fontSize: FONT_SIZE.headingMD,
      fontFamily: FONT.heading,
      fontWeight: WEIGHT.bold,
      color: c.textPrimary,
      textTransform: "capitalize",
    },
    summaryAction: {
      fontSize: FONT_SIZE.caption,
      fontFamily: FONT.body,
      fontWeight: WEIGHT.medium,
      color: c.textMuted,
      textTransform: "uppercase",
      letterSpacing: 0.5,
    },
    summaryAmount: {
      fontSize: FONT_SIZE.displaySM,
      fontFamily: FONT.heading,
      fontWeight: WEIGHT.bold,
      color: c.textPrimary,
    },
    metaRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
    },
    metaLabel: {
      fontSize: FONT_SIZE.bodySM,
      fontFamily: FONT.body,
      color: c.textMuted,
    },
    metaValue: {
      fontSize: FONT_SIZE.bodyMD,
      fontFamily: FONT.heading,
      fontWeight: WEIGHT.semibold,
      color: c.melonText,
    },
    warningCard: {
      flexDirection: "row",
      alignItems: "center",
      gap: SPACE.sm,
      paddingHorizontal: SPACE.md,
      paddingVertical: SPACE.sm,
      borderRadius: RADIUS.md,
      backgroundColor: withAlpha(c.cherryDark, 0.12),
      borderWidth: 1.5,
      borderColor: c.cherryDark,
    },
    warningIcon: {
      fontSize: 18,
    },
    warningText: {
      flex: 1,
      fontSize: FONT_SIZE.bodySM,
      fontFamily: FONT.body,
      fontWeight: WEIGHT.medium,
      color: c.textPrimary,
      lineHeight: 18,
    },
    notice: {
      paddingHorizontal: SPACE.md,
      paddingVertical: SPACE.sm,
      borderRadius: RADIUS.md,
      backgroundColor: withAlpha(c.caramel, 0.1),
      borderWidth: 1,
      borderColor: withAlpha(c.caramel, 0.3),
    },
    adapterCard: {
      paddingHorizontal: SPACE.md,
      paddingVertical: SPACE.sm,
      borderRadius: RADIUS.md,
      backgroundColor: withAlpha(c.melonLight, 0.25),
      borderWidth: 1,
      borderColor: withAlpha(c.melonText, 0.25),
      gap: SPACE.xs,
    },
    adapterLabel: {
      fontSize: FONT_SIZE.overline,
      fontFamily: FONT.body,
      fontWeight: WEIGHT.bold,
      color: c.melonText,
      textTransform: "uppercase",
      letterSpacing: 0.5,
    },
    adapterRow: {
      flexDirection: "row",
      alignItems: "baseline",
      gap: SPACE.sm,
    },
    adapterAmount: {
      fontSize: FONT_SIZE.bodyMD,
      fontFamily: FONT.heading,
      fontWeight: WEIGHT.bold,
      color: c.textPrimary,
    },
    adapterArrow: {
      fontSize: FONT_SIZE.bodyMD,
      color: c.textMuted,
    },
    adapterMeta: {
      fontSize: FONT_SIZE.caption,
      fontFamily: FONT.body,
      color: c.textSubtitle,
    },
    noticeText: {
      fontSize: FONT_SIZE.bodySM,
      fontFamily: FONT.body,
      color: c.caramel,
      lineHeight: 18,
    },
    busyBody: {
      paddingVertical: SPACE.xxl,
      alignItems: "center",
      gap: SPACE.md,
    },
    busyLabel: {
      fontSize: FONT_SIZE.bodyMD,
      fontFamily: FONT.heading,
      fontWeight: WEIGHT.semibold,
      color: c.textSubtitle,
    },
    successIconWrap: {
      alignSelf: "center",
      width: 56,
      height: 56,
      borderRadius: 28,
      backgroundColor: withAlpha(c.melonText, 0.18),
      alignItems: "center",
      justifyContent: "center",
    },
    successIcon: {
      fontSize: 28,
      color: c.melonText,
      fontWeight: WEIGHT.bold,
    },
    successTitle: {
      fontSize: FONT_SIZE.headingLG,
      fontFamily: FONT.heading,
      fontWeight: WEIGHT.bold,
      color: c.textPrimary,
      textAlign: "center",
    },
    signatureCard: {
      paddingHorizontal: SPACE.md,
      paddingVertical: SPACE.sm,
      borderRadius: RADIUS.md,
      backgroundColor: withAlpha(c.sodaLight, 0.5),
      gap: 2,
    },
    signatureLabel: {
      fontSize: FONT_SIZE.overline,
      fontFamily: FONT.body,
      fontWeight: WEIGHT.bold,
      color: c.textMuted,
      textTransform: "uppercase",
      letterSpacing: 1,
    },
    signatureValue: {
      fontSize: FONT_SIZE.bodyMD,
      fontFamily: FONT.mono,
      color: c.sodaText,
    },
    successHint: {
      fontSize: FONT_SIZE.bodySM,
      fontFamily: FONT.body,
      color: c.textSubtitle,
      textAlign: "center",
    },
    errorIconWrap: {
      alignSelf: "center",
      width: 56,
      height: 56,
      borderRadius: 28,
      backgroundColor: withAlpha(c.cherryDark, 0.18),
      alignItems: "center",
      justifyContent: "center",
    },
    errorIcon: {
      fontSize: 32,
      color: c.cherryDark,
      fontWeight: WEIGHT.bold,
    },
    errorTitle: {
      fontSize: FONT_SIZE.headingMD,
      fontFamily: FONT.heading,
      fontWeight: WEIGHT.bold,
      color: c.cherryDark,
      textAlign: "center",
    },
    errorMessage: {
      fontSize: FONT_SIZE.bodySM,
      fontFamily: FONT.mono,
      color: c.textSubtitle,
      textAlign: "center",
      lineHeight: 18,
    },
    ctaPrimary: {
      paddingVertical: SPACE.md,
      borderRadius: RADIUS.md,
      backgroundColor: c.sodaText,
      alignItems: "center",
      justifyContent: "center",
      minHeight: 48,
    },
    ctaPrimaryText: {
      fontSize: FONT_SIZE.bodyLG,
      fontFamily: FONT.heading,
      fontWeight: WEIGHT.bold,
      color: c.textOnColor,
    },
    ctaSecondary: {
      paddingVertical: SPACE.md,
      borderRadius: RADIUS.md,
      borderWidth: 1,
      borderColor: c.borderStrong,
      alignItems: "center",
      justifyContent: "center",
      minHeight: 44,
    },
    ctaSecondaryText: {
      fontSize: FONT_SIZE.bodyMD,
      fontFamily: FONT.heading,
      fontWeight: WEIGHT.semibold,
      color: c.textSubtitle,
    },
  });
}
