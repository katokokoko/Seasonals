/**
 * Phase 8.15: protocol 汎用 swap-earn endpoint のテスト。
 *
 * deposit = underlying→share、withdraw = share→underlying の Jupiter Swap を
 * SWAP_EARN_MARKETS で一般化した経路を検証する。Jupiter / oracle client は mock し、
 * (1) market 解決 (shareMint → 正しい input/output)、(2) oracle fail-closed gate (§4.6)、
 * (3) 未知 shareMint / 欠損 field の 400、(4) 既存 jupiter-lend endpoint の back-compat
 * を確認する。実ネットワークは叩かない。
 */
import type { FastifyInstance } from "fastify";

import {
  SWAP_EARN_MARKETS,
  findMarketByShareMint,
} from "@workspace/lib/config/swap-earn-markets";
import type { OracleResult } from "@workspace/lib/types";

import { buildServer } from "./server";
import { fetchSwapQuote, fetchSwapTransaction } from "./clients/jupiter-swap";
import { getOracleResult, getOracleResults } from "./clients/oracle";
import { fetchLstSolValues } from "./clients/lst-rates";
import { getWalletBalanceSmallest, refreshUnsignedTxBlockhash } from "./clients/helius-rpc";
import { fetchEarnMarkets, type JupiterLendMarket } from "./clients/jupiter-lend";

jest.mock("./clients/jupiter-swap");
// 2026-10-13: funding deposit の cross-asset 償還価値ガードが convertToAssets を読む (他は実体のまま)
jest.mock("./clients/jupiter-lend", () => ({
  ...jest.requireActual("./clients/jupiter-lend"),
  fetchEarnMarkets: jest.fn(),
}));
jest.mock("./clients/oracle");
// 8.72/8.73: 償還価値ガードの参照レート (protocol 実データ)。実ネットワークは叩かない
jest.mock("./clients/lst-rates");
// 8.80: 残高 gate。mock が無いと live RPC を叩く
jest.mock("./clients/helius-rpc");

const mockQuote = fetchSwapQuote as jest.MockedFunction<typeof fetchSwapQuote>;
const mockTx = fetchSwapTransaction as jest.MockedFunction<
  typeof fetchSwapTransaction
>;
const mockOracle = getOracleResult as jest.MockedFunction<
  typeof getOracleResult
>;
const mockSolValues = fetchLstSolValues as jest.MockedFunction<
  typeof fetchLstSolValues
>;
const mockBalance = getWalletBalanceSmallest as jest.MockedFunction<
  typeof getWalletBalanceSmallest
>;
/** 8.72: jitoSOL 1 枚 = 1.2 SOL の想定レート (lamports) */
const JITO_SOL_VALUE = 1_200_000_000n;
const JITO_MINT = "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn";
/** fair な受取量。deposit = SOL→jitoSOL / withdraw = jitoSOL→SOL で向きが逆 */
function fairOut(inAmount: string, inputMint: string): string {
  if (!/^[0-9]+$/.test(inAmount)) return "999";
  const amount = BigInt(inAmount);
  return inputMint === JITO_MINT
    ? ((amount * JITO_SOL_VALUE) / 1_000_000_000n).toString()
    : ((amount * 1_000_000_000n) / JITO_SOL_VALUE).toString();
}

const VALID_USER = "8sN5e1Qm9bYz2c3d4e5f6g7h8i9jAk1L2m3n4o5p6q7r";

function okOracle(symbol = "SOL"): OracleResult {
  return {
    asset_symbol: symbol,
    status: "ok",
    primary: "pyth",
    price_usd: "150.00000000",
    pyth: { available: true, price_usd: "150.00000000", age_seconds: 1 },
    secondary: { source: "redstone", available: true, price_usd: "150.10000000", age_seconds: 0 },
    tier: "A",
    divergence_pct: 0.06,
    warnings: [],
    block_reason: null,
  };
}

function blockedOracle(symbol = "SOL"): OracleResult {
  return {
    asset_symbol: symbol,
    status: "blocked",
    primary: null,
    price_usd: null,
    pyth: { available: false, price_usd: null, age_seconds: null },
    secondary: { source: null, available: false, price_usd: null, age_seconds: null },
    tier: "C",
    divergence_pct: null,
    warnings: [],
    block_reason: "oracle_both_stale",
  };
}

let app: FastifyInstance;

