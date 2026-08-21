/**
 * Phase 8.95: soft-fail 棚卸し — 上流失敗を 200-空で隠さない。
 *
 * 8.93 で mobile はエラー時にキャッシュ保持 + 自動再試行するようになったので、
 * BFF は「incidental な catch → 空」を 503 で返す。意図的 degrade
 * (/menu-listings の fixture overlay、/oracle/status の fail-closed、
 * /time-events/wallet の部分結果、/prices の blocked drop) は 200 のまま —
 * それらは menu.test / oracle-gate.test が固定している。
 *
 * kamino reserves の no-adapter 503 分岐は registry に mock adapter が常駐する
 * test 環境では到達不能 (防御的分岐) のためここでは検証しない。
 */
import type { FastifyInstance } from "fastify";

import type { OracleResult } from "@workspace/lib/types";

import { buildServer } from "./server";
import {
  fetchMeteoraPoolStats,
  fetchMeteoraPositions,
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
import { fetchEarnMarkets, fetchEarnPositions } from "./clients/jupiter-lend";
import { fetchEnhancedTransactions } from "./clients/helius-tx";
import { getOracleResult, oracleMintForSymbol } from "./clients/oracle";

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
jest.mock("./clients/oracle");
jest.mock("./clients/kamino-tx");
jest.mock("./clients/save-tx");
jest.mock("./clients/rates");
jest.mock("./clients/helius");
jest.mock("./clients/jupiter-lend");
jest.mock("./clients/helius-tx");

const WALLET = "8sN5e1Qm9bYz2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r";
const MAIN_UPSTREAMS = [
  fetchEarnPositions,
  fetchAssetsByOwner,
  fetchEnhancedTransactions,
  fetchKaminoObligations,
  fetchKaminoReserveMetrics,
] as const;

function okOracle(): OracleResult {
  return {
    asset_symbol: "SOL",
    status: "ok",
    primary: "pyth",
    price_usd: "90.00000000",
    pyth: { available: true, price_usd: "90.00000000", age_seconds: 1 },
    switchboard: { available: false, price_usd: null, age_seconds: null },
    divergence_pct: null,
    warnings: [],
    block_reason: null,
  };
}

let app: FastifyInstance;

beforeEach(async () => {
  jest.clearAllMocks();
  // .then/.catch が直接付く client は resolved default が必須 (automock は undefined)
  (fetchMeteoraPositions as jest.Mock).mockResolvedValue([]);
  (fetchMeteoraPoolStats as jest.Mock).mockResolvedValue(new Map());
  (fetchOrcaPositions as jest.Mock).mockResolvedValue([]);
  (fetchOrcaPoolStats as jest.Mock).mockResolvedValue(new Map());
  (fetchKaminoVaultUserPositions as jest.Mock).mockResolvedValue([]);
  (fetchKaminoVaultMetrics as jest.Mock).mockRejectedValue(new Error("off"));
  (fetchSaveReserveRates as jest.Mock).mockResolvedValue([]);
  (fetchSanctumSolValues as jest.Mock).mockResolvedValue(new Map());
  (fetchJupiterRateOut as jest.Mock).mockResolvedValue(1_000_000n);
  (fetchLstApys as jest.Mock).mockResolvedValue(new Map());
  (fetchExponentApys as jest.Mock).mockResolvedValue(new Map());
  (getOracleResult as jest.Mock).mockResolvedValue(okOracle());
  app = await buildServer({ logger: false });
});

afterEach(async () => {
  await app.close();
});

describe("8.95: /protocols/jupiter-lend/markets", () => {
  it("上流失敗は 503 (旧: 200-[])", async () => {
    (fetchEarnMarkets as jest.Mock).mockRejectedValue(new Error("lite-api down"));
    const res = await app.inject({
      method: "GET",
      url: "/protocols/jupiter-lend/markets",
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe("jupiter_lend_markets_unavailable");
  });

  it("上流が本当に空を返した場合は 200 [] (成功した空は正当)", async () => {
    (fetchEarnMarkets as jest.Mock).mockResolvedValue([]);
    const res = await app.inject({
      method: "GET",
      url: "/protocols/jupiter-lend/markets",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });
});

describe("8.95: /portfolio/history", () => {
  it("上流全滅は 503 (旧: 200 空 points)", async () => {
    for (const fn of MAIN_UPSTREAMS) {
      (fn as jest.Mock).mockRejectedValue(new Error("helius down"));
    }
    const res = await app.inject({
      method: "GET",
      url: `/portfolio/history?wallet=${WALLET}&days=30`,
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe("portfolio_history_unavailable");
  });
});

describe("8.95: /prices", () => {
  it("lookup が throw で全滅なら 503 (旧: 200 {})", async () => {
    (oracleMintForSymbol as jest.Mock).mockReturnValue(
      "So11111111111111111111111111111111111111112"
    );
    (getOracleResult as jest.Mock).mockRejectedValue(new Error("oracle rpc down"));
    const res = await app.inject({ method: "GET", url: "/prices?symbols=SOL" });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe("prices_unavailable");
  });

  it("blocked による drop のみなら従来どおり 200 {} (§4.6 の意図的挙動)", async () => {
    (oracleMintForSymbol as jest.Mock).mockReturnValue(
      "So11111111111111111111111111111111111111112"
    );
    (getOracleResult as jest.Mock).mockResolvedValue({
      ...okOracle(),
      status: "blocked",
      price_usd: null,
      block_reason: "oracle_unavailable",
    });
    const res = await app.inject({ method: "GET", url: "/prices?symbols=SOL" });
    expect(res.statusCode).toBe(200);
    expect(res.json().prices).toEqual({});
  });
});

describe("8.95: /positions/earn", () => {
  it("主要 5 upstream 全滅は 503 (真の空 wallet と区別する)", async () => {
    for (const fn of MAIN_UPSTREAMS) {
      (fn as jest.Mock).mockRejectedValue(new Error("all down"));
    }
    const res = await app.inject({
      method: "GET",
      url: `/positions/earn?wallet=${WALLET}`,
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe("earn_positions_unavailable");
  });

  it("部分失敗は従来どおり 200 + per-protocol degrade", async () => {
    (fetchEarnPositions as jest.Mock).mockResolvedValue([]);
    for (const fn of MAIN_UPSTREAMS.slice(1)) {
      (fn as jest.Mock).mockRejectedValue(new Error("partial down"));
    }
    const res = await app.inject({
      method: "GET",
      url: `/positions/earn?wallet=${WALLET}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.jupiterLend).toEqual([]);
    expect(body.kaminoBestEffort).toEqual([]);
  });
});
