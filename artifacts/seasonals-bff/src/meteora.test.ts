/**
 * Phase 8.17: Meteora DLMM endpoint のテスト。
 *
 * meteora-tx client と oracle を mock し、(1) pool 解決、(2) oracle gate、
 * (3) withdraw の bps 計算 (部分/全量/超過/丸め)、(4) positions mapper の
 * deposit 建て換算 (X↔Y bigint スケール) + fee→earned を検証する。
 */
import type { FastifyInstance } from "fastify";

import { METEORA_MARKETS } from "@workspace/lib/config/meteora-markets";
import type { OracleResult } from "@workspace/lib/types";

import {
  buildServer,
  computeLpCostBasisByPositionKey,
  mapMeteoraPositionsToEarnPositions,
  meteoraTotalsInDepositTerms,
} from "./server";
import type { HeliusEnhancedTx } from "./clients/helius-tx";
import {
  buildMeteoraDepositTxns,
  buildMeteoraWithdrawTxns,
  fetchMeteoraPoolStats,
  fetchMeteoraPositions,
  type MeteoraRawPosition,
} from "./clients/meteora-tx";
import { fetchOrcaPoolStats, fetchOrcaPositions } from "./clients/orca-tx";
import {
  fetchKaminoObligations,
  fetchKaminoReserveMetrics,
  fetchKaminoVaultMetrics,
  fetchKaminoVaultUserPositions,
} from "./clients/kamino-tx";
import { fetchSaveReserveRates } from "./clients/save-tx";
import {
  fetchExponentApys,
  fetchJupiterRateOut,
  fetchLstApys,
  fetchSanctumSolValues,
} from "./clients/rates";
import { fetchAssetsByOwner } from "./clients/helius";
import { fetchEarnPositions } from "./clients/jupiter-lend";
import { fetchEnhancedTransactions } from "./clients/helius-tx";
import { getOracleResult } from "./clients/oracle";

jest.mock("./clients/meteora-tx", () => ({
  ...jest.requireActual("./clients/meteora-tx"),
  buildMeteoraDepositTxns: jest.fn(),
  buildMeteoraWithdrawTxns: jest.fn(),
  fetchMeteoraPositions: jest.fn(),
  fetchMeteoraPoolStats: jest.fn(),
}));
jest.mock("./clients/oracle");
// /positions/earn が実 network (kamino REST / sanctum / helius) を
// 掴まないよう全 client を mock (並列 worker 下での timeout 防止)
jest.mock("./clients/orca-tx", () => ({
  ...jest.requireActual("./clients/orca-tx"),
  fetchOrcaPositions: jest.fn(),
  fetchOrcaPoolStats: jest.fn(),
}));
jest.mock("./clients/kamino-tx");
jest.mock("./clients/save-tx");
jest.mock("./clients/rates");
jest.mock("./clients/helius");
jest.mock("./clients/jupiter-lend");
jest.mock("./clients/helius-tx");

const mockDeposit = buildMeteoraDepositTxns as jest.MockedFunction<
  typeof buildMeteoraDepositTxns
>;
const mockWithdraw = buildMeteoraWithdrawTxns as jest.MockedFunction<
  typeof buildMeteoraWithdrawTxns
>;
const mockPositions = fetchMeteoraPositions as jest.MockedFunction<
  typeof fetchMeteoraPositions
>;
const mockOracle = getOracleResult as jest.MockedFunction<typeof getOracleResult>;

const VALID_USER = "8sN5e1Qm9bYz2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r";
const USDC_USDT = METEORA_MARKETS.find((m) => m.pool_id === "meteora_usdc_usdt_dlmm")!;
const SOL_USDC = METEORA_MARKETS.find((m) => m.pool_id === "meteora_sol_usdc_dlmm")!;
const POSITION = "PoS1t1on111111111111111111111111111111111111";

function okOracle(): OracleResult {
  return {
    asset_symbol: "USDC",
    status: "ok",
    primary: "pyth",
    price_usd: "1.00000000",
    pyth: { available: true, price_usd: "1.00000000", age_seconds: 1 },
    switchboard: { available: false, price_usd: null, age_seconds: null },
    divergence_pct: null,
    warnings: [],
    block_reason: null,
  };
}

function rawPos(partial: Partial<MeteoraRawPosition>): MeteoraRawPosition {
  return {
    pool_id: SOL_USDC.pool_id,
    position_address: POSITION,
    total_x: "0",
    total_y: "0",
    fee_x: "0",
    fee_y: "0",
    price_raw: "0.18210923719745299511", // 実 on-chain 値 (X smallest → Y smallest)
    lower_bin_id: -1724,
    upper_bin_id: -1704,
    ...partial,
  };
}

