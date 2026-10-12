/**
 * ActionModal — onchain tx 成功後の cache 更新 (API 効率化計画 Phase A-3 / §4.0)
 *
 * tx 成功 5 秒後の invalidate は **署名した wallet の key だけ** を対象にする:
 *   - positions / earn-positions / wallet-time-events / portfolio-history (8.8.2 は history が漏れていた)
 *   - 他 wallet の保持 cache・fixture key・SKR には触らない
 * jest は USE_ONCHAIN=false なのでこのファイルだけ config を mock し、署名 / 送信 / tx 構築は stub。
 *
 * 2026-10-13: submit 後は `/tx/status` で着地を確認してから success (RPC 受理 ≠ 着地)。
 * getTxStatus は即 resolve する mock にして timer を使わずに landed / failed / expired を見る。
 * `/health` の executionTarget = "disabled" (公開 plans-only BFF) は署名前に止まることも見る。
 */
jest.mock("../../services/config", () => ({
  ...jest.requireActual("../../services/config"),
  USE_ONCHAIN: true,
}));
jest.mock("@solana/web3.js", () => ({
  VersionedTransaction: { deserialize: jest.fn(() => ({})) },
}));
jest.mock("../../services/mwa", () => ({
  __esModule: true,
  signTransactions: jest.fn(async (_auth: unknown, txs: unknown[]) =>
    txs.map(() => ({ serialize: () => new Uint8Array([1, 2, 3]) }))
  ),
  connectWallet: jest.fn(),
  reauthorizeWallet: jest.fn(),
  disconnectWallet: jest.fn(),
  DEFAULT_IDENTITY: { name: "Seasonals", uri: "https://x", icon: "i" },
}));
jest.mock("../../services/solana-tx", () => ({
  buildSolanaTxs: jest.fn(async () => ({ txs: ["AAAA"], lastValidBlockHeight: null })),
}));

import React, { type ReactNode } from "react";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { fixtureAgentPlanSimulated } from "@workspace/lib/__fixtures__";
import type {
  AgentPlan,
  OracleResult,
  Position,
  TxStatusResponse,
} from "@workspace/lib/types";

import { TxConfirmAbort } from "@workspace/lib/derive/tx-confirm";

import { ActionModal, POST_SETTLE_INVALIDATE_MS } from "./ActionModal";
import * as walletQuerySync from "../../services/wallet-query-sync";
import * as api from "../../services/api";
import { buildSolanaTxs } from "../../services/solana-tx";
import { createQueryClient } from "../../services/queryClient";
import { useWalletStore } from "../../services/walletStore";
import { signTransactions } from "../../services/mwa";
import { useWatchStore } from "../../stores/watch";
import { VersionedTransaction } from "@solana/web3.js";

const A = "7nZbHkQqXkr3eW8s2dKvHqBxNz9vC5jPpL2tF6mYrXaA";
const B = "6QGJNXnCjhYkKgPpDm7qRzxBKCj9KugUL2LDHc8sGUUM";

const METRICS = {
  frame: { x: 0, y: 0, width: 400, height: 800 },
  insets: { top: 24, left: 0, right: 0, bottom: 16 },
};

const DEPOSIT_PLAN: AgentPlan = {
  ...fixtureAgentPlanSimulated,
  selected_action: {
    ...fixtureAgentPlanSimulated.selected_action!,
    action_type: "deposit",
    protocol: "kamino",
    asset: "USDC",
    amount: "1000000",
  },
} as AgentPlan;

const ORACLE_OK = {
  asset_symbol: "USDC",
  status: "ok",
  primary: "pyth",
  price_usd: null,
  pyth: { available: true, price_usd: null, age_seconds: 3 },
  secondary: { source: "redstone", available: true, price_usd: null, age_seconds: 3 },
  tier: "A",
  divergence_pct: null,
  warnings: [],
  block_reason: null,
} as unknown as OracleResult;

const USDC_IN_WALLET = {
  position_id: "wallet_usdc",
  protocol_id: "wallet_stable",
  asset_symbol: "USDC",
  current_amount: "50000000",
} as unknown as Position;

afterEach(() => {
  jest.restoreAllMocks();
  useWalletStore.getState().reset();
  useWatchStore.getState().reset();
});

