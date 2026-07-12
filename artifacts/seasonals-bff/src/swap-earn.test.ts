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

jest.mock("./clients/jupiter-swap");
jest.mock("./clients/oracle");

const mockQuote = fetchSwapQuote as jest.MockedFunction<typeof fetchSwapQuote>;
const mockTx = fetchSwapTransaction as jest.MockedFunction<
  typeof fetchSwapTransaction
>;
const mockOracle = getOracleResult as jest.MockedFunction<
  typeof getOracleResult
>;

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
  mockQuote.mockImplementation(async (params) => ({
    inputMint: params.inputMint,
    outputMint: params.outputMint,
    inAmount: params.amount,
    outAmount: "999",
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
