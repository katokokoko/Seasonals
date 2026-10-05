/**
 * Phase 8.22: GET /menu-listings — fixture skeleton + live APY/TVL overlay。
 *
 * 全 live client を mock し、(1) protocol 別 overlay の換算、(2) ソース失敗時の
 * fixture 維持 (graceful degrade)、(3) shape/pool_id 不変、(4) 60s cache を検証。
 */
import type { FastifyInstance } from "fastify";

import { fixtureMenuListings } from "@workspace/lib/__fixtures__";
import { KAMINO_MARKETS, KAMINO_VAULTS } from "@workspace/lib/config/kamino-markets";
import { SAVE_MARKETS } from "@workspace/lib/config/save-markets";
import { ORCA_MARKETS } from "@workspace/lib/config/orca-markets";
import type { ProtocolMenuEntry } from "@workspace/lib/types";

import { buildServer } from "./server";
import { fetchEarnMarkets, type JupiterLendMarket } from "./clients/jupiter-lend";
import {
  fetchKaminoDepositCaps,
  fetchKaminoReserveMetrics,
  fetchKaminoVaultMetrics,
} from "./clients/kamino-tx";
import { fetchSaveReserveRates } from "./clients/save-tx";
import { fetchOrcaPoolStats } from "./clients/orca-tx";
import {
  fetchExponentApys,
  fetchExponentFullMarkets,
  fetchExponentSyRates,
  fetchLstApys,
  fetchPerenaUsdStarApy,
  fetchPerenaUsdStarPrice,
  fetchSanctumTvls,
  type ExponentFullMarket,
} from "./clients/rates";
import { fetchSaveReserveTotals } from "./clients/save-reserve";
import { fetchJupiterUsdPrices } from "./clients/jupiter-price";
import { fetchMeteoraPoolStats } from "./clients/meteora-tx";
import { getTokenSupplyUi } from "./clients/helius-rpc";
import { fetchPerenaTriStableTvlUsd } from "./clients/perena";
import { getOracleResult } from "./clients/oracle";
import { METEORA_MARKETS } from "@workspace/lib/config/meteora-markets";
import { exponentPoolId } from "@workspace/lib/config/exponent-markets";
import { SWAP_EARN_MARKETS } from "@workspace/lib/config/swap-earn-markets";

jest.mock("./clients/jupiter-lend");
jest.mock("./clients/kamino-tx");
jest.mock("./clients/save-tx");
jest.mock("./clients/orca-tx", () => ({
  ...jest.requireActual("./clients/orca-tx"),
  fetchOrcaPoolStats: jest.fn(),
}));
jest.mock("./clients/rates");
jest.mock("./clients/meteora-tx", () => ({
  ...jest.requireActual("./clients/meteora-tx"),
  fetchMeteoraPoolStats: jest.fn(),
}));
jest.mock("./clients/helius-rpc");
jest.mock("./clients/perena");
// Phase 8.33: /menu-listings が SOL oracle 価格 (exponent TVL 換算) を引くため mock
jest.mock("./clients/oracle");
// 2026-10: menu TVL live 化 (Save reserve on-chain / Jupiter Price v3)
jest.mock("./clients/save-reserve");
jest.mock("./clients/jupiter-price");

const mockJup = fetchEarnMarkets as jest.MockedFunction<typeof fetchEarnMarkets>;
const mockKamino = fetchKaminoReserveMetrics as jest.MockedFunction<
  typeof fetchKaminoReserveMetrics
>;
const mockKvault = fetchKaminoVaultMetrics as jest.MockedFunction<
  typeof fetchKaminoVaultMetrics
>;
// 8.51: 預入枠 (on-chain reserve から読む deposit limit)
const mockCaps = fetchKaminoDepositCaps as jest.MockedFunction<
  typeof fetchKaminoDepositCaps
>;
const mockSave = fetchSaveReserveRates as jest.MockedFunction<
  typeof fetchSaveReserveRates
>;
const mockOrca = fetchOrcaPoolStats as jest.MockedFunction<
  typeof fetchOrcaPoolStats
>;
const mockLst = fetchLstApys as jest.MockedFunction<typeof fetchLstApys>;
const mockExponent = fetchExponentApys as jest.MockedFunction<
  typeof fetchExponentApys
>;
const mockMeteoraStats = fetchMeteoraPoolStats as jest.MockedFunction<
  typeof fetchMeteoraPoolStats
