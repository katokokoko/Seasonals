/**
 * useSignAndSubmit — Solana の「BFF が組んだ unsigned tx → wallet で一括署名 → BFF が送信 → 着地確認」。
 *
 * Seeker `ActionModal` の signSubmitAndSettle (Phase 8.8 / 8.15b) と同じ流れ:
 *   - 署名は 1 回の承認で全 tx (sign-only)。送信は BFF `/tx/submit` (Helius) が順番に行う
 *   - 2 本目以降は先行 tx 未 confirm でも preflight で落ちないよう skipPreflight
 *   - 安全側の拒否 (oracle_blocked / fair_value_blocked) は失敗ではなく declined (Seeker 8.74)
 * Web は wallet が送信後の状態を出さないので、`/tx/status` を引いて confirmed / failed まで見せる。
 * Seasonals は秘密鍵を扱わない (CLAUDE.md §5)。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { SOLANA_DECLINED_CODES, type OracleBlockReason, type SolanaTxErrorCode, type TxConfirmationStatus } from "@workspace/lib/types";
import { oracleBlockLabel } from "@workspace/lib/derive/oracle-gate";
import { api, ApiError } from "../services/api";
import { base64ToBytes, bytesToBase64 } from "../services/bytes";
import { isSolanaUserRejection, signSolanaTransactions, SolanaWalletError } from "../services/solanaWallet";

export type SignPhase =
  | "idle"
  | "building"
  | "signing"
  | "submitting"
  | "confirming"
  /** 全 tx が confirmed / finalized */
  | "success"
  /** 送信済みだが確認が時間内に取れなかった (失敗とは言えない) */
  | "submitted"
  /** BFF が安全のため組まなかった (oracle / fair value)。何も署名していない */
  | "declined"
  /** wallet で拒否した */
  | "cancelled"
  | "error";

export interface SubmittedTx {
  index: number;
  signature: string;
  status: "submitted" | TxConfirmationStatus;
  err?: string | null;
}

export interface SignState {
  phase: SignPhase;
  /** BFF が返した tx の本数 (署名前は 0) */
  total: number;
  txs: SubmittedTx[];
  message: string | null;
  code: string | null;
}

const INITIAL: SignState = { phase: "idle", total: 0, txs: [], message: null, code: null };

export interface SignOptions {
  pollMs?: number;
  timeoutMs?: number;
  /** 着地後に保有 / イベントを取り直すまでの待ち (indexer の反映待ち、Seeker は 5 秒) */
  settleMs?: number;
}

const LANDED = new Set<SubmittedTx["status"]>(["confirmed", "finalized"]);

function isBusy(p: SignPhase) {
  return p === "building" || p === "signing" || p === "submitting" || p === "confirming";
}

export function signPhaseBusy(p: SignPhase): boolean {
  return isBusy(p);
}

