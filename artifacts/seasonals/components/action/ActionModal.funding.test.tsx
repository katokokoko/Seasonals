/**
 * ActionModal — funding-token deposit (2026-10-13、PR-B)
 *
 * Jupiter Lend JupUSD market は registry の funding allowlist で USDC を受け付ける
 * (Jupiter が USDC → jlJupUSD を 1 tx で route)。ここで固定する挙動:
 *   (a) asset = USDC + metadata.share_mint → 単位 USDC、残高は mint で引く、builder に inputMint = USDC
 *   (b) underlying / funding の両方を保有 → "Pay with" toggle。JupUSD に切り替えると inputMint が消える
 *   (c) どちらも無い → "Insufficient JupUSD — you have 0" + "This market also accepts USDC"、CTA disabled
 *   (d) 見積り (useSwapEarnQuote) → "Receive ≈ 0.9608 jlJupUSD"。fair value blocked なら CTA を止める
 *   (e) oracle は 2 mint とも gate (USDC blocked + JupUSD ok → blocked)
 *
 * ActionModal.onchain.test.tsx と同じく config / web3 / mwa を mock するが、solana-tx は
 * mock しない (builder の body まで見る)。BFF は api の spy で差し替える。
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

import React from "react";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { fixtureAgentPlanSimulated } from "@workspace/lib/__fixtures__";
import type {
  AgentPlan,
  OracleResult,
  Position,
  SwapEarnQuoteResponse,
  SwapEarnTxResponse,
} from "@workspace/lib/types";
import { findMarketByProtocolAsset } from "@workspace/lib/config/swap-earn-markets";

import { ActionModal } from "./ActionModal";
import * as api from "../../services/api";
import { createQueryClient } from "../../services/queryClient";
import { useWalletStore } from "../../services/walletStore";
import { useWatchStore } from "../../stores/watch";

const A = "7nZbHkQqXkr3eW8s2dKvHqBxNz9vC5jPpL2tF6mYrXaA";
const MARKET = findMarketByProtocolAsset("jupiter_lend", "JupUSD")!;
const USDC_MINT = MARKET.funding![0]!.mint;
const JUPUSD_MINT = MARKET.underlying_mint;
const SHARE_MINT = MARKET.share_mint;

const METRICS = {
  frame: { x: 0, y: 0, width: 400, height: 800 },
  insets: { top: 24, left: 0, right: 0, bottom: 16 },
};

function depositPlan(asset: string, metadata?: Record<string, unknown>): AgentPlan {
  return {
    ...fixtureAgentPlanSimulated,
    plan_id: `funding_${asset}_${Math.random()}`,
    candidate_actions: [],
    selected_action: {
      ...fixtureAgentPlanSimulated.selected_action!,
      action_type: "deposit",
      protocol: "jupiter",
      asset,
      amount: "1000000",
      metadata,
    },
  } as AgentPlan;
}

/** Menu が funding deposit で開く形 (app/index.tsx handleStartActionFromServices) */
const FUNDED_PLAN = () => depositPlan("USDC", { share_mint: SHARE_MINT });
/** Menu が underlying で開く形 (従来、share_mint 無し) */
const UNDERLYING_PLAN = () => depositPlan("JupUSD", { pool_id: "jl_JupUSD" });

function walletRow(symbol: string, mint: string, amount: string): Position {
  return {
    position_id: `helius_${A}_${mint}`,
    protocol_id: "wallet_stable",
    asset_symbol: symbol,
    current_amount: amount,
    raw_state: { mint, source: "helius_das", decimals: 6 },
  } as unknown as Position;
}
/** DAS は JupUSD を "jupUSD" で返す (symbol は表記揺れ、mint で引けること) */
const USDC_ROW = walletRow("USDC", USDC_MINT, "50000000");
const JUPUSD_ROW = walletRow("jupUSD", JUPUSD_MINT, "2000000");

function oracle(symbol: string, status: "ok" | "blocked"): OracleResult {
  return {
    asset_symbol: symbol,
    status,
    primary: "pyth",
    price_usd: status === "ok" ? "1.00000000" : null,
    pyth: { available: true, price_usd: null, age_seconds: 3 },
    secondary: { source: "redstone", available: true, price_usd: null, age_seconds: 3 },
    tier: "A",
    divergence_pct: null,
    warnings: [],
    block_reason: status === "blocked" ? "both_stale" : null,
  } as unknown as OracleResult;
}

function mockOracles(statusByMint: Record<string, "ok" | "blocked"> = {}) {
  return jest.spyOn(api, "getOracleStatus").mockImplementation(async (mint: string) =>
    oracle(mint === USDC_MINT ? "USDC" : "JupUSD", statusByMint[mint] ?? "ok")
  );
}

function quote(partial: Partial<SwapEarnQuoteResponse> = {}): SwapEarnQuoteResponse {
  return {
    inputMint: USDC_MINT,
    outputMint: SHARE_MINT,
    inAmount: "1000000",
    outAmount: "960800",
    minOut: "956000",
    priceImpactPct: "0",
    slippageBps: 50,
    fairValue: { status: "ok", deviation_bps: 3 },
    ...partial,
  };
}

