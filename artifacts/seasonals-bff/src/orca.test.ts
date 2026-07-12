/**
 * Phase 8.18: Orca Whirlpools endpoint のテスト。
 *
 * orca-tx client と oracle を mock し、(1) pool 解決 + zap deposit 配管、
 * (2) oracle gate、(3) withdraw の bps 計算 (共通 helper)、(4) positions mapper の
 * deposit 建て換算 (sqrtPrice X64 bigint スケール) + feeOwed→earned + 実 APY を検証する。
 */
import type { FastifyInstance } from "fastify";

import { ORCA_MARKETS } from "@workspace/lib/config/orca-markets";
import type { OracleResult } from "@workspace/lib/types";

import {
  buildServer,
  computeLpCostBasisByPositionKey,
  mapOrcaPositionsToEarnPositions,
  orcaTotalsInDepositTerms,
  withdrawBpsFor,
} from "./server";
import type { HeliusEnhancedTx } from "./clients/helius-tx";
import {
  buildOrcaDepositTxns,
  buildOrcaWithdrawTxns,
  fetchOrcaPoolStats,
  fetchOrcaPositions,
  type OrcaPoolStats,
  type OrcaRawPosition,
} from "./clients/orca-tx";
import { fetchDriftSpotPositions } from "./clients/drift-tx";
import {
  fetchMeteoraPoolStats,
  fetchMeteoraPositions,
} from "./clients/meteora-tx";
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

jest.mock("./clients/orca-tx", () => ({
  ...jest.requireActual("./clients/orca-tx"),
  buildOrcaDepositTxns: jest.fn(),
  buildOrcaWithdrawTxns: jest.fn(),
  fetchOrcaPositions: jest.fn(),
  fetchOrcaPoolStats: jest.fn(),
}));
jest.mock("./clients/oracle");
// /positions/earn が実 network (drift websocket / kamino REST / sanctum / helius /
// meteora) を掴まないよう全 client を mock (並列 worker 下での timeout 防止)
jest.mock("./clients/drift-tx");
jest.mock("./clients/meteora-tx", () => ({
  ...jest.requireActual("./clients/meteora-tx"),
  fetchMeteoraPositions: jest.fn(),
  fetchMeteoraPoolStats: jest.fn(),
}));
jest.mock("./clients/kamino-tx");
jest.mock("./clients/save-tx");
jest.mock("./clients/rates");
jest.mock("./clients/helius");
jest.mock("./clients/jupiter-lend");
jest.mock("./clients/helius-tx");

const mockDeposit = buildOrcaDepositTxns as jest.MockedFunction<
  typeof buildOrcaDepositTxns
>;
const mockWithdraw = buildOrcaWithdrawTxns as jest.MockedFunction<
  typeof buildOrcaWithdrawTxns
>;
const mockPositions = fetchOrcaPositions as jest.MockedFunction<
  typeof fetchOrcaPositions
>;
const mockStats = fetchOrcaPoolStats as jest.MockedFunction<
  typeof fetchOrcaPoolStats
>;
const mockOracle = getOracleResult as jest.MockedFunction<typeof getOracleResult>;

const VALID_USER = "8sN5e1Qm9bYz2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r";
const USDC_USDT = ORCA_MARKETS.find((m) => m.pool_id === "orca_usdc_usdt_whirlpool")!;
const SOL_USDC = ORCA_MARKETS.find((m) => m.pool_id === "orca_sol_usdc_whirlpool")!;
const POSITION_MINT = "M1ntPoS1t1on11111111111111111111111111111111";

// sqrtPrice X64: 2^64 → price 1.0、2^63 → price 0.25 (B smallest per A smallest)
const SQRT_PRICE_1 = "18446744073709551616";
const SQRT_QUARTER = "9223372036854775808";

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

function rawPos(partial: Partial<OrcaRawPosition>): OrcaRawPosition {
  return {
    pool_id: SOL_USDC.pool_id,
    position_address: "PdA1111111111111111111111111111111111111111",
    position_mint: POSITION_MINT,
    liquidity: "1000000",
    token_a: "0",
    token_b: "0",
    fee_owed_a: "0",
    fee_owed_b: "0",
    sqrt_price: SQRT_QUARTER,
    tick_lower: -443636,
    tick_upper: 443636,
    ...partial,
  };
}

let app: FastifyInstance;

