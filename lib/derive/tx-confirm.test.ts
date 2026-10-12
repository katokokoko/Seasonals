/**
 * tx-confirm: 着地確認の純関数 (I/O 注入)。2026-10-13 の「RPC 受理 = success 表示」事故の再発防止。
 */
import type { TxStatusResponse } from "../types/solana-tx";
import {
  confirmSignatures,
  describeConfirmOutcome,
  isLandedStatus,
  TxConfirmAbort,
  type TrackedTx,
} from "./tx-confirm";

const SIG_A = "A".repeat(87);
const SIG_B = "B".repeat(87);

function status(
  signature: string,
  s: TxStatusResponse["status"],
  extra: Partial<TxStatusResponse> = {}
): TxStatusResponse {
  return { signature, status: s, slot: s === "pending" ? null : 1, err: null, ...extra };
}

/** 呼び出し順に応答を返す fetchStatus (signature 別)。足りなければ最後を繰り返す */
function scripted(script: Record<string, TxStatusResponse[]>) {
  const calls: Record<string, number> = {};
  return async (sig: string) => {
    const seq = script[sig] ?? [];
    const i = calls[sig] ?? 0;
    calls[sig] = i + 1;
    return seq[Math.min(i, seq.length - 1)] ?? status(sig, "pending");
  };
}

/** 仮想時計: sleep が時間を進める */
function clock(start = 0) {
  let t = start;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

const tx = (signature: string, index = 0): TrackedTx => ({ index, signature, status: "submitted" });

describe("confirmSignatures", () => {
  it("pending → confirmed で landed、txs は in-place で更新される", async () => {
    const txs = [tx(SIG_A)];
    const c = clock();
    const updates: TrackedTx[][] = [];
    const out = await confirmSignatures(txs, {
      fetchStatus: scripted({ [SIG_A]: [status(SIG_A, "pending"), status(SIG_A, "confirmed")] }),
      ...c,
      pollMs: 1000,
      onUpdate: (t) => updates.push(t),
    });
    expect(out).toBe("landed");
    expect(txs[0]!.status).toBe("confirmed");
    expect(updates.length).toBe(2);
    expect(c.now()).toBe(1000);
  });

  it("on-chain err は failed (err 文字列を保持)", async () => {
    const txs = [tx(SIG_A, 0), tx(SIG_B, 1)];
    const out = await confirmSignatures(txs, {
      fetchStatus: scripted({
        [SIG_A]: [status(SIG_A, "confirmed")],
        [SIG_B]: [status(SIG_B, "failed", { err: '{"InstructionError":[2,{"Custom":6001}]}' })],
      }),
      ...clock(),
    });
    expect(out).toBe("failed");
    expect(txs[1]!.err).toContain("6001");
    expect(describeConfirmOutcome(out, txs)).toMatch(/Transaction 2 of 2 failed on-chain: .*6001/);
  });

  it("現在高が lastValidBlockHeight を超えてまだ pending なら expired (確定、時間切れを待たない)", async () => {
    const txs = [tx(SIG_A)];
    const c = clock();
    const out = await confirmSignatures(txs, {
      fetchStatus: scripted({
        [SIG_A]: [
          status(SIG_A, "pending", { blockHeight: 100 }),
          status(SIG_A, "pending", { blockHeight: 151 }),
        ],
      }),
      lastValidBlockHeight: 150,
      ...c,
      pollMs: 2000,
      timeoutMs: 75_000,
    });
    expect(out).toBe("expired");
    expect(c.now()).toBe(2000);
    expect(describeConfirmOutcome(out, txs)).toMatch(/expired/);
  });

  it("processed (RPC が見ている) なら高さ超過でも expired にしない", async () => {
    const txs = [tx(SIG_A)];
    const out = await confirmSignatures(txs, {
      fetchStatus: scripted({
        [SIG_A]: [status(SIG_A, "processed", { blockHeight: 200 }), status(SIG_A, "confirmed")],
      }),
      lastValidBlockHeight: 150,
      ...clock(),
    });
    expect(out).toBe("landed");
  });

  it("時間内に着地しなければ unknown (失敗と言わない)", async () => {
    const txs = [tx(SIG_A)];
    const out = await confirmSignatures(txs, {
      fetchStatus: scripted({ [SIG_A]: [status(SIG_A, "pending")] }),
      ...clock(),
      pollMs: 10_000,
      timeoutMs: 30_000,
    });
    expect(out).toBe("unknown");
    expect(describeConfirmOutcome(out, txs)).toMatch(/not confirmed/);
  });

  it("旧 BFF (TxConfirmAbort) は即 unknown、一時エラーは次の poll で取り直す", async () => {
    const aborted = await confirmSignatures([tx(SIG_A)], {
      fetchStatus: async () => {
        throw new TxConfirmAbort();
      },
      ...clock(),
    });
    expect(aborted).toBe("unknown");

    let n = 0;
    const txs = [tx(SIG_A)];
    const recovered = await confirmSignatures(txs, {
      fetchStatus: async (sig) => {
        n += 1;
        if (n === 1) throw new Error("ECONNRESET");
        return status(sig, "finalized");
      },
      ...clock(),
    });
    expect(recovered).toBe("landed");
    expect(n).toBe(2);
  });

  it("isAlive が false になったら unknown で止まる", async () => {
    let alive = true;
    const c = clock();
    const out = await confirmSignatures([tx(SIG_A)], {
      fetchStatus: async (sig) => {
        alive = false;
        return status(sig, "pending");
      },
      ...c,
      isAlive: () => alive,
    });
    expect(out).toBe("unknown");
  });

  it("isLandedStatus は confirmed / finalized のみ", () => {
    expect(isLandedStatus("confirmed")).toBe(true);
    expect(isLandedStatus("finalized")).toBe(true);
    expect(isLandedStatus("processed")).toBe(false);
    expect(isLandedStatus("submitted")).toBe(false);
  });
});
