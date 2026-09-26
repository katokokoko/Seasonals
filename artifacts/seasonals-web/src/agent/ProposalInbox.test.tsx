import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import type { EthAgentProposal } from "@workspace/lib/types";
import { useSession } from "../state/session";
import { ProposalInbox } from "./ProposalInbox";

const OWNER = "0x1121aFF29666B91181568264Ab0F2Bc58Bf90a11";
const HASH = `0x${"ab".repeat(32)}`;
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const SUSDE = "0x9d39a5de30e57443bff2a8307a4256c8797a3497";
const brief: EthAgentProposal["brief"] = {
  name: "🍋 Lemon Ladder",
  tagline: "Idle USDC → sUSDe",
  before: {
    totalUsd: "4000.00000000",
    lines: [
      { key: USDC, label: "USDC (wallet)", amounts: [{ value: "1000000000", decimals: 6, symbol: "USDC" }], usd: "1000.00000000", share: 0.25, apy: 0, apyLabel: "Idle", deployed: false },
      { key: "ETH", label: "ETH (wallet)", amounts: [{ value: "1000000000000000000", decimals: 18, symbol: "ETH" }], usd: "3000.00000000", share: 0.75, apy: 0, apyLabel: "Idle", deployed: false },
    ],
  },
  after: {
    totalUsd: "3999.50000000",
    lines: [
      { key: USDC, label: "USDC (wallet)", amounts: [{ value: "900000000", decimals: 6, symbol: "USDC" }], usd: "900.00000000", share: 0.225, apy: 0, apyLabel: "Idle", deployed: false },
      { key: "ETH", label: "ETH (wallet)", amounts: [{ value: "1000000000000000000", decimals: 18, symbol: "ETH" }], usd: "3000.00000000", share: 0.75, apy: 0, apyLabel: "Idle", deployed: false },
      { key: SUSDE, label: "sUSDe (Ethena)", productId: "ethereum:ethena:susde", amounts: [{ value: "79200000000000000000", decimals: 18, symbol: "sUSDe" }], usd: "99.00000000", share: 0.025, apy: 0.05, approx: true, deployed: true },
      { key: "aqua:usdc-usde", label: "Aqua USDC/USDe LP (1inch)", amounts: [{ value: "500000", decimals: 6, symbol: "USDC" }], usd: "0.50000000", share: 0.0001, apy: null, apyLabel: "Fees (not counted)", deployed: true },
    ],
  },
  blendedApy: {
    moved: { usd: "100.00000000", before: 0, after: 0.0495, delta: 0.0495 },
    deployed: { usdBefore: "0.00000000", usdAfter: "99.50000000", before: null, after: 0.04975, delta: null },
    excluded: ["Aqua USDC/USDe LP (1inch)"],
  },
  aqua: { usdc: { value: "500000", decimals: 6, symbol: "USDC" }, usde: { value: "500000000000000000", decimals: 18, symbol: "USDe" }, bandBps: 50, feeBps: 5, reviewAt: "2026-10-10T00:00:00.000Z", peg: "Within 50 bps (1 bps)." },
  horizon: [{ at: "2026-10-10T00:00:00.000Z", label: "Review the Aqua USDC/USDe strategy" }],
  unpriced: ["PT-mystery"],
  warnings: [],
  markdown: "# 🍋 Lemon Ladder",
  builtAt: "2026-09-26T00:00:00.000Z",
};
const pending: EthAgentProposal = {
  id: "ethprop_1",
  owner: OWNER,
  name: "🍋 Lemon Ladder",
  tagline: "Idle USDC → sUSDe",
  rationale: "sUSDe pays 5% while USDC sits idle.",
  brief,
  steps: [
    { kind: "uniswap_swap", tokenIn: "USDC", tokenOut: "USDe", amount: "100" },
    { kind: "menu", productId: "ethereum:ethena:susde", action: "deposit", amount: "99" },
  ],
  previews: [
    { ok: true, preview: { summary: "Swap USDC → USDe through Uniswap (CLASSIC).", warnings: [], simulation: { ran: false, note: "checked on the fork" }, amountOut: "99500000000000000000" } },
    { ok: false, note: "Uses balances produced by an earlier step; checked on the fork when it runs." },
  ],
  bundleHash: HASH,
  status: "pending",
  createdBy: "mcp",
  createdAt: "2026-09-26T00:00:00.000Z",
  updatedAt: "2026-09-26T00:00:00.000Z",
  expiresAt: "2026-09-27T00:00:00.000Z",
};
const executed: EthAgentProposal = {
  ...pending,
  status: "executed",
  execution: {
    startedAt: "2026-09-26T00:01:00.000Z",
    finishedAt: "2026-09-26T00:02:00.000Z",
    via: "web",
    steps: [
      { index: 0, ok: true, summary: "Swap USDC → USDe through Uniswap (CLASSIC).", txs: [{ hash: "0xaaaaaaaaaaaaaaaa", status: "success", blockNumber: "10", gasUsed: "1", description: "swap" }] },
      { index: 1, ok: true, summary: "Deposit 99 USDe into sUSDe.", txs: [{ hash: "0xbbbbbbbbbbbbbbbb", status: "success", blockNumber: "11", gasUsed: "1", description: "deposit" }] },
    ],
  },
};