beforeEach(async () => {
  jest.clearAllMocks();
  mockOracle.mockResolvedValue(okOracle());
  mockDeposit.mockResolvedValue({
    transactions: ["ORCA_SWAP_TX", "ORCA_OPEN_TX"],
    position: POSITION_MINT,
  });
  mockWithdraw.mockResolvedValue({ transactions: ["ORCA_WD_TX"] });
  mockPositions.mockResolvedValue([]);
  mockStats.mockResolvedValue(new Map());
  // .catch/.then が直接付く client は resolved default が必須 (automock は undefined を返す)
  (fetchDriftSpotPositions as jest.MockedFunction<typeof fetchDriftSpotPositions>)
    .mockResolvedValue([]);
  (fetchMeteoraPositions as jest.MockedFunction<typeof fetchMeteoraPositions>)
    .mockResolvedValue([]);
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

describe("POST /protocols/orca/deposit-tx", () => {
  it("pool 解決 + oracle gate + zap 2 tx (swap + 部分署名済 open)", async () => {
    const res = await post("/protocols/orca/deposit-tx", {
      user: VALID_USER,
      poolKey: USDC_USDT.pool_id,
      amount: "2000000",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.transactions).toEqual(["ORCA_SWAP_TX", "ORCA_OPEN_TX"]);
    expect(body.position).toBe(POSITION_MINT);
    expect(body.poolAddress).toBe(USDC_USDT.pool_address);
    expect(mockDeposit).toHaveBeenCalledWith({
      wallet: VALID_USER,
      market: expect.objectContaining({ pool_id: USDC_USDT.pool_id }),
      amountSmallest: "2000000",
    });
    expect(mockOracle).toHaveBeenCalledWith(USDC_USDT.deposit_mint);
  });

  it("oracle blocked → 409 / 未知 pool → 400 / 不正 amount → 400", async () => {
    mockOracle.mockResolvedValue({
      ...okOracle(),
      status: "blocked",
      block_reason: "oracle_both_stale",
    });
    const blocked = await post("/protocols/orca/deposit-tx", {
      user: VALID_USER,
      poolKey: SOL_USDC.pool_id,
      amount: "1000000",
    });
    expect(blocked.statusCode).toBe(409);
    expect(mockDeposit).not.toHaveBeenCalled();

    mockOracle.mockResolvedValue(okOracle());
    const unknown = await post("/protocols/orca/deposit-tx", {
      user: VALID_USER,
      poolKey: "orca_unknown_pool", // jitosol_sol は 8.21 で registry 入り
      amount: "1",
    });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().error).toBe("unsupported_pool");

    const bad = await post("/protocols/orca/deposit-tx", {
      user: VALID_USER,
      poolKey: USDC_USDT.pool_id,
      amount: "1.5",
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe("invalid_amount");
  });
});

describe("POST /protocols/orca/withdraw-tx — bps 計算", () => {
  // SOL-USDC (A=SOL / deposit=B=USDC)、price 0.25:
  // A=1 SOL (1e9) × 0.25 = 250,000,000 + B=100,000,000 → 総額 350,000,000 USDC units
  const HOLDING = rawPos({ token_a: "1000000000", token_b: "100000000" });

  it("部分 withdraw: 半額 → bps 5000 (decreaseLiquidity)", async () => {
    mockPositions.mockResolvedValue([HOLDING]);
    const res = await post("/protocols/orca/withdraw-tx", {
      user: VALID_USER,
      position: POSITION_MINT,
      amount: "175000000",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().bps).toBe(5000);
    expect(mockWithdraw).toHaveBeenCalledWith(
      expect.objectContaining({ positionMint: POSITION_MINT, bps: 5000 })
    );
  });

  it("総額以上 → bps 10000 (closePosition: fees + close + NFT burn)", async () => {
    mockPositions.mockResolvedValue([HOLDING]);
    const res = await post("/protocols/orca/withdraw-tx", {
      user: VALID_USER,
      position: POSITION_MINT,
      amount: "999999999999",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().bps).toBe(10000);
  });

  it("極小額 → bps は最低 1 に clamp / position 不在 → 400", async () => {
    mockPositions.mockResolvedValue([HOLDING]);
    const tiny = await post("/protocols/orca/withdraw-tx", {
      user: VALID_USER,
      position: POSITION_MINT,
      amount: "1",
    });
    expect(tiny.statusCode).toBe(200);
    expect(tiny.json().bps).toBe(1);

    mockPositions.mockResolvedValue([]);
    const missing = await post("/protocols/orca/withdraw-tx", {
      user: VALID_USER,
      position: POSITION_MINT,
      amount: "1",
    });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error).toBe("position_not_found");
  });
});

describe("withdrawBpsFor (共通 helper)", () => {
  it("round / clamp / 全量 / total 不明", () => {
    expect(withdrawBpsFor(50n, 100n)).toBe(5000);
    expect(withdrawBpsFor(1n, 1000000000n)).toBe(1); // 最低 1
    expect(withdrawBpsFor(100n, 100n)).toBe(10000); // 総額ちょうど
    expect(withdrawBpsFor(200n, 100n)).toBe(10000); // 超過
    expect(withdrawBpsFor(1n, null)).toBe(10000); // total 不明 → 全量
    expect(withdrawBpsFor(1n, 0n)).toBe(10000);
    expect(withdrawBpsFor(333n, 1000n)).toBe(3330);
  });
});

describe("orcaTotalsInDepositTerms", () => {
  it("deposit=B (SOL-USDC): A×price + B", () => {
    const t = orcaTotalsInDepositTerms(
      rawPos({
        token_a: "1000000000",
        token_b: "100000000",
        fee_owed_a: "1000000000",
        fee_owed_b: "0",
      }),
      "b"
    );
    expect(t).not.toBeNull();
    expect(t!.total).toBe(350000000n); // 100000000 + 250000000
    expect(t!.fee).toBe(250000000n);
  });

  it("deposit=A (USDC-USDT、price 1.0): B/price + A", () => {
    const t = orcaTotalsInDepositTerms(
      rawPos({
        token_a: "1000000",
        token_b: "1000000",
        sqrt_price: SQRT_PRICE_1,
        fee_owed_a: "100",
        fee_owed_b: "200",
      }),
      "a"
    );
    expect(t!.total).toBe(2000000n);
    expect(t!.fee).toBe(300n);
  });

  it("不正な整数 string は null", () => {
    expect(orcaTotalsInDepositTerms(rawPos({ token_a: "1.5" }), "b")).toBeNull();
    expect(orcaTotalsInDepositTerms(rawPos({ sqrt_price: "abc" }), "b")).toBeNull();
  });
});

describe("mapOrcaPositionsToEarnPositions", () => {
  const prices = new Map([
    ["EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", 1_00000000n],
  ]);

  it("position → EarnPosition (share_mint=position mint、feeOwed=earned gain、実 APY)", () => {
    const stats = new Map<string, OrcaPoolStats>([
      [SOL_USDC.pool_address, { tvl_usd: 32526289, apr_day_bps: 5933 }],
    ]);
    const out = mapOrcaPositionsToEarnPositions(
      [
        rawPos({
          token_a: "0",
          token_b: "100000000",
          fee_owed_a: "0",
          fee_owed_b: "50000",
        }),
      ],
      prices,
      stats
    );
    expect(out).toHaveLength(1);
    const p = out[0]!;
    expect(p.protocol_id).toBe("orca");
    expect(p.share_mint).toBe(POSITION_MINT);
    expect(p.market_symbol).toBe("SOL-USDC");
    expect(p.asset_symbol).toBe("USDC");
    expect(p.underlying_amount).toBe("100000000");
    expect(p.underlying_usd).toBe("100.00000000");
    expect(p.supply_rate_bps).toBe(5933);
    expect(p.accrued_yield_amount).toBe("50000");
    expect(p.accrued_yield_sign).toBe("gain");
  });

  it("空 position / 未知 pool は除外、stats 無しは APY null", () => {
    const out = mapOrcaPositionsToEarnPositions(
      [
        rawPos({ token_a: "0", token_b: "0" }),
        rawPos({ pool_id: "orca_unknown", token_b: "5" }),
        rawPos({ token_b: "100" }),
      ],
      prices,
      new Map()
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.supply_rate_bps).toBeNull();
  });
});

// ── Phase 8.19: LP cost-basis (IL 込み earned) ───────────────────────────────

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDT_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const POSITION_PDA = "PdA1111111111111111111111111111111111111111";

function bal(mint: string, owner: string, raw: string, decimals = 6) {
  return { mint, userAccount: owner, rawTokenAmount: { tokenAmount: raw, decimals } };
}
/**
 * position account が accountData に載る lifecycle tx (live probe と同形)。
 * rentLamports > 0 = open (position account 作成の rent 入金)。
 */
function lpTx(
  sig: string,
  positionAccount: string,
  changes: ReturnType<typeof bal>[],
  rentLamports = 0
): HeliusEnhancedTx {
  return {
    signature: sig,
    timestamp: 1_700_000_000,
    type: "OPEN_POSITION_WITH_METADATA",
    fee: 5000,
    accountData: [
      { account: positionAccount, nativeBalanceChange: rentLamports },
      { account: "ACC", tokenBalanceChanges: changes },
    ],
  };
}
const RENT = 2394240; // live probe 実測の position PDA rent

describe("computeLpCostBasisByPositionKey — orca", () => {
  it("stable (USDC-USDT): open の両脚を 1:1 で積む (probe 実測値)", () => {
    const pos = rawPos({ pool_id: USDC_USDT.pool_id });
    const txs = [
      lpTx(
        "open",
        POSITION_PDA,
        [
          bal(USDC_MINT, VALID_USER, "-950000"),
          bal(USDT_MINT, VALID_USER, "-949785"),
        ],
        RENT
      ),
    ];
    const map = computeLpCostBasisByPositionKey(txs, VALID_USER, [pos], []);
    expect(map.get(POSITION_MINT)).toBe(1899785n); // key = position mint (NFT)
  });

  it("stable: 部分 withdraw / fee claim が cost を減らす", () => {
    const pos = rawPos({ pool_id: USDC_USDT.pool_id });
    const txs = [
      lpTx(
        "open",
        POSITION_PDA,
        [
          bal(USDC_MINT, VALID_USER, "-1000000"),
          bal(USDT_MINT, VALID_USER, "-1000000"),
        ],
        RENT
      ),
      lpTx("wd", POSITION_PDA, [
        bal(USDC_MINT, VALID_USER, "300000"),
        bal(USDT_MINT, VALID_USER, "300000"),
      ]),
    ];
    const map = computeLpCostBasisByPositionKey(txs, VALID_USER, [pos], []);
    expect(map.get(POSITION_MINT)).toBe(1400000n);
  });

  it("open が window 外 (rent 入金 tx 無し) → cost 不明 (部分可視ガード)", () => {
    // 実 wallet で観測した欠陥ケース: 直近の increase だけ見えている
    const pos = rawPos({ pool_id: USDC_USDT.pool_id });
    const increaseOnly = lpTx("inc", POSITION_PDA, [
      bal(USDC_MINT, VALID_USER, "-50000"),
      bal(USDT_MINT, VALID_USER, "-50000"),
    ]);
    expect(
      computeLpCostBasisByPositionKey([increaseOnly], VALID_USER, [pos], []).size
    ).toBe(0);
  });

  it("volatile (SOL-USDC): full-range 1 tx の zap open → deposit 脚 ×2", () => {
    const pos = rawPos({}); // default: SOL_USDC, full-range ±443636
    const txs = [
      lpTx("open", POSITION_PDA, [bal(USDC_MINT, VALID_USER, "-1000000")], RENT),
    ];
    const map = computeLpCostBasisByPositionKey(txs, VALID_USER, [pos], []);
    expect(map.get(POSITION_MINT)).toBe(2000000n);
  });

  it("volatile jitoSOL-SOL (8.27): 両脚負 = deposit 脚 ×2 / 相方脚のみ = rate 換算 ×2", () => {
    const JITOSOL = "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn";
    const pos = rawPos({ pool_id: "orca_jitosol_sol_whirlpool" });
    // rate: 1 jitoSOL = 1.2886 SOL (num=lamports per whole, den=1e9)
    const rates = new Map([[JITOSOL, { num: 1_288_600_000n, den: 1_000_000_000n }]]);

    // 実測形: WSOL + jitoSOL 両方負 (直接 two-sided add) → deposit(WSOL) 脚 ×2
    const both = lpTx(
      "open",
      POSITION_PDA,
      [
        bal(USDC_MINT /*dummy*/, "other", "0"),
        bal("So11111111111111111111111111111111111111112", VALID_USER, "-269116542", 9),
        bal(JITOSOL, VALID_USER, "-724227203", 9),
      ],
      RENT
    );
    expect(
      computeLpCostBasisByPositionKey([both], VALID_USER, [pos], [], rates).get(
        POSITION_MINT
      )
    ).toBe(538233084n); // 269116542 × 2

    // zap 形: WSOL delta 無し (一時 account 経由) → jitoSOL 脚 × rate × 2
    const zapOnly = lpTx(
      "open",
      POSITION_PDA,
      [bal(JITOSOL, VALID_USER, "-1000000000", 9)],
      RENT
    );
    expect(
      computeLpCostBasisByPositionKey([zapOnly], VALID_USER, [pos], [], rates).get(
        POSITION_MINT
      )
    ).toBe(2577200000n); // 1e9 × 1.2886 × 2
    // rate 無しなら cost 不明 (fee-only fallback)
    expect(
      computeLpCostBasisByPositionKey([zapOnly], VALID_USER, [pos], []).size
    ).toBe(0);
  });

  it("volatile: 2 tx 以上 / 集中レンジ / window 外は cost 不明", () => {
    const open = lpTx(
      "open",
      POSITION_PDA,
      [bal(USDC_MINT, VALID_USER, "-1000000")],
      RENT
    );
    const wd = lpTx("wd", POSITION_PDA, [bal(USDC_MINT, VALID_USER, "200000")]);
    // 2 tx (部分 withdraw 済)
    expect(
      computeLpCostBasisByPositionKey([open, wd], VALID_USER, [rawPos({})], []).size
    ).toBe(0);
    // 集中レンジ (full-range でない)
    expect(
      computeLpCostBasisByPositionKey(
        [open],
        VALID_USER,
        [rawPos({ tick_lower: -100, tick_upper: 100 })],
        []
      ).size
    ).toBe(0);
    // position を触る tx が無い (window 外)
    expect(
      computeLpCostBasisByPositionKey([], VALID_USER, [rawPos({})], []).size
    ).toBe(0);
  });
});

describe("mapOrcaPositionsToEarnPositions — IL 込み earned (8.19)", () => {
  const prices = new Map([[USDC_MINT, 1_00000000n]]);

  it("cost 判明 + 含み損 → loss (magnitude + cost_basis)", () => {
    // SOL-USDC price 0.25: total = 100000000、fee 0。cost 150000000 → delta -50000000
    const out = mapOrcaPositionsToEarnPositions(
      [rawPos({ token_a: "0", token_b: "100000000" })],
      prices,
      new Map(),
      new Map([[POSITION_MINT, 150000000n]])
    );
    expect(out[0]!.accrued_yield_sign).toBe("loss");
    expect(out[0]!.accrued_yield_amount).toBe("50000000");
    expect(out[0]!.cost_basis_amount).toBe("150000000");
  });

  it("cost 判明 + 利益 (fee 込み) → gain", () => {
    const out = mapOrcaPositionsToEarnPositions(
      [rawPos({ token_a: "0", token_b: "100000000", fee_owed_b: "500000" })],
      prices,
      new Map(),
      new Map([[POSITION_MINT, 99000000n]])
    );
    expect(out[0]!.accrued_yield_sign).toBe("gain");
    expect(out[0]!.accrued_yield_amount).toBe("1500000"); // 100.5M - 99M
    expect(out[0]!.cost_basis_amount).toBe("99000000");
  });

  it("cost 不明 → 従来の fee-only gain (cost_basis null)", () => {
    const out = mapOrcaPositionsToEarnPositions(
      [rawPos({ token_a: "0", token_b: "100000000", fee_owed_b: "500000" })],
      prices,
      new Map(),
      new Map()
    );
    expect(out[0]!.accrued_yield_sign).toBe("gain");
    expect(out[0]!.accrued_yield_amount).toBe("500000");
    expect(out[0]!.cost_basis_amount).toBeNull();
  });
});

describe("/positions/earn に orca 配列", () => {
  it("orca positions が response に載る (実 APY 付き)", async () => {
    mockPositions.mockResolvedValue([
      rawPos({ token_a: "0", token_b: "100000000" }),
    ]);
    mockStats.mockResolvedValue(
      new Map([[SOL_USDC.pool_address, { tvl_usd: 1, apr_day_bps: 5933 }]])
    );
    const res = await app.inject({
      method: "GET",
      url: `/positions/earn?wallet=${VALID_USER}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.orca)).toBe(true);
    expect(body.orca).toHaveLength(1);
    expect(body.orca[0].share_mint).toBe(POSITION_MINT);
    expect(body.orca[0].supply_rate_bps).toBe(5933);
  });
});
