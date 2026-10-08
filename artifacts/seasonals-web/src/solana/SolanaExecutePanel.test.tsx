/**
 * SolanaExecutePanel — 金額 → oracle gate → wallet 一括署名 → BFF /tx/submit → /tx/status。
 * BFF は fetch の差し替え、wallet は偽の Wallet Standard wallet。mainnet には何も送らない。
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { SolanaActionInput } from "@workspace/lib/types";
import { SWAP_EARN_MARKETS } from "@workspace/lib/config/swap-earn-markets";
import { SAVE_MARKETS } from "@workspace/lib/config/save-markets";
import { depositAction } from "@workspace/lib/derive/solana-action";
import { useSession } from "../state/session";
import { _resetSolanaWalletsForTest, connectSolanaWallet } from "../services/solanaWallet";
import { fakeSolanaWallet, signedMarker, SOL_OTHER, SOL_OWNER, type FakeWalletOptions } from "../testing/fakeSolanaWallet";
import { b64, installFakeBff, type FakeHandler } from "../testing/fakeBff";
import { SolanaExecutePanel } from "./SolanaExecutePanel";

const jlUsdc = SWAP_EARN_MARKETS.find((m) => m.protocol_id === "jupiter_lend" && m.underlying_symbol === "USDC")!;
const save = SAVE_MARKETS[0]!;
const SIG1 = "1".repeat(87);
const SIG2 = "2".repeat(87);
const OK_ORACLE = {
  asset_symbol: "USDC",
  status: "ok",
  primary: "pyth",
  price_usd: "1.00000000",
  tier: "A",
  secondary: { source: "redstone", available: true, price_usd: "1.00000000", age_seconds: 10 },
  warnings: [],
  block_reason: null,
};

async function connect(opts: FakeWalletOptions = {}) {
  const w = fakeSolanaWallet(opts);
  await connectSolanaWallet({ name: w.name, icon: w.icon, wallet: w });
  useSession.setState({ connected: { solana: { address: SOL_OWNER, wallet: { name: w.name, icon: "", rdns: w.name } } } });
  return w;
}

/** 既定: 残高 5 USDC、oracle ok、builder は tx 1 本、submit は SIG1、status は confirmed */
function bff(over: Partial<Record<string, FakeHandler>> = {}): FakeHandler {
  return (path, body, method) => {
    for (const [prefix, h] of Object.entries(over)) if (path.startsWith(prefix)) return h!(path, body, method);
    if (path.startsWith("/positions?")) return { json: [{ protocol_id: "wallet_usdc", asset_symbol: "USDC", current_amount: "5000000" }] };
    if (path.startsWith("/oracle/status")) return { json: OK_ORACLE };
    if (path === "/protocols/swap-earn/deposit-tx") return { json: { swapTransaction: b64([1, 2, 3]), lastValidBlockHeight: 1, outAmount: "1", outputMint: "x", quote: {} } };
    if (path === "/tx/submit") return { json: { signature: SIG1 } };
    if (path.startsWith("/tx/status")) return { json: { signature: path.split("=")[1], status: "confirmed", slot: 1, err: null } };
    return undefined;
  };
}

function renderPanel(action: SolanaActionInput, owner: string | null = SOL_OWNER) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <SolanaExecutePanel action={action} owner={owner} title="Jupiter Lend USDC" onClose={() => {}} />
    </QueryClientProvider>
  );
}

const signButton = () => screen.getByRole("button", { name: /Sign in wallet|Working/ }) as HTMLButtonElement;

beforeEach(() => useSession.setState({ watchlist: [], connected: {}, lastSolanaWallet: null }));
afterEach(() => {
  cleanup();
  _resetSolanaWalletsForTest();
});

test("deposit: smallest unit で BFF に組ませ、1 回の承認で署名し、/tx/submit → confirmed を表示する", async () => {
  const w = await connect();
  const calls = installFakeBff(bff());
  renderPanel(depositAction("jupiter", "USDC", "jupiter_usdc"));
  await screen.findByText(/Wallet balance: 5 USDC/);
  fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "1.5" } });
  await waitFor(() => expect(signButton().disabled).toBe(false));
  fireEvent.click(signButton());
  await screen.findByText("Confirmed on Solana mainnet.");

  const build = calls.find((c) => c.path === "/protocols/swap-earn/deposit-tx")!;
  expect(build.body).toEqual({ slippageBps: 50, user: SOL_OWNER, shareMint: jlUsdc.share_mint, amount: "1500000" });
  expect(w.signFn).toHaveBeenCalledTimes(1);
  const submit = calls.find((c) => c.path === "/tx/submit")!;
  expect(submit.body).toEqual({ signedTx: b64([...signedMarker(Uint8Array.from([1, 2, 3]))]), skipPreflight: false });
  expect(screen.getByRole("link", { name: /111111…1111/ }).getAttribute("href")).toBe(`https://solscan.io/tx/${SIG1}`);
});

