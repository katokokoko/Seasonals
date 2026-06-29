/**
 * Phase 8.14: deposit-tx の fail-closed gate。oracle が blocked を返したら
 * swapTransaction を返さず 409 oracle_blocked になることを検証 (oracle client を mock)。
 */
import type { FastifyInstance } from "fastify";
import type { OracleResult } from "@workspace/lib/types";

const mockGetOracleResult = jest.fn<Promise<OracleResult>, [string]>();

jest.mock("./clients/oracle", () => ({
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