describe("ActionModal — tx 後の invalidate は署名した wallet だけ", () => {
  it("5 秒後に A の 4 系統を invalidate し、B / fixture / SKR の cache は触らない", async () => {
    jest.spyOn(api, "getOracleStatus").mockResolvedValue(ORACLE_OK);
    jest.spyOn(api, "getPositions").mockResolvedValue([USDC_IN_WALLET]);
    jest.spyOn(api, "getKaminoReserves").mockResolvedValue([]);
    jest.spyOn(api, "submitSignedTx").mockResolvedValue({ signature: "sig_1" } as never);
    // 2026-10-13: 着地確認 (1 回目の poll で confirmed)
    jest.spyOn(api, "getTxStatus").mockResolvedValue({
      signature: "sig_1",
      status: "confirmed",
      slot: 1,
      err: null,
    });
    useWalletStore.setState({
      authorization: {
        address: A,
        label: "Phantom",
        authToken: "tok",
        walletUriBase: null,
        chain: "solana:mainnet",
      },
      status: "connected",
    });

    // 5 秒の遅延 invalidate だけ捕まえて手で流す (他の timer は素通し)
    const realSetTimeout = global.setTimeout;
    let delayed: (() => void) | null = null;
    jest.spyOn(global, "setTimeout").mockImplementation(((
      fn: () => void,
      ms?: number
    ) => {
      if (ms === 5000) {
        delayed = fn;
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }
      return realSetTimeout(fn, ms);
    }) as typeof setTimeout);

    const qc: QueryClient = createQueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 60_000 } },
    });
    const keys: unknown[][] = [
      ["earn-positions", A],
      ["wallet-time-events", A],
      ["portfolio-history", A, 30],
      ["positions", B],
      ["earn-positions", B],
      ["portfolio-history", B, 30],
      ["positions"],
      ["skr-staking", "live", "mainnet-beta", A],
    ];
    for (const k of keys) qc.setQueryData(k, { seeded: true });

    render(
      <SafeAreaProvider initialMetrics={METRICS}>
        <QueryClientProvider client={qc}>
          <ActionModal plan={DEPOSIT_PLAN} onClose={() => {}} testID="am" />
        </QueryClientProvider>
      </SafeAreaProvider>
    );
    await waitFor(() => expect(screen.getByText("Sign & execute")).toBeTruthy());
    await waitFor(() =>
      expect(
        screen.getByTestId("am-review-execute").props.accessibilityState?.disabled
      ).toBeFalsy()
    );
    fireEvent.press(screen.getByTestId("am-review-execute"));
    await waitFor(() => expect(api.submitSignedTx).toHaveBeenCalled());
    await waitFor(() => expect(delayed).not.toBeNull());

    delayed!();
    const invalidated = (k: unknown[]) =>
      qc.getQueryCache().find({ queryKey: k, exact: true })?.state.isInvalidated;
    // A: positions は ActionModal 自身が observe している key。他 3 系統は seed した key
    await waitFor(() => expect(invalidated(["positions", A])).toBe(true));
    expect(invalidated(["earn-positions", A])).toBe(true);
    expect(invalidated(["wallet-time-events", A])).toBe(true);
    expect(invalidated(["portfolio-history", A, 30])).toBe(true);
    // 他 wallet / fixture / SKR はそのまま
    expect(invalidated(["positions", B])).toBe(false);
    expect(invalidated(["earn-positions", B])).toBe(false);
    expect(invalidated(["portfolio-history", B, 30])).toBe(false);
    expect(invalidated(["positions"])).toBe(false);
    expect(invalidated(["skr-staking", "live", "mainnet-beta", A])).toBe(false);
    qc.clear();
  });
});

/**
 * watch-only mode: 未接続 + watch address では署名経路に入らない。
 * 特に onchain build + 未接続の "Approve only" fallback (POST /agent-plans/:id/approve →
 * success 表示) に落ちないこと (ActionModal の handleExecute が early return で止める)
 */
