/**
 * ActionModal — calendar / Menu から review → MWA sign → submit までの flow
 *
 * 5 phase の state machine:
 *   review     : plan summary + 「署名して実行」 (default 表示)
 *   approving  : BFF から unsigned tx を取得 (非 onchain は POST /agent-plans/:id/approve)
 *   signing    : Seed Vault / wallet で sign-only → BFF /tx/submit
 *   success    : signature + Explorer link
 *   error      : 失敗詳細 + retry
 *
 * onchain の market 解決は lib `resolveSolanaRoute`、builder 呼び分けは
 * `services/solana-tx.ts` の `buildSolanaTxs` (web と同じ部品、CLAUDE.md §1)。
 * BFF が返す base64 v0 tx を VersionedTransaction で復元して MWA で署名する
 * (Mobile 側に Connection を持たせない、CLAUDE.md §32.2 fail-closed safety 準拠)。
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Dimensions,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { BlurView } from "expo-blur";
import { VersionedTransaction } from "@solana/web3.js";

import {
  FONT,
  FONT_SIZE,
  RADIUS,
  SPACE,
  WEIGHT,
  withAlpha,
} from "@workspace/lib/design-system";
import {
  formatPercentage,
  toHumanReadable,
} from "@workspace/lib/utils/numeric";
import type { AgentPlan } from "@workspace/lib/types";

import {
  useApproveAgentPlan,
  useJupiterQuote,
  useKaminoReserves,
  useOracleStatus,
  usePositions,
} from "../../services/queries";
import {
  depositMaxSmallest,
  resolveAmountUnit,
  validateAmountInput,
  validateDepositAgainstBalance,
  type AmountUnit,
  type AmountValidation,
} from "@workspace/lib/derive/amount-utils";
import { WarningArea } from "./WarningArea";
import { oracleBlockLabel, resolveOracleMint } from "@workspace/lib/derive/oracle-gate";
import {
  resolveSolanaRoute,
  UNSUPPORTED_MARKET_MESSAGE,
} from "@workspace/lib/derive/solana-action";
import { useWallet } from "../../services/useWallet";
import { signTransactions } from "../../services/mwa";
import { USE_ONCHAIN } from "../../services/config";
import * as api from "../../services/api";
import { buildSolanaTxs } from "../../services/solana-tx";
// 8.74: BFF の拒否 code を判別するため (失敗と拒否を見分ける)
import { BffError } from "../../services/api";
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
import { useSafeAreaInsets } from "react-native-safe-area-context";

type Phase = "review" | "approving" | "signing" | "success" | "error";

// Phase 6.4: backdrop fade-in + blur、sheet slide-up、別々アニメ
const SCREEN_H = Dimensions.get("window").height;
const ENTER_MS = 240;
const EXIT_MS = 200;

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
  // 8.45: edge-to-edge の下端 inset
  const insets = useSafeAreaInsets();

  const [phase, setPhase] = useState<Phase>("review");
  const [signature, setSignature] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  // 8.74: BFF が返した machine-readable な code。「失敗」と「意図的な拒否」を
  // 区別して見せるために持つ
  const [errorCode, setErrorCode] = useState<string | null>(null);

  const approveMutation = useApproveAgentPlan();
  const { authorization, isConnected } = useWallet();
  const queryClient = useQueryClient();

  // ── Phase 8.16: 金額入力 ──
  // 編集単位 (deposit=underlying / withdraw=経路別 share or underlying) は plan から解決。
  const amountUnit = useMemo(
    () => resolveAmountUnit(plan?.selected_action),
    [plan]
  );
  const [amountInput, setAmountInput] = useState("");
  // plan が変わったら既存 amount (default 0.1 USDC 等 / withdraw 全量) を初期値に。
  useEffect(() => {
    const action = plan?.selected_action;
    if (action?.amount) {
      try {
        setAmountInput(toHumanReadable(action.amount, amountUnit.decimals));
      } catch {
        setAmountInput("");
      }
    } else {
      setAmountInput("");
    }
    // amountUnit は plan から導出されるので plan だけを依存にする
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan]);
  // 書式 / 正数の検証 (8.80: 残高検証は depositBalance 確定後に連結する)
  const formatValidation = useMemo(
    () => validateAmountInput(amountInput, amountUnit.decimals),
    [amountInput, amountUnit]
  );

  // deposit の残高 (wallet 系 raw position、TanStack cache 再利用)
  const isDeposit = plan?.selected_action?.action_type === "deposit";
  const onchainWallet =
    USE_ONCHAIN && isConnected && authorization ? authorization.address : null;
  const { data: rawPositions = [], isSuccess: positionsLoaded } =
    usePositions(onchainWallet);
  const depositBalance = useMemo(() => {
    const asset = plan?.selected_action?.asset;
    if (!isDeposit || !asset) return null;
    const p = rawPositions.find(
      (pos) =>
        pos.asset_symbol === asset && pos.protocol_id.startsWith("wallet_")
    );
    if (p) return p.current_amount;
    // 8.80: onchain 接続済みで positions が取得**成功**しているのに行が無い =
    // 保有ゼロ (DAS は保有 token を全部返す)。"0" を返して残高検証を効かせる。
    // query 未完 / 失敗 / 未接続は従来どおり null (= 不明、誤ブロックしない)
    if (onchainWallet && positionsLoaded) return "0";
    return null;
  }, [isDeposit, plan, rawPositions, onchainWallet, positionsLoaded]);

  // 8.80: 書式 OK でも保有残高を超える deposit は error にする。
  // 残高ゼロの JupUSD deposit が Phantom 警告 → broadcast 0x1789 まで素通りした
  // 実例の再発防止 (BFF 側 insufficient_balance gate と二重の fail-closed)
  const amountValidation = useMemo((): AmountValidation => {
    if (!formatValidation.ok || !isDeposit) return formatValidation;
    const asset = plan?.selected_action?.asset ?? "";
    const balanceCheck = validateDepositAgainstBalance(
      formatValidation.smallest,
      depositBalance,
      asset,
      amountUnit.decimals
    );
    return balanceCheck.ok
      ? formatValidation
      : { ok: false, error: balanceCheck.error };
  }, [formatValidation, isDeposit, plan, depositBalance, amountUnit]);

  const handlePressMax = useCallback(() => {
    const action = plan?.selected_action;
    if (!action) return;
    try {
      if (isDeposit) {
        if (!depositBalance) return;
        const max = depositMaxSmallest(depositBalance, action.asset);
        if (max !== null) {
          setAmountInput(toHumanReadable(max, amountUnit.decimals));
        }
      } else if (action.amount) {
        // withdraw: plan の amount は position 全量 (shares smallest)
        setAmountInput(toHumanReadable(action.amount, amountUnit.decimals));
      }
    } catch {
      // 変換不能 (不正 balance 等) は無視
    }
  }, [plan, isDeposit, depositBalance, amountUnit]);

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
    // Phase 8.16: 編集済み金額 (validated smallest)。invalid は CTA が gate 済みだが、
    // 念のため plan の元 amount に fallback (fallback memo path は amount 不使用)。
    const execAmount = amountValidation.ok
      ? amountValidation.smallest
      : action?.amount;
    // §1 same source of truth: market 解決 (swap-earn → Kamino reserve → kVault →
    // Meteora → Orca → Save → Exponent の順) は lib の resolveSolanaRoute が canonical。
    // web (seasonals-web/src/solana/buildTx.ts) と同じ route を同じ builder に写す。
    const route = resolveSolanaRoute(action);
    const canOnchain = Boolean(USE_ONCHAIN && isConnected && authorization);
    const isDepositOrWithdraw =
      action?.action_type === "deposit" || action?.action_type === "withdraw";

    // Phase 8.15b/8.15c: sign-only + Helius RPC submit の共通 tail (§8.8)。
    // BFF が返す base64 unsigned v0 tx 群を MWA で **一括署名** (承認 1 回) → 順次
    // broadcast → refetch。Save は ATA 準備等で複数 tx になり得る (2 本目以降は
    // 先行 tx 未 confirm でも preflight 落ちしないよう skipPreflight)。
    const signSubmitAndSettle = async (base64Txs: string[]) => {
      setPhase("signing");
      const txs = base64Txs.map((b64) =>
        VersionedTransaction.deserialize(Buffer.from(b64, "base64"))
      );
      const signedTxs = await signTransactions(authorization!, txs);
      if (signedTxs.length !== txs.length || signedTxs.some((t) => !t)) {
        throw new Error("Wallet did not return all signed transactions.");
      }
      let lastSignature: string | null = null;
      for (let i = 0; i < signedTxs.length; i++) {
        const signedBase64 = Buffer.from(signedTxs[i]!.serialize()).toString(
          "base64"
        );
        const { signature } = await api.submitSignedTx(signedBase64, {
          skipPreflight: i > 0,
        });
        lastSignature = signature;
      }
      setSignature(lastSignature);
      setPhase("success");
      // Phase 8.8.2: 成功後に portfolio / earn / wallet tx を refetch (cache 反映待ち)。
      setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ["positions"] });
        queryClient.invalidateQueries({ queryKey: ["earn-positions"] });
        queryClient.invalidateQueries({ queryKey: ["wallet-time-events"] });
      }, 5000);
    };

    // approving → (fetch unsigned txns) → sign+submit を共通の error 処理で包む。
    const runOnchainTx = async (fetchBase64: () => Promise<string | string[]>) => {
      setPhase("approving");
      try {
        const result = await fetchBase64();
        await signSubmitAndSettle(Array.isArray(result) ? result : [result]);
      } catch (e) {
        // Phase 8.6.1: null / 空 message を可視化 (Phantom が無応答で戻った時等)
        const raw = e instanceof Error ? e.message : e == null ? "" : String(e);
        // 8.74: 構造化された拒否 (oracle / fair value) は message が完結しているので、
        // stack の 1 行目を足さない (雑音にしかならない)
        const code = e instanceof BffError ? (e.code ?? null) : null;
        const detail =
          !code && e instanceof Error && e.stack
            ? `\n${e.stack.split("\n")[0]}`
            : "";
        const msg =
          raw && raw !== "null"
            ? raw + detail
            : "Wallet returned no result. Try disconnecting and reconnecting.";
        setErrorCode(code);
        setErrorMsg(msg);
        setPhase("error");
      }
    };

    // ── onchain: 解決した route の builder 1 本 → MWA 一括署名 → 順次 submit ──
    if (canOnchain && isDepositOrWithdraw && action?.amount && route) {
      const user = authorization!.address;
      await runOnchainTx(() => buildSolanaTxs(route, user, execAmount!));
      return;
    }

    // ── Phase 8.37 (M-H1): onchain 対象なのに market 未解決 → fail-closed ──
    // memo / approve fallback に落とすと「Approved & executed」の偽成功表示になるため、
    // canOnchain (onchain build + wallet 接続) の間はエラーで止める。
    // fallback は fixture/デモ (非 onchain) のときだけの経路にする。
    if (canOnchain && isDepositOrWithdraw) {
      setErrorCode(null);
      setErrorMsg(UNSUPPORTED_MARKET_MESSAGE);
      setPhase("error");
      return;
    }

    // ── Fallback path (非 onchain = fixture / デモ build のみ): plan を approve するだけ ──
    // BFF の memo stub (fee_payer → devnet memo tx) は agent-plan 契約の改訂で廃止。
    // approve は body なしで送り、tx は broadcast しない (SuccessBody が明示する)。
    setPhase("approving");
    try {
      const result = await approveMutation.mutateAsync({
        plan_id: plan.plan_id,
      });
      onSettled?.(result);
      setPhase("success");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setErrorMsg(msg);
      setPhase("error");
    }
  }, [
    plan,
    isConnected,
    authorization,
    approveMutation,
    onSettled,
    amountValidation,
    queryClient,
  ]);

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
      {/* 8.86: amount 入力がキーボードに隠れないよう padding で押し上げる
          (edge-to-edge では adjustResize が効かないため JS 側で回避) */}
      <KeyboardAvoidingView
        behavior="padding"
        style={styles.sheetWrap}
        pointerEvents="box-none"
      >
        {/* 8.45 (edge-to-edge): statusBarTranslucent の全画面 window なので、
            CTA がジェスチャーバーに重ならないよう下端 inset を足す */}
        <Animated.View
          style={[
            styles.sheet,
            { paddingBottom: SPACE.xl + insets.bottom },
            sheetAnimStyle,
          ]}
          testID={testID}
        >
        <View style={styles.header}>
          <View>
            <Text style={styles.headerLabel}>Approve & Execute</Text>
            <Text style={styles.headerTitle}>
              {/* 8.74: 拒否は「失敗」ではないので見出しも変える */}
              {phase === "error" && isDeclined(errorCode)
                ? "Stopped"
                : phaseLabel(phase)}
            </Text>
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
            amountInput={amountInput}
            onChangeAmount={setAmountInput}
            amountUnit={amountUnit}
            amountError={amountValidation.ok ? null : amountValidation.error}
            depositBalance={depositBalance}
            onPressMax={handlePressMax}
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
            title={isDeclined(errorCode) ? "Stopped before signing" : undefined}
            note={
              isDeclined(errorCode)
                ? "No funds moved — the transaction was never signed."
                : undefined
            }
            onRetry={() => setPhase("review")}
            onClose={handleClose}
            testID={testID ? `${testID}-error` : undefined}
          />
        )}
        </Animated.View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

