/**
 * ActionModal — calendar / Menu から review → MWA sign → submit までの flow
 *
 * phase の state machine:
 *   review     : plan summary + 「署名して実行」 (default 表示)
 *   approving  : BFF から unsigned tx を取得 (非 onchain は POST /agent-plans/:id/approve)
 *   signing    : Seed Vault / wallet で sign-only
 *   submitting : 署名済 tx を BFF /tx/submit で broadcast (RPC 受理まで)
 *   confirming : `/tx/status` を poll して着地 (confirmed / finalized) を見届ける
 *   success    : 着地済 signature + Explorer link
 *   submitted  : 送信はしたが時間内に着地を確認できなかった (失敗とは言わない、Solscan 導線)
 *   error      : 失敗詳細 + retry (on-chain 失敗 / blockhash 期限切れを含む)
 *
 * 2026-10-13: 以前は `/tx/submit` が signature を返した時点 (= RPC 受理) で success を
 * 出していたが、受理後に dropped (期限内に取り込まれない) になった USDC → jlUSDC deposit で
 * 「success なのに残高も calendar も変わらない」が実機で起きた。web `useSignAndSubmit.ts`
 * と同じく lib `confirmSignatures` で着地を確認してから success を名乗る。
 *
 * onchain の market 解決は lib `resolveSolanaRoute`、builder 呼び分けは
 * `services/solana-tx.ts` の `buildSolanaTxs` (web と同じ部品、CLAUDE.md §1)。
 * BFF が返す base64 v0 tx を VersionedTransaction で復元して MWA で署名する
 * (Mobile 側に Connection を持たせない、CLAUDE.md §32.2 fail-closed safety 準拠)。
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  useHealth,
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
// watch-only mode: 読み取り address と mode (watch 中は署名経路に入らない)
import {
  useActiveAddress,
  type ActiveAddressMode,
} from "../../services/useActiveAddress";
import { signTransactions } from "../../services/mwa";
import { USE_ONCHAIN } from "../../services/config";
import * as api from "../../services/api";
import { buildSolanaTxs, type BuiltSolanaTxs } from "../../services/solana-tx";
// 2026-10-13: RPC 受理ではなく着地 (confirmed / finalized) を見届けてから成功を名乗る
import {
  confirmSignatures,
  describeConfirmOutcome,
  isLandedStatus,
  type TrackedTx,
} from "@workspace/lib/derive/tx-confirm";
// 8.74: BFF の拒否 code を判別するため (失敗と拒否を見分ける)
import { BffError } from "../../services/api";
import { useQueryClient } from "@tanstack/react-query";
// §4.0 / Phase A-3: tx 後は署名した wallet の key だけ取り直す
import { invalidateWalletAfterTx } from "../../services/wallet-query-sync";
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

// 2026-10-13: submitting / confirming / submitted を追加 (着地確認、ファイル冒頭参照)
type Phase =
  | "review"
  | "approving"
  | "signing"
  | "submitting"
  | "confirming"
  | "success"
  | "submitted"
  | "error";

// Phase 6.4: backdrop fade-in + blur、sheet slide-up、別々アニメ
const SCREEN_H = Dimensions.get("window").height;
const ENTER_MS = 240;
const EXIT_MS = 200;

function shortenSig(sig: string): string {
  if (sig.length <= 14) return sig;
  return `${sig.slice(0, 8)}…${sig.slice(-6)}`;
}

/** WalletPopover と同じ末尾 6 文字表記 */
function shortenAddress(addr: string): string {
  if (addr.length <= 10) return addr;
  return `…${addr.slice(-6)}`;
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
  // 2026-10-13: 送信済 tx の着地確認の進捗 (confirming の "n of m confirmed" 表示用)
  const [trackedTxs, setTrackedTxs] = useState<TrackedTx[]>([]);

  // 2026-10-13: 着地確認 (最大 75 秒) の途中で閉じられた / unmount / 別 plan に
  // 切り替わったら poll を止め、古い結果で phase を書き換えない (誤った success を出さない)
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const planIdRef = useRef<string | null>(plan?.plan_id ?? null);
  planIdRef.current = plan?.plan_id ?? null;
  /** close ごとに進める世代番号。実行開始時の値と違えば、その実行の結果は捨てる */
  const runIdRef = useRef(0);

  // 2026-10-13: 公開 BFF (`SOLANA_EXECUTION_TARGET=disabled`) は全 `*-tx` route が 409。
  // wallet を開く **前** に deposit / withdraw を止める (失敗してから知らせない)
  const health = useHealth();
  const executionDisabled = health.data?.solana?.executionTarget === "disabled";
  const planIsDepositOrWithdraw =
    plan?.selected_action?.action_type === "deposit" ||
    plan?.selected_action?.action_type === "withdraw";
  const executionBlocked = executionDisabled && planIsDepositOrWithdraw;

  const approveMutation = useApproveAgentPlan();
  // 署名は接続 wallet の authorization だけが使う (watch は authorization を書かない)
  const { authorization, isConnected } = useWallet();
  const { address: activeAddress, mode: addressMode } = useActiveAddress();
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

  // deposit の残高 (wallet 系 raw position、TanStack cache 再利用)。
  // watch-only mode: watch address の保有も同じ key で読む (表示のみ、署名はしない)
  const isDeposit = plan?.selected_action?.action_type === "deposit";
  const onchainWallet = activeAddress;
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
    // 2026-10-13: 進行中の着地確認があれば結果を捨てさせる (isAlive が false になる)
    runIdRef.current += 1;
    setPhase("review");
    setSignature(null);
    setErrorMsg(null);
    setTrackedTxs([]);
  }, []);

  const handleClose = useCallback(() => {
    reset();
    onClose();
  }, [onClose, reset]);

  const handleExecute = useCallback(async () => {
    // watch-only mode: 署名できない。CTA の disabled だけに頼らず硬く止める —
    // ここを抜けると !canOnchain で下の "Approve only" fallback (POST
    // /agent-plans/:id/approve → success 表示) に落ち、他人の address で偽成功になる
    if (addressMode === "watch") return;
    // 2026-10-13: plans-only server (`/health` の executionTarget = "disabled")。CTA の
    // disabled だけに頼らず watch と同じく硬く止める (builder → 409 → wallet 前で失敗、を避ける)
    if (executionBlocked) return;
    if (!plan) return;
    setErrorMsg(null);
    setErrorCode(null);
    const runId = runIdRef.current;
    const planId = plan.plan_id;
    const isAlive = () =>
      mountedRef.current &&
      runIdRef.current === runId &&
      planIdRef.current === planId;

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
    // 2026-10-13: submit 後に `/tx/status` で着地を確認してから success (ファイル冒頭参照)。
    const signSubmitAndSettle = async (
      base64Txs: string[],
      lastValidBlockHeight: number | null
    ) => {
      setPhase("signing");
      const txs = base64Txs.map((b64) =>
        VersionedTransaction.deserialize(Buffer.from(b64, "base64"))
      );
      // 署名した wallet (5 秒後の invalidate 対象。その間に切替えられても取り違えない)
      const signerAddress = authorization!.address;
      const signedTxs = await signTransactions(authorization!, txs);
      if (signedTxs.length !== txs.length || signedTxs.some((t) => !t)) {
        throw new Error("Wallet did not return all signed transactions.");
      }
      if (isAlive()) setPhase("submitting");
      const tracked: TrackedTx[] = [];
      for (let i = 0; i < signedTxs.length; i++) {
        const signedBase64 = Buffer.from(signedTxs[i]!.serialize()).toString(
          "base64"
        );
        const { signature } = await api.submitSignedTx(signedBase64, {
          skipPreflight: i > 0,
        });
        // 2026-10-13: signature は RPC 受理の証拠でしかない (着地は下で確認する)
        tracked.push({ index: i, signature, status: "submitted" });
      }
      const lastSignature = tracked[tracked.length - 1]?.signature ?? null;
      // Phase 8.8.2: 送信後に portfolio / earn / wallet tx を refetch (cache 反映待ち)。
      // Phase A-3: prefix 一括ではなく **署名した wallet の key だけ** (他 wallet の
      // 保持 cache と fixture key は触らない)。8.8.2 で漏れていた portfolio-history も含める
      // 2026-10-13: 着地確認の結果に関わらず (途中で閉じられても) 送信した時点で予約する。
      // unknown は後から着地し得るし、failed / expired でも取り直しは無害
      setTimeout(() => {
        void invalidateWalletAfterTx(queryClient, signerAddress);
      }, 5000);
      if (!isAlive()) return;
      setSignature(lastSignature);
      setTrackedTxs([...tracked]);
      setPhase("confirming");
      const outcome = await confirmSignatures(tracked, {
        fetchStatus: (sig) => api.getTxStatus(sig),
        lastValidBlockHeight,
        isAlive,
        onUpdate: (txs) => {
          if (isAlive()) setTrackedTxs(txs);
        },
      });
      // 閉じられた / 別 plan に切り替わった後の結果は表示しない
      if (!isAlive()) return;
      setTrackedTxs([...tracked]);
      switch (outcome) {
        case "landed":
          setPhase("success");
          return;
        case "failed":
          setErrorCode("tx_failed");
          setErrorMsg(describeConfirmOutcome("failed", tracked));
          setPhase("error");
          return;
        case "expired":
          // 期限切れ = もう取り込まれない。何も動いていないので組み直して署名し直す
          setErrorCode("expired");
          setErrorMsg(describeConfirmOutcome("expired", tracked));
          setPhase("error");
          return;
        case "unknown":
          // 時間切れ / 旧 BFF (/tx/status 無し)。失敗とは言わず signature を見せる
          setPhase("submitted");
          return;
      }
    };

    // approving → (fetch unsigned txns) → sign+submit を共通の error 処理で包む。
    const runOnchainTx = async (fetchTxs: () => Promise<BuiltSolanaTxs>) => {
      setPhase("approving");
      try {
        const { txs, lastValidBlockHeight } = await fetchTxs();
        await signSubmitAndSettle(txs, lastValidBlockHeight);
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
    addressMode,
    executionBlocked,
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
            mode={addressMode}
            activeAddress={activeAddress}
            amountInput={amountInput}
            onChangeAmount={setAmountInput}
            amountUnit={amountUnit}
            amountError={amountValidation.ok ? null : amountValidation.error}
            depositBalance={depositBalance}
            onPressMax={handlePressMax}
            executionDisabled={executionBlocked}
            testID={testID ? `${testID}-review` : undefined}
          />
        )}

        {phase === "approving" && <BusyBody label="Preparing transaction…" />}

        {phase === "signing" && (
          <BusyBody label="Approve in your wallet to sign the transaction" />
        )}

        {/* 2026-10-13: RPC 受理 → 着地確認 (close は signing と同じく常に可。閉じた後の
            結果は isAlive で捨てるので、誤った success にはならない) */}
        {phase === "submitting" && <BusyBody label="Sending to Solana…" />}

        {phase === "confirming" && (
          <BusyBody
            label="Confirming on Solana…"
            detail={
              trackedTxs.length > 1
                ? `${trackedTxs.filter((t) => isLandedStatus(t.status)).length} of ${trackedTxs.length} confirmed`
                : undefined
            }
            testID={testID ? `${testID}-confirming` : undefined}
          />
        )}

        {phase === "submitted" && (
          <SubmittedBody
            signature={signature}
            message={describeConfirmOutcome("unknown", trackedTxs)}
            onClose={handleClose}
            testID={testID ? `${testID}-submitted` : undefined}
          />
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
            title={
              isDeclined(errorCode)
                ? "Stopped before signing"
                : errorCode === "expired"
                  ? "Transaction expired"
                  : undefined
            }
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
 * 公開 BFF (`SOLANA_EXECUTION_TARGET=disabled`) の 409 `action_not_available` も
 * tx を組む前 (署名前) に止まるので同じ扱い。
 */
function isDeclined(code: string | null): boolean {
  return (
    code === "fair_value_blocked" ||
    code === "oracle_blocked" ||
    code === "action_not_available"
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
    case "submitting":
      return "Sending…";
    case "confirming":
      return "Confirming…";
    case "success":
      return "Done";
    case "submitted":
      return "Submitted";
    case "error":
      return "Failed";
  }
}

// ─── Review ──────────────────────────────────────────────────────────────────

function ReviewBody({
  plan,
  onExecute,
  isConnected,
  mode,
  activeAddress,
  amountInput,
  onChangeAmount,
  amountUnit,
  amountError,
  depositBalance,
  onPressMax,
  executionDisabled,
  testID,
}: {
  plan: AgentPlan;
  onExecute: () => void;
  isConnected: boolean;
  /** watch-only mode: "watch" なら read-only (CTA / 金額入力を止める) */
  mode: ActiveAddressMode;
  activeAddress: string | null;
  amountInput: string;
  onChangeAmount: (v: string) => void;
  amountUnit: AmountUnit;
  amountError: string | null;
  depositBalance: string | null;
  onPressMax: () => void;
  /** 2026-10-13: plans-only server (deposit / withdraw のみ渡す)。CTA を止めて理由を出す */
  executionDisabled: boolean;
  testID?: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const c = useThemeColors();
  const action = plan.selected_action;
  const watchOnly = mode === "watch";

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
  // Phase A-1: Kamino 以外の review では reserves を取得しない
  const { data: reserves } = useKaminoReserves({ enabled: isKamino });
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
            editable={!watchOnly}
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
            disabled={watchOnly}
            accessibilityState={{ disabled: watchOnly }}
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

      {/* watch-only mode: 署名経路は handleExecute が止める。ここは理由の表示 */}
      {watchOnly ? (
        <View style={styles.notice} testID={testID ? `${testID}-watch-only` : undefined}>
          <Text style={styles.noticeText}>
            Watching {activeAddress ? shortenAddress(activeAddress) : "address"} —
            read-only. Connect a wallet to sign.
          </Text>
        </View>
      ) : (
        !isConnected && (
          <View style={styles.notice} testID={testID ? `${testID}-not-connected` : undefined}>
            <Text style={styles.noticeText}>
              Wallet not connected — approve only (signing skipped). On-chain
              broadcast needs a connected wallet.
            </Text>
          </View>
        )
      )}

      {/* 2026-10-13: plans-only server の注記。oracle warning ではないので WarningArea
          (oracle warning の唯一の入口) は使わない。署名経路は handleExecute が止める */}
      {executionDisabled && (
        <View
          style={styles.noticeMuted}
          testID={testID ? `${testID}-execution-disabled` : undefined}
        >
          <Text style={styles.noticeMutedText}>
            This server is read-only (plans only). Deposits and withdrawals are
            disabled.
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
          // watch-only mode: 署名できないので常に disabled (handleExecute も early return)
          const ctaDisabled =
            disabled ||
            watchOnly ||
            executionDisabled ||
            oracleBlocked ||
            oracleChecking ||
            amountInvalid;
          return (
            <Pressable
              accessibilityRole="button"
              onPress={onExecute}
              disabled={ctaDisabled}
              accessibilityState={{ disabled: ctaDisabled }}
              style={[styles.ctaPrimary, ctaDisabled && styles.ctaDisabled]}
              testID={testID ? `${testID}-execute` : undefined}
            >
              <Text style={styles.ctaPrimaryText}>
                {watchOnly
                  ? "Connect a wallet to sign"
                  : executionDisabled
                    ? "Unavailable"
                    : oracleBlocked
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

// ─── Busy (approving / signing / submitting / confirming) ────────────────────

function BusyBody({
  label,
  detail,
  testID,
}: {
  label: string;
  /** 2026-10-13: 複数 tx の着地進捗 ("1 of 2 confirmed") */
  detail?: string;
  testID?: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const themeColors = useThemeColors();
  return (
    <View style={styles.busyBody} testID={testID}>
      <ActivityIndicator color={themeColors.sodaText} size="large" />
      <Text style={styles.busyLabel}>{label}</Text>
      {detail && <Text style={styles.busyDetail}>{detail}</Text>}
    </View>
  );
}

// ─── Submitted (送信済・着地未確認) ───────────────────────────────────────────

/**
 * 2026-10-13: 時間内に着地を確認できなかった (lib confirmSignatures の "unknown")。
 * 失敗とも成功とも言わない — signature と Solscan への導線を出し、wallet で確認させる。
 */
function SubmittedBody({
  signature,
  message,
  onClose,
  testID,
}: {
  signature: string | null;
  message: string;
  onClose: () => void;
  testID?: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const solscanUrl = signature ? `https://solscan.io/tx/${signature}` : null;
  return (
    <View style={styles.body} testID={testID}>
      <Text style={styles.successTitle}>Not confirmed yet</Text>
      <Text
        style={styles.successHint}
        testID={testID ? `${testID}-message` : undefined}
      >
        {message}
      </Text>
      {signature && (
        <View style={styles.signatureCard}>
          <Text style={styles.signatureLabel}>Transaction Signature</Text>
          <Text
            style={styles.signatureValue}
            selectable
            testID={testID ? `${testID}-signature` : undefined}
          >
            {shortenSig(signature)}
          </Text>
        </View>
      )}
      {solscanUrl && (
        <Pressable
          accessibilityRole="button"
          onPress={() => Linking.openURL(solscanUrl).catch(() => undefined)}
          style={styles.ctaSecondary}
          testID={testID ? `${testID}-solscan` : undefined}
        >
          <Text style={styles.ctaSecondaryText}>View on Solscan ↗</Text>
        </Pressable>
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
    // 2026-10-13: plans-only server の注記 (警告ではない事実の説明なので muted)
    noticeMuted: {
      paddingHorizontal: SPACE.md,
      paddingVertical: SPACE.sm,
      borderRadius: RADIUS.md,
      backgroundColor: withAlpha(c.textMuted, 0.1),
      borderWidth: 1,
      borderColor: withAlpha(c.textMuted, 0.3),
    },
    noticeMutedText: {
      fontSize: FONT_SIZE.bodySM,
      fontFamily: FONT.body,
      color: c.textMuted,
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
    busyDetail: {
      fontSize: FONT_SIZE.bodySM,
      fontFamily: FONT.body,
      color: c.textMuted,
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