test("複数 tx (Save): 承認は 1 回、送信は順番に、2 本目以降は skipPreflight", async () => {
  const w = await connect();
  let n = 0;
  const calls = installFakeBff(
    bff({
      "/protocols/save/deposit-tx": () => ({ json: { transactions: [b64([1]), b64([2])], reserve: save.reserve, ctokenMint: save.ctoken_mint, underlyingMint: "x" } }),
      "/tx/submit": () => ({ json: { signature: ++n === 1 ? SIG1 : SIG2 } }),
    })
  );
  renderPanel(depositAction("savefi", save.underlying_symbol, save.pool_id));
  fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "0.1" } });
  await waitFor(() => expect(signButton().disabled).toBe(false));
  fireEvent.click(signButton());
  await screen.findByText("Confirmed on Solana mainnet.");
  expect(w.signFn).toHaveBeenCalledTimes(1);
  expect(w.signFn.mock.calls[0]).toHaveLength(2);
  const submits = calls.filter((c) => c.path === "/tx/submit").map((c) => (c.body as { skipPreflight: boolean }).skipPreflight);
  expect(submits).toEqual([false, true]);
  expect(screen.getAllByRole("listitem").map((li) => li.textContent)).toEqual([expect.stringContaining("Confirmed"), expect.stringContaining("Confirmed")]);
});

test("BFF が oracle_blocked で拒否したら declined (失敗扱いしない)。wallet は開かない", async () => {
  const w = await connect();
  installFakeBff(bff({ "/protocols/swap-earn/deposit-tx": () => ({ status: 409, json: { error: "oracle_blocked", block_reason: "oracle_both_stale" } }) }));
  renderPanel(depositAction("jupiter", "USDC", "jupiter_usdc"));
  fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "1" } });
  await waitFor(() => expect(signButton().disabled).toBe(false));
  fireEvent.click(signButton());
  const alert = await screen.findByText(/Price check failed: Price sources are stale/);
  expect(alert.textContent).toContain("Nothing was signed.");
  expect(w.signFn).not.toHaveBeenCalled();
});

test("wallet で拒否したら cancelled で、何も送らない", async () => {
  await connect({ sign: async () => Promise.reject(Object.assign(new Error("User rejected the request."), { code: 4001 })) });
  const calls = installFakeBff(bff());
  renderPanel(depositAction("jupiter", "USDC", "jupiter_usdc"));
  fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "1" } });
  await waitFor(() => expect(signButton().disabled).toBe(false));
  fireEvent.click(signButton());
  await screen.findByText("Cancelled in your wallet. Nothing was sent.");
  expect(calls.some((c) => c.path === "/tx/submit")).toBe(false);
});

test("2 本目の送信が失敗したら error。着地した 1 本目の signature は残す", async () => {
  await connect();
  let n = 0;
  installFakeBff(
    bff({
      "/protocols/save/deposit-tx": () => ({ json: { transactions: [b64([1]), b64([2])], reserve: save.reserve, ctokenMint: save.ctoken_mint, underlyingMint: "x" } }),
      "/tx/submit": () => (++n === 1 ? { json: { signature: SIG1 } } : { status: 502, json: { error: "submit_failed", message: "Helius sendTransaction RPC error -32002: Blockhash not found" } }),
    })
  );
  renderPanel(depositAction("savefi", save.underlying_symbol, save.pool_id));
  fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "0.1" } });
  await waitFor(() => expect(signButton().disabled).toBe(false));
  fireEvent.click(signButton());
  await screen.findByText(/expired before it reached the network/);
  expect(screen.getByRole("link", { name: /111111…1111/ })).toBeTruthy();
});

test("on-chain で失敗した tx は error として出す", async () => {
  await connect();
  installFakeBff(bff({ "/tx/status": (p) => ({ json: { signature: p.split("=")[1], status: "failed", slot: 2, err: '{"InstructionError":[0,{"Custom":6001}]}' } }) }));
  renderPanel(depositAction("jupiter", "USDC", "jupiter_usdc"));
  fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "1" } });
  await waitFor(() => expect(signButton().disabled).toBe(false));
  fireEvent.click(signButton());
  expect((await screen.findByText(/Transaction 1 of 1 failed on-chain/)).textContent).toContain("6001");
});

