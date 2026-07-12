/**
 * Phase 8.15e: Drift spot endpoint のテスト。
 *
 * drift-tx client と oracle を mock し、(1) positionKey → market 解決、(2) amount
 * passthrough (§4.5 smallest-unit、変換なし)、(3) oracle fail-closed gate、
 * (4) 未知 market / 欠損 field / 不正 amount の 400、(5) 保有 mapper を検証する。
 * 実 SDK / network は呼ばない (drift-tx は lazy-require なので mock で SDK 自体 load されない)。
 */
import type { FastifyInstance } from "fastify";

import { DRIFT_MARKETS } from "@workspace/lib/config/drift-markets";
import type { OracleResult } from "@workspace/lib/types";

import { buildServer, mapDriftHoldingsToEarnPositions } from "./server";
import {
  buildDriftDepositTx,
  buildDriftWithdrawTx,
  fetchDriftSpotPositions,
} from "./clients/drift-tx";
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
import {
  fetchMeteoraPoolStats,
  fetchMeteoraPositions,
} from "./clients/meteora-tx";
import { fetchOrcaPoolStats, fetchOrcaPositions } from "./clients/orca-tx";
import { fetchAssetsByOwner } from "./clients/helius";
import { fetchEarnPositions } from "./clients/jupiter-lend";
import { fetchEnhancedTransactions } from "./clients/helius-tx";
import { getOracleResult } from "./clients/oracle";

jest.mock("./clients/drift-tx");
jest.mock("./clients/oracle");
// /positions/earn が実 network を掴まないよう全 client を mock (並列 worker の timeout 防止)
jest.mock("./clients/kamino-tx");
jest.mock("./clients/save-tx");
jest.mock("./clients/rates");
jest.mock("./clients/helius");
jest.mock("./clients/jupiter-lend");
jest.mock("./clients/helius-tx");
jest.mock("./clients/meteora-tx", () => ({
  ...jest.requireActual("./clients/meteora-tx"),
  fetchMeteoraPositions: jest.fn(),
  fetchMeteoraPoolStats: jest.fn(),
}));
jest.mock("./clients/orca-tx", () => ({
  ...jest.requireActual("./clients/orca-tx"),
  fetchOrcaPositions: jest.fn(),
  fetchOrcaPoolStats: jest.fn(),
}));

const mockDeposit = buildDriftDepositTx as jest.MockedFunction<
  typeof buildDriftDepositTx
>;
const mockWithdraw = buildDriftWithdrawTx as jest.MockedFunction<
  typeof buildDriftWithdrawTx
>;
const mockPositions = fetchDriftSpotPositions as jest.MockedFunction<
  typeof fetchDriftSpotPositions
>;
const mockOracle = getOracleResult as jest.MockedFunction<
  typeof getOracleResult
>;

const VALID_USER = "8sN5e1Qm9bYz2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r";
const USDC = DRIFT_MARKETS.find((m) => m.underlying_symbol === "USDC")!;
const SOL = DRIFT_MARKETS.find((m) => m.underlying_symbol === "SOL")!;

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
  mockDeposit.mockResolvedValue({ transaction: "DRIFT_DEP_TX", firstDeposit: false });
  mockWithdraw.mockResolvedValue({ transaction: "DRIFT_WD_TX", firstDeposit: false });
  mockPositions.mockResolvedValue([]);
  // .catch/.then が直接付く client の resolved default
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
  (fetchMeteoraPositions as jest.MockedFunction<typeof fetchMeteoraPositions>)
    .mockResolvedValue([]);
  (fetchOrcaPositions as jest.MockedFunction<typeof fetchOrcaPositions>)
    .mockResolvedValue([]);
  (fetchOrcaPoolStats as jest.MockedFunction<typeof fetchOrcaPoolStats>)
    .mockResolvedValue(new Map());
  // 実 network 時代の「fetch 失敗 → degrade」挙動を再現 (rejected で allSettled に流す)
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

