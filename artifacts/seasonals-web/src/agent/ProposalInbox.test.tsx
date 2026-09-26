import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import type { EthAgentProposal } from "@workspace/lib/types";
import { useSession } from "../state/session";
import { ProposalInbox } from "./ProposalInbox";

const OWNER = "0x1121aFF29666B91181568264Ab0F2Bc58Bf90a11";
const HASH = `0x${"ab".repeat(32)}`;
const pending: EthAgentProposal = {
  id: "ethprop_1",
  owner: OWNER,
  title: "Move 100 USDC into sUSDe",
  rationale: "sUSDe pays 5% while USDC sits idle.",
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

test("shows the agent's steps, defers the dependent step, and one tap approves with the shown bundle hash", async () => {
  const calls = renderInbox([pending]);
  await screen.findByText("Move 100 USDC into sUSDe");
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