>;
const METEORA_USDC_USDT = METEORA_MARKETS.find(
  (m) => m.pool_id === "meteora_usdc_usdt_dlmm"
)!;

// Phase 8.33: exponent live markets mock。maturity は実行時 now+90d/+30d で組む
// (wall-clock 固定値を置かない = 永続 deterministic)。
const NOW_SEC = Math.floor(Date.now() / 1000);
const EXP_MKT_A: ExponentFullMarket = {
  ticker: "USX",
  underlying_mint: "6FrrzDk5mQARGc1TDYoyVnSyRdds1t4PbtohCD6p3tgG",
  underlying_decimals: 6,
  pt_mint: "PtUsx111111111111111111111111111111111111111",
  yt_mint: "YtUsx111111111111111111111111111111111111111",
  vault_address: "VaultUsx111111111111111111111111111111111111",
  pt_decimals: 6,
  maturity_ts: NOW_SEC + 30 * 86400,
  implied_apy: 0.061,
  underlying_apy: 0.05,
  total_market_size: 40_000_000,
  quote_ticker: "USD",
  pt_price_in_asset: 0.98,
  market_status: "active",
};
const EXP_MKT_B: ExponentFullMarket = {
  ...EXP_MKT_A,
  ticker: "fragSOL",
  pt_mint: "PtFrag11111111111111111111111111111111111111",
  yt_mint: "YtFrag11111111111111111111111111111111111111",
  maturity_ts: NOW_SEC + 90 * 86400,
  implied_apy: 0.072,
  total_market_size: 1_000, // SOL 建て → ×SOL 価格
  quote_ticker: "SOL",
};

const KAMINO_USDC = KAMINO_MARKETS.find((m) => m.pool_id === "kamino_usdc_main")!;
// 8.52: USDC は registry で預入を塞いでいるので、「開いている pool」の確認は SOL で行う
const KAMINO_SOL = KAMINO_MARKETS.find((m) => m.pool_id === "kamino_sol_main")!;
const KVAULT = KAMINO_VAULTS[0]!;
const SAVE_USDC = SAVE_MARKETS.find((m) => m.pool_id === "savefi_usdc_main")!;
const SAVE_SOL = SAVE_MARKETS.find((m) => m.pool_id === "savefi_sol_main")!;
const SHYUSD = SWAP_EARN_MARKETS.find((m) => m.share_symbol === "sHYUSD")!;
const mockSanctumTvl = fetchSanctumTvls as jest.MockedFunction<typeof fetchSanctumTvls>;
const mockSaveTotals = fetchSaveReserveTotals as jest.MockedFunction<
  typeof fetchSaveReserveTotals
>;
const mockJupPrice = fetchJupiterUsdPrices as jest.MockedFunction<
  typeof fetchJupiterUsdPrices
>;
const ORCA_USDC_USDT = ORCA_MARKETS.find(
  (m) => m.pool_id === "orca_usdc_usdt_whirlpool"
)!;

function jupMarket(partial: Partial<JupiterLendMarket>): JupiterLendMarket {
  return {
    jlMint: "jl111",
    jlSymbol: "jlUSDC",
    jlDecimals: 6,
    underlyingMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    underlyingSymbol: "USDC",
    underlyingDecimals: 6,
    underlyingPriceUsd: 1,
    supplyRateBps: 450,
    rewardsRateBps: 0,
    totalRateBps: 450,
    tvlUnderlying: "5000000000000", // 5M USDC
    ...partial,
  } as JupiterLendMarket;
}

let app: FastifyInstance;