beforeEach(async () => {
  // 2026-10-13: blockhash 差し替えは auto-mock だと undefined を返すので素通しにする (差し替え自体は tx-status.test.ts)
  (refreshUnsignedTxBlockhash as jest.MockedFunction<typeof refreshUnsignedTxBlockhash>).mockImplementation(
    async (txBase64, lastValidBlockHeight) => ({ txBase64, lastValidBlockHeight, refreshed: false })
  );
  jest.clearAllMocks();
  // B3: routes は getOracleResults (batch) を使う — 既存の getOracleResult stub から組み立てる
  (getOracleResults as jest.Mock).mockImplementation(async (mints: string[]) =>
    new Map(await Promise.all(mints.map(async (m) => [m, await getOracleResult(m)] as const)))
  );
  mockOracle.mockResolvedValue(okOracle());
  mockSolValues.mockResolvedValue(new Map([["jitoSOL", JITO_SOL_VALUE]]));
  // 8.80: 既定は潤沢な残高 (gate を通す)。不足系は専用 describe で上書き
  mockBalance.mockResolvedValue(1_000_000_000_000_000n);
  mockQuote.mockImplementation(async (params) => ({
    inputMint: params.inputMint,
    outputMint: params.outputMint,
    inAmount: params.amount,
    // 8.72: 既定は **fair な quote**。ガードそのものは専用の describe で検証する
    outAmount: fairOut(params.amount, params.inputMint),
    otherAmountThreshold: "990",
    swapMode: "ExactIn",
    slippageBps: params.slippageBps ?? 50,
    priceImpactPct: "0",
    routePlan: [],
  }));
  mockTx.mockResolvedValue({
    swapTransaction: "BASE64_VTX",
    lastValidBlockHeight: 1234,
  });
  app = await buildServer({ logger: false });
});

afterEach(async () => {
  await app.close();
});

async function post(url: string, body: Record<string, unknown>) {
  return app.inject({ method: "POST", url, payload: body });
}

// 既知の jito market (SOL → jitoSOL) を fixture 代わりに使う
const jito = findMarketByShareMint(
  "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn"
)!;

