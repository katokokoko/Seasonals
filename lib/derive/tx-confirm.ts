/**
 * tx-confirm — 送信済 Solana tx の着地確認 (純関数、RN / browser / node 共通)。
 *
 * `/tx/submit` は RPC が tx を **受理** した時点で signature を返すだけで、block に入ったかは
 * 分からない。受理されても blockhash の期限 (約 60 秒) 内に取り込まれなければ tx は静かに
 * 消える (dropped)。2026-10-13 に Seeker で「success 表示 → 何も起きない」が実際に起きたので、
 * 着地 (`confirmed` / `finalized`) を `/tx/status` で見届けてから成功を名乗る。
 *
 * 判定:
 *   - landed  : 全 tx が confirmed / finalized
 *   - failed  : いずれかの tx が on-chain で err
 *   - expired : builder の `lastValidBlockHeight` を現在高が超え、まだ pending の tx がある
 *               (= もう取り込まれない。何も動いていないので「組み直して署名し直す」が正しい)
 *   - unknown : 時間内に判定できなかった (失敗とは言えない。wallet に現れるか確認する)
 *
 * web `useSignAndSubmit.ts` の confirmAll を lib に移したもの。I/O (fetch / sleep) は注入する。
 */
import type { TxConfirmationStatus, TxStatusResponse } from "../types/solana-tx";

export type TxConfirmOutcome = "landed" | "failed" | "expired" | "unknown";

/** 送信済 tx 1 本の追跡状態。`submitted` = RPC 受理のみ (status 未取得) */
export interface TrackedTx {
  index: number;
  signature: string;
  status: "submitted" | TxConfirmationStatus;
  err?: string | null;
}

/** `/tx/status` が無い旧 BFF (404) 等、確認を続けても意味が無い時に fetchStatus が投げる */
export class TxConfirmAbort extends Error {
  constructor(message = "transaction status is not available") {
    super(message);
    this.name = "TxConfirmAbort";
  }
}

export interface TxConfirmOptions {
  fetchStatus: (signature: string) => Promise<TxStatusResponse>;
  /** builder (`SwapEarnTxResponse` 等) が返した値。無ければ時間切れで unknown に落とす */
  lastValidBlockHeight?: number | null;
  pollMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** 進捗を UI に反映する (tx の配列は呼び手が渡したものを in-place 更新して渡す) */
  onUpdate?: (txs: TrackedTx[]) => void;
  /** unmount 等で止める */
  isAlive?: () => boolean;
}

export const TX_CONFIRM_DEFAULTS = {
  pollMs: 2_000,
  /** blockhash 期限 (~60s) + 伝播の余裕。これを超えたら unknown (失敗とは言わない) */
  timeoutMs: 75_000,
} as const;

const LANDED: ReadonlySet<TrackedTx["status"]> = new Set(["confirmed", "finalized"]);

export function isLandedStatus(status: TrackedTx["status"]): boolean {
  return LANDED.has(status);
}

/** まだ結論が出ていない tx (着地も失敗もしていない) */
function openTxs(txs: TrackedTx[]): TrackedTx[] {
  return txs.filter((t) => !isLandedStatus(t.status) && t.status !== "failed");
}

/** RPC がまだ見ていない (= 期限が過ぎれば取り込まれない) tx */
function isUnseen(t: TrackedTx): boolean {
  return t.status === "submitted" || t.status === "pending";
}

// lib は DOM / node の型を読まないので timer は globalThis から取る (RN / browser / node で同名)
const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    const g = globalThis as { setTimeout?: (fn: () => void, ms: number) => unknown };
    if (typeof g.setTimeout !== "function") throw new Error("tx-confirm: no timer available; pass opts.sleep");
    g.setTimeout(resolve, ms);
  });

/**
 * 全 tx が着地 / 失敗 / 期限切れになるか、時間切れになるまで `/tx/status` を引く。
 * `txs` は in-place で status / err を更新する (呼び手は onUpdate でコピーを UI へ)。
 */
export async function confirmSignatures(
  txs: TrackedTx[],
  opts: TxConfirmOptions
): Promise<TxConfirmOutcome> {
  const pollMs = opts.pollMs ?? TX_CONFIRM_DEFAULTS.pollMs;
  const timeoutMs = opts.timeoutMs ?? TX_CONFIRM_DEFAULTS.timeoutMs;
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;
  const isAlive = opts.isAlive ?? (() => true);
  const lastValid =
    typeof opts.lastValidBlockHeight === "number" && Number.isFinite(opts.lastValidBlockHeight)
      ? opts.lastValidBlockHeight
      : null;
  const deadline = now() + timeoutMs;

  while (isAlive() && now() < deadline) {
    const open = openTxs(txs);
    if (open.length === 0) return "landed";
    let blockHeight: number | null = null;
    try {
      const results = await Promise.all(open.map((t) => opts.fetchStatus(t.signature)));
      results.forEach((r, i) => {
        const t = open[i]!;
        if (r.status !== "pending") {
          t.status = r.status;
          t.err = r.err;
        }
        if (typeof r.blockHeight === "number" && Number.isFinite(r.blockHeight)) {
          blockHeight = blockHeight === null ? r.blockHeight : Math.max(blockHeight, r.blockHeight);
        }
      });
      opts.onUpdate?.([...txs]);
    } catch (e) {
      if (e instanceof TxConfirmAbort) return "unknown";
      // 一時的な失敗 (RPC 瞬断等) は次の poll で取り直す
    }
    if (txs.some((t) => t.status === "failed")) return "failed";
    if (txs.every((t) => isLandedStatus(t.status))) return "landed";
    // 期限切れの確定: 現在高が lastValidBlockHeight を超えても RPC が見ていない tx が残っている
    if (lastValid !== null && blockHeight !== null && blockHeight > lastValid && txs.some(isUnseen)) {
      return "expired";
    }
    await sleep(pollMs);
  }
  return txs.every((t) => isLandedStatus(t.status)) ? "landed" : "unknown";
}

/** UI 文言 (Seeker / web 共通。失敗と「分からない」を混ぜない) */
export function describeConfirmOutcome(outcome: TxConfirmOutcome, txs: TrackedTx[]): string {
  switch (outcome) {
    case "landed":
      return txs.length > 1 ? `All ${txs.length} transactions confirmed on Solana.` : "Confirmed on Solana.";
    case "failed": {
      const f = txs.find((t) => t.status === "failed");
      const which = txs.length > 1 && f ? `Transaction ${f.index + 1} of ${txs.length}` : "The transaction";
      return `${which} failed on-chain${f?.err ? `: ${f.err}` : "."}`;
    }
    case "expired":
      return "The transaction expired before the network included it. Nothing moved — build and sign it again.";
    case "unknown":
      return "Sent, but not confirmed within the time limit. Nothing moved unless it appears in your wallet — check the signature before retrying.";
  }
}