let app: FastifyInstance;

beforeEach(async () => {
  jest.clearAllMocks();
  mockOracle.mockResolvedValue(okOracle());
  mockDeposit.mockResolvedValue({ transactions: ["MET_DEP_TX"], position: POSITION });
  mockWithdraw.mockResolvedValue({ transactions: ["MET_WD_TX"] });
  mockPositions.mockResolvedValue([]);
  (fetchOrcaPositions as jest.MockedFunction<typeof fetchOrcaPositions>)
    .mockResolvedValue([]);
  (fetchOrcaPoolStats as jest.MockedFunction<typeof fetchOrcaPoolStats>)
    .mockResolvedValue(new Map());
  // .catch/.then が直接付く client は resolved default が必須 (automock は undefined を返す)
  (fetchKaminoVaultUserPositions as jest.MockedFunction<typeof fetchKaminoVaultUserPositions>)
    .mockResolvedValue([]);
  (fetchSaveReserveRates as jest.MockedFunction<typeof fetchSaveReserveRates>)
    .mockResolvedValue([]);
  (fetchSanctumSolValues as jest.MockedFunction<typeof fetchSanctumSolValues>)
    .mockResolvedValue(new Map());
  (fetchJupiterRateOut as jest.MockedFunction<typeof fetchJupiterRateOut>)
    .mockResolvedValue(1_000_000n);
  (fetchLstApys as jest.MockedFunction<typeof fetchLstApys>)
    .mockResolvedValue(new Map());
  (fetchExponentApys as jest.MockedFunction<typeof fetchExponentApys>)
    .mockResolvedValue(new Map());
  (fetchMeteoraPoolStats as jest.MockedFunction<typeof fetchMeteoraPoolStats>)
    .mockResolvedValue(new Map());
  // 実 network 時代の「fetch 失敗 → degrade」挙動を再現
  for (const fn of [
    fetchEarnPositions,
    fetchAssetsByOwner,
    fetchEnhancedTransactions,
    fetchKaminoObligations,
    fetchKaminoReserveMetrics,
    fetchKaminoVaultMetrics,
  ]) {
    (fn as jest.Mock).mockRejectedValue(new Error("mocked-off"));
  }
  app = await buildServer({ logger: false });
});
afterEach(async () => {
  await app.close();
});

async function post(url: string, body: Record<string, unknown>) {
  return app.inject({ method: "POST", url, payload: body });
}

