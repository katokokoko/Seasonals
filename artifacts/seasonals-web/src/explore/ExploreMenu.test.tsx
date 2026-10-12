import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { render, screen } from "@testing-library/react";
import type { MenuProduct } from "@workspace/lib/types";
import { EthMenuCard, noBreakHyphen } from "./ExploreMenu";

function product(p: Partial<MenuProduct>): MenuProduct {
  return {
    id: "ethereum:pendle:pt:0x1",
    chain: "ethereum",
    protocolId: "pendle",
    protocolName: "Pendle",
    name: "PT-apyUSD",
    category: "pt_yt",
    tokenKind: "pt",
    rate: { label: "Fixed APY", value: 0.1459, basis: "Fixed if held to maturity", source: "Pendle API" },
    facts: [],
    maturity: "2026-11-05T00:00:00.000Z",
    observedAt: "2026-09-26T00:00:00.000Z",
    ...p,
  };
}

function renderCard(p: MenuProduct) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <ul>
          <EthMenuCard product={p} />
        </ul>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

test("PT card stacks chain logo above the Pendle logo and the PT badge below it", () => {
  const { container } = renderCard(product({}));
  const media = container.querySelector(".menu-media")!;
  const kids = [...media.children].map((el) => el.className);
  expect(kids[0]).toContain("menu-media-chain");
  expect(kids[1]).toContain("protocol-badge");
  expect(screen.getByRole("img", { name: "Principal Token" }).textContent).toBe("PT");
  expect(screen.getByText("Fixed APY")).toBeTruthy();
  expect(screen.getByText("Fixed if held to maturity · Pendle API")).toBeTruthy();
});

test("YT card shows a negative Long yield APY in the warning color", () => {
  const { container } = renderCard(
    product({ name: "YT-apyUSD", tokenKind: "yt", rate: { label: "Long yield APY", value: -0.7516, basis: "Floating; YT is worth 0 at maturity", source: "Pendle API" } })
  );
  expect(screen.getByRole("img", { name: "Yield Token" })).toBeTruthy();
  expect(container.querySelector(".menu-price-value.negative")?.textContent).toContain("-75.16%");
});

test("names keep the token prefix on one line", () => {
  expect(noBreakHyphen("PT-apyUSD")).toBe("PT‑apyUSD");
  const { container } = renderCard(product({}));
  expect(container.querySelector("h3")?.textContent).toBe("PT‑apyUSD");
});

// ── Solana カード: Seeker MenuDrawer と同じ gate で Deposit / Withdraw ──
import { cleanup, fireEvent, within } from "@testing-library/react";
import type { EarnPosition, ProtocolMenuEntry, ProtocolPool } from "@workspace/lib/types";
import { SWAP_EARN_MARKETS } from "@workspace/lib/config/swap-earn-markets";
import ExploreMenu, { MenuCard } from "./ExploreMenu";
import { installFakeBff } from "../testing/fakeBff";
import { useSession } from "../state/session";

const SOL = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const jlUsdc = SWAP_EARN_MARKETS.find((m) => m.protocol_id === "jupiter_lend" && m.underlying_symbol === "USDC")!;
const jupiter = { protocol_id: "jupiter", display_name: "Jupiter Lend", primary_category: "lending", supported_assets: ["USDC"], icon_id: "jupiter", icon_bg: "", pools: [] } as unknown as ProtocolMenuEntry;
const pool = (p: Partial<ProtocolPool> = {}): ProtocolPool => ({ pool_id: "jupiter_usdc", name: "USDC", category: "lending", asset: "USDC", apy: 0.05, tvl_usd: 1e6, ...p }) as ProtocolPool;
const jlPosition = {
  protocol_id: "jupiter_lend",
  protocol_name: "Jupiter Lend",
  market_symbol: "USDC",
  share_mint: jlUsdc.share_mint,
  shares: "1000000",
  share_decimals: 6,
  asset_symbol: "USDC",
  underlying_amount: "1010000",
  underlying_decimals: 6,
  underlying_usd: "1.01000000",
  supply_rate_bps: 500,
  accrued_yield_amount: "0",
  accrued_yield_sign: "unknown",
  cost_basis_amount: null,
} as EarnPosition;

function renderSol(p: ProtocolPool, owner: string | null, mine: EarnPosition[] = []) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <ul>
          <MenuCard item={{ protocol: jupiter, pool: p, section: "Lending" }} owner={owner} mine={mine} />
        </ul>
      </MemoryRouter>
    </QueryClientProvider>
  );
}
const btn = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;

