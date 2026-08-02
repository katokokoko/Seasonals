/**
 * fair-value — swap quote が LST の償還価値からどれだけ外れているかの判定 (Phase 8.72)
 *
 * `buildSwapEarnTx` は oracle gate (§4.6) を通した後、Jupiter の quote をそのまま
 * tx にして返していた。**quote の実効レートが妥当かは誰も見ていなかった**。
 * LST の deposit / withdraw は SOL ↔ LST の交換で、LST には
 * **償還価値 (NAV) という明確なフェアレート**がある。ルーティング事故や薄い流動性で
 * NAV から大きく外れた quote が返っても、署名画面まで素通りしてしまう。
 *
 * ここでは **ユーザーが不利になる方向の乖離だけ**を止める。deposit / withdraw の
 * どちらもユーザーが受け取るのは `outAmount` なので、「fair より out が少ない」= 不利。
 * 逆 (out が多い) は user の得なので通す。
 *
 * 参照レートは `clients/rates.ts` の `fetchSanctumSolValues` (LST 1 枚あたりの
 * lamports)。earnings 経路が既に使っている実績のある値で、stake pool の account
 * layout を新規に持ち込まずに済む。
 *
 * **「参照が無い」と「参照が取れない」は区別する** (ここが安全性の要):
 *   - jlUSDC / USD* / eUSX / hyloSOL / sHYUSD 等は **そもそも参照を持たない**
 *     → 対象外として通す。ここで止めると大半の protocol の deposit が死ぬ
 *   - 参照を持つはずの LST で値が取れない → **fail-closed で止める**
 *
 * backlog は「stake pool の `last_update_epoch` が 2 epoch 以上古ければ fail-closed」と
 * していたが、**Sanctum API から epoch は取れない**ので実装していない。代わりに
 * 上記「参照を持つはずなのに取れなければ止める」を等価の担保としている。
 *
 * §4.5: 判定は全て bigint。金額に `Number()` を通さない (bps だけ表示用に number)。
 */

/** 参照レート (Sanctum sol-value) を持つ share symbol */
export const FAIR_VALUE_LST_SYMBOLS: ReadonlySet<string> = new Set([
  "jitoSOL",
  "mSOL",
  "INF",
]);

/**
 * 既定の許容乖離 = **500bps (5%)**。
 *
 * backlog は 50bps を提案していたが、**実測が通らない**。1 SOL の deposit を実際に
 * quote した結果 (2026-08-03、price impact は 0.0006% 程度でほぼゼロ):
 *
 *   jitoSOL  fairOut 783781335 / quoteOut 773629799 → 129 bps
 *   mSOL     fairOut 726402068 / quoteOut 716915846 → 130 bps
 *   INF      fairOut 710309270 / quoteOut 695399459 → 209 bps
 *
 * つまり 130〜210bps は **NAV に対する平常の市場スプレッド** (mint ではなく AMM 経由で
 * 買う以上避けられない)。ここを閾値にすると正常な deposit が全部止まる。
 *
 * このガードが捕まえたいのは平常のスプレッドではなく **ルーティング事故級の乖離**
 * なので、実測の最悪値 (209bps) に十分な余裕を取り、§4.6 の oracle 乖離ブロックと
 * 同じ **5%** に揃える (「5% 外れたら実行を止める」という基準が 1 本になる)。
 */
export const DEFAULT_FAIR_VALUE_GUARD_BPS = 500;

export type FairValueVerdict =
  | { status: "ok"; deviation_bps: number }
  /** 参照レートを持たない market → ガード対象外 (通す) */
  | { status: "no_reference" }
  | {
      status: "blocked";
      reason: "fair_value_deviation" | "fair_value_unavailable";
      deviation_bps?: number;
    };

/**
 * env `SEASONALS_FAIR_VALUE_GUARD_BPS` (既定 50)。**0 で無効化**。
 * 不正値は既定にフォールバックする (壊れた env で無防備にしない)。
 */
export function fairValueGuardBps(
  env: NodeJS.ProcessEnv = process.env
): number {
  const raw = env.SEASONALS_FAIR_VALUE_GUARD_BPS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_FAIR_VALUE_GUARD_BPS;
  if (!/^[0-9]+$/.test(raw.trim())) return DEFAULT_FAIR_VALUE_GUARD_BPS;
  const n = Number.parseInt(raw.trim(), 10);
  return Number.isSafeInteger(n) ? n : DEFAULT_FAIR_VALUE_GUARD_BPS;
}

const LAMPORTS_PER_SOL = 1_000_000_000n;
const BPS = 10_000n;

/**
 * quote が償還価値からどれだけ外れているかを判定する純関数。I/O は呼び手が担当。
 *
 * @param direction deposit = SOL → LST / withdraw = LST → SOL
 * @param lamportsPerLst Sanctum sol-value。**undefined = 取得できなかった**
 * @param hasReference この market が本来 参照レートを持つか
 * @param guardBps 許容乖離 (0 で無効)
 */
export function evaluateFairValue(p: {
  direction: "deposit" | "withdraw";
  inAmount: string;
  outAmount: string;
  lamportsPerLst: bigint | undefined;
  hasReference: boolean;
  guardBps: number;
}): FairValueVerdict {
  if (!p.hasReference) return { status: "no_reference" };
  // 0 = 無効化。参照を持つ market でも判定自体を行わない
  if (p.guardBps <= 0) return { status: "no_reference" };
  if (
    p.lamportsPerLst === undefined ||
    p.lamportsPerLst <= 0n ||
    !/^[0-9]+$/.test(p.inAmount) ||
    !/^[0-9]+$/.test(p.outAmount)
  ) {
    // 参照を持つはずの market で判定材料が無い → 止める側に倒す
    return { status: "blocked", reason: "fair_value_unavailable" };
  }

  const inAmount = BigInt(p.inAmount);
  const outAmount = BigInt(p.outAmount);
  if (inAmount <= 0n) {
    return { status: "blocked", reason: "fair_value_unavailable" };
  }

  // deposit  (SOL → LST): fairOut = in × 1e9 / lamportsPerLst
  // withdraw (LST → SOL): fairOut = in × lamportsPerLst / 1e9
  const fairOut =
    p.direction === "deposit"
      ? (inAmount * LAMPORTS_PER_SOL) / p.lamportsPerLst
      : (inAmount * p.lamportsPerLst) / LAMPORTS_PER_SOL;
  if (fairOut <= 0n) {
    return { status: "blocked", reason: "fair_value_unavailable" };
  }

  // 正 = ユーザー不利 (受け取りが fair より少ない)。負 (有利) は通す
  const deviationBps = Number(((fairOut - outAmount) * BPS) / fairOut);
  if (deviationBps > p.guardBps) {
    return {
      status: "blocked",
      reason: "fair_value_deviation",
      deviation_bps: deviationBps,
    };
  }
  return { status: "ok", deviation_bps: deviationBps };
}