test("旧 BFF (/tx/status が無い) では送信済みとして終える", async () => {
  await connect();
  installFakeBff(bff({ "/tx/status": () => undefined }));
  renderPanel(depositAction("jupiter", "USDC", "jupiter_usdc"));
  fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "1" } });
  await waitFor(() => expect(signButton().disabled).toBe(false));
  fireEvent.click(signButton());
  await screen.findByText(/Sent\. Confirmation is taking longer/);
});

test("oracle が blocked なら CTA を押せず、理由を出す", async () => {
  await connect();
  installFakeBff(bff({ "/oracle/status": () => ({ json: { ...OK_ORACLE, status: "blocked", block_reason: "oracle_divergence_too_large", warnings: [] } }) }));
  renderPanel(depositAction("jupiter", "USDC", "jupiter_usdc"));
  fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "1" } });
  await screen.findByText(/Blocked for safety: Price sources disagree by more than 5%/);
  expect(signButton().disabled).toBe(true);
});

test("oracle warning は CTA 直上に出し、1 秒グレーアウトしてから押せる", async () => {
  await connect();
  installFakeBff(
    bff({ "/oracle/status": () => ({ json: { ...OK_ORACLE, status: "warning", warnings: [{ kind: "oracle_divergence_warning", divergencePct: 3.2 }] } }) })
  );
  renderPanel(depositAction("jupiter", "USDC", "jupiter_usdc"));
  fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "1" } });
  await screen.findByText(/differ by 3.2%/);
  expect(signButton().disabled).toBe(true);
  await waitFor(() => expect(signButton().disabled).toBe(false), { timeout: 2000 });
});

test("route が解決しない action は CTA を出さない (fail-closed)", async () => {
  await connect();
  installFakeBff(bff());
  renderPanel({ action_type: "withdraw", protocol: "kamino", asset: "USDC", amount: "1", metadata: { share_mint: "Unknown11111111111111111111111111111111111" } });
  expect(screen.getByText(/Unsupported market/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Sign in wallet/ })).toBeNull();
});

test("接続していない (watch のみの) address では署名させず、接続を案内する", async () => {
  await connect();
  installFakeBff(bff());
  renderPanel(depositAction("jupiter", "USDC", "jupiter_usdc"), SOL_OTHER);
  expect(screen.getByText(/Connect 9WzDXw…AWWM in a Solana wallet to sign/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Sign in wallet/ })).toBeNull();
});

test("残高を超える deposit は止め、Max は wallet 残高を正確に入れる", async () => {
  await connect();
  installFakeBff(bff());
  renderPanel(depositAction("jupiter", "USDC", "jupiter_usdc"));
  await screen.findByText(/Wallet balance: 5 USDC/);
  fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "6" } });
  expect(await screen.findByText(/Insufficient USDC/)).toBeTruthy();
  expect(signButton().disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Max" }));
  expect((screen.getByLabelText("Amount") as HTMLInputElement).value).toBe("5");
});

test("withdraw は保有全量を初期値にし、それを超える量は止める", async () => {
  await connect();
  installFakeBff(bff());
  renderPanel({
    action_type: "withdraw",
    protocol: "jupiter_lend",
    asset: "USDC",
    amount: "2000000",
    metadata: { share_mint: jlUsdc.share_mint, share_decimals: 6, underlying_decimals: 6, underlying_amount: "2100000" },
  });
  expect((screen.getByLabelText("Amount") as HTMLInputElement).value).toBe("2");
  expect(screen.getByText(/Holding: 2 jlUSDC · ≈ 2.1 USDC/)).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "2.5" } });
  expect(screen.getByText(/More than you hold/)).toBeTruthy();
});

test("tier C (Pyth のみ) は通すが、照合していないことを控えめに出す", async () => {
  await connect();
  installFakeBff(bff({ "/oracle/status": () => ({ json: { ...OK_ORACLE, tier: "C", secondary: { source: null, available: false, price_usd: null, age_seconds: null } } }) }));
  renderPanel(depositAction("jupiter", "USDC", "jupiter_usdc"));
  fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "1" } });
  expect(await screen.findByText(/Single price source \(Pyth\)/)).toBeTruthy();
  await waitFor(() => expect(signButton().disabled).toBe(false));
});

test("secondary が stale なら強警告を出し、1 秒後に押せる", async () => {
  await connect();
  installFakeBff(bff({ "/oracle/status": () => ({ json: { ...OK_ORACLE, status: "warning", warnings: [{ kind: "oracle_secondary_stale", secondaryAgeSeconds: 120 }] } }) }));
  renderPanel(depositAction("jupiter", "USDC", "jupiter_usdc"));
  fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "1" } });
  expect(await screen.findByText(/Secondary price source is stale/)).toBeTruthy();
  expect(signButton().disabled).toBe(true);
  await waitFor(() => expect(signButton().disabled).toBe(false), { timeout: 2000 });
});