describe("POST /protocols/drift/deposit-tx", () => {
  it("positionKey を解決し amount を smallest のまま client へ", async () => {
    mockDeposit.mockResolvedValue({ transaction: "DRIFT_DEP_TX", firstDeposit: true });
    const res = await post("/protocols/drift/deposit-tx", {
      user: VALID_USER,
      positionKey: USDC.position_key,
      amount: "1000000",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.transaction).toBe("DRIFT_DEP_TX");
    expect(body.firstDeposit).toBe(true);
    expect(body.positionKey).toBe(USDC.position_key);
    expect(mockDeposit).toHaveBeenCalledWith({
      wallet: VALID_USER,
      market: expect.objectContaining({ market_index: 0 }),
      amountSmallest: "1000000", // passthrough (変換しない)
    });
    expect(mockOracle).toHaveBeenCalledWith(USDC.underlying_mint);
  });

  it("oracle blocked → 409、client は呼ばない", async () => {
    mockOracle.mockResolvedValue({
      ...okOracle(),
      status: "blocked",
      block_reason: "oracle_both_stale",
    });
    const res = await post("/protocols/drift/deposit-tx", {
      user: VALID_USER,
      positionKey: SOL.position_key,
      amount: "1000000000",
    });
    expect(res.statusCode).toBe(409);
    expect(mockDeposit).not.toHaveBeenCalled();
  });

  it("未知 positionKey → 400 unsupported_market", async () => {
    const res = await post("/protocols/drift/deposit-tx", {
      user: VALID_USER,
      positionKey: "drift_spot_99",
      amount: "1",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("unsupported_market");
  });

  it("不正 amount / 欠損 field → 400", async () => {
    const bad = await post("/protocols/drift/deposit-tx", {
      user: VALID_USER,
      positionKey: USDC.position_key,
      amount: "1.5",
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe("invalid_amount");
    const missing = await post("/protocols/drift/deposit-tx", {
      user: VALID_USER,
      amount: "1",
    });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error).toBe("missing_required_field");
  });
});

describe("POST /protocols/drift/withdraw-tx", () => {
  it("SOL market を解決し withdraw client (reduceOnly は client 側固定) を呼ぶ", async () => {
    const res = await post("/protocols/drift/withdraw-tx", {
      user: VALID_USER,
      positionKey: SOL.position_key,
      amount: "500000000",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().transaction).toBe("DRIFT_WD_TX");
    expect(mockWithdraw).toHaveBeenCalledWith({
      wallet: VALID_USER,
      market: expect.objectContaining({ market_index: 1 }),
      amountSmallest: "500000000",
    });
    expect(mockOracle).toHaveBeenCalledWith(SOL.underlying_mint);
  });
});

describe("mapDriftHoldingsToEarnPositions", () => {
  const prices = new Map([
    ["EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", 1_00000000n],
    ["So11111111111111111111111111111111111111112", 77_73929138n],
  ]);

  it("保有 → EarnPosition (position_key = share_mint、oracle USD)", () => {
    const out = mapDriftHoldingsToEarnPositions(
      [{ market_index: 0, token_amount: "2500000", supply_apy: 0.054 }],
      prices
    );
    expect(out).toHaveLength(1);
    const p = out[0]!;
    expect(p.protocol_id).toBe("drift");
    expect(p.share_mint).toBe("drift_spot_0");
    expect(p.underlying_amount).toBe("2500000");
    expect(p.asset_symbol).toBe("USDC");
    expect(p.underlying_usd).toBe("2.50000000");
    expect(p.supply_rate_bps).toBe(540);
    expect(p.accrued_yield_sign).toBe("unknown");
  });

  it("未登録 market / 0 残高 / price 不明は除外・degrade", () => {
    const out = mapDriftHoldingsToEarnPositions(
      [
        { market_index: 99, token_amount: "5", supply_apy: null },
        { market_index: 0, token_amount: "0", supply_apy: null },
        { market_index: 1, token_amount: "1000000000", supply_apy: null },
      ],
      new Map()
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.share_mint).toBe("drift_spot_1");
    expect(out[0]!.underlying_usd).toBe("0");
    expect(out[0]!.supply_rate_bps).toBeNull();
  });
});

describe("/positions/earn に drift 配列", () => {
  it("drift 保有が response に載る", async () => {
    mockPositions.mockResolvedValue([
      { market_index: 0, token_amount: "2500000", supply_apy: 0.05 },
    ]);
    const res = await app.inject({
      method: "GET",
      url: `/positions/earn?wallet=${VALID_USER}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.drift)).toBe(true);
    expect(body.drift).toHaveLength(1);
    expect(body.drift[0].share_mint).toBe("drift_spot_0");
  });
});