describe("Solana menu card", () => {
  afterEach(cleanup);

  test("open な pool は Deposit を押せ、保有が無ければ Withdraw は理由付きで無効", () => {
    renderSol(pool({ deposit_open: true }), SOL);
    expect(btn("Deposit").disabled).toBe(false);
    expect(btn("Withdraw").disabled).toBe(true);
    expect(btn("Withdraw").title).toBe("Nothing withdrawable at the connected wallet");
    expect(screen.queryByText(/Seeker app/)).toBeNull();
  });

  test("display_only と満杯の pool は Deposit を押させない (fail-closed)", () => {
    renderSol(pool({ display_only: true }), SOL);
    expect(btn("Deposit").disabled).toBe(true);
    expect(btn("Deposit").title).toBe("View only");
    cleanup();
    renderSol(pool({ deposit_open: false, deposit_closed_reason: "full" } as Partial<ProtocolPool>), SOL);
    expect(btn("Deposit").title).toBe("Deposit cap reached");
  });

  test("tx builder に解決できない pool も Deposit を押させない", () => {
    renderSol(pool({ pool_id: "jupiter_nothing", asset: "NOPE" }), SOL);
    expect(btn("Deposit").disabled).toBe(true);
    expect(btn("Deposit").title).toMatch(/cannot build deposits/);
  });

  test("接続 wallet が withdraw できる position を持てば Withdraw で全量の panel を開く", () => {
    useSession.setState({ connected: { solana: { address: SOL, wallet: { name: "Phantom", icon: "", rdns: "Phantom" } } } });
    installFakeBff((path) => (path.startsWith("/oracle/status") ? { json: { status: "ok", warnings: [], block_reason: null } } : undefined));
    renderSol(pool(), SOL, [jlPosition]);
    fireEvent.click(btn("Withdraw"));
    expect((screen.getByLabelText("Amount") as HTMLInputElement).value).toBe("1");
    expect(screen.getByText(/Holding: 1 jlUSDC/)).toBeTruthy();
  });

  test("pool に note / external_url があれば詳細に案内と公式 app の link を出す (旧 USD* の Tri-Stable)", () => {
    renderSol(
      pool({
        pool_id: "perena_tri_stable",
        display_only: true,
        note: "This pool's LP token is the legacy USD*.",
        external_url: "https://app.perena.org/earn",
      } as Partial<ProtocolPool>),
      SOL
    );
    fireEvent.click(screen.getByRole("button", { name: "View details" }));
    expect(screen.getByText("This pool's LP token is the legacy USD*.")).toBeTruthy();
    // 閲覧専用の pool に「wallet で署名して送る」とは書かない
    expect(screen.getByText(/listed for reference only/)).toBeTruthy();
    expect(screen.queryByText(/Deposits and withdrawals are signed/)).toBeNull();
    const link = screen.getByRole("link", { name: /Open Jupiter Lend/ });
    expect(link.getAttribute("href")).toBe("https://app.perena.org/earn");
    expect(link.getAttribute("rel")).toBe("noreferrer");
    expect(btn("Deposit").disabled).toBe(true);
  });

  test("note / external_url が無い pool では案内も link も出さない", () => {
    renderSol(pool(), SOL);
    fireEvent.click(screen.getByRole("button", { name: "View details" }));
    expect(screen.queryByRole("link", { name: /^Open / })).toBeNull();
  });

  test("未接続で Deposit を開くと接続を案内し、署名ボタンは出さない", () => {
    renderSol(pool(), null);
    fireEvent.click(btn("Deposit"));
    expect(screen.getByText(/Connect a Solana wallet to deposit/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Sign in wallet/ })).toBeNull();
  });
});

test("chain chip は SUPPORTED_CHAINS から描く", async () => {
  useSession.setState({ watchlist: [], connected: {} });
  installFakeBff((path) => (path === "/menu-listings" ? { json: [] } : path === "/eth/menu" ? { json: [] } : undefined));
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <ExploreMenu />
      </MemoryRouter>
    </QueryClientProvider>
  );
  const chips = within(screen.getByRole("group", { name: "Chain" }))
    .getAllByRole("button")
    .filter((b) => b.className.includes("filter-chip") && b.textContent !== "Deposited only")
    .map((b) => b.textContent);
  expect(chips).toEqual(["All chains", "Solana", "Ethereum"]);
});