describe("ActionModal — watch mode", () => {
  // module mock (signTransactions / deserialize) の呼び出し記録は前の describe から残るので消す
  beforeEach(() => jest.clearAllMocks());

  it("CTA は disabled の 'Connect a wallet to sign'、押しても署名 / approve に進まない", async () => {
    jest.spyOn(api, "getOracleStatus").mockResolvedValue(ORACLE_OK);
    const getPositions = jest
      .spyOn(api, "getPositions")
      .mockResolvedValue([USDC_IN_WALLET]);
    jest.spyOn(api, "getKaminoReserves").mockResolvedValue([]);
    const approve = jest.spyOn(api, "postApproveAgentPlan");
    const submit = jest.spyOn(api, "submitSignedTx");
    useWatchStore.getState().addWatch(B);

    const qc: QueryClient = createQueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 60_000 } },
    });
    render(
      <SafeAreaProvider initialMetrics={METRICS}>
        <QueryClientProvider client={qc}>
          <ActionModal plan={DEPOSIT_PLAN} onClose={() => {}} testID="am" />
        </QueryClientProvider>
      </SafeAreaProvider>
    );

    await waitFor(() =>
      expect(screen.getByText("Connect a wallet to sign")).toBeTruthy()
    );
    // 残高は watch address の key で読む (表示のみ)
    await waitFor(() => expect(getPositions.mock.calls[0]?.[0]).toBe(B));
    expect(screen.getByTestId("am-review-watch-only")).toBeTruthy();
    expect(screen.queryByTestId("am-review-not-connected")).toBeNull();
    expect(screen.queryByText("Approve only")).toBeNull();
    const cta = screen.getByTestId("am-review-execute");
    expect(cta.props.accessibilityState?.disabled).toBe(true);
    expect(screen.getByTestId("am-review-amount-input").props.editable).toBe(false);

    fireEvent.press(cta);
    // phase は review のまま (approving / success に進まない)
    await waitFor(() => expect(screen.getByTestId("am-review-execute")).toBeTruthy());
    expect(screen.getByText("Review & approve")).toBeTruthy();
    expect(screen.queryByTestId("am-success")).toBeNull();
    expect(signTransactions).not.toHaveBeenCalled();
    expect(VersionedTransaction.deserialize).not.toHaveBeenCalled();
    expect(approve).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    qc.clear();
  });

  it("接続 wallet があれば watch より優先し、従来どおり 'Sign & execute'", async () => {
    jest.spyOn(api, "getOracleStatus").mockResolvedValue(ORACLE_OK);
    jest.spyOn(api, "getPositions").mockResolvedValue([USDC_IN_WALLET]);
    jest.spyOn(api, "getKaminoReserves").mockResolvedValue([]);
    useWatchStore.getState().addWatch(B);
    useWalletStore.setState({
      authorization: {
        address: A,
        label: "Phantom",
        authToken: "tok",
        walletUriBase: null,
        chain: "solana:mainnet",
      },
      status: "connected",
    });

    const qc: QueryClient = createQueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 60_000 } },
    });
    render(
      <SafeAreaProvider initialMetrics={METRICS}>
        <QueryClientProvider client={qc}>
          <ActionModal plan={DEPOSIT_PLAN} onClose={() => {}} testID="am" />
        </QueryClientProvider>
      </SafeAreaProvider>
    );
    await waitFor(() => expect(screen.getByText("Sign & execute")).toBeTruthy());
    expect(screen.queryByTestId("am-review-watch-only")).toBeNull();
    qc.clear();
  });
});

describe("ActionModal — 公開 BFF の 409 action_not_available", () => {
  it("署名前の拒否として 'Stopped before signing' を出す (失敗扱いにしない)", async () => {
    jest.clearAllMocks();
    jest.spyOn(api, "getOracleStatus").mockResolvedValue(ORACLE_OK);
    jest.spyOn(api, "getPositions").mockResolvedValue([USDC_IN_WALLET]);
    jest.spyOn(api, "getKaminoReserves").mockResolvedValue([]);
    (buildSolanaTxs as jest.Mock).mockRejectedValueOnce(
      new api.BffError(
        "Execution is disabled: this server is configured for plans only.",
        "action_not_available"
      )
    );
    useWalletStore.setState({
      authorization: {
        address: A,
        label: "Phantom",
        authToken: "tok",
        walletUriBase: null,
        chain: "solana:mainnet",
      },
      status: "connected",
    });

    const qc: QueryClient = createQueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 60_000 } },
    });
    render(
      <SafeAreaProvider initialMetrics={METRICS}>
        <QueryClientProvider client={qc}>
          <ActionModal plan={DEPOSIT_PLAN} onClose={() => {}} testID="am" />
        </QueryClientProvider>
      </SafeAreaProvider>
    );
    await waitFor(() =>
      expect(
        screen.getByTestId("am-review-execute").props.accessibilityState?.disabled
      ).toBe(false)
    );
    fireEvent.press(screen.getByTestId("am-review-execute"));
    await waitFor(() => expect(screen.getByText("Stopped before signing")).toBeTruthy());
    expect(signTransactions).not.toHaveBeenCalled();
    qc.clear();
  });
});