beforeEach(async () => {
  jest.clearAllMocks();
  mockJup.mockResolvedValue([
    jupMarket({}),
    // 8.26: jl API の SOL market は "WSOL" — alias match の検証用
    jupMarket({
      jlSymbol: "jlWSOL",
      underlyingSymbol: "WSOL",
      underlyingDecimals: 9,
      underlyingPriceUsd: 78,
      supplyRateBps: 431,
      tvlUnderlying: "2000000000000000", // 2M SOL
    }),
  ]);
  // 上限 200 USDC / 供給 1 USDC (fixture の totalSupply "1" に対応)
  mockCaps.mockResolvedValue([
    { reserve: KAMINO_USDC.reserve, limit: 200_000_000n },
    { reserve: KAMINO_SOL.reserve, limit: 100_000_000_000n }, // 100 SOL (9 dec)
  ]);
  mockKamino.mockResolvedValue([
    {
      reserve: KAMINO_USDC.reserve,
      liquidityToken: "USDC",
      liquidityTokenMint: KAMINO_USDC.underlying_mint,
      supplyApy: "0.062",
      borrowApy: "0.09",
      totalSupply: "1",
      totalBorrow: "1",
      totalSupplyUsd: "12345678.9",
      totalBorrowUsd: "1000000",
    },
    {
      reserve: KAMINO_SOL.reserve,
      liquidityToken: "SOL",
      liquidityTokenMint: KAMINO_SOL.underlying_mint,
      supplyApy: "0.086",
      borrowApy: "0.11",
      totalSupply: "2",
      totalBorrow: "1",
      totalSupplyUsd: "400",
      totalBorrowUsd: "200",
    },
  ]);
  mockKvault.mockResolvedValue({
    apy: "0.081",
    tokensPerShare: "1",
    tokenPrice: "1",
    tokensInvestedUsd: "19000000.5",
    tokensAvailableUsd: "80000.25",
  });
  mockSave.mockResolvedValue([
    { reserve: SAVE_USDC.reserve, supply_apy: 0.041, ctoken_exchange_rate: "1.3" },
  ]);
  mockOrca.mockResolvedValue(
    new Map([[ORCA_USDC_USDT.pool_address, { tvl_usd: 1200000, apr_day_bps: 549 }]])
  );
  mockLst.mockResolvedValue(
    new Map([
      ["jitoSOL", 0.0681],
      ["mSOL", 0.0665],
      ["INF", 0.0773],
      ["bSOL", 0.0655],
    ])
  );
  mockExponent.mockResolvedValue(new Map([["eUSX", 0.0376]]));
  // Phase 8.33: exponent PT markets + SOL oracle 価格 ($80)
  (fetchExponentFullMarkets as jest.MockedFunction<typeof fetchExponentFullMarkets>)
    .mockResolvedValue([EXP_MKT_A, EXP_MKT_B]);
  (getOracleResult as jest.MockedFunction<typeof getOracleResult>)
    .mockResolvedValue({ price_usd: "80.00000000" } as Awaited<
      ReturnType<typeof getOracleResult>
    >);
  (fetchPerenaUsdStarApy as jest.MockedFunction<typeof fetchPerenaUsdStarApy>)
    .mockResolvedValue(0.093);
  // 8.26: Solstice TVL = eUSX 供給 × syExchangeRate
  (getTokenSupplyUi as jest.MockedFunction<typeof getTokenSupplyUi>)
    .mockResolvedValue(40_000_000);
  (fetchExponentSyRates as jest.MockedFunction<typeof fetchExponentSyRates>)
    .mockResolvedValue(new Map([["eUSX", 1.0377]]));
  mockMeteoraStats.mockResolvedValue(
    new Map([[METEORA_USDC_USDT.pool_address, { apy_bps: 134, tvl_usd: 275092 }]])
  );
  // 2026-10: LST TVL (lamports)。SOL 価格は上の oracle mock ($80)
  mockSanctumTvl.mockResolvedValue(
    new Map([
      ["INF", 2_000_000_000_000_000n], // 2M SOL
      ["jitoSOL", 10_000_000_000_000_000n], // 10M SOL
      ["bSOL", 1_000_000_000_000_000n], // 1M SOL
      ["mSOL", 3_000_000_000_000_000n], // 3M SOL
      ["hyloSOL", 200_000_000_000_000n], // 200k SOL
    ])
  );
  // 2026-10: Save reserve 供給総量 (smallest unit)
  mockSaveTotals.mockResolvedValue(
    new Map([
      [SAVE_USDC.reserve, { total: 22_500_000_000_000n, decimals: 6 }], // 22.5M USDC
      [SAVE_SOL.reserve, { total: 185_000_000_000_000n, decimals: 9 }], // 185k SOL
    ])
  );
  // 2026-10: sHYUSD 単価 (供給は getTokenSupplyUi mock の 40M)
  mockJupPrice.mockResolvedValue(new Map([[SHYUSD.share_mint, 1.5]]));
  app = await buildServer({ logger: false });
});
afterEach(async () => {
  await app.close();
});

async function getMenu(): Promise<ProtocolMenuEntry[]> {
  const res = await app.inject({ method: "GET", url: "/menu-listings" });
  expect(res.statusCode).toBe(200);
  return res.json() as ProtocolMenuEntry[];
}

