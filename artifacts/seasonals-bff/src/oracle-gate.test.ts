/**
 * Phase 8.14: deposit-tx の fail-closed gate。oracle が blocked を返したら
 * swapTransaction を返さず 409 oracle_blocked になることを検証 (oracle client を mock)。
 */
import type { FastifyInstance } from "fastify";
import type { OracleResult } from "@workspace/lib/types";

const mockGetOracleResult = jest.fn<Promise<OracleResult>, [string]>();

jest.mock("./clients/oracle", () => ({
  // 8.57: symbol → mint の逆引きは実物を使う (registry と一致させるため)
  ...jest.requireActual("./clients/oracle"),
  getOracleResult: (mint: string) => mockGetOracleResult(mint),
}));

import { buildServer } from "./server";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

let app: FastifyInstance;
beforeEach(async () => {
  app = await buildServer({ logger: false });
});
afterEach(async () => {
  await app.close();
  mockGetOracleResult.mockReset();
});

function blockedResult(): OracleResult {
  return {
    asset_symbol: "USDC",
    status: "blocked",
    primary: null,
    price_usd: null,
    pyth: { available: false, price_usd: null, age_seconds: null },
    switchboard: { available: false, price_usd: null, age_seconds: null },
    divergence_pct: null,
    warnings: [],
    block_reason: "oracle_unavailable",
  };
}

describe("POST /protocols/jupiter-lend/deposit-tx — oracle fail-closed gate", () => {
  it("oracle blocked → 409 oracle_blocked, swapTransaction を返さない", async () => {
    mockGetOracleResult.mockResolvedValue(blockedResult());
    const res = await app.inject({
      method: "POST",
      url: "/protocols/jupiter-lend/deposit-tx",
      payload: {
        user: "6QGJNXnCjhYkKgPpDm7qRzxBKCj9KugUL2LDHc8sGUUM",
        inputMint: USDC,
        amount: "1000000",
      },
    });
    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.error).toBe("oracle_blocked");
    expect(body.block_reason).toBe("oracle_unavailable");
    expect(body.swapTransaction).toBeUndefined();
    // blocked の時点で oracle を 1 回引いている
    expect(mockGetOracleResult).toHaveBeenCalledWith(USDC);
  });
});

// ── Phase 8.57: GET /prices (mobile の評価額に使う実 USD 価格) ───────────────

function okResult(symbol: string, price: string): OracleResult {
  return {
    asset_symbol: symbol,
    status: "ok",
    primary: "pyth",
    price_usd: price,
    pyth: { available: true, price_usd: price, age_seconds: 2 },
    switchboard: { available: false, price_usd: null, age_seconds: null },
    divergence_pct: null,
    warnings: [],
    block_reason: null,
  };
}

describe("GET /prices", () => {
  it("symbol → 8-dec USD string を返す (registry にある asset のみ)", async () => {
    mockGetOracleResult.mockImplementation(async (mint) =>
      mint === "So11111111111111111111111111111111111111112"
        ? okResult("SOL", "74.92000000")
        : okResult("USDC", "0.99986310")
    );
    const res = await app.inject({ method: "GET", url: "/prices?symbols=SOL,USDC" });
    expect(res.statusCode).toBe(200);
    expect(res.json().prices).toEqual({
      SOL: "74.92000000",
      USDC: "0.99986310",
    });
  });

  it("blocked の symbol は **返さない** (0 で埋めると 0 円と誤読される)", async () => {
    mockGetOracleResult.mockResolvedValue(blockedResult());
    const res = await app.inject({ method: "GET", url: "/prices?symbols=SOL" });
    expect(res.json().prices).toEqual({});
  });

  it("registry に無い symbol は oracle を叩かずに落とす", async () => {
    mockGetOracleResult.mockResolvedValue(okResult("SOL", "74.92000000"));
    const res = await app.inject({ method: "GET", url: "/prices?symbols=DOGE" });
    expect(res.json().prices).toEqual({});
    expect(mockGetOracleResult).not.toHaveBeenCalled();
  });

  it("WSOL は SOL として解決する", async () => {
    mockGetOracleResult.mockResolvedValue(okResult("SOL", "74.92000000"));
    const res = await app.inject({ method: "GET", url: "/prices?symbols=WSOL" });
    expect(res.json().prices).toEqual({ WSOL: "74.92000000" });
  });

  it("symbols 未指定は 400", async () => {
    const res = await app.inject({ method: "GET", url: "/prices" });
    expect(res.statusCode).toBe(400);
  });
});