// ─── 2026-10-13: 着地確認 (RPC 受理では success にしない) ─────────────────────

function connectA() {
  useWalletStore.setState({
    authorization: {
      address: A,
      label: "Phantom",
      authToken: "tok",
      walletUriBase: null,
      chain: "solana:mainnet",
    },
    status: "connected",
  });
}

function renderDeposit(): QueryClient {
  const qc: QueryClient = createQueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 60_000 } },
  });
  render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <QueryClientProvider client={qc}>
        <ActionModal plan={DEPOSIT_PLAN} onClose={() => {}} testID="am" />
      </QueryClientProvider>
    </SafeAreaProvider>
  );
  return qc;
}

async function pressExecuteWhenReady() {
  await waitFor(() =>
    expect(
      screen.getByTestId("am-review-execute").props.accessibilityState?.disabled
    ).toBe(false)
  );
  fireEvent.press(screen.getByTestId("am-review-execute"));
}

function status(partial: Partial<TxStatusResponse>): TxStatusResponse {
  return { signature: "sig_1", status: "pending", slot: null, err: null, ...partial };
}

describe("ActionModal — submit 後の着地確認 (/tx/status)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(api, "getOracleStatus").mockResolvedValue(ORACLE_OK);
    jest.spyOn(api, "getPositions").mockResolvedValue([USDC_IN_WALLET]);
    jest.spyOn(api, "getKaminoReserves").mockResolvedValue([]);
    jest.spyOn(api, "submitSignedTx").mockResolvedValue({ signature: "sig_1" } as never);
    connectA();
  });

  it("1 回目の poll で confirmed → success (signature を出す)", async () => {
    const getTxStatus = jest
      .spyOn(api, "getTxStatus")
      .mockResolvedValue(status({ status: "confirmed", slot: 10 }));
    const qc = renderDeposit();
    await pressExecuteWhenReady();
    await waitFor(() => expect(screen.getByText("Approved & executed")).toBeTruthy());
    expect(getTxStatus).toHaveBeenCalledWith("sig_1");
    expect(screen.getByTestId("am-success-signature")).toBeTruthy();
    qc.clear();
  });

  it("on-chain で failed → error (success にしない、err を見せる)", async () => {
    jest
      .spyOn(api, "getTxStatus")
      .mockResolvedValue(status({ status: "failed", slot: 10, err: '{"InstructionError":[0,"Custom"]}' }));
    const qc = renderDeposit();
    await pressExecuteWhenReady();
    await waitFor(() => expect(screen.getByTestId("am-error-message")).toBeTruthy());
    expect(screen.getByTestId("am-error-message").props.children).toContain(
      "failed on-chain"
    );
    expect(screen.queryByText("Approved & executed")).toBeNull();
    expect(screen.getByText("Failed")).toBeTruthy();
    qc.clear();
  });

  it("pending のまま現在高が lastValidBlockHeight を超えた → expired の error", async () => {
    (buildSolanaTxs as jest.Mock).mockResolvedValueOnce({
      txs: ["AAAA"],
      lastValidBlockHeight: 100,
    });
    const getTxStatus = jest
      .spyOn(api, "getTxStatus")
      .mockResolvedValue(status({ status: "pending", blockHeight: 151 }));
    // lib は expired を **2 回連続** の poll で確定する (code review #48)。poll 間隔 (2 秒) は即時にする
    const realSetTimeout = global.setTimeout;
    jest.spyOn(global, "setTimeout").mockImplementation(((
      fn: () => void,
      ms?: number
    ) => realSetTimeout(fn, ms === 2000 ? 0 : ms)) as typeof setTimeout);
    const qc = renderDeposit();
    await pressExecuteWhenReady();
    await waitFor(() => expect(screen.getByTestId("am-error-message")).toBeTruthy());
    expect(screen.getByTestId("am-error-message").props.children).toContain(
      "expired"
    );
    expect(screen.getByText("Transaction expired")).toBeTruthy();
    expect(getTxStatus.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText("Approved & executed")).toBeNull();
    qc.clear();
  });

  it("/tx/status が無い旧 BFF (TxConfirmAbort) → submitted (Solscan 導線、success にしない)", async () => {
    jest.spyOn(api, "getTxStatus").mockRejectedValue(new TxConfirmAbort());
    const qc = renderDeposit();
    await pressExecuteWhenReady();
    await waitFor(() => expect(screen.getByTestId("am-submitted")).toBeTruthy());
    expect(screen.getByText("Not confirmed yet")).toBeTruthy();
    expect(screen.getByTestId("am-submitted-solscan")).toBeTruthy();
    expect(screen.queryByText("Approved & executed")).toBeNull();
    qc.clear();
  });
});

