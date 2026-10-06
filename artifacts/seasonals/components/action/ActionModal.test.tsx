/**
 * ActionModal — review body の oracle 表示 (§4.6)
 *
 * tier C (Pyth のみ) の注記は warning ではないので WarningArea の外に muted 1 行で出す
 * (web OracleGate の「single price source」と同じ文言)。blocked / tier A では出さない。
 * oracle は IS_TEST_ENV の fixture 経路 (getOracleStatus) を spy で差し替える。
 */
import React, { type ReactNode } from "react";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { fixtureAgentPlanSimulated } from "@workspace/lib/__fixtures__";
import type { AgentPlan, OracleResult } from "@workspace/lib/types";

import { ActionModal } from "./ActionModal";
import * as api from "../../services/api";
import { createQueryClient } from "../../services/queryClient";

function freshClient(): QueryClient {
  return createQueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
}

const METRICS = {
  frame: { x: 0, y: 0, width: 400, height: 800 },
  insets: { top: 24, left: 0, right: 0, bottom: 16 },
};

function wrap(ui: ReactNode) {
  return (
    <SafeAreaProvider initialMetrics={METRICS}>
      <QueryClientProvider client={freshClient()}>{ui}</QueryClientProvider>
    </SafeAreaProvider>
  );
}

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

function oracle(overrides: Partial<OracleResult>): OracleResult {
  return {
    asset_symbol: "USDC",
    status: "ok",
    primary: "pyth",
    price_usd: null,
    pyth: { available: true, price_usd: null, age_seconds: 3 },
    secondary: { source: null, available: false, price_usd: null, age_seconds: null },
    tier: "C",
    divergence_pct: null,
    warnings: [],
    block_reason: null,
    ...overrides,
  } as OracleResult;
}

// web3.js / MWA は native 依存 (rpc-websockets 等) を引くので review 表示の test では stub
jest.mock("@solana/web3.js", () => ({
  VersionedTransaction: { deserialize: jest.fn() },
}));
jest.mock("../../services/mwa", () => ({
  signTransactions: jest.fn(),
  authorize: jest.fn(),
  deauthorize: jest.fn(),
  reauthorize: jest.fn(),
}));

afterEach(() => {
  jest.restoreAllMocks();
});

describe("ActionModal review — tier C single-source note", () => {
  it("tier C (ok) は WarningArea の外に注記を 1 行出す", async () => {
    jest.spyOn(api, "getOracleStatus").mockResolvedValue(oracle({ tier: "C" }));
    render(wrap(<ActionModal plan={DEPOSIT_PLAN} onClose={() => {}} testID="am" />));
    await waitFor(() =>
      expect(screen.getByTestId("oracle-single-source-note")).toBeTruthy()
    );
    expect(
      screen.getByText(
        "Single price source (Pyth). Not cross-checked against a second oracle."
      )
    ).toBeTruthy();
    // warning ではない: WarningArea の oracle 警告枠には入らない
    expect(screen.queryByTestId("am-review-warning-area-oracle")).toBeNull();
  });

  it("tier A では注記を出さない", async () => {
    jest.spyOn(api, "getOracleStatus").mockResolvedValue(oracle({ tier: "A" }));
    render(wrap(<ActionModal plan={DEPOSIT_PLAN} onClose={() => {}} testID="am" />));
    await waitFor(() => expect(screen.getByText("Approve only")).toBeTruthy());
    expect(screen.queryByTestId("oracle-single-source-note")).toBeNull();
  });

  it("tier C でも blocked なら注記ではなく blocked card", async () => {
    jest.spyOn(api, "getOracleStatus").mockResolvedValue(
      oracle({ tier: "C", status: "blocked", block_reason: "oracle_both_stale" } as Partial<OracleResult>)
    );
    render(wrap(<ActionModal plan={DEPOSIT_PLAN} onClose={() => {}} testID="am" />));
    await waitFor(() =>
      expect(screen.getByTestId("am-review-oracle-blocked")).toBeTruthy()
    );
    expect(screen.queryByTestId("oracle-single-source-note")).toBeNull();
  });
});