const TX: SwapEarnTxResponse = {
  swapTransaction: "AAAA",
  lastValidBlockHeight: 100,
  outAmount: "960800",
  outputMint: SHARE_MINT,
  quote: {},
};

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

function renderModal(plan: AgentPlan): QueryClient {
  const qc: QueryClient = createQueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 60_000 } },
  });
  render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <QueryClientProvider client={qc}>
        <ActionModal plan={plan} onClose={() => {}} testID="am" />
      </QueryClientProvider>
    </SafeAreaProvider>
  );
  return qc;
}

/** Text の children (配列 / 文字列) を 1 本の文字列に */
function textOf(testID: string): string {
  const c = screen.getByTestId(testID).props.children as unknown;
  return ([] as unknown[]).concat(c).filter((x) => typeof x === "string").join("");
}

function ctaDisabled(): boolean | undefined {
  return screen.getByTestId("am-review-execute").props.accessibilityState?.disabled;
}

beforeEach(() => {
  jest.clearAllMocks();
  connectA();
  jest.spyOn(api, "submitSignedTx").mockResolvedValue({ signature: "sig_1" } as never);
  jest
    .spyOn(api, "getTxStatus")
    .mockResolvedValue({ signature: "sig_1", status: "confirmed", slot: 1, err: null });
});

afterEach(() => {
  jest.restoreAllMocks();
  useWalletStore.getState().reset();
  useWatchStore.getState().reset();
});

