/**
 * Your Positions (Solana) — /positions/earn を 1 表に。withdraw は route のある position × 接続 wallet だけ。
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { EarnPosition, EarnPositionsResponse } from "@workspace/lib/types";
import { SWAP_EARN_MARKETS } from "@workspace/lib/config/swap-earn-markets";
import { EXPONENT_MARKETS } from "@workspace/lib/config/exponent-markets";
import { useSession } from "../state/session";
import { installFakeBff } from "../testing/fakeBff";
import { SOL_OTHER, SOL_OWNER } from "../testing/fakeSolanaWallet";
import { SolanaPositions } from "./SolanaPositions";

const jl = SWAP_EARN_MARKETS.find((m) => m.protocol_id === "jupiter_lend" && m.underlying_symbol === "USDC")!;
const pt = EXPONENT_MARKETS[0]!;
const pos = (over: Partial<EarnPosition>): EarnPosition => ({
  protocol_id: "jupiter_lend",
  protocol_name: "Jupiter Lend",
  market_symbol: "USDC",
  share_mint: jl.share_mint,
  shares: "1000000",
  share_decimals: 6,
  asset_symbol: "USDC",
  underlying_amount: "1010000",
  underlying_decimals: 6,
  underlying_usd: "1.01000000",
  supply_rate_bps: 512,
  accrued_yield_amount: "10000",
  accrued_yield_sign: "gain",
  cost_basis_amount: "1000000",
  ...over,
});
const earn = (over: Partial<EarnPositionsResponse>): EarnPositionsResponse => ({ jupiterLend: [], kaminoBestEffort: [], ...over }) as EarnPositionsResponse;

const LEGACY = "BenJy1n3WTx9mTjEvy63e8Q1j4RqUc6E4VBMz3ir4Wo6";
let walletPositions: Record<string, unknown[]> = {};

function renderWith(byWallet: Record<string, EarnPositionsResponse | "fail">) {
  installFakeBff((path) => {
    if (path.startsWith("/oracle/status")) return { json: { status: "ok", warnings: [], block_reason: null } };
    const w = /^\/positions\?wallet=(.+)$/.exec(path);
    if (w) return { json: walletPositions[decodeURIComponent(w[1]!)] ?? [] };
    const m = /^\/positions\/earn\?wallet=(.+)$/.exec(path);
    if (!m) return undefined;
    const r = byWallet[decodeURIComponent(m[1]!)];
    return r === "fail" ? { status: 502, json: { error: "upstream" } } : { json: r };
  });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <SolanaPositions />
    </QueryClientProvider>
  );
}
const connect = (address: string) =>
  useSession.setState({ connected: { solana: { address, wallet: { name: "Phantom", icon: "", rdns: "Phantom" } } } });

beforeEach(() => {
  useSession.setState({ watchlist: [], connected: {}, lastSolanaWallet: null });
  walletPositions = {};
});
afterEach(cleanup);

test("全 protocol の position を並べ、量・評価額・APY・earned を BFF の値のまま出す", async () => {
  connect(SOL_OWNER);
  renderWith({
    [SOL_OWNER]: earn({
      jupiterLend: [pos({})],
      exponent: [pos({ protocol_id: "exponent", protocol_name: "Exponent", market_symbol: `PT-${pt.underlying_symbol}`, share_mint: pt.pt_mint, supply_rate_bps: null, accrued_yield_sign: "unknown", maturity_at: "2099-01-01T00:00:00Z" })],
    }),
  });
  const rows = await screen.findAllByRole("row");
  expect(rows).toHaveLength(3);
  const jlRow = within(rows[1]!);
  expect(jlRow.getByText("1.01 USDC")).toBeTruthy();
  expect(jlRow.getByText("$1.01")).toBeTruthy();
  expect(jlRow.getByText("5.12%")).toBeTruthy();
  expect(jlRow.getByText("+0.01 USDC").className).toContain("positive");
  expect((jlRow.getByRole("button", { name: "Withdraw" }) as HTMLButtonElement).disabled).toBe(false);
  // Exponent PT: 満期前は redeem できない
  const ptBtn = within(rows[2]!).getByRole("button", { name: "Withdraw" }) as HTMLButtonElement;
  expect(ptBtn.disabled).toBe(true);
  expect(ptBtn.title).toBe("Redeemable after maturity");
});

test("watch 中 (未接続) の address の position は withdraw させない", async () => {
  connect(SOL_OWNER);
  useSession.setState({ watchlist: [{ chain: "solana", address: SOL_OTHER }] });
  renderWith({ [SOL_OWNER]: earn({}), [SOL_OTHER]: earn({ jupiterLend: [pos({})] }) });
  const btn = (await screen.findByRole("button", { name: "Withdraw" })) as HTMLButtonElement;
  expect(btn.disabled).toBe(true);
  expect(btn.title).toBe("Connect this wallet to withdraw");
});

test("Withdraw で行の下に全量の withdraw panel を開く", async () => {
  connect(SOL_OWNER);
  renderWith({ [SOL_OWNER]: earn({ jupiterLend: [pos({})] }) });
  fireEvent.click(await screen.findByRole("button", { name: "Withdraw" }));
  expect((screen.getByLabelText("Amount") as HTMLInputElement).value).toBe("1");
  expect(screen.getByRole("button", { name: "Sign in wallet" })).toBeTruthy();
});

test("取れなかった address は 0 と見せず名前を出す", async () => {
  connect(SOL_OWNER);
  renderWith({ [SOL_OWNER]: "fail" });
  // hook は本番と同じ retry: 1 なので再試行の後に失敗が出る
  expect((await screen.findByRole("alert", {}, { timeout: 4000 })).textContent).toMatch(/Could not read positions for 7xKXtg…gAsU/);
});

test("旧 USD* を持つ address には Perena app への案内を出す (Seasonals では引き出せない)", async () => {
  connect(SOL_OWNER);
  walletPositions = {
    [SOL_OWNER]: [{ protocol_id: "perena", asset_symbol: "USD* (legacy)", current_amount: "12500000", raw_state: { mint: LEGACY } }],
  };
  renderWith({ [SOL_OWNER]: earn({}) });
  const note = await screen.findByRole("note");
  expect(note.textContent).toMatch(/7xKXtg…gAsU holds 12.5 legacy USD\*/);
  expect(within(note).getByRole("link", { name: /Perena app/ }).getAttribute("href")).toBe("https://app.perena.org/earn");
});

test("旧 USD* を持たなければ案内は出さない", async () => {
  connect(SOL_OWNER);
  walletPositions = { [SOL_OWNER]: [{ protocol_id: "wallet_holding", asset_symbol: "USDC", current_amount: "1000000", raw_state: { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" } }] };
  renderWith({ [SOL_OWNER]: earn({ jupiterLend: [pos({})] }) });
  await screen.findAllByRole("row");
  expect(screen.queryByRole("note")).toBeNull();
});
