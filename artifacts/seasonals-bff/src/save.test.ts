/**
 * Phase 8.15c: Save (旧 Solend) endpoint のテスト。
 *
 * solend-sdk client と oracle を mock し、(1) reserve / cToken → market 解決、
 * (2) amount passthrough (§4.5 smallest-unit、変換なし)、(3) oracle fail-closed gate、
 * (4) 未知 reserve/ctoken / 欠損 field / 不正 amount の 400、(5) transactions 配列の
 * 返却を検証する。実ネットワーク / 実 SDK は呼ばない。
 */
import type { FastifyInstance } from "fastify";

import { SAVE_MARKETS } from "@workspace/lib/config/save-markets";
import type { OracleResult } from "@workspace/lib/types";

import { buildServer } from "./server";
import {
  buildSaveDepositTxns,
  buildSaveWithdrawTxns,
  fetchSaveReserveRates,
} from "./clients/save-tx";
import { getOracleResult } from "./clients/oracle";

jest.mock("./clients/save-tx");
jest.mock("./clients/oracle");

const mockDeposit = buildSaveDepositTxns as jest.MockedFunction<
  typeof buildSaveDepositTxns
>;
const mockWithdraw = buildSaveWithdrawTxns as jest.MockedFunction<
  typeof buildSaveWithdrawTxns
>;
const mockRates = fetchSaveReserveRates as jest.MockedFunction<
  typeof fetchSaveReserveRates
>;
const mockOracle = getOracleResult as jest.MockedFunction<
  typeof getOracleResult
>;

const VALID_USER = "8sN5e1Qm9bYz2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r";
const USDC = SAVE_MARKETS.find((m) => m.underlying_symbol === "USDC")!;
const SOL = SAVE_MARKETS.find((m) => m.underlying_symbol === "SOL")!;

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

let app: FastifyInstance;

beforeEach(async () => {
  jest.clearAllMocks();
  mockOracle.mockResolvedValue(okOracle());
  mockDeposit.mockResolvedValue({ transactions: ["SAVE_DEP_TX1", "SAVE_DEP_TX2"] });
  mockWithdraw.mockResolvedValue({ transactions: ["SAVE_WD_TX"] });
  mockRates.mockResolvedValue([]);
  app = await buildServer({ logger: false });
});
afterEach(async () => {
  await app.close();
});

async function post(url: string, body: Record<string, unknown>) {
  return app.inject({ method: "POST", url, payload: body });
}

describe("POST /protocols/save/deposit-tx", () => {
  it("USDC reserve を解決し amount を smallest-unit のまま SDK client へ", async () => {
    const res = await post("/protocols/save/deposit-tx", {
      user: VALID_USER,
      reserve: USDC.reserve,
      amount: "1500000",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.transactions).toEqual(["SAVE_DEP_TX1", "SAVE_DEP_TX2"]);
    expect(body.ctokenMint).toBe(USDC.ctoken_mint);
    expect(mockDeposit).toHaveBeenCalledWith({
      wallet: VALID_USER,
      market: expect.objectContaining({ reserve: USDC.reserve }),
      amount: "1500000", // passthrough — human 変換しない (Kamino と異なる)
    });
    expect(mockOracle).toHaveBeenCalledWith(USDC.underlying_mint);
  });

  it("oracle blocked → 409、SDK は呼ばない", async () => {
    mockOracle.mockResolvedValue({
      ...okOracle(),
      status: "blocked",
      block_reason: "oracle_both_stale",
    });
    const res = await post("/protocols/save/deposit-tx", {
      user: VALID_USER,
      reserve: SOL.reserve,
      amount: "1000000000",
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("oracle_blocked");
    expect(mockDeposit).not.toHaveBeenCalled();
  });

  it("未知 reserve → 400 unsupported_reserve", async () => {
    const res = await post("/protocols/save/deposit-tx", {
      user: VALID_USER,
      reserve: "NotARegisteredReserve11111111111111111111",
      amount: "1500000",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("unsupported_reserve");
  });

  it("不正 amount (小数) → 400 invalid_amount", async () => {
    const res = await post("/protocols/save/deposit-tx", {
      user: VALID_USER,
      reserve: USDC.reserve,
      amount: "1.5",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_amount");
  });

  it("欠損 field → 400", async () => {
    const res = await post("/protocols/save/deposit-tx", {
      user: VALID_USER,
      amount: "1500000",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("missing_required_field");
  });
});

describe("POST /protocols/save/withdraw-tx", () => {
  it("cToken mint を解決し redeem txns を返す", async () => {
    const res = await post("/protocols/save/withdraw-tx", {
      user: VALID_USER,
      ctokenMint: SOL.ctoken_mint,
      amount: "500000000",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().transactions).toEqual(["SAVE_WD_TX"]);
    expect(mockWithdraw).toHaveBeenCalledWith({
      wallet: VALID_USER,
      market: expect.objectContaining({ ctoken_mint: SOL.ctoken_mint }),
      amount: "500000000",
    });
    // oracle gate は underlying (SOL)
    expect(mockOracle).toHaveBeenCalledWith(SOL.underlying_mint);
  });

  it("未知 cToken → 400 unsupported_ctoken", async () => {
    const res = await post("/protocols/save/withdraw-tx", {
      user: VALID_USER,
      ctokenMint: "NotACToken111111111111111111111111111111",
      amount: "1",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("unsupported_ctoken");
  });
});

describe("GET /protocols/save/reserves", () => {
  it("rates を registry の asset にひも付けて返す", async () => {
    mockRates.mockResolvedValue([
      { reserve: USDC.reserve, supply_apy: 0.0203, ctoken_exchange_rate: "1.3008" },
      { reserve: SOL.reserve, supply_apy: 0.0269, ctoken_exchange_rate: "1.1859" },
    ]);
    const res = await app.inject({ method: "GET", url: "/protocols/save/reserves" });
    expect(res.statusCode).toBe(200);
    const { reserves } = res.json();
    expect(reserves).toHaveLength(2);
    expect(reserves[0]).toEqual({
      reserve_id: USDC.reserve,
      asset_symbol: "USDC",
      lend_apy: 0.0203,
      ctoken_exchange_rate: "1.3008",
    });
  });

  it("8.95: REST 失敗時は 503 (200-空で client キャッシュを上書きしない)", async () => {
    mockRates.mockRejectedValue(new Error("boom"));
    const res = await app.inject({ method: "GET", url: "/protocols/save/reserves" });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe("save_reserves_unavailable");
  });
});