describe("ActionModal — funding deposit (USDC → jlJupUSD)", () => {
  it("(a) USDC + share_mint: 単位 USDC、残高は mint で引き、builder に inputMint = USDC を渡す", async () => {
    mockOracles();
    jest.spyOn(api, "getPositions").mockResolvedValue([USDC_ROW]);
    jest.spyOn(api, "getSwapEarnQuote").mockResolvedValue(quote());
    const build = jest.spyOn(api, "getSwapEarnDepositTx").mockResolvedValue(TX);
    const qc = renderModal(FUNDED_PLAN());

    await waitFor(() => expect(textOf("am-review-balance")).toBe("Balance 50 USDC"));
    expect(textOf("am-review-amount-unit")).toBe("USDC");
    // 片方しか持たないので toggle は出ない
    expect(screen.queryByTestId("am-review-pay-with")).toBeNull();
    await waitFor(() => expect(ctaDisabled()).toBe(false));
    fireEvent.press(screen.getByTestId("am-review-execute"));
    await waitFor(() => expect(screen.getByText("Approved & executed")).toBeTruthy());
    expect(build).toHaveBeenCalledWith({
      user: A,
      shareMint: SHARE_MINT,
      amount: "1000000",
      slippageBps: 50,
      inputMint: USDC_MINT,
    });
    qc.clear();
  });

  it("(a') underlying の残高も mint で引く (DAS の 'jupUSD' 表記でも 'JupUSD' の残高になる)", async () => {
    mockOracles();
    jest.spyOn(api, "getPositions").mockResolvedValue([JUPUSD_ROW]);
    const qc = renderModal(UNDERLYING_PLAN());
    await waitFor(() => expect(textOf("am-review-balance")).toBe("Balance 2 JupUSD"));
    expect(screen.queryByTestId("am-review-amount-error")).toBeNull();
    // underlying deposit に見積り行 (funding 専用) は出ない
    expect(screen.queryByTestId("am-review-funding")).toBeNull();
    qc.clear();
  });

  it("(b) 両方保有: toggle が出て、JupUSD に切り替えると単位 / 残高が追従し inputMint が消える", async () => {
    mockOracles();
    jest.spyOn(api, "getPositions").mockResolvedValue([USDC_ROW, JUPUSD_ROW]);
    jest.spyOn(api, "getSwapEarnQuote").mockResolvedValue(quote());
    const build = jest.spyOn(api, "getSwapEarnDepositTx").mockResolvedValue(TX);
    const qc = renderModal(FUNDED_PLAN());

    await waitFor(() => expect(screen.getByTestId("am-review-pay-with")).toBeTruthy());
    // 既定 = plan の asset (USDC)
    expect(
      screen.getByTestId("am-review-pay-with-USDC").props.accessibilityState?.selected
    ).toBe(true);
    expect(textOf("am-review-amount-unit")).toBe("USDC");

    fireEvent.press(screen.getByTestId("am-review-pay-with-JupUSD"));
    await waitFor(() => expect(textOf("am-review-amount-unit")).toBe("JupUSD"));
    expect(
      screen.getByTestId("am-review-pay-with-JupUSD").props.accessibilityState?.selected
    ).toBe(true);
    expect(textOf("am-review-balance")).toBe("Balance 2 JupUSD");
    // underlying 払いは funding の見積り行を出さない
    expect(screen.queryByTestId("am-review-funding")).toBeNull();

    await waitFor(() => expect(ctaDisabled()).toBe(false));
    fireEvent.press(screen.getByTestId("am-review-execute"));
    await waitFor(() => expect(build).toHaveBeenCalled());
    const body = build.mock.calls[0]![0] as Record<string, unknown>;
    expect(body).toEqual({
      user: A,
      shareMint: SHARE_MINT,
      amount: "1000000",
      slippageBps: 50,
    });
    expect("inputMint" in body).toBe(false);
    qc.clear();
  });

  it("(c) どちらも無い: Insufficient + 'This market also accepts USDC'、CTA disabled", async () => {
    mockOracles();
    jest.spyOn(api, "getPositions").mockResolvedValue([]);
    const build = jest.spyOn(api, "getSwapEarnDepositTx");
    const qc = renderModal(UNDERLYING_PLAN());

    await waitFor(() =>
      expect(screen.getByText("Insufficient JupUSD — you have 0")).toBeTruthy()
    );
    expect(screen.getByTestId("am-review-accepts-hint").props.children).toBe(
      "This market also accepts USDC"
    );
    expect(screen.queryByTestId("am-review-pay-with")).toBeNull();
    await waitFor(() => expect(screen.getByText("Sign & execute")).toBeTruthy());
    expect(ctaDisabled()).toBe(true);
    fireEvent.press(screen.getByTestId("am-review-execute"));
    expect(build).not.toHaveBeenCalled();
    qc.clear();
  });

  it("(d) 見積り: 'Pay with USDC · Receive ≈ 0.9608 jlJupUSD via Jupiter'", async () => {
    mockOracles();
    jest.spyOn(api, "getPositions").mockResolvedValue([USDC_ROW]);
    const getQuote = jest.spyOn(api, "getSwapEarnQuote").mockResolvedValue(quote());
    const qc = renderModal(FUNDED_PLAN());

    await waitFor(() =>
      expect(textOf("am-review-funding-line")).toBe(
        "Pay with USDC · Receive ≈ 0.9608 jlJupUSD via Jupiter"
      )
    );
    expect(screen.getByText(/≈ 0\.9608 jlJupUSD/)).toBeTruthy();
    expect(getQuote.mock.calls[0]![0]).toEqual({
      shareMint: SHARE_MINT,
      inputMint: USDC_MINT,
      amount: "1000000",
    });
    expect(screen.queryByTestId("am-review-funding-blocked")).toBeNull();
    qc.clear();
  });

  it("(d') fair value が blocked の見積り → 理由を出して CTA を止める ('Blocked (price check)')", async () => {
    mockOracles();
    jest.spyOn(api, "getPositions").mockResolvedValue([USDC_ROW]);
    jest.spyOn(api, "getSwapEarnQuote").mockResolvedValue(
      quote({
        fairValue: { status: "blocked", reason: "fair_value_deviation", deviation_bps: 420 },
      })
    );
    const build = jest.spyOn(api, "getSwapEarnDepositTx");
    const qc = renderModal(FUNDED_PLAN());

    await waitFor(() =>
      expect(screen.getByTestId("am-review-funding-blocked").props.children).toBe(
        "The swap price is far from the redemption value"
      )
    );
    await waitFor(() => expect(screen.getByText("Blocked (price check)")).toBeTruthy());
    expect(ctaDisabled()).toBe(true);
    fireEvent.press(screen.getByTestId("am-review-execute"));
    expect(build).not.toHaveBeenCalled();
    qc.clear();
  });

  it("(e) oracle: USDC blocked + JupUSD ok → 'Blocked (oracle)' で CTA disabled (2 mint とも引く)", async () => {
    const getOracle = mockOracles({ [USDC_MINT]: "blocked" });
    jest.spyOn(api, "getPositions").mockResolvedValue([USDC_ROW]);
    jest.spyOn(api, "getSwapEarnQuote").mockResolvedValue(quote());
    const build = jest.spyOn(api, "getSwapEarnDepositTx");
    const qc = renderModal(FUNDED_PLAN());

    await waitFor(() => expect(screen.getByText("Blocked (oracle)")).toBeTruthy());
    expect(screen.getByTestId("am-review-oracle-blocked")).toBeTruthy();
    expect(ctaDisabled()).toBe(true);
    const mints = getOracle.mock.calls.map(([m]) => m);
    expect(mints).toEqual(expect.arrayContaining([JUPUSD_MINT, USDC_MINT]));
    fireEvent.press(screen.getByTestId("am-review-execute"));
    expect(build).not.toHaveBeenCalled();
    qc.clear();
  });

  it("(e') 両 oracle ok なら gate は通る (underlying deposit は 1 mint だけ引く)", async () => {
    const getOracle = mockOracles();
    jest.spyOn(api, "getPositions").mockResolvedValue([JUPUSD_ROW]);
    const qc = renderModal(UNDERLYING_PLAN());
    await waitFor(() => expect(ctaDisabled()).toBe(false));
    expect(new Set(getOracle.mock.calls.map(([m]) => m))).toEqual(new Set([JUPUSD_MINT]));
    qc.clear();
  });
});
