/**
 * Dashboard Portfolio: 複数 address の合算・category 別 allocation・絞り込み・
 * 取得失敗の明示 (0 として混ぜない) を画面で確認する。
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type {
  PortfolioHistoryPoint,
  PortfolioHistoryResponse,
  PortfolioHoldingsResponse,
} from "@workspace/lib/types";
import { PositionCategory } from "@workspace/lib/types";
import { useSession } from "../../state/session";
import { PortfolioPanel } from "./PortfolioPanel";

// recharts の ResponsiveContainer は ResizeObserver を使う (jsdom には無い)
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const ETH = "0x1111111111111111111111111111111111111111";
const SOL = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const DAY = 86_400;
const T0 = 1_790_000_000;

function pt(i: number, usd: string, deposited = "0.00000000", flow = "0.00000000"): PortfolioHistoryPoint {
  return {
    at: T0 + i * DAY,
    usd,
    native: "0.00000000",
    deposited_usd: deposited,
    deposited_native: "0.00000000",
    flow_usd: flow,
    deposited_flow_usd: "0.00000000",
  };
}

const ethHistory: PortfolioHistoryResponse = {
  chain: "ethereum",
  points: [pt(0, "1000.00000000", "400.00000000"), pt(1, "1010.00000000", "405.00000000"), pt(2, "1020.00000000", "410.00000000")],
  oldest_at: T0,
  approximated_symbols: ["stETH"],
  excluded_from_history: ["Aave V4"],
};
const solHistory: PortfolioHistoryResponse = {
  chain: "solana",
  // 2 点目で 100 入金 (flow)。合算の増減からは除かれる
  points: [pt(0, "50.00000000"), pt(1, "150.00000000", "0.00000000", "100.00000000"), pt(2, "151.00000000")],
  oldest_at: T0,
  approximated_symbols: [],
};
const ethHoldings: PortfolioHoldingsResponse = {
  chain: "ethereum",
  address: ETH.toLowerCase(),
  holdings: [
    { chain: "ethereum", address: ETH, symbol: "ETH", protocol_id: "ethereum", category: PositionCategory.Other, usd: "600.00000000", deposited: false, in_history: true },
    { chain: "ethereum", address: ETH, symbol: "stETH", protocol_id: "lido", category: PositionCategory.Staking, usd: "420.00000000", deposited: true, in_history: true },
    { chain: "ethereum", address: ETH, symbol: "Aave V4 · Main", protocol_id: "aave", category: PositionCategory.Lending, usd: "80.00000000", deposited: true, in_history: false },
  ],
};
const solHoldings: PortfolioHoldingsResponse = {
  chain: "solana",
  address: SOL,
  holdings: [{ chain: "solana", address: SOL, symbol: "USDC", protocol_id: "wallet_stable", category: PositionCategory.Stable, usd: "151.00000000", deposited: false, in_history: true }],
};

type Route = { match: string; status?: number; body: unknown };

function renderPanel(routes: Route[]) {
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    const hit = routes.find((r) => url.includes(r.match));
    if (!hit) return Promise.reject(new Error("offline"));
    return Promise.resolve(
      new Response(JSON.stringify(hit.body), { status: hit.status ?? 200, headers: { "content-type": "application/json" } })
    );
  }) as typeof fetch;
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <PortfolioPanel />
    </QueryClientProvider>
  );
}

const ALL_OK: Route[] = [
  { match: `/eth/portfolio/history?address=${ETH}`, body: ethHistory },
  { match: `/eth/portfolio/holdings?address=${ETH}`, body: ethHoldings },
  { match: `/portfolio/history?wallet=${SOL}`, body: solHistory },
  { match: `/portfolio/holdings?wallet=${SOL}`, body: solHoldings },
];

beforeEach(() => {
  useSession.setState({
    watchlist: [
      { chain: "ethereum", address: ETH },
      { chain: "solana", address: SOL },
    ],
    connectedEvm: null,
  });
});

test("asks to connect when no address is watched", () => {
  useSession.setState({ watchlist: [], connectedEvm: null });
  renderPanel([]);
  expect(screen.getByText(/Connect or watch a wallet/)).toBeTruthy();
  expect(screen.queryByTestId("portfolio-total")).toBeNull();
});

test("sums every watched address across chains and groups allocation by category", async () => {
  renderPanel(ALL_OK);
  // 600 + 420 + 80 + 151
  await waitFor(() => expect(screen.getByTestId("portfolio-total").textContent).toBe("$1,251.00"));
  const legend = await screen.findByRole("list", { name: "Allocation by category" });
  const labels = within(legend).getAllByRole("listitem").map((li) => li.textContent);
  expect(labels[0]).toContain("Lending");
  expect(labels.some((l) => l?.includes("Staking"))).toBe(true);
  expect(labels.some((l) => l?.includes("Yield-Bearing Stablecoins"))).toBe(true);
  expect(labels.some((l) => l?.includes("Other"))).toBe(true);
  // 1020 + 151 − (1000 + 50) − 100 (入金) = +21
  expect((await screen.findByTestId("portfolio-change")).textContent).toContain("+$21.00");
  expect(screen.getByTestId("history-chart")).toBeTruthy();
  expect(screen.getByText(/Estimated: stETH/)).toBeTruthy();
  expect(screen.getByText(/Aave V4: current value only/)).toBeTruthy();
  expect(screen.getByText("Current only")).toBeTruthy();
});

test("address chip narrows the totals to one address", async () => {
  renderPanel(ALL_OK);
  await waitFor(() => expect(screen.getByTestId("portfolio-total").textContent).toBe("$1,251.00"));
  fireEvent.click(screen.getByRole("button", { name: /7xKXtg…gAsU/ }));
  expect(screen.getByTestId("portfolio-total").textContent).toBe("$151.00");
  expect(screen.queryByText("stETH")).toBeNull();
});

test("deposited scope counts only protocol deposits", async () => {
  renderPanel(ALL_OK);
  await waitFor(() => expect(screen.getByTestId("portfolio-total").textContent).toBe("$1,251.00"));
  fireEvent.click(screen.getByRole("button", { name: "Deposited" }));
  // stETH 420 + Aave 80
  expect(screen.getByTestId("portfolio-total").textContent).toBe("$500.00");
  expect(screen.getByText("Deposited value")).toBeTruthy();
});

test("a failed address is left out and named, never counted as zero", async () => {
  renderPanel([
    { match: `/eth/portfolio/history?address=${ETH}`, status: 503, body: { error: "etherscan_not_configured", message: "Ethereum history needs ETHERSCAN_API_KEY on the server." } },
    ...ALL_OK.slice(1),
  ]);
  expect(await screen.findByText(/Not included — Ethereum 0x1111…1111 \(history\): Ethereum history needs ETHERSCAN_API_KEY/)).toBeTruthy();
  // holdings は取れているので総額には入る
  await waitFor(() => expect(screen.getByTestId("portfolio-total").textContent).toBe("$1,251.00"));
  // Solana だけで線は描ける
  expect(await screen.findByTestId("history-chart")).toBeTruthy();
});

test("shows no total (not $0.00) when every holdings request failed", async () => {
  useSession.setState({ watchlist: [{ chain: "ethereum", address: ETH }], connectedEvm: null });
  const down = { status: 503, body: { error: "etherscan_not_configured", message: "Ethereum history needs ETHERSCAN_API_KEY on the server." } };
  renderPanel([
    { match: `/eth/portfolio/history?address=${ETH}`, ...down },
    { match: `/eth/portfolio/holdings?address=${ETH}`, ...down },
  ]);
  expect(await screen.findByText(/\(history and holdings\): Ethereum history needs ETHERSCAN_API_KEY/)).toBeTruthy();
  expect(screen.getByTestId("portfolio-total").textContent).toBe("—");
  expect(screen.getByText("Holdings could not be loaded for the selected addresses.")).toBeTruthy();
  expect(screen.getByText("History could not be loaded for the selected addresses.")).toBeTruthy();
});