describe("ActionModal — plans-only server (/health executionTarget = disabled)", () => {
  beforeEach(() => jest.clearAllMocks());

  it("CTA は disabled、注記を出し、押しても builder / 署名に進まない", async () => {
    jest.spyOn(api, "getOracleStatus").mockResolvedValue(ORACLE_OK);
    jest.spyOn(api, "getPositions").mockResolvedValue([USDC_IN_WALLET]);
    jest.spyOn(api, "getKaminoReserves").mockResolvedValue([]);
    jest.spyOn(api, "getHealth").mockResolvedValue({
      status: "ok",
      solana: { heliusConfigured: true, executionTarget: "disabled" },
    });
    const submit = jest.spyOn(api, "submitSignedTx");
    connectA();
    const qc = renderDeposit();

    await waitFor(() =>
      expect(screen.getByTestId("am-review-execution-disabled")).toBeTruthy()
    );
    expect(
      screen.getByText(
        "This server is read-only (plans only). Deposits and withdrawals are disabled."
      )
    ).toBeTruthy();
    const cta = screen.getByTestId("am-review-execute");
    expect(cta.props.accessibilityState?.disabled).toBe(true);
    expect(screen.getByText("Unavailable")).toBeTruthy();

    fireEvent.press(cta);
    await waitFor(() => expect(screen.getByText("Review & approve")).toBeTruthy());
    expect(buildSolanaTxs).not.toHaveBeenCalled();
    expect(signTransactions).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    qc.clear();
  });
});

// ─── 2026-10-13 (PR #48 review): 閉じた / 差し替えた plan の run を進めない ─────────────

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("ActionModal — 閉じた run は wallet を開かない / broadcast しない", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(api, "getOracleStatus").mockResolvedValue(ORACLE_OK);
    jest.spyOn(api, "getPositions").mockResolvedValue([USDC_IN_WALLET]);
    jest.spyOn(api, "getKaminoReserves").mockResolvedValue([]);
    connectA();
  });

  it("Preparing… 中に閉じる → builder が後で resolve しても signTransactions を呼ばない", async () => {
    const build = deferred<{ txs: string[]; lastValidBlockHeight: number | null }>();
    (buildSolanaTxs as jest.Mock).mockReturnValueOnce(build.promise);
    const submit = jest.spyOn(api, "submitSignedTx");
    const qc = renderDeposit();
    await pressExecuteWhenReady();
    await waitFor(() => expect(screen.getByText("Preparing transaction…")).toBeTruthy());

    fireEvent.press(screen.getByTestId("am-close"));
    build.resolve({ txs: ["AAAA"], lastValidBlockHeight: null });
    await waitFor(() => expect(screen.getByText("Review & approve")).toBeTruthy());
    // builder の resolve 後の microtask を流しきってから見る
    await new Promise((r) => setTimeout(r, 0));
    expect(signTransactions).not.toHaveBeenCalled();
    expect(VersionedTransaction.deserialize).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    expect(screen.queryByText("Approve in your wallet to sign the transaction")).toBeNull();
    qc.clear();
  });

  it("wallet prompt 中に閉じる → 署名が後で返っても submitSignedTx を呼ばない", async () => {
    const signed = deferred<{ serialize: () => Uint8Array }[]>();
    (signTransactions as jest.Mock).mockReturnValueOnce(signed.promise);
    const submit = jest
      .spyOn(api, "submitSignedTx")
      .mockResolvedValue({ signature: "sig_1" } as never);
    const qc = renderDeposit();
    await pressExecuteWhenReady();
    await waitFor(() =>
      expect(
        screen.getByText("Approve in your wallet to sign the transaction")
      ).toBeTruthy()
    );
    expect(signTransactions).toHaveBeenCalledTimes(1);

    fireEvent.press(screen.getByTestId("am-close"));
    signed.resolve([{ serialize: () => new Uint8Array([1, 2, 3]) }]);
    await waitFor(() => expect(screen.getByText("Review & approve")).toBeTruthy());
    await new Promise((r) => setTimeout(r, 0));
    expect(submit).not.toHaveBeenCalled();
    expect(screen.queryByText("Sending to Solana…")).toBeNull();
    qc.clear();
  });
});