describe("POST /protocols/swap-earn/deposit-tx", () => {
  it("既知 shareMint を解決し underlying→share でルートする", async () => {
    const res = await post("/protocols/swap-earn/deposit-tx", {
      user: VALID_USER,
      shareMint: jito.share_mint,
      amount: "1000000000",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.swapTransaction).toBe("BASE64_VTX");
    expect(body.outputMint).toBe(jito.share_mint);
    // input=underlying(SOL), output=share(jitoSOL)
    expect(mockQuote).toHaveBeenCalledWith(
      expect.objectContaining({
        inputMint: jito.underlying_mint,
        outputMint: jito.share_mint,
        amount: "1000000000",
      })
    );
    // oracle gate は underlying(SOL) に掛かる
    expect(mockOracle).toHaveBeenCalledWith(jito.underlying_mint);
  });

  it("oracle blocked → 409 + oracle_blocked、swap は呼ばない", async () => {
    mockOracle.mockResolvedValue(blockedOracle());
    const res = await post("/protocols/swap-earn/deposit-tx", {
      user: VALID_USER,
      shareMint: jito.share_mint,
      amount: "1000000000",
    });
    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.error).toBe("oracle_blocked");
    expect(body.block_reason).toBe("oracle_both_stale");
    expect(mockQuote).not.toHaveBeenCalled();
    expect(mockTx).not.toHaveBeenCalled();
  });

  it("未知 shareMint → 400 + unsupported_share_mint", async () => {
    const res = await post("/protocols/swap-earn/deposit-tx", {
      user: VALID_USER,
      shareMint: "NotARealShareMint1111111111111111111111111",
      amount: "1000000000",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("unsupported_share_mint");
    expect(mockOracle).not.toHaveBeenCalled();
  });

  it("欠損 field → 400 + missing_required_field", async () => {
    const res = await post("/protocols/swap-earn/deposit-tx", {
      user: VALID_USER,
      shareMint: jito.share_mint,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("missing_required_field");
  });

  it("不正 wallet → 400 + invalid_wallet_address", async () => {
    const res = await post("/protocols/swap-earn/deposit-tx", {
      user: "too short",
      shareMint: jito.share_mint,
      amount: "1000000000",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_wallet_address");
  });
});

describe("8.37 (B3): §4.5 amount 境界検証 (swap-earn family)", () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["/protocols/swap-earn/deposit-tx", { user: "", shareMint: "" }],
    ["/protocols/swap-earn/withdraw-tx", { user: "", shareMint: "" }],
    ["/protocols/jupiter-lend/deposit-tx", { user: "", inputMint: "" }],
    ["/protocols/jupiter-lend/withdraw-tx", { user: "", shareMint: "" }],
  ];
  const jlUsdcMint = "9BEcn9aPEmhSPbPQeFGjidRiEKki46fVQDyPpSQXPA2D"; // jlUSDC (registry 値)
  for (const [url] of cases) {
    it(`${url}: 不正 amount ("1.5") は 400 invalid_amount`, async () => {
      const body: Record<string, unknown> = {
        user: VALID_USER,
        amount: "1.5", // 小数 — smallest-unit string 規約違反
        shareMint: jito.share_mint,
        inputMint: jito.underlying_mint,
        jlMint: jlUsdcMint, // jupiter-lend/withdraw-tx は jl mint 解決が先
      };
      const res = await post(url, body);
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("invalid_amount");
      expect(mockQuote).not.toHaveBeenCalled(); // Jupiter へ素通ししない
    });
  }

  it("負数 / 指数表記も 400 (deposit-tx 代表)", async () => {
    for (const bad of ["-100", "1e6", ""]) {
      const res = await post("/protocols/swap-earn/deposit-tx", {
        user: VALID_USER,
        shareMint: jito.share_mint,
        amount: bad,
      });
      expect(res.statusCode).toBe(400);
    }
  });
});

describe("POST /protocols/swap-earn/withdraw-tx", () => {
  it("既知 shareMint を解決し share→underlying でルートする", async () => {
    const res = await post("/protocols/swap-earn/withdraw-tx", {
      user: VALID_USER,
      shareMint: jito.share_mint,
      amount: "500000000",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.outputMint).toBe(jito.underlying_mint);
    expect(mockQuote).toHaveBeenCalledWith(
      expect.objectContaining({
        inputMint: jito.share_mint,
        outputMint: jito.underlying_mint,
        amount: "500000000",
      })
    );
    // withdraw も oracle gate は underlying に掛かる
    expect(mockOracle).toHaveBeenCalledWith(jito.underlying_mint);
  });

  it("oracle blocked → 409", async () => {
    mockOracle.mockResolvedValue(blockedOracle());
    const res = await post("/protocols/swap-earn/withdraw-tx", {
      user: VALID_USER,
      shareMint: jito.share_mint,
      amount: "500000000",
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("oracle_blocked");
  });

  it("未知 shareMint → 400", async () => {
    const res = await post("/protocols/swap-earn/withdraw-tx", {
      user: VALID_USER,
      shareMint: "NotARealShareMint1111111111111111111111111",
      amount: "500000000",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("unsupported_share_mint");
  });
});

describe("jupiter-lend endpoint back-compat (helper 経由 refactor 後)", () => {
  const jlUsdc = SWAP_EARN_MARKETS.find(
    (m) => m.protocol_id === "jupiter_lend" && m.underlying_symbol === "USDC"
  )!;

  it("deposit-tx: inputMint(USDC) → jlUSDC、従来 shape を維持", async () => {
    const res = await post("/protocols/jupiter-lend/deposit-tx", {
      user: VALID_USER,
      inputMint: jlUsdc.underlying_mint,
      amount: "1500000",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.outputMint).toBe(jlUsdc.share_mint);
    expect(body.swapTransaction).toBe("BASE64_VTX");
    expect(mockQuote).toHaveBeenCalledWith(
      expect.objectContaining({
        inputMint: jlUsdc.underlying_mint,
        outputMint: jlUsdc.share_mint,
      })
    );
  });

  it("withdraw-tx: jlMint(jlUSDC) → USDC underlying", async () => {
    const res = await post("/protocols/jupiter-lend/withdraw-tx", {
      user: VALID_USER,
      jlMint: jlUsdc.share_mint,
      amount: "1500000",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().outputMint).toBe(jlUsdc.underlying_mint);
  });

  it("deposit-tx: 未対応 inputMint → 400 unsupported_input_mint", async () => {
    const res = await post("/protocols/jupiter-lend/deposit-tx", {
      user: VALID_USER,
      inputMint: "NotARegisteredUnderlying111111111111111111",
      amount: "1500000",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("unsupported_input_mint");
  });
});

describe("Phase 8.72 — 償還価値ガード (LST の NAV から不利方向に外れた quote)", () => {
  /** 参照レートを持たない market の代表 (jlUSDC) */
  const noRefMarket = SWAP_EARN_MARKETS.find(
    (m) => m.protocol_id === "jupiter_lend" && m.underlying_symbol === "USDC"
  )!;

  /** 既定の fair な quote を上書きして、任意の受取量を返させる */
  function quoteReturning(outAmount: string) {
    mockQuote.mockImplementation(async (params) => ({
      inputMint: params.inputMint,
      outputMint: params.outputMint,
      inAmount: params.amount,
      outAmount,
      otherAmountThreshold: outAmount,
      swapMode: "ExactIn",
      slippageBps: params.slippageBps ?? 50,
      priceImpactPct: "0",
      routePlan: [],
    }));
  }

  it("受取が NAV より不利に外れた deposit は 409 + tx を組まない", async () => {
    // fair は 1e9 → 833333333。既定 200bps を明確に超える 10% 少ない受取
    quoteReturning("750000000");
    const res = await post("/protocols/swap-earn/deposit-tx", {
      user: VALID_USER,
      shareMint: jito.share_mint,
      amount: "1000000000",
    });
    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.error).toBe("fair_value_blocked");
    expect(body.reason).toBe("fair_value_deviation");
    expect(body.deviation_bps).toBeGreaterThan(900);
    expect(body.guard_bps).toBe(200);
    // 8.74: 生 code ではなく人が読める文章も返す (machine-readable は維持)
    expect(body.message).toContain("jitoSOL");
    expect(body.message).toContain("Stopped before signing");
    // 署名前に止める = swap tx を組ませない
    expect(mockTx).not.toHaveBeenCalled();
  });

  it("ユーザー有利方向 (受取が多い) は通す", async () => {
    quoteReturning("900000000"); // fair 833333333 より多い
    const res = await post("/protocols/swap-earn/deposit-tx", {
      user: VALID_USER,
      shareMint: jito.share_mint,
      amount: "1000000000",
    });
    expect(res.statusCode).toBe(200);
    expect(mockTx).toHaveBeenCalled();
  });

  it("Sanctum が落ちても通さない (fail-closed)", async () => {
    mockSolValues.mockRejectedValue(new Error("lst rate source down"));
    const res = await post("/protocols/swap-earn/deposit-tx", {
      user: VALID_USER,
      shareMint: jito.share_mint,
      amount: "1000000000",
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().reason).toBe("fair_value_unavailable");
    expect(res.json().message).toContain("Stopped before signing");
    expect(mockTx).not.toHaveBeenCalled();
  });

  it("参照を持たない market (jlUSDC) はガードを通さず素通り", async () => {
    // LST の fair からは大きく外れた値でも、参照が無いので判定対象外
    quoteReturning("1");
    mockSolValues.mockRejectedValue(new Error("lst rate source down"));
    const res = await post("/protocols/swap-earn/deposit-tx", {
      user: VALID_USER,
      shareMint: noRefMarket.share_mint,
      amount: "1500000",
    });
    expect(res.statusCode).toBe(200);
    expect(mockTx).toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 8.80: input 残高 gate — 残高ゼロの JupUSD deposit が quote → tx →
// Phantom 警告 → broadcast 0x1789 まで素通りした実例の再発防止。
// gate は「確実に失敗する tx を署名前に止める」UX ガードなので、
// **残高が取れない時 (null) は素通し** (瞬断で誤ブロックしない、8.78 の教訓)。
// ─────────────────────────────────────────────────────────────────────────────

describe("8.80: input 残高 gate", () => {
  const jl = SWAP_EARN_MARKETS.find((m) => m.share_symbol === "jlUSDC")!;

  // 2026-10-13: SOL 0 の Seeker wallet で preflight が "no record of a prior credit" (-32002) になった件
  it("USDC は足りても手数料の SOL がほぼ 0 → 400 insufficient_sol、quote を呼ばない", async () => {
    const WSOL = "So11111111111111111111111111111111111111112";
    mockBalance.mockImplementation(async (_user, mint) => (mint === WSOL ? 0n : 1_000_000_000n));
    const res = await post("/protocols/swap-earn/deposit-tx", { user: VALID_USER, shareMint: jl.share_mint, amount: "100000" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "insufficient_sol", balance: "0", message: expect.stringMatching(/no SOL for the network fee.*Nothing was signed/) });
    expect(mockQuote).not.toHaveBeenCalled();
  });

  it("SOL が閾値以上 / 取得失敗 (null) なら通す", async () => {
    const WSOL = "So11111111111111111111111111111111111111112";
    mockBalance.mockImplementation(async (_user, mint) => (mint === WSOL ? 100_000n : 1_000_000_000n));
    expect((await post("/protocols/swap-earn/deposit-tx", { user: VALID_USER, shareMint: jl.share_mint, amount: "100000" })).statusCode).toBe(200);
    mockBalance.mockImplementation(async (_user, mint) => (mint === WSOL ? null : 1_000_000_000n));
    expect((await post("/protocols/swap-earn/deposit-tx", { user: VALID_USER, shareMint: jl.share_mint, amount: "100000" })).statusCode).toBe(200);
  });

  it("残高不足 → 400 insufficient_balance、quote を呼ばない", async () => {
    mockBalance.mockResolvedValue(0n); // 未保有
    const res = await post("/protocols/swap-earn/deposit-tx", {
      user: VALID_USER,
      shareMint: jl.share_mint,
      amount: "100000", // 0.1 USDC
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe("insufficient_balance");
    expect(body.balance).toBe("0");
    // 人が読める message (8.74 方針)。保有量と必要量の両方が出る
    expect(body.message).toContain("You hold 0 USDC");
    expect(body.message).toContain("0.1");
    expect(mockQuote).not.toHaveBeenCalled();
    expect(mockTx).not.toHaveBeenCalled();
  });

  it("ちょうど同額は通す (境界)", async () => {
    mockBalance.mockResolvedValue(100000n);
    const res = await post("/protocols/swap-earn/deposit-tx", {
      user: VALID_USER,
      shareMint: jl.share_mint,
      amount: "100000",
    });
    expect(res.statusCode).toBe(200);
  });

  it("残高が取れない (null) 時は素通し — UX ガードであり安全ガードではない", async () => {
    mockBalance.mockResolvedValue(null);
    const res = await post("/protocols/swap-earn/deposit-tx", {
      user: VALID_USER,
      shareMint: jl.share_mint,
      amount: "100000",
    });
    expect(res.statusCode).toBe(200);
    expect(mockTx).toHaveBeenCalled();
  });

  it("withdraw は share 残高を見る (share が input)", async () => {
    mockBalance.mockResolvedValue(0n);
    const res = await post("/protocols/swap-earn/withdraw-tx", {
      user: VALID_USER,
      shareMint: jl.share_mint,
      amount: "500000",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("insufficient_balance");
    // input は share なので share symbol で表示される
    expect(res.json().message).toContain("jlUSDC");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2026-10-13: funding token deposit (USDC を払って jlJupUSD を受け取る)。
// oracle は underlying (JupUSD) と funding (USDC) の 2 本、残高は支払う USDC、
// 償還価値は cross-asset (USDC → JupUSD → jlJupUSD)、allowlist 外の inputMint は 400。
// ─────────────────────────────────────────────────────────────────────────────

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDT_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const JUPUSD_MINT = "JuprjznTrTSp2UFa3ZBUFgwdAmtZCq4MQCwysN55USD";
const JLJUPUSD_MINT = "7GxATsNMnaC88vdwd2t3mwrFuQwwGvmYPrUQ4D6FotXk";
const mockMarkets = fetchEarnMarkets as jest.MockedFunction<typeof fetchEarnMarkets>;

function usdOracle(symbol: string, price = "1.00000000"): OracleResult {
  return {
    ...okOracle(symbol),
    price_usd: price,
    pyth: { available: true, price_usd: price, age_seconds: 1 },
    secondary: { source: "redstone", available: true, price_usd: price, age_seconds: 0 },
    divergence_pct: 0,
  };
}

/** null = API が convertToAssets を返さなかった */
function jlJupUsdMarket(convertToAssets: string | null = "1041200"): JupiterLendMarket {
  return {
    jlMint: JLJUPUSD_MINT,
    jlSymbol: "jlJupUSD",
    jlDecimals: 6,
    underlyingMint: JUPUSD_MINT,
    underlyingSymbol: "jupUSD",
    underlyingDecimals: 6,
    underlyingPriceUsd: 1,
    ...(convertToAssets ? { convertToAssets } : {}),
    supplyRateBps: 430,
    rewardsRateBps: 0,
    totalRateBps: 430,
    tvlUnderlying: "49500000000000",
  };
}

describe("2026-10-13: funding token deposit (USDC → jlJupUSD)", () => {
  /** 実測 (2026-10-13): 1 USDC → 0.960781 jlJupUSD */
  let usdcToJl = "960781";
  beforeEach(() => {
    usdcToJl = "960781";
    mockOracle.mockImplementation(async (mint: string) =>
      mint === USDC_MINT ? usdOracle("USDC") : mint === JUPUSD_MINT ? usdOracle("JupUSD") : okOracle()
    );
    mockMarkets.mockResolvedValue([jlJupUsdMarket()]);
    mockQuote.mockImplementation(async (params) => ({
      inputMint: params.inputMint,
      outputMint: params.outputMint,
      inAmount: params.amount,
      outAmount: params.inputMint === USDC_MINT && params.outputMint === JLJUPUSD_MINT ? usdcToJl : "1000000",
      otherAmountThreshold: "955977",
      swapMode: "ExactIn",
      slippageBps: params.slippageBps ?? 50,
      priceImpactPct: "0.0001",
      routePlan: [],
    }));
  });

  const funded = { user: VALID_USER, shareMint: JLJUPUSD_MINT, inputMint: USDC_MINT, amount: "1000000" };

  it("USDC → jlJupUSD を 1 swap で quote し、oracle は JupUSD + USDC の 2 本を gate する", async () => {
    const res = await post("/protocols/swap-earn/deposit-tx", funded);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.swapTransaction).toBe("BASE64_VTX");
    expect(body.inputMint).toBe(USDC_MINT);
    expect(body.outputMint).toBe(JLJUPUSD_MINT);
    expect(body.outAmount).toBe("960781");
    expect(mockQuote).toHaveBeenCalledWith(
      expect.objectContaining({ inputMint: USDC_MINT, outputMint: JLJUPUSD_MINT, amount: "1000000" })
    );
    expect(getOracleResults).toHaveBeenCalledWith([JUPUSD_MINT, USDC_MINT]);
    // cross-asset ガードは Jupiter Lend の convertToAssets を読む (LST の参照は読まない)
    expect(mockMarkets).toHaveBeenCalled();
    expect(mockSolValues).not.toHaveBeenCalled();
  });

  it("USDC の oracle が blocked なら JupUSD が ok でも 409 oracle_blocked (USDC を名指し)", async () => {
    mockOracle.mockImplementation(async (mint: string) =>
      mint === USDC_MINT ? blockedOracle("USDC") : usdOracle("JupUSD")
    );
    const res = await post("/protocols/swap-earn/deposit-tx", funded);
    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.error).toBe("oracle_blocked");
    expect(body.block_reason).toBe("oracle_both_stale");
    expect(body.message).toContain("USDC");
    expect(body.oracle.status).toBe("blocked");
    expect(mockBalance).not.toHaveBeenCalled();
    expect(mockQuote).not.toHaveBeenCalled();
    expect(mockTx).not.toHaveBeenCalled();
  });

  it("JupUSD (underlying) が blocked でも 409", async () => {
    mockOracle.mockImplementation(async (mint: string) =>
      mint === JUPUSD_MINT ? blockedOracle("JupUSD") : usdOracle("USDC")
    );
    const res = await post("/protocols/swap-earn/deposit-tx", funded);
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain("JupUSD");
  });

  it("allowlist 外の inputMint (USDT) → 400 unsupported_input_mint + allowed、何も呼ばない", async () => {
    const res = await post("/protocols/swap-earn/deposit-tx", { ...funded, inputMint: USDT_MINT });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: "unsupported_input_mint",
      message: "jlJupUSD deposits can be paid with JupUSD or USDC",
      inputMint: USDT_MINT,
      allowed: [JUPUSD_MINT, USDC_MINT],
    });
    expect(mockOracle).not.toHaveBeenCalled();
    expect(mockQuote).not.toHaveBeenCalled();
  });

  it("funding を持たない market に別 mint → 400 (underlying だけ)、形式不正の inputMint は echo しない", async () => {
    const res = await post("/protocols/swap-earn/deposit-tx", {
      user: VALID_USER,
      shareMint: jito.share_mint,
      inputMint: USDC_MINT,
      amount: "1000000",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      error: "unsupported_input_mint",
      message: "jitoSOL deposits can be paid with SOL",
      allowed: [jito.underlying_mint],
    });
    const bad = await post("/protocols/swap-earn/deposit-tx", { ...funded, inputMint: "not a mint!" });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe("unsupported_input_mint");
    expect(bad.json()).not.toHaveProperty("inputMint");
  });

  it("残高 gate は支払う USDC を見る (\"You hold 0 USDC\")", async () => {
    mockBalance.mockResolvedValue(0n);
    const res = await post("/protocols/swap-earn/deposit-tx", funded);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("insufficient_balance");
    expect(res.json().message).toContain("You hold 0 USDC");
    expect(mockBalance).toHaveBeenCalledWith(VALID_USER, USDC_MINT);
    expect(mockQuote).not.toHaveBeenCalled();
  });

  it("quote が fair から 2% 超不利 → 409 fair_value_blocked (cross-asset の message)", async () => {
    usdcToJl = "930000"; // fair ≈ 960,430 に対し 3.16% 少ない
    const res = await post("/protocols/swap-earn/deposit-tx", funded);
    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body).toMatchObject({
      error: "fair_value_blocked",
      reason: "fair_value_deviation",
      deviation_bps: 316,
      guard_bps: 200,
    });
    expect(body.message).toBe(
      "Quote is 3.16% below what 1 USDC should buy in jlJupUSD (limit 2.00%). Stopped before signing — this is a routing or liquidity problem, not your amount."
    );
    expect(mockTx).not.toHaveBeenCalled();
  });

  it("Jupiter Lend markets が落ちたら通さない (fair_value_unavailable、fail-closed)", async () => {
    mockMarkets.mockRejectedValue(new Error("lite-api down"));
    const res = await post("/protocols/swap-earn/deposit-tx", funded);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "fair_value_blocked", reason: "fair_value_unavailable" });
    expect(mockTx).not.toHaveBeenCalled();
  });

  it("convertToAssets が無い / funding が not_configured (価格 null) でも通さない", async () => {
    mockMarkets.mockResolvedValue([jlJupUsdMarket(null)]);
    expect((await post("/protocols/swap-earn/deposit-tx", funded)).json().reason).toBe("fair_value_unavailable");
    mockMarkets.mockResolvedValue([jlJupUsdMarket()]);
    mockOracle.mockImplementation(async (mint: string) =>
      mint === USDC_MINT
        ? { ...usdOracle("USDC"), primary: null, price_usd: null, tier: "D", not_configured: true }
        : usdOracle("JupUSD")
    );
    const res = await post("/protocols/swap-earn/deposit-tx", funded);
    expect(res.statusCode).toBe(409);
    expect(res.json().reason).toBe("fair_value_unavailable");
  });

  it("inputMint = underlying (JupUSD) は通常の deposit (oracle 1 本、cross-asset ガード無し)", async () => {
    const res = await post("/protocols/swap-earn/deposit-tx", { ...funded, inputMint: JUPUSD_MINT });
    expect(res.statusCode).toBe(200);
    expect(res.json().inputMint).toBe(JUPUSD_MINT);
    expect(getOracleResults).toHaveBeenCalledWith([JUPUSD_MINT]);
    expect(mockMarkets).not.toHaveBeenCalled();
  });

  it("inputMint 無しの jlUSDC は従来どおり (USDC → jlUSDC、oracle は USDC だけ)", async () => {
    const jl = SWAP_EARN_MARKETS.find((m) => m.share_symbol === "jlUSDC")!;
    const res = await post("/protocols/swap-earn/deposit-tx", {
      user: VALID_USER,
      shareMint: jl.share_mint,
      amount: "1000000",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().inputMint).toBe(USDC_MINT);
    expect(mockQuote).toHaveBeenCalledWith(
      expect.objectContaining({ inputMint: USDC_MINT, outputMint: jl.share_mint })
    );
    expect(getOracleResults).toHaveBeenCalledWith([USDC_MINT]);
    expect(mockMarkets).not.toHaveBeenCalled();
  });
});

describe("2026-10-13: POST /protocols/swap-earn/quote", () => {
  beforeEach(() => {
    mockOracle.mockImplementation(async (mint: string) =>
      mint === USDC_MINT ? usdOracle("USDC") : mint === JUPUSD_MINT ? usdOracle("JupUSD") : okOracle()
    );
    mockMarkets.mockResolvedValue([jlJupUsdMarket()]);
  });

  it("funding deposit の見積り: quote + cross-asset verdict、tx も残高も触らない", async () => {
    mockQuote.mockResolvedValue({
      inputMint: USDC_MINT,
      outputMint: JLJUPUSD_MINT,
      inAmount: "1000000",
      outAmount: "960781",
      otherAmountThreshold: "955977",
      swapMode: "ExactIn",
      slippageBps: 50,
      priceImpactPct: "0.0001",
      routePlan: [],
    });
    const res = await post("/protocols/swap-earn/quote", {
      shareMint: JLJUPUSD_MINT,
      inputMint: USDC_MINT,
      amount: "1000000",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      inputMint: USDC_MINT,
      outputMint: JLJUPUSD_MINT,
      inAmount: "1000000",
      outAmount: "960781",
      minOut: "955977",
      priceImpactPct: "0.0001",
      slippageBps: 50,
      fairValue: { status: "ok", deviation_bps: -3 },
    });
    expect(mockQuote).toHaveBeenCalledWith(
      expect.objectContaining({ inputMint: USDC_MINT, outputMint: JLJUPUSD_MINT, slippageBps: 50 })
    );
    expect(getOracleResults).toHaveBeenCalledWith([JUPUSD_MINT, USDC_MINT]);
    expect(mockTx).not.toHaveBeenCalled();
    expect(mockBalance).not.toHaveBeenCalled();
  });

  it("不利な funding quote は blocked verdict を返すが 200 (止めるのは deposit-tx)", async () => {
    mockQuote.mockResolvedValue({
      inputMint: USDC_MINT,
      outputMint: JLJUPUSD_MINT,
      inAmount: "1000000",
      outAmount: "930000",
      otherAmountThreshold: "925350",
      swapMode: "ExactIn",
      slippageBps: 50,
      priceImpactPct: "0.03",
      routePlan: [],
    });
    const res = await post("/protocols/swap-earn/quote", {
      shareMint: JLJUPUSD_MINT,
      inputMint: USDC_MINT,
      amount: "1000000",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().fairValue).toEqual({
      status: "blocked",
      reason: "fair_value_deviation",
      deviation_bps: 316,
    });
  });

  it("参照を持たない market (jlUSDC) は no_reference、oracle も引かない", async () => {
    const jl = SWAP_EARN_MARKETS.find((m) => m.share_symbol === "jlUSDC")!;
    const res = await post("/protocols/swap-earn/quote", { shareMint: jl.share_mint, amount: "1000000", slippageBps: 30 });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ inputMint: USDC_MINT, slippageBps: 30, fairValue: { status: "no_reference" } });
    expect(getOracleResults).not.toHaveBeenCalled();
  });

  it("LST (jitoSOL) は 8.72 の NAV ガードで判定する", async () => {
    const res = await post("/protocols/swap-earn/quote", { shareMint: jito.share_mint, amount: "1000000000" });
    expect(res.statusCode).toBe(200);
    expect(res.json().fairValue.status).toBe("ok");
    expect(mockSolValues).toHaveBeenCalled();
  });

  it("入力検証: 欠損 / 不正 amount / 未知 shareMint / allowlist 外 inputMint", async () => {
    expect((await post("/protocols/swap-earn/quote", { shareMint: JLJUPUSD_MINT })).json().error).toBe(
      "missing_required_field"
    );
    expect((await post("/protocols/swap-earn/quote", { shareMint: JLJUPUSD_MINT, amount: "1.5" })).json().error).toBe(
      "invalid_amount"
    );
    expect((await post("/protocols/swap-earn/quote", { shareMint: JLJUPUSD_MINT, amount: "0" })).json().error).toBe(
      "invalid_amount"
    );
    expect(
      (await post("/protocols/swap-earn/quote", { shareMint: VALID_USER, amount: "1" })).json().error
    ).toBe("unsupported_share_mint");
    const bad = await post("/protocols/swap-earn/quote", {
      shareMint: JLJUPUSD_MINT,
      inputMint: USDT_MINT,
      amount: "1",
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ error: "unsupported_input_mint", allowed: [JUPUSD_MINT, USDC_MINT] });
    expect(
      (await post("/protocols/swap-earn/quote", { shareMint: JLJUPUSD_MINT, amount: "1", slippageBps: 1.5 })).json()
        .error
    ).toBe("invalid_slippage_bps");
    expect(mockQuote).not.toHaveBeenCalled();
  });

  it("#49 review: 交換レート (earn/tokens) は quote の完了を待たずに取りに行く (deposit-tx / quote 両方)", async () => {
    for (const url of ["/protocols/swap-earn/quote", "/protocols/swap-earn/deposit-tx"]) {
      mockMarkets.mockClear();
      let resolveQuote: ((q: Awaited<ReturnType<typeof fetchSwapQuote>>) => void) | undefined;
      mockQuote.mockImplementation(
        () => new Promise((resolve) => { resolveQuote = resolve; })
      );
      const resP = post(url, { user: VALID_USER, shareMint: JLJUPUSD_MINT, inputMint: USDC_MINT, amount: "1000000" });
      for (let i = 0; i < 50 && !resolveQuote; i++) await new Promise((r) => setImmediate(r));
      // quote はまだ pending — それでも markets は既に取りに行っている
      expect(resolveQuote).toBeDefined();
      expect(mockMarkets).toHaveBeenCalledTimes(1);
      resolveQuote!({
        inputMint: USDC_MINT,
        outputMint: JLJUPUSD_MINT,
        inAmount: "1000000",
        outAmount: "960781",
        otherAmountThreshold: "955977",
        swapMode: "ExactIn",
        slippageBps: 50,
        priceImpactPct: "0.0001",
        routePlan: [],
      });
      const res = await resP;
      expect(res.statusCode).toBe(200);
      if (url.endsWith("/quote")) expect(res.json().fairValue).toEqual({ status: "ok", deviation_bps: -3 });
      else expect(res.json().outAmount).toBe("960781");
      expect(mockMarkets).toHaveBeenCalledTimes(1);
    }
  });

  it("Jupiter quote 失敗 → 502 jupiter_swap_failed", async () => {
    mockQuote.mockRejectedValue(new Error("boom"));
    const res = await post("/protocols/swap-earn/quote", { shareMint: JLJUPUSD_MINT, amount: "1000000" });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe("jupiter_swap_failed");
  });

  it("plans-only サーバ (SOLANA_EXECUTION_TARGET=disabled) でも quote は 409 にならない (read-only)", async () => {
    const prev = process.env.SOLANA_EXECUTION_TARGET;
    process.env.SOLANA_EXECUTION_TARGET = "disabled";
    const plansOnly = await buildServer({ logger: false, rateLimit: false });
    try {
      const q = await plansOnly.inject({
        method: "POST",
        url: "/protocols/swap-earn/quote",
        payload: { shareMint: JLJUPUSD_MINT, amount: "1000000" },
      });
      expect(q.statusCode).toBe(200);
      const tx = await plansOnly.inject({
        method: "POST",
        url: "/protocols/swap-earn/deposit-tx",
        payload: { user: VALID_USER, shareMint: JLJUPUSD_MINT, amount: "1000000" },
      });
      expect(tx.statusCode).toBe(409);
    } finally {
      await plansOnly.close();
      if (prev === undefined) delete process.env.SOLANA_EXECUTION_TARGET;
      else process.env.SOLANA_EXECUTION_TARGET = prev;
    }
  });
});
