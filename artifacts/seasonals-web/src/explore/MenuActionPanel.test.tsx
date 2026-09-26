import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { MenuHoldingsResponse, MenuProduct } from "@workspace/lib/types";
import { MenuActionPanel } from "./MenuActionPanel";

const OWNER = "0x1121aFF29666B91181568264Ab0F2Bc58Bf90a11";
const product = { id: "ethereum:ethena:susde", chain: "ethereum", protocolId: "ethena", protocolName: "Ethena", name: "sUSDe", category: "stable", rate: null, facts: [], observedAt: "" } as MenuProduct;
const holdings: MenuHoldingsResponse = {
  address: OWNER,
  holdings: [{ productId: product.id, amounts: [{ value: "109301356327675196", decimals: 18, symbol: "sUSDe" }] }],
  extraProducts: [],
  spendable: [{ value: "0", decimals: 18, symbol: "USDe" }],
  failed: [],
  observedAt: "",
};

function renderPanel(action: "deposit" | "withdraw") {
  const calls: Array<{ url: string; body: unknown }> = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.endsWith("/eth/status")) return new Response(JSON.stringify({ executionTarget: "fork", forkReachable: true }));
    return new Response(
      JSON.stringify({
        eventId: "menu:x",
        actionType: "ethena_cooldown",
        chainId: 1,
        owner: OWNER,
        target: "fork",
        summary: "Start withdrawing 0.1093 sUSDe from Ethena.",
        steps: [{ kind: "call", to: "0x9D39A5DE30e57443BfF2A8307A4256c8797A3497", data: "0x1234", value: "0", description: "Start the cooldown" }],
        simulation: { ran: true, ok: true, note: "Succeeds against current mainnet state (eth_call). Nothing was sent." },
        warnings: ["USDe is locked for 1 day"],
        builtAt: "",
        source: "susde.cooldownShares",
        broadcast: false,
      })
    );
  }) as typeof fetch;
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MenuActionPanel product={product} action={action} addresses={[OWNER]} byAddress={new Map([[OWNER, holdings]])} onClose={() => {}} />
    </QueryClientProvider>
  );
  return calls;
}

test("Max fills the exact on-chain balance (no float rounding) and the plan is requested as a decimal string", async () => {
  const calls = renderPanel("withdraw");
  fireEvent.click(screen.getByRole("button", { name: "Max" }));
  expect((screen.getByLabelText("Amount") as HTMLInputElement).value).toBe("0.109301356327675196");
  fireEvent.click(screen.getByRole("button", { name: "Build plan" }));
  await screen.findByText("Start withdrawing 0.1093 sUSDe from Ethena.");
  expect(screen.getByText("USDe is locked for 1 day")).toBeTruthy();
  const plan = calls.find((c) => c.url.endsWith("/eth/menu/plan"))!;
  expect(plan.body).toEqual({ owner: OWNER, productId: product.id, action: "withdraw", amount: "0.109301356327675196" });
});

test("invalid amounts keep Build plan disabled; an empty balance disables Max", async () => {
  renderPanel("deposit");
  const build = screen.getByRole("button", { name: "Build plan" }) as HTMLButtonElement;
  for (const v of ["", "0", "abc", "1e3"]) {
    fireEvent.change(screen.getByLabelText("Amount"), { target: { value: v } });
    expect(build.disabled).toBe(true);
  }
  fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "2.5" } });
  await waitFor(() => expect(build.disabled).toBe(false));
  expect(screen.getByText(/Available: 0 USDe/)).toBeTruthy();
  expect((screen.getByRole("button", { name: "Max" }) as HTMLButtonElement).disabled).toBe(true);
});