export function useSignAndSubmit(owner: string, opts: SignOptions = {}) {
  const { pollMs = 2000, timeoutMs = 60_000, settleMs = 4000 } = opts;
  const qc = useQueryClient();
  const [state, setState] = useState<SignState>(INITIAL);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const invalidate = useCallback(() => {
    for (const key of [
      ["sol", "earn", owner],
      ["sol", "events", owner],
      ["sol", "positions", owner],
      ["portfolio", "holdings", "solana", owner],
      ["portfolio", "history", "solana", owner],
    ]) {
      void qc.invalidateQueries({ queryKey: key });
    }
  }, [qc, owner]);

  const run = useCallback(
    async (build: () => Promise<string[]>) => {
      if (isBusy(state.phase)) return;
      let stage: SignPhase = "building";
      const txs: SubmittedTx[] = [];
      const update = (patch: Partial<SignState>) => {
        if (alive.current) setState((s) => ({ ...s, ...patch }));
      };
      setState({ ...INITIAL, phase: "building" });
      try {
        const b64 = await build();
        if (b64.length === 0) throw new Error("The server returned no transaction to sign.");
        stage = "signing";
        update({ phase: "signing", total: b64.length });
        const signed = await signSolanaTransactions(owner, b64.map(base64ToBytes));

        stage = "submitting";
        update({ phase: "submitting" });
        for (let i = 0; i < signed.length; i++) {
          const { signature } = await api.submitSignedTx(bytesToBase64(signed[i]!), i > 0);
          txs.push({ index: i, signature, status: "submitted" });
          update({ txs: [...txs] });
        }

        stage = "confirming";
        update({ phase: "confirming" });
        const outcome = await confirmAll(txs, pollMs, timeoutMs, (next) => update({ txs: next }), () => alive.current);
        const failed = txs.find((t) => t.status === "failed");
        if (failed) {
          update({
            phase: "error",
            code: "tx_failed",
            message: `Transaction ${failed.index + 1} of ${txs.length} failed on-chain${failed.err ? `: ${failed.err}` : "."}`,
          });
        } else {
          update({ phase: outcome === "landed" ? "success" : "submitted" });
        }
        setTimeout(invalidate, settleMs);
      } catch (e) {
        if (txs.length > 0) setTimeout(invalidate, settleMs);
        update(describeError(e, stage));
      }
    },
    [owner, state.phase, pollMs, timeoutMs, settleMs, invalidate]
  );

  const reset = useCallback(() => setState(INITIAL), []);
  return { state, run, reset, busy: isBusy(state.phase) };
}

/** 全 tx が着地 (or 失敗) するまで /tx/status を引く。旧 BFF (404) なら確認をあきらめる */
async function confirmAll(
  txs: SubmittedTx[],
  pollMs: number,
  timeoutMs: number,
  onUpdate: (txs: SubmittedTx[]) => void,
  isAlive: () => boolean
): Promise<"landed" | "unknown"> {
  const deadline = Date.now() + timeoutMs;
  while (isAlive() && Date.now() < deadline) {
    const open = txs.filter((t) => !LANDED.has(t.status) && t.status !== "failed");
    if (open.length === 0) return "landed";
    try {
      const results = await Promise.all(open.map((t) => api.txStatus(t.signature)));
      results.forEach((r, i) => {
        const t = open[i]!;
        if (r.status !== "pending") {
          t.status = r.status;
          t.err = r.err;
        }
      });
      onUpdate([...txs]);
      if (txs.some((t) => t.status === "failed")) return "landed";
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return "unknown";
      /* 一時的な失敗は次の poll で取り直す */
    }
    if (txs.every((t) => LANDED.has(t.status))) return "landed";
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return txs.every((t) => LANDED.has(t.status)) ? "landed" : "unknown";
}

function describeError(e: unknown, stage: SignPhase): Partial<SignState> {
  if (e instanceof ApiError) {
    if (e.code && (SOLANA_DECLINED_CODES as readonly string[]).includes(e.code)) {
      // 一部の builder は message を付けずに返す — 生の code を見せず block_reason から文にする
      const message =
        e.message !== e.code
          ? e.message
          : e.code === "oracle_blocked"
            ? `Price check failed: ${oracleBlockLabel(e.details?.block_reason as OracleBlockReason | undefined)}.`
            : "The quoted price is too far from fair value.";
      return { phase: "declined", code: e.code, message };
    }
    if (stage === "submitting" && /blockhash not found|block height exceeded/i.test(e.message)) {
      return { phase: "error", code: "expired", message: "The transaction expired before it reached the network. Build and sign it again." };
    }
    return { phase: "error", code: (e.code as SolanaTxErrorCode | undefined) ?? null, message: e.message };
  }
  if (e instanceof SolanaWalletError) return { phase: "error", code: e.code, message: e.message };
  if (stage === "signing" && isSolanaUserRejection(e)) {
    return { phase: "cancelled", code: "user_rejected", message: "Cancelled in your wallet. Nothing was sent." };
  }
  const msg = e instanceof Error && e.message ? e.message : "Wallet returned no result. Try disconnecting and reconnecting.";
  return { phase: "error", code: null, message: msg };
}