describe("POST /protocols/meteora/deposit-tx", () => {
  it("pool 解決 + oracle gate + client 呼び出し", async () => {
    const res = await post("/protocols/meteora/deposit-tx", {
      user: VALID_USER,
      poolKey: USDC_USDT.pool_id,
      amount: "1000000",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.transactions).toEqual(["MET_DEP_TX"]);
    expect(body.position).toBe(POSITION);
    expect(mockDeposit).toHaveBeenCalledWith({
      wallet: VALID_USER,
      market: expect.objectContaining({ pool_id: USDC_USDT.pool_id }),
      amountSmallest: "1000000",
    });
    expect(mockOracle).toHaveBeenCalledWith(USDC_USDT.deposit_mint);
  });

  it("oracle blocked → 409 / 未知 pool → 400 / 不正 amount → 400", async () => {
    mockOracle.mockResolvedValue({
      ...okOracle(),
      status: "blocked",
      block_reason: "oracle_both_stale",
    });
    const blocked = await post("/protocols/meteora/deposit-tx", {
      user: VALID_USER,
      poolKey: SOL_USDC.pool_id,
      amount: "1000000",
    });
    expect(blocked.statusCode).toBe(409);
    expect(mockDeposit).not.toHaveBeenCalled();

    mockOracle.mockResolvedValue(okOracle());
    const unknown = await post("/protocols/meteora/deposit-tx", {
      user: VALID_USER,
      poolKey: "meteora_unknown_pool", // jitosol_sol は 8.27 で registry 入り
      amount: "1",
    });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().error).toBe("unsupported_pool");

    const bad = await post("/protocols/meteora/deposit-tx", {
      user: VALID_USER,
      poolKey: USDC_USDT.pool_id,
      amount: "1.5",
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe("invalid_amount");
  });
});

describe("POST /protocols/meteora/withdraw-tx — bps 計算", () => {
  // SOL-USDC (deposit=Y=USDC): total = Y + X×price/1e12
  // X=1 SOL (1e9) × 0.18210923… = 182,109,237 USDC units; Y=100 USDC (1e8=100000000)
  const HOLDING = rawPos({
    total_x: "1000000000",
    total_y: "100000000",
  }); // 総額 ≈ 282,109,237 USDC units

  it("部分 withdraw: 半額 → bps ≈ 5000 (round)", async () => {
    mockPositions.mockResolvedValue([HOLDING]);
    const res = await post("/protocols/meteora/withdraw-tx", {
      user: VALID_USER,
      position: POSITION,
      amount: "141054618", // 半額
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().bps).toBe(5000);
    expect(mockWithdraw).toHaveBeenCalledWith(
      expect.objectContaining({
        positionAddress: POSITION,
        bps: 5000,
        fromBinId: -1724,
        toBinId: -1704,
      })
    );
  });

  it("総額以上 → bps 10000 (claim & close)", async () => {
    mockPositions.mockResolvedValue([HOLDING]);
    const res = await post("/protocols/meteora/withdraw-tx", {
      user: VALID_USER,
      position: POSITION,
      amount: "999999999999",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().bps).toBe(10000);
  });

  it("極小額 → bps は最低 1 に clamp", async () => {
    mockPositions.mockResolvedValue([HOLDING]);
    const res = await post("/protocols/meteora/withdraw-tx", {
      user: VALID_USER,
      position: POSITION,
      amount: "1",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().bps).toBe(1);
  });

  it("position 不在 → 400", async () => {
    mockPositions.mockResolvedValue([]);
    const res = await post("/protocols/meteora/withdraw-tx", {
      user: VALID_USER,
      position: POSITION,
      amount: "1",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("position_not_found");
  });
});

describe("meteoraTotalsInDepositTerms", () => {
  it("deposit=Y (SOL-USDC): X×price + Y", () => {
    const t = meteoraTotalsInDepositTerms(
      rawPos({ total_x: "1000000000", total_y: "100000000", fee_x: "1000000000", fee_y: "0" }),
      "y"
    );
    expect(t).not.toBeNull();
    expect(t!.total).toBe(282109237n); // 100000000 + 182109237
    expect(t!.fee).toBe(182109237n);
  });

  it("deposit=X (USDC-USDT): Y/price + X", () => {
    const t = meteoraTotalsInDepositTerms(
      rawPos({
        total_x: "1000000",
        total_y: "1000600",
        price_raw: "1.0006",
        fee_x: "0",
        fee_y: "0",
      }),
      "x"
    );
    expect(t!.total).toBe(2000000n); // 1000000 + 1000600/1.0006 = 1000000+1000000
  });

  it("decimal 揺れの amount (除算由来の端数) は整数部を採用", () => {
    const t = meteoraTotalsInDepositTerms(
      rawPos({ total_x: "0", total_y: "123456.789", price_raw: "1" }),
      "y"
    );
    expect(t!.total).toBe(123456n);
  });

  it("不正 price は null", () => {
    expect(
      meteoraTotalsInDepositTerms(rawPos({ price_raw: "abc" }), "y")
    ).toBeNull();
  });
});

describe("mapMeteoraPositionsToEarnPositions", () => {
  const prices = new Map([
    ["EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", 1_00000000n],
  ]);

  it("position → EarnPosition (share_mint=position addr、fee=earned gain)", () => {
    const out = mapMeteoraPositionsToEarnPositions(
      [
        rawPos({
          total_x: "0",
          total_y: "100000000",
          fee_x: "0",
          fee_y: "50000",
        }),
      ],
      prices
    );
    expect(out).toHaveLength(1);
    const p = out[0]!;
    expect(p.protocol_id).toBe("meteora");
    expect(p.share_mint).toBe(POSITION);
    expect(p.market_symbol).toBe("SOL-USDC");
    expect(p.asset_symbol).toBe("USDC");
    expect(p.underlying_amount).toBe("100000000");
    expect(p.underlying_usd).toBe("100.00000000");
    expect(p.accrued_yield_amount).toBe("50000");
    expect(p.accrued_yield_sign).toBe("gain");
  });

  it("空 position / 未知 pool は除外", () => {
    const out = mapMeteoraPositionsToEarnPositions(
      [
        rawPos({ total_x: "0", total_y: "0" }),
        rawPos({ pool_id: "meteora_unknown", total_y: "5" }),
      ],
      prices
    );
    expect(out).toHaveLength(0);
  });
});

// ── Phase 8.19: LP cost-basis (IL 込み earned) ───────────────────────────────

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDT_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const SOL_MINT = "So11111111111111111111111111111111111111112";

function bal(mint: string, owner: string, raw: string, decimals = 6) {
  return { mint, userAccount: owner, rawTokenAmount: { tokenAmount: raw, decimals } };
}
/** rentLamports > 0 = open (position account 作成の rent 入金)。 */
function lpTx(
  sig: string,
  positionAccount: string,
  changes: ReturnType<typeof bal>[],
  rentLamports = 0
): HeliusEnhancedTx {
  return {
    signature: sig,
    timestamp: 1_700_000_000,
    type: "ADD_LIQUIDITY",
    fee: 5000,
    accountData: [
      { account: positionAccount, nativeBalanceChange: rentLamports },
      { account: "ACC", tokenBalanceChanges: changes },
    ],
  };
}
const RENT = 57_000_000; // DLMM position account rent (概算値、>0 判定のみ)

describe("computeLpCostBasisByPositionKey — meteora", () => {
  it("volatile (SOL-USDC): 全 tx single-sided → deposit 脚のみ (key = position account)", () => {
    const pos = rawPos({}); // SOL_USDC、deposit=Y=USDC
    const txs = [
      lpTx("open", POSITION, [bal(USDC_MINT, VALID_USER, "-100000000")], RENT),
    ];
    const map = computeLpCostBasisByPositionKey(txs, VALID_USER, [], [pos]);
    expect(map.get(POSITION)).toBe(100000000n);
  });

  it("volatile: other 脚 (SOL) が動く tx があれば cost 不明", () => {
    const pos = rawPos({});
    const txs = [
      lpTx("open", POSITION, [bal(USDC_MINT, VALID_USER, "-100000000")], RENT),
      lpTx("wd", POSITION, [
        bal(USDC_MINT, VALID_USER, "30000000"),
        bal(SOL_MINT, VALID_USER, "100000000", 9),
      ]),
    ];
    expect(computeLpCostBasisByPositionKey(txs, VALID_USER, [], [pos]).size).toBe(0);
  });

  it("stable (USDC-USDT): 両脚 1:1 で withdraw も正しく積む", () => {
    const pos = rawPos({ pool_id: USDC_USDT.pool_id });
    const txs = [
      lpTx("open", POSITION, [bal(USDC_MINT, VALID_USER, "-1000000")], RENT),
      lpTx("wd", POSITION, [
        bal(USDC_MINT, VALID_USER, "300000"),
        bal(USDT_MINT, VALID_USER, "300000"),
      ]),
    ];
    const map = computeLpCostBasisByPositionKey(txs, VALID_USER, [], [pos]);
    expect(map.get(POSITION)).toBe(400000n);
  });

  it("open が window 外 (rent 入金 tx 無し) → cost 不明 (部分可視ガード)", () => {
    const pos = rawPos({ pool_id: USDC_USDT.pool_id });
    const addOnly = lpTx("add", POSITION, [bal(USDC_MINT, VALID_USER, "-50000")]);
    expect(
      computeLpCostBasisByPositionKey([addOnly], VALID_USER, [], [pos]).size
    ).toBe(0);
  });
});

describe("mapMeteoraPositionsToEarnPositions — IL 込み earned (8.19)", () => {
  const prices = new Map([[USDC_MINT, 1_00000000n]]);

  it("cost 判明 + 含み損 → loss / cost 不明 → 従来 fee-only gain", () => {
    const raws = [rawPos({ total_x: "0", total_y: "100000000", fee_y: "50000" })];
    const withCost = mapMeteoraPositionsToEarnPositions(
      raws,
      prices,
      new Map([[POSITION, 150000000n]])
    );
    expect(withCost[0]!.accrued_yield_sign).toBe("loss");
    expect(withCost[0]!.accrued_yield_amount).toBe("49950000"); // 150M - 100.05M
    expect(withCost[0]!.cost_basis_amount).toBe("150000000");

    const noCost = mapMeteoraPositionsToEarnPositions(raws, prices, new Map());
    expect(noCost[0]!.accrued_yield_sign).toBe("gain");
    expect(noCost[0]!.accrued_yield_amount).toBe("50000");
    expect(noCost[0]!.cost_basis_amount).toBeNull();
  });
});

describe("/positions/earn に meteora 配列", () => {
  it("meteora positions が response に載る", async () => {
    mockPositions.mockResolvedValue([
      rawPos({ total_x: "0", total_y: "100000000" }),
    ]);
    const res = await app.inject({
      method: "GET",
      url: `/positions/earn?wallet=${VALID_USER}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.meteora)).toBe(true);
    expect(body.meteora).toHaveLength(1);
    expect(body.meteora[0].share_mint).toBe(POSITION);
  });
});
