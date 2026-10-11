/**
 * ActionModal — onchain tx 成功後の cache 更新 (API 効率化計画 Phase A-3 / §4.0)
 *
 * tx 成功 5 秒後の invalidate は **署名した wallet の key だけ** を対象にする:
 *   - positions / earn-positions / wallet-time-events / portfolio-history (8.8.2 は history が漏れていた)
 *   - 他 wallet の保持 cache・fixture key・SKR には触らない
 * jest は USE_ONCHAIN=false なのでこのファイルだけ config を mock し、署名 / 送信 / tx 構築は stub。
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
  buildSolanaTxs: jest.fn(async () => ["AAAA"]),
}));

import React, { type ReactNode } from "react";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { fixtureAgentPlanSimulated } from "@workspace/lib/__fixtures__";
import type { AgentPlan, OracleResult, Position } from "@workspace/lib/types";

import { ActionModal } from "./ActionModal";
import * as api from "../../services/api";
import { createQueryClient } from "../../services/queryClient";
import { useWalletStore } from "../../services/walletStore";

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
});

describe("ActionModal — tx 後の invalidate は署名した wallet だけ", () => {
  it("5 秒後に A の 4 系統を invalidate し、B / fixture / SKR の cache は触らない", async () => {
    jest.spyOn(api, "getOracleStatus").mockResolvedValue(ORACLE_OK);
    jest.spyOn(api, "getPositions").mockResolvedValue([USDC_IN_WALLET]);
    jest.spyOn(api, "getKaminoReserves").mockResolvedValue([]);
    jest.spyOn(api, "submitSignedTx").mockResolvedValue({ signature: "sig_1" } as never);
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