describe("ActionModal — 着地確定後にも invalidate する", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(api, "getOracleStatus").mockResolvedValue(ORACLE_OK);
    jest.spyOn(api, "getPositions").mockResolvedValue([USDC_IN_WALLET]);
    jest.spyOn(api, "getKaminoReserves").mockResolvedValue([]);
    jest.spyOn(api, "submitSignedTx").mockResolvedValue({ signature: "sig_1" } as never);
    connectA();
  });

  it("2 回目の poll で confirmed → 送信時 (5 秒) + 着地後 (4 秒) の 2 回 invalidate", async () => {
    const getTxStatus = jest
      .spyOn(api, "getTxStatus")
      .mockResolvedValueOnce(status({ status: "pending" }))
      .mockResolvedValue(status({ status: "confirmed", slot: 10 }));
    const invalidate = jest
      .spyOn(walletQuerySync, "invalidateWalletAfterTx")
      .mockResolvedValue(undefined as never);

    // invalidate の遅延 (5000 / 4000) は捕まえて手で流す。poll 間隔 (2000) は即時にする
    const realSetTimeout = global.setTimeout;
    const delayed: { ms: number; fn: () => void }[] = [];
    jest.spyOn(global, "setTimeout").mockImplementation(((
      fn: () => void,
      ms?: number
    ) => {
      if (ms === 5000 || ms === POST_SETTLE_INVALIDATE_MS) {
        delayed.push({ ms, fn });
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }
      return realSetTimeout(fn, ms === 2000 ? 0 : ms);
    }) as typeof setTimeout);

    const qc = renderDeposit();
    await pressExecuteWhenReady();
    await waitFor(() => expect(screen.getByText("Approved & executed")).toBeTruthy());
    expect(getTxStatus).toHaveBeenCalledTimes(2);
    // 送信直後の 5 秒 + 着地確定後の 4 秒 (この順に予約される)
    expect(delayed.map((d) => d.ms)).toEqual([5000, POST_SETTLE_INVALIDATE_MS]);
    expect(invalidate).not.toHaveBeenCalled();
    for (const d of delayed) d.fn();
    expect(invalidate).toHaveBeenCalledTimes(2);
    expect(invalidate.mock.calls.map((c) => c[1])).toEqual([A, A]);
    qc.clear();
  });
});

describe("ActionModal — 実行中に親が plan を差し替える", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(api, "getOracleStatus").mockResolvedValue(ORACLE_OK);
    jest.spyOn(api, "getPositions").mockResolvedValue([USDC_IN_WALLET]);
    jest.spyOn(api, "getKaminoReserves").mockResolvedValue([]);
    jest.spyOn(api, "submitSignedTx").mockResolvedValue({ signature: "sig_1" } as never);
    connectA();
  });

  it("confirming 中に別 plan へ → 新 plan は review、旧 run の着地は success にしない", async () => {
    const pendingStatus = deferred<TxStatusResponse>();
    jest.spyOn(api, "getTxStatus").mockReturnValueOnce(pendingStatus.promise);
    const OTHER_PLAN: AgentPlan = { ...DEPOSIT_PLAN, plan_id: "plan_other" } as AgentPlan;

    const qc: QueryClient = createQueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 60_000 } },
    });
    const tree = (p: AgentPlan) => (
      <SafeAreaProvider initialMetrics={METRICS}>
        <QueryClientProvider client={qc}>
          <ActionModal plan={p} onClose={() => {}} testID="am" />
        </QueryClientProvider>
      </SafeAreaProvider>
    );
    const { rerender } = render(tree(DEPOSIT_PLAN));
    await pressExecuteWhenReady();
    await waitFor(() => expect(screen.getByTestId("am-confirming")).toBeTruthy());

    rerender(tree(OTHER_PLAN));
    await waitFor(() => expect(screen.getByText("Review & approve")).toBeTruthy());
    expect(screen.queryByTestId("am-confirming")).toBeNull();
    expect(screen.getByTestId("am-review-execute")).toBeTruthy();

    // 旧 plan の tx が後から着地しても、新 plan の sheet を success に書き換えない
    pendingStatus.resolve(status({ status: "confirmed", slot: 10 }));
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByText("Approved & executed")).toBeNull();
    expect(screen.getByText("Review & approve")).toBeTruthy();
    qc.clear();
  });
});