function renderInbox(list: EthAgentProposal[]) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  let current = list;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.endsWith("/eth/status")) return new Response(JSON.stringify({ executionTarget: "fork", forkReachable: true }));
    if (url.includes("/eth/agent-proposals?address=")) return new Response(JSON.stringify({ proposals: current }));
    if (url.endsWith("/execute")) {
      current = [executed];
      return new Response(JSON.stringify(executed));
    }
    if (url.endsWith("/reject")) {
      current = [{ ...pending, status: "rejected" }];
      return new Response(JSON.stringify(current[0]));
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ProposalInbox />
    </QueryClientProvider>
  );
  return calls;
}

beforeEach(() => {
  useSession.setState({ watchlist: [{ chain: "ethereum", address: OWNER }], connectedEvm: null });
});

test("shows the strategy brief: name, before → after, blended APY delta, Aqua sleeve, horizon and unpriced note", async () => {
  renderInbox([pending]);
  expect((await screen.findByRole("heading", { level: 3 })).textContent).toBe("🍋 Lemon Ladder");
  expect(screen.getByText("Idle USDC → sUSDe")).toBeTruthy();
  const text = document.body.textContent!;
  expect(text).toContain("USDC (wallet)");
  expect(text).toContain("$1,000.00");
  expect(text).toContain("≈$99.00");
  // 動かす資金の APY が見出し。idle の ETH $3,000 は表に出ず "Unchanged" にまとまり、分母にも入らない
  expect(text).toContain("This rebalance moves $100.00");
  expect(text).toContain("(+4.95% pts)");
  expect(screen.getByText("(+4.95% pts)").className).toContain("delta-up");
  expect(text).toContain("Deployed capital (DeFi only)");
  expect(text).toContain("$99.50");
  expect(text).toContain("Unchanged: ETH (wallet) $3,000.00 (1 position, $3,000.00).");
  expect(screen.queryByRole("cell", { name: /1 ETH/ })).toBeNull();
  expect(text).toContain("Idle wallet balances are not part of either blend.");
  expect(text).toContain("Fees (not counted)");
  expect(text).toContain("1inch Aqua LP sleeve:");
  expect(text).toContain("Review the Aqua USDC/USDe strategy");
  expect(text).toContain("Not priced (excluded from totals): PT-mystery.");
});

test("shows the agent's steps, defers the dependent step, and one tap approves with the shown bundle hash", async () => {
  const calls = renderInbox([pending]);
  await screen.findByText("sUSDe pays 5% while USDC sits idle.");
  expect(screen.getByText("Swap 100 USDC → USDe on Uniswap")).toBeTruthy();
  expect(screen.getByText(/checked on the fork when it runs/)).toBeTruthy();
  fireEvent.click(await screen.findByRole("button", { name: "Approve and execute on local fork" }));
  await screen.findByText("Executed on the local fork");
  const exec = calls.find((c) => c.url.endsWith("/eth/agent-proposals/ethprop_1/execute"))!;
  expect(exec.body).toEqual({ approvedBy: "user", via: "web", bundleHash: HASH });
  expect(document.body.textContent).toContain("0xbbbbbbbbbb… · success · block 11");
  expect(screen.queryByRole("button", { name: "Approve and execute on local fork" })).toBeNull();
});

test("reject posts to the reject route and the card leaves the pending state", async () => {
  const calls = renderInbox([pending]);
  fireEvent.click(await screen.findByRole("button", { name: "Reject" }));
  await screen.findByText("Rejected");
  expect(calls.some((c) => c.url.endsWith("/eth/agent-proposals/ethprop_1/reject") && c.method === "POST")).toBe(true);
});

test("without an Ethereum address it asks for a wallet instead of fetching", async () => {
  useSession.setState({ watchlist: [], connectedEvm: null });
  const calls = renderInbox([pending]);
  await screen.findByText("No wallet yet");
  expect(calls).toHaveLength(0);
});