/**
 * 8.74: BFF が **意図的に拒否した** ケースか。失敗ではないので見出しを変える。
 * §4.6 の oracle gate と 8.72 の償還価値ガードが該当。
 */
function isDeclined(code: string | null): boolean {
  return code === "fair_value_blocked" || code === "oracle_blocked";
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
  amountInput,
  onChangeAmount,
  amountUnit,
  amountError,
  depositBalance,
  onPressMax,
  testID,
}: {
  plan: AgentPlan;
  onExecute: () => void;
  isConnected: boolean;
  amountInput: string;
  onChangeAmount: (v: string) => void;
  amountUnit: AmountUnit;
  amountError: string | null;
  depositBalance: string | null;
  onPressMax: () => void;
  testID?: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const c = useThemeColors();
  const action = plan.selected_action;

  // Phase 8.16: 残高/保有行のテキスト (表示専用)。
  const isDeposit = action?.action_type === "deposit";
  let balanceText = "—";
  try {
    if (isDeposit && depositBalance) {
      balanceText = `Balance ${toHumanReadable(depositBalance, amountUnit.decimals)} ${amountUnit.unitSymbol}`;
    } else if (!isDeposit && action?.amount) {
      balanceText = `Holding ${toHumanReadable(action.amount, amountUnit.decimals)} ${amountUnit.unitSymbol}`;
    }
  } catch {
    balanceText = "—";
  }

  // withdraw で share 建て編集のとき、underlying 換算の参考行 (display 専用 Number、
  // §4.5 適用外 precedent)。比率 = metadata.underlying_amount / plan 全量 shares。
  let approxText: string | null = null;
  if (!isDeposit && action?.amount && action.metadata) {
    const underlyingTotal = action.metadata.underlying_amount;
    const underlyingDecimals = action.metadata.underlying_decimals;
    if (
      typeof underlyingTotal === "string" &&
      typeof underlyingDecimals === "number" &&
      amountUnit.unitSymbol !== action.asset
    ) {
      const totalShares = Number(action.amount);
      const editedShares = Number(amountInput) * Math.pow(10, amountUnit.decimals);
      const totalUnderlying = Number(underlyingTotal);
      if (
        Number.isFinite(totalShares) &&
        totalShares > 0 &&
        Number.isFinite(editedShares) &&
        editedShares > 0 &&
        Number.isFinite(totalUnderlying) &&
        totalUnderlying > 0
      ) {
        const approx =
          ((editedShares / totalShares) * totalUnderlying) /
          Math.pow(10, underlyingDecimals);
        approxText = `≈ ${approx.toFixed(Math.min(underlyingDecimals, 6))} ${action.asset}`;
      }
    }
  }
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
  // §4.6: 実 oracle 判定 (Pyth push → RedStone push)。mock simulation_result.oracle は使わない。
  const oracleMint = resolveOracleMint(action);
  const { data: oracle, isLoading: oracleLoading } = useOracleStatus(oracleMint);
  const oracleChecking = Boolean(oracleMint) && oracleLoading;
  const oracleBlocked = oracle?.status === "blocked";
  const oracleWarnings = oracleBlocked ? [] : oracle?.warnings ?? [];

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
        {/* Phase 8.16: 金額入力 (旧 read-only summaryAmount を置換) */}
        <View style={styles.amountInputRow}>
          <TextInput
            style={styles.amountInput}
            value={amountInput}
            onChangeText={onChangeAmount}
            keyboardType="decimal-pad"
            placeholder="0.0"
            placeholderTextColor={c.textMuted}
            testID={testID ? `${testID}-amount-input` : undefined}
          />
          <Text style={styles.amountUnit}>{amountUnit.unitSymbol}</Text>
        </View>
        <View style={styles.balanceRow}>
          <Text style={styles.balanceText} numberOfLines={1}>
            {balanceText}
            {approxText ? `  ·  ${approxText}` : ""}
          </Text>
          <Pressable
            accessibilityRole="button"
            onPress={onPressMax}
            style={styles.maxButton}
            testID={testID ? `${testID}-max` : undefined}
          >
            <Text style={styles.maxButtonText}>MAX</Text>
          </Pressable>
        </View>
        {amountError && (
          <Text
            style={styles.amountError}
            testID={testID ? `${testID}-amount-error` : undefined}
          >
            {amountError}
          </Text>
        )}
        <View style={styles.metaRow}>
          <Text style={styles.metaLabel}>Est. APY</Text>
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

      {/* Phase 8.14 §4.6: fail-closed で execute 拒否 (両 stale / 乖離>5% / 未取得) */}
      {oracleBlocked && (
        <View style={styles.warningCard} testID={testID ? `${testID}-oracle-blocked` : undefined}>
          <Text style={styles.warningIcon}>⛔</Text>
          <Text style={styles.warningText}>
            Oracle check failed: {oracleBlockLabel(oracle?.block_reason)} — execution
            blocked for safety.
          </Text>
        </View>
      )}

      {/* §4.6 tier C (Pyth のみ): warning ではない注記なので WarningArea の外・oracleWarnings
          に入れない。web OracleGate の「single price source」表示と同じ文言 */}
      {oracle?.tier === "C" && oracle.status !== "blocked" && (
        <Text style={styles.singleSourceNote} testID="oracle-single-source-note">
          Single price source (Pyth). Not cross-checked against a second oracle.
        </Text>
      )}

      {!isConnected && (
        <View style={styles.notice} testID={testID ? `${testID}-not-connected` : undefined}>
          <Text style={styles.noticeText}>
            Wallet not connected — approve only (signing skipped). On-chain
            broadcast needs a connected wallet.
          </Text>
        </View>
      )}

      {/* Phase 8.14: oracle warning (2-5% 乖離 / Pyth stale) は WarningArea が CTA 直上に
          強警告 + 1s grayout。blocked / 確認中 / 未接続を含め CTA disabled を統合制御。 */}
      <WarningArea
        oracleWarnings={oracleWarnings}
        testID={testID ? `${testID}-warning-area` : undefined}
        renderCta={({ disabled }) => {
          // Phase 8.16: 金額 invalid も CTA を gate (plan に amount がある action のみ)
          const amountInvalid = Boolean(action?.amount) && amountError !== null;
          const ctaDisabled =
            disabled || oracleBlocked || oracleChecking || amountInvalid;
          return (
            <Pressable
              accessibilityRole="button"
              onPress={onExecute}
              disabled={ctaDisabled}
              style={[styles.ctaPrimary, ctaDisabled && styles.ctaDisabled]}
              testID={testID ? `${testID}-execute` : undefined}
            >
              <Text style={styles.ctaPrimaryText}>
                {oracleBlocked
                  ? "Blocked (oracle)"
                  : oracleChecking
                    ? "Checking oracle…"
                    : isConnected
                      ? "Sign & execute"
                      : "Approve only"}
              </Text>
            </Pressable>
          );
        }}
      />
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
        Min: {minOutHuman} {outputSym} (slippage {quote.slippage_bps / 100}%)
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
            {/* 8.38 (L5): onchain build は mainnet — "Devnet" 固定表記は誤り */}
            <Text style={styles.signatureLabel}>Transaction Signature</Text>
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
  title,
  note,
  onRetry,
  onClose,
  testID,
}: {
  message: string;
  /** 8.74: 拒否ケースでは "Transaction failed" ではない見出しにする */
  title?: string;
  /** 8.74: 資金が動いていないことの一言 (拒否ケースのみ) */
  note?: string;
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
      <Text style={styles.errorTitle}>{title ?? "Transaction failed"}</Text>
      <Text
        style={styles.errorMessage}
        selectable
        testID={testID ? `${testID}-message` : undefined}
      >
        {message}
      </Text>
      {note && (
        <Text
          style={styles.errorMessage}
          testID={testID ? `${testID}-note` : undefined}
        >
          {note}
        </Text>
      )}
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
    // ── Phase 8.16: 金額入力 ──
    amountInputRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: SPACE.sm,
    },
    amountInput: {
      flex: 1,
      backgroundColor: c.bgPrimary,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: RADIUS.sm,
      paddingHorizontal: SPACE.sm,
      paddingVertical: SPACE.xs,
      fontSize: FONT_SIZE.displaySM,
      fontFamily: FONT.heading,
      fontWeight: WEIGHT.bold,
      color: c.textPrimary,
    },
    amountUnit: {
      fontSize: FONT_SIZE.bodyMD,
      fontFamily: FONT.body,
      fontWeight: WEIGHT.semibold,
      color: c.textSubtitle,
    },
    balanceRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      marginTop: SPACE.xs,
    },
    balanceText: {
      flex: 1,
      fontSize: FONT_SIZE.bodySM,
      fontFamily: FONT.body,
      color: c.textMuted,
    },
    // tier C 注記: balanceText と同じ muted caption (column 内なので flex は持たない)
    singleSourceNote: {
      fontSize: FONT_SIZE.bodySM,
      fontFamily: FONT.body,
      color: c.textMuted,
    },
    maxButton: {
      paddingHorizontal: SPACE.sm,
      paddingVertical: 4,
      borderRadius: RADIUS.sm,
      backgroundColor: withAlpha(c.sodaText, 0.12),
    },
    maxButtonText: {
      fontSize: FONT_SIZE.bodySM,
      fontFamily: FONT.body,
      fontWeight: WEIGHT.bold,
      color: c.sodaText,
    },
    amountError: {
      marginTop: SPACE.xs,
      fontSize: FONT_SIZE.bodySM,
      fontFamily: FONT.body,
      color: c.cherryDark,
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
    // Phase 8.14: oracle blocked / 確認中 / grayout 時の CTA disabled 表現
    ctaDisabled: {
      backgroundColor: withAlpha(c.textMuted, 0.4),
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
