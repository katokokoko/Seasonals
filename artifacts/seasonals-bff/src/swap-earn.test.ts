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
import { getOracleResult } from "./clients/oracle";
import { fetchLstSolValues } from "./clients/lst-rates";

jest.mock("./clients/jupiter-swap");
jest.mock("./clients/oracle");
// 8.72/8.73: 償還価値ガードの参照レート (protocol 実データ)。実ネットワークは叩かない
jest.mock("./clients/lst-rates");

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

const VALID_USER = "8sN5e1Qm9bYz2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r";

function okOracle(symbol = "SOL"): OracleResult {
  return {
    asset_symbol: symbol,
    status: "ok",
    primary: "pyth",
    price_usd: "150.00000000",
    pyth: { available: true, price_usd: "150.00000000", age_seconds: 1 },
    switchboard: { available: true, price_usd: "150.10000000", age_seconds: 0 },
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
    switchboard: { available: false, price_usd: null, age_seconds: null },
    divergence_pct: null,
    warnings: [],
    block_reason: "oracle_both_stale",
  };
}

let app: FastifyInstance;

beforeEach(async () => {
  jest.clearAllMocks();
  mockOracle.mockResolvedValue(okOracle());
  mockSolValues.mockResolvedValue(new Map([["jitoSOL", JITO_SOL_VALUE]]));
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