function pool(menu: ProtocolMenuEntry[], protocolId: string, poolId: string) {
  return menu
    .find((e) => e.protocol_id === protocolId)!
    .pools.find((p) => p.pool_id === poolId)!;
}

describe("GET /menu-listings — live overlay", () => {
  it("shape 不変: 全 protocol / pool_id が fixture と同一 (exponent は live 置換)", async () => {
    const menu = await getMenu();
    expect(menu.map((e) => e.protocol_id)).toEqual(
      fixtureMenuListings.map((e) => e.protocol_id)
    );
    for (let i = 0; i < menu.length; i++) {
      // Phase 8.33: exponent entry のみ pools を live markets から作り直す
      if (menu[i]!.protocol_id === "exponent") {
        expect(menu[i]!.pools.map((p) => p.pool_id)).toEqual([
          exponentPoolId(EXP_MKT_A.ticker, EXP_MKT_A.maturity_ts),
          exponentPoolId(EXP_MKT_B.ticker, EXP_MKT_B.maturity_ts),
        ]);
        continue;
      }
      expect(menu[i]!.pools.map((p) => p.pool_id)).toEqual(
        fixtureMenuListings[i]!.pools.map((p) => p.pool_id)
      );
    }
  });

  it("8.33: exponent pools は live 置換 (maturity 昇順 / display_only / TVL 換算)", async () => {
    const menu = await getMenu();
    const exp = menu.find((e) => e.protocol_id === "exponent")!;
    expect(exp.pools).toHaveLength(2);
    expect(exp.pools.every((p) => p.display_only === true)).toBe(true);
    const usx = exp.pools[0]!; // +30d が先 (昇順)
    expect(usx.asset).toBe("USX");
    expect(usx.apy).toBeCloseTo(0.061, 6);
    expect(usx.tvl_usd).toBe(40_000_000); // USD quote ×1
    const frag = exp.pools[1]!;
    expect(frag.tvl_usd).toBe(80_000); // 1000 SOL × $80 (oracle mock)
  });

  it("8.33: exponent live 失敗 → registry snapshot へ degrade (maturity filter 込み)", async () => {
    (fetchExponentFullMarkets as jest.MockedFunction<typeof fetchExponentFullMarkets>)
      .mockRejectedValue(new Error("exponent down"));
    const menu = await getMenu();
    const exp = menu.find((e) => e.protocol_id === "exponent")!;
    // registry の未満期 market のみ (test 実行時刻依存だが「registry 由来 id である」
    // ことだけを assert — 満期通過で件数が減っても壊れない)
    for (const p of exp.pools) {
      expect(p.pool_id.startsWith("exponent_pt_")).toBe(true);
      expect(p.display_only).toBe(true);
    }
    // 他 protocol は live のまま
    expect(pool(menu, "orca", "orca_usdc_usdt_whirlpool").apy).toBeCloseTo(0.0549, 6);
  });

  it("kamino reserve: apy/tvl/borrowed を overlay、kVault は apy + TVL (invested+available)", async () => {
    const menu = await getMenu();
    const usdc = pool(menu, "kamino", "kamino_usdc_main");
    expect(usdc.apy).toBeCloseTo(0.062, 6);
    expect(usdc.tvl_usd).toBeCloseTo(12345678.9, 1);
    expect(usdc.borrowed_usd).toBeCloseTo(1000000, 1);
    const vault = pool(menu, "kamino", KVAULT.pool_id);
    expect(vault.apy).toBeCloseTo(0.081, 6);
    expect(vault.tvl_usd).toBeCloseTo(19_000_000.5 + 80_000.25, 2);
  });

  it("2026-10: kVault metrics に TVL field が無い / 不正なら fixture の TVL のまま", async () => {
    mockKvault.mockResolvedValue({
      apy: "0.081",
      tokensPerShare: "1",
      tokenPrice: "1",
      tokensInvestedUsd: "not-a-number",
      tokensAvailableUsd: "80000.25",
    });
    const menu = await getMenu();
    const vault = pool(menu, "kamino", KVAULT.pool_id);
    expect(vault.apy).toBeCloseTo(0.081, 6);
    expect(vault.tvl_usd).toBe(pool(fixtureMenuListings, "kamino", KVAULT.pool_id).tvl_usd);
  });

  it("8.51: kamino pool に預入枠 (cap/used/open) が載る", async () => {
    const menu = await getMenu();
    const usdc = pool(menu, "kamino", "kamino_usdc_main");
    expect(usdc.deposit_cap).toBe("200000000"); // 200 USDC (smallest)
    expect(usdc.deposit_used).toBe("1000000"); // totalSupply "1" USDC
    // 8.52: USDC は registry で塞がれているので open は別 market (SOL) で見る
    expect(pool(menu, "kamino", "kamino_sol_main").deposit_open).toBe(true);
    // 枠を取れなかった pool は undefined のまま (他 protocol も同様)
    const vault = pool(menu, "kamino", KVAULT.pool_id);
    expect(vault.deposit_cap).toBeUndefined();
    expect(pool(menu, "jupiter", "jupiter_usdc_main").deposit_cap).toBeUndefined();
  });

  it("8.52: deposit_blocked_reason 付き market は枠に空きがあっても deposit_open=false", async () => {
    // USDC は上流の誤ルーティングで必ず失敗する。枠 (200 / 1 USDC) は空いている
    const menu = await getMenu();
    const usdc = pool(menu, "kamino", "kamino_usdc_main");
    expect(KAMINO_USDC.deposit_blocked_reason).toBeTruthy(); // registry が真実の源
    expect(usdc.deposit_cap).toBe("200000000"); // 枠情報自体は出す
    expect(usdc.deposit_open).toBe(false);
  });

  it("8.52: 枠が取れない日でも deposit_blocked_reason は効く (cap と独立)", async () => {
    mockCaps.mockResolvedValue([]);
    const menu = await getMenu();
    const usdc = pool(menu, "kamino", "kamino_usdc_main");
    expect(usdc.deposit_cap).toBeUndefined();
    expect(usdc.deposit_open).toBe(false);
  });

  it("8.51: 上限 0 (預入停止中) は deposit_open=false", async () => {
    mockCaps.mockResolvedValue([{ reserve: KAMINO_USDC.reserve, limit: 0n }]);
    const menu = await getMenu();
    const usdc = pool(menu, "kamino", "kamino_usdc_main");
    expect(usdc.deposit_cap).toBe("0");
    expect(usdc.deposit_open).toBe(false);
  });

  it("8.91: used >= cap は deposit_closed_reason=full", async () => {
    mockCaps.mockResolvedValue([
      { reserve: KAMINO_SOL.reserve, limit: 1_000_000_000n }, // 1 SOL < 供給 2 SOL
    ]);
    const menu = await getMenu();
    const sol = pool(menu, "kamino", "kamino_sol_main");
    expect(sol.deposit_open).toBe(false);
    expect(sol.deposit_closed_reason).toBe("full");
  });

  it("8.91: 上限 0 は deposit_closed_reason=suspended (registry block の無い market で見る)", async () => {
    mockCaps.mockResolvedValue([{ reserve: KAMINO_SOL.reserve, limit: 0n }]);
    const menu = await getMenu();
    const sol = pool(menu, "kamino", "kamino_sol_main");
    expect(sol.deposit_open).toBe(false);
    expect(sol.deposit_closed_reason).toBe("suspended");
  });

  it("8.91: deposit_blocked_reason は blocked (枠に空きがあっても優先)、open な market は理由なし", async () => {
    // default mock: USDC は枠 (200/1) に空きがあるが registry で塞がれている
    const menu = await getMenu();
    expect(pool(menu, "kamino", "kamino_usdc_main").deposit_closed_reason).toBe(
      "blocked"
    );
    expect(
      pool(menu, "kamino", "kamino_sol_main").deposit_closed_reason
    ).toBeUndefined();
  });

  it("8.91: 枠が取れない日でも blocked は付く (8.52 と同じ独立性)", async () => {
    mockCaps.mockResolvedValue([]);
    const menu = await getMenu();
    const usdc = pool(menu, "kamino", "kamino_usdc_main");
    expect(usdc.deposit_cap).toBeUndefined();
    expect(usdc.deposit_closed_reason).toBe("blocked");
  });

  it("8.51: 枠の取得に失敗しても menu は degrade して返る", async () => {
    mockCaps.mockRejectedValue(new Error("rpc down"));
    const menu = await getMenu();
    const usdc = pool(menu, "kamino", "kamino_usdc_main");
    expect(usdc.deposit_cap).toBeUndefined();
    expect(usdc.apy).toBeCloseTo(0.062, 6); // 他の overlay は生きている
  });

  it("jupiter: supplyRateBps/10000 + tvlUnderlying×price 換算", async () => {
    const menu = await getMenu();
    const usdc = pool(menu, "jupiter", "jupiter_usdc_main");
    expect(usdc.apy).toBeCloseTo(0.045, 6);
    expect(usdc.tvl_usd).toBeCloseTo(5_000_000, 0);
    // 8.27: jupiter_jlp_lending は削除済 (実体は kamino_jlp) — jupiter は 2 pools
    expect(menu.find((e) => e.protocol_id === "jupiter")!.pools).toHaveLength(2);
  });

  it("orca / savefi の overlay", async () => {
    const menu = await getMenu();
    const orca = pool(menu, "orca", "orca_usdc_usdt_whirlpool");
    expect(orca.apy).toBeCloseTo(0.0549, 6);
    expect(orca.tvl_usd).toBe(1200000);
    const save = pool(menu, "savefi", "savefi_usdc_main");
    expect(save.apy).toBeCloseTo(0.041, 6);
    // 2026-10: TVL = reserve 供給総量 × 単価 (USDC は 1、SOL は oracle $80)
    expect(save.tvl_usd).toBeCloseTo(22_500_000, 2);
    expect(pool(menu, "savefi", "savefi_sol_main").tvl_usd).toBeCloseTo(185_000 * 80, 2);
    // ソース無し pool は fixture
    expect(pool(menu, "savefi", "savefi_turbo_sol").tvl_usd).toBe(
      pool(fixtureMenuListings, "savefi", "savefi_turbo_sol").tvl_usd
    );
  });

  it("2026-10: Save reserve 読み取り失敗 → savefi TVL は fixture、APY は live", async () => {
    mockSaveTotals.mockRejectedValue(new Error("rpc down"));
    const menu = await getMenu();
    const save = pool(menu, "savefi", "savefi_usdc_main");
    expect(save.apy).toBeCloseTo(0.041, 6);
    expect(save.tvl_usd).toBe(pool(fixtureMenuListings, "savefi", "savefi_usdc_main").tvl_usd);
    expect(pool(menu, "savefi", "savefi_sol_main").tvl_usd).toBe(
      pool(fixtureMenuListings, "savefi", "savefi_sol_main").tvl_usd
    );
  });

  it("2026-10: SOL 価格が取れなければ Save SOL / LST の TVL は fixture (USDC は live)", async () => {
    (getOracleResult as jest.MockedFunction<typeof getOracleResult>).mockRejectedValue(
      new Error("oracle down")
    );
    const menu = await getMenu();
    expect(pool(menu, "savefi", "savefi_usdc_main").tvl_usd).toBeCloseTo(22_500_000, 2);
    expect(pool(menu, "savefi", "savefi_sol_main").tvl_usd).toBe(
      pool(fixtureMenuListings, "savefi", "savefi_sol_main").tvl_usd
    );
    expect(pool(menu, "sanctum", "sanctum_inf").tvl_usd).toBe(
      pool(fixtureMenuListings, "sanctum", "sanctum_inf").tvl_usd
    );
  });

  it("ソース失敗 → 該当 protocol は fixture 値のまま、他は live (degrade)", async () => {
    mockKamino.mockRejectedValue(new Error("kamino down"));
    const menu = await getMenu();
    const usdc = pool(menu, "kamino", "kamino_usdc_main");
    expect(usdc.apy).toBe(
      pool(fixtureMenuListings, "kamino", "kamino_usdc_main").apy
    );
    // 他ソースは生きている
    expect(pool(menu, "orca", "orca_usdc_usdt_whirlpool").apy).toBeCloseTo(0.0549, 6);
  });

  it("LST APY (8.23): jito/marinade/sanctum の pool に overlay、restaking は fixture", async () => {
    const menu = await getMenu();
    expect(pool(menu, "jito", "jito_jitosol").apy).toBeCloseTo(0.0681, 6);
    expect(pool(menu, "marinade", "marinade_msol").apy).toBeCloseTo(0.0665, 6);
    expect(pool(menu, "sanctum", "sanctum_inf").apy).toBeCloseTo(0.0773, 6);
    expect(pool(menu, "sanctum", "sanctum_bsol").apy).toBeCloseTo(0.0655, 6);
    // LST APY 対象外 pool は fixture 維持
    expect(pool(menu, "jito", "jito_restaking_vault").apy).toBe(
      pool(fixtureMenuListings, "jito", "jito_restaking_vault").apy
    );
    // restaking vault の TVL はソース無し → fixture 維持
    expect(pool(menu, "jito", "jito_restaking_vault").tvl_usd).toBe(
      pool(fixtureMenuListings, "jito", "jito_restaking_vault").tvl_usd
    );
  });

  it("2026-10: LST TVL = Sanctum lamports × SOL 価格 ($80)", async () => {
    const menu = await getMenu();
    expect(pool(menu, "sanctum", "sanctum_inf").tvl_usd).toBeCloseTo(2_000_000 * 80, 2);
    expect(pool(menu, "sanctum", "sanctum_jitosol").tvl_usd).toBeCloseTo(10_000_000 * 80, 2);
    expect(pool(menu, "sanctum", "sanctum_bsol").tvl_usd).toBeCloseTo(1_000_000 * 80, 2);
    expect(pool(menu, "marinade", "marinade_msol").tvl_usd).toBeCloseTo(3_000_000 * 80, 2);
    expect(pool(menu, "jito", "jito_jitosol").tvl_usd).toBeCloseTo(10_000_000 * 80, 2);
    expect(pool(menu, "hylo", "hylo_hylosol").tvl_usd).toBeCloseTo(200_000 * 80, 2);
    // Sanctum に投げる symbol は SOL 建て LST のみ (eUSX / USD* を含まない)
    const syms = mockSanctumTvl.mock.calls[0]![0];
    expect([...syms].sort()).toEqual(["INF", "bSOL", "hyloSOL", "jitoSOL", "mSOL"]);
  });

  it("2026-10: Sanctum TVL 失敗 → LST pool の TVL は fixture、APY は live", async () => {
    mockSanctumTvl.mockRejectedValue(new Error("sanctum down"));
    const menu = await getMenu();
    for (const [proto, id] of [
      ["sanctum", "sanctum_inf"],
      ["marinade", "marinade_msol"],
      ["jito", "jito_jitosol"],
      ["hylo", "hylo_hylosol"],
    ] as const) {
      expect(pool(menu, proto, id).tvl_usd).toBe(pool(fixtureMenuListings, proto, id).tvl_usd);
    }
    expect(pool(menu, "sanctum", "sanctum_inf").apy).toBeCloseTo(0.0773, 6);
  });

  it("2026-10: LST APY が落ちても TVL は live (ソースは独立)", async () => {
    mockLst.mockRejectedValue(new Error("sanctum apy down"));
    mockExponent.mockRejectedValue(new Error("exponent down"));
    (fetchPerenaUsdStarApy as jest.MockedFunction<typeof fetchPerenaUsdStarApy>)
      .mockRejectedValue(new Error("perena down"));
    const menu = await getMenu();
    expect(pool(menu, "jito", "jito_jitosol").tvl_usd).toBeCloseTo(10_000_000 * 80, 2);
  });

  it("2026-10: sHYUSD TVL = 供給 × Jupiter 単価", async () => {
    const menu = await getMenu();
    // getTokenSupplyUi の mock は全 mint で 40,000,000
    expect(pool(menu, "hylo", "hylo_shyusd").tvl_usd).toBeCloseTo(40_000_000 * 1.5, 2);
    expect(mockJupPrice).toHaveBeenCalledWith([SHYUSD.share_mint]);
    // APY はソース無し → fixture
    expect(pool(menu, "hylo", "hylo_shyusd").apy).toBe(
      pool(fixtureMenuListings, "hylo", "hylo_shyusd").apy
    );
  });

  it("2026-10: Jupiter 単価が取れなければ sHYUSD TVL は fixture", async () => {
    mockJupPrice.mockRejectedValue(new Error("jup down"));
    const menu = await getMenu();
    expect(pool(menu, "hylo", "hylo_shyusd").tvl_usd).toBe(
      pool(fixtureMenuListings, "hylo", "hylo_shyusd").tvl_usd
    );
  });

  it("LST APY ソース失敗 → LST pool は fixture のまま", async () => {
    mockLst.mockRejectedValue(new Error("sanctum down"));
    const menu = await getMenu();
    expect(pool(menu, "jito", "jito_jitosol").apy).toBe(
      pool(fixtureMenuListings, "jito", "jito_jitosol").apy
    );
  });

  it("meteora (8.24): 新データ API の apy/tvl overlay、solstice: Exponent APY", async () => {
    const menu = await getMenu();
    const met = pool(menu, "meteora", "meteora_usdc_usdt_dlmm");
    expect(met.apy).toBeCloseTo(0.0134, 6); // 134 bps
    expect(met.tvl_usd).toBe(275092);
    // stats 無し pool (SOL-USDC) は fixture 維持
    expect(pool(menu, "meteora", "meteora_sol_usdc_dlmm").apy).toBe(
      pool(fixtureMenuListings, "meteora", "meteora_sol_usdc_dlmm").apy
    );
    const sol = pool(menu, "solstice", "solstice_eusx");
    expect(sol.apy).toBeCloseTo(0.0376, 6);
    // perena (8.25): 非公開 endpoint の 7d APY
    expect(pool(menu, "perena", "perena_usd_star").apy).toBeCloseTo(0.093, 6);
  });

  it("2026-10: Perena の TVL — USD* は供給×単価、Tri-Stable は vault 残高。取れなければ fixture", async () => {
    (fetchPerenaUsdStarPrice as jest.MockedFunction<typeof fetchPerenaUsdStarPrice>).mockResolvedValue(1.1008);
    (fetchPerenaTriStableTvlUsd as jest.MockedFunction<typeof fetchPerenaTriStableTvlUsd>).mockResolvedValue(306770.57);
    const menu = await getMenu();
    // getTokenSupplyUi の mock は全 mint で 40,000,000
    expect(pool(menu, "perena", "perena_usd_star").tvl_usd).toBeCloseTo(40_000_000 * 1.1008, 0);
    const tri = pool(menu, "perena", "perena_tri_stable");
    expect(tri.tvl_usd).toBeCloseTo(306770.57, 2);
    // 旧 USD* の案内は fixture から素通し
    expect(tri.note).toMatch(/legacy USD\*/);
    expect(tri.external_url).toBe("https://app.perena.org/earn");
    expect(tri.display_only).toBe(true);
  });

  it("2026-10: Perena の単価 / vault が取れなければ fixture の TVL のまま", async () => {
    (fetchPerenaUsdStarPrice as jest.MockedFunction<typeof fetchPerenaUsdStarPrice>).mockRejectedValue(new Error("down"));
    (fetchPerenaTriStableTvlUsd as jest.MockedFunction<typeof fetchPerenaTriStableTvlUsd>).mockRejectedValue(new Error("down"));
    const menu = await getMenu();
    expect(pool(menu, "perena", "perena_usd_star").tvl_usd).toBe(pool(fixtureMenuListings, "perena", "perena_usd_star").tvl_usd);
    expect(pool(menu, "perena", "perena_tri_stable").tvl_usd).toBe(pool(fixtureMenuListings, "perena", "perena_tri_stable").tvl_usd);
  });

  it("8.26: jupsol は WSOL alias で overlay、solstice TVL = 供給×syRate", async () => {
    const menu = await getMenu();
    const jupsol = pool(menu, "jupiter", "jupiter_jupsol");
    expect(jupsol.apy).toBeCloseTo(0.0431, 6); // WSOL market 431bps
    expect(jupsol.tvl_usd).toBeCloseTo(2_000_000 * 78, 0);
    const sol = pool(menu, "solstice", "solstice_eusx");
    expect(sol.tvl_usd).toBeCloseTo(40_000_000 * 1.0377, 0);
  });

  it("8.26: utilization — kamino = borrow/supply", async () => {
    const menu = await getMenu();
    const kamino = pool(menu, "kamino", "kamino_usdc_main");
    expect(kamino.utilization).toBeCloseTo(1_000_000 / 12_345_678.9, 6);
    // utilization ソース無し protocol は undefined のまま
    expect(pool(menu, "orca", "orca_usdc_usdt_whirlpool").utilization).toBeUndefined();
  });

  it("live ソース無し pool (meteora_jitosol_sol、registry 外) は fixture のまま", async () => {
    const menu = await getMenu();
    expect(pool(menu, "meteora", "meteora_jitosol_sol_dlmm")).toEqual(
      pool(fixtureMenuListings, "meteora", "meteora_jitosol_sol_dlmm")
    );
  });

  it("60s cache: 2 回目はソースを再 fetch しない", async () => {
    await getMenu();
    expect(mockJup).toHaveBeenCalledTimes(1);
    await getMenu();
    expect(mockJup).toHaveBeenCalledTimes(1); // cache hit
  });
});
