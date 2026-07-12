/**
 * Phase 8.15b: Kamino Lend deposit/withdraw endpoint のテスト。
 *
 * Kamino REST client と oracle を mock し、(1) reserve → market 解決、(2) §4.5
 * smallest-unit → human/decimal 変換、(3) oracle fail-closed gate (§4.6)、
 * (4) 未知 reserve / 欠損 field の 400 を検証する。実ネットワークは叩かない。
 */
import type { FastifyInstance } from "fastify";

import {
  KAMINO_MAIN_MARKET,
  KAMINO_MARKETS,
  KAMINO_VAULTS,
} from "@workspace/lib/config/kamino-markets";
import type { OracleResult } from "@workspace/lib/types";

import {
  buildServer,
  mapKaminoObligationsToEarnPositions,
  mapKaminoVaultPositionsToEarnPositions,
  sfToUsd8,
  truncateDecimal,
} from "./server";
import {
  fetchKaminoDepositTx,
  fetchKaminoWithdrawTx,
  fetchKaminoReserveMetrics,
  fetchKaminoObligations,
  fetchKaminoVaultDepositTx,
  fetchKaminoVaultWithdrawTx,
  fetchKaminoVaultMetrics,
  fetchKaminoVaultUserPositions,
} from "./clients/kamino-tx";
import { getOracleResult } from "./clients/oracle";

jest.mock("./clients/kamino-tx");
jest.mock("./clients/oracle");

const mockDeposit = fetchKaminoDepositTx as jest.MockedFunction<
  typeof fetchKaminoDepositTx
>;
const mockWithdraw = fetchKaminoWithdrawTx as jest.MockedFunction<
  typeof fetchKaminoWithdrawTx
>;
const mockMetrics = fetchKaminoReserveMetrics as jest.MockedFunction<
  typeof fetchKaminoReserveMetrics
>;
const mockObligations = fetchKaminoObligations as jest.MockedFunction<
  typeof fetchKaminoObligations
>;
const mockOracle = getOracleResult as jest.MockedFunction<
  typeof getOracleResult
>;
const mockVaultDeposit = fetchKaminoVaultDepositTx as jest.MockedFunction<
  typeof fetchKaminoVaultDepositTx
>;
const mockVaultWithdraw = fetchKaminoVaultWithdrawTx as jest.MockedFunction<
  typeof fetchKaminoVaultWithdrawTx
>;
const mockVaultMetrics = fetchKaminoVaultMetrics as jest.MockedFunction<
  typeof fetchKaminoVaultMetrics
>;
const mockVaultPositions = fetchKaminoVaultUserPositions as jest.MockedFunction<
  typeof fetchKaminoVaultUserPositions
>;

const VALID_USER = "8sN5e1Qm9bYz2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r";
const USDC = KAMINO_MARKETS.find((m) => m.underlying_symbol === "USDC")!;
const SOL = KAMINO_MARKETS.find((m) => m.underlying_symbol === "SOL")!;
const VAULT_USDC = KAMINO_VAULTS.find((v) => v.underlying_symbol === "USDC")!;
const VAULT_SOL = KAMINO_VAULTS.find((v) => v.underlying_symbol === "SOL")!;

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
function blockedOracle(): OracleResult {
  return { ...okOracle(), status: "blocked", block_reason: "oracle_both_stale" };
}

let app: FastifyInstance;

beforeEach(async () => {
  jest.clearAllMocks();
  mockOracle.mockResolvedValue(okOracle());
  mockDeposit.mockResolvedValue({ transaction: "KAMINO_DEP_TX" });
  mockWithdraw.mockResolvedValue({ transaction: "KAMINO_WD_TX" });
  mockMetrics.mockResolvedValue([]);
  mockObligations.mockResolvedValue([]);
  mockVaultDeposit.mockResolvedValue({ transaction: "KVAULT_DEP_TX" });
  mockVaultWithdraw.mockResolvedValue({ transaction: "KVAULT_WD_TX" });
  mockVaultMetrics.mockResolvedValue({
    apy: "0.04",
    tokensPerShare: "1",
    tokenPrice: "1",
  });
  mockVaultPositions.mockResolvedValue([]);
  app = await buildServer({ logger: false });
});
afterEach(async () => {
  await app.close();
});

async function post(url: string, body: Record<string, unknown>) {
  return app.inject({ method: "POST", url, payload: body });
}

describe("POST /protocols/kamino/deposit-tx", () => {
  it("USDC reserve を解決し smallest→human 変換して Kamino を呼ぶ", async () => {
    const res = await post("/protocols/kamino/deposit-tx", {
      user: VALID_USER,
      reserve: USDC.reserve,
      amount: "1500000", // 1.5 USDC (6 decimals)
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().transaction).toBe("KAMINO_DEP_TX");
    expect(mockDeposit).toHaveBeenCalledWith({
      wallet: VALID_USER,
      market: KAMINO_MAIN_MARKET,
      reserve: USDC.reserve,
      amount: "1.5", // §4.5 human/decimal 変換
    });
    // oracle gate は underlying (USDC mint) に掛かる
    expect(mockOracle).toHaveBeenCalledWith(USDC.underlying_mint);
  });

  it("SOL reserve: 500000000 (9 dec) → 0.5", async () => {
    const res = await post("/protocols/kamino/deposit-tx", {
      user: VALID_USER,
      reserve: SOL.reserve,
      amount: "500000000",
    });
    expect(res.statusCode).toBe(200);
    expect(mockDeposit).toHaveBeenCalledWith(
      expect.objectContaining({ reserve: SOL.reserve, amount: "0.5" })
    );
  });

  it("oracle blocked → 409、Kamino は呼ばない", async () => {
    mockOracle.mockResolvedValue(blockedOracle());
    const res = await post("/protocols/kamino/deposit-tx", {
      user: VALID_USER,
      reserve: USDC.reserve,
      amount: "1500000",
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("oracle_blocked");
    expect(mockDeposit).not.toHaveBeenCalled();
  });

  it("未知 reserve → 400 unsupported_reserve", async () => {
    const res = await post("/protocols/kamino/deposit-tx", {
      user: VALID_USER,
      reserve: "NotARegisteredReserve11111111111111111111",
      amount: "1500000",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("unsupported_reserve");
    expect(mockOracle).not.toHaveBeenCalled();
  });

  it("欠損 field → 400", async () => {
    const res = await post("/protocols/kamino/deposit-tx", {
      user: VALID_USER,
      reserve: USDC.reserve,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("missing_required_field");
  });

  it("不正 amount (負) → 400 invalid_amount", async () => {
    const res = await post("/protocols/kamino/deposit-tx", {
      user: VALID_USER,
      reserve: USDC.reserve,
      amount: "-5",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_amount");
  });
});

describe("POST /protocols/kamino/withdraw-tx", () => {
  it("SOL reserve を解決し withdraw を呼ぶ", async () => {
    const res = await post("/protocols/kamino/withdraw-tx", {
      user: VALID_USER,
      reserve: SOL.reserve,
      amount: "250000000", // 0.25 SOL
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().transaction).toBe("KAMINO_WD_TX");
    expect(mockWithdraw).toHaveBeenCalledWith(
      expect.objectContaining({ reserve: SOL.reserve, amount: "0.25" })
    );
  });

  it("未知 reserve → 400", async () => {
    const res = await post("/protocols/kamino/withdraw-tx", {
      user: VALID_USER,
      reserve: "NotARegisteredReserve11111111111111111111",
      amount: "1",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("unsupported_reserve");
  });
});

// ── obligation → EarnPosition マッピング (実 Kamino API の shape を fixture 化) ──
// shape は実 obligation (deposits[] = {depositReserve, depositedAmount, marketValueSf})
// を実地確認済。空 slot は system-program reserve、非対応 reserve は除外される。
const EMPTY = "11111111111111111111111111111111";
describe("mapKaminoObligationsToEarnPositions", () => {
  it("supported reserve の deposit を EarnPosition に (reserve=share_mint、Sf→USD)", () => {
    const apy = new Map<string, number>([[USDC.reserve, 446]]);
    const obligations = [
      {
        deposits: [
          {
            depositReserve: USDC.reserve,
            depositedAmount: "1500000", // 1.5 USDC (cToken ≈ underlying)
            // 1234.5 USD × 2^60 (= 1234.5 * 1152921504606846976)
            marketValueSf: (1234n * 1152921504606846976n).toString(),
          },
          { depositReserve: EMPTY, depositedAmount: "0", marketValueSf: "0" },
        ],
      },
    ];
    const out = mapKaminoObligationsToEarnPositions(obligations, apy);
    expect(out).toHaveLength(1);
    expect(out[0]!.protocol_id).toBe("kamino");
    expect(out[0]!.share_mint).toBe(USDC.reserve); // reserve = position key
    expect(out[0]!.shares).toBe("1500000"); // withdraw 入力
    expect(out[0]!.asset_symbol).toBe("USDC");
    expect(out[0]!.supply_rate_bps).toBe(446);
    expect(out[0]!.underlying_usd.startsWith("1234.")).toBe(true);
    expect(out[0]!.accrued_yield_sign).toBe("unknown");
  });

  it("非対応 reserve / 空 slot / 0 amount は除外", () => {
    const obligations = [
      {
        deposits: [
          { depositReserve: "SomeOtherReserve1111111111111111111111111", depositedAmount: "999", marketValueSf: "1" },
          { depositReserve: EMPTY, depositedAmount: "0", marketValueSf: "0" },
          { depositReserve: USDC.reserve, depositedAmount: "0", marketValueSf: "0" },
        ],
      },
    ];
    expect(mapKaminoObligationsToEarnPositions(obligations, new Map())).toHaveLength(0);
  });

  it("deposits が object 形 (非 vanilla obligation) でも走査する", () => {
    const obligations = [
      {
        deposits: {
          "0": { depositReserve: SOL.reserve, depositedAmount: "250000000", marketValueSf: "0" },
        },
      },
    ];
    const out = mapKaminoObligationsToEarnPositions(obligations, new Map());
    expect(out).toHaveLength(1);
    expect(out[0]!.share_mint).toBe(SOL.reserve);
  });
});

describe("sfToUsd8", () => {
  it("scaled fraction (×2^60) を 8-dec USD string に", () => {
    expect(sfToUsd8((100n * 1152921504606846976n).toString())).toBe(
      "100.00000000"
    );
  });
  it("不正入力は '0'", () => {
    expect(sfToUsd8("0x12")).toBe("0");
    expect(sfToUsd8(undefined)).toBe("0");
  });
});

// ── Phase 8.15d: kVault ──────────────────────────────────────────────────────

describe("POST /protocols/kamino/vault-deposit-tx", () => {
  it("vault を解決し underlying smallest→human 変換して Kamino を呼ぶ", async () => {
    const res = await post("/protocols/kamino/vault-deposit-tx", {
      user: VALID_USER,
      vault: VAULT_USDC.vault,
      amount: "1500000", // 1.5 USDC
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().transaction).toBe("KVAULT_DEP_TX");
    expect(mockVaultDeposit).toHaveBeenCalledWith({
      wallet: VALID_USER,
      kvault: VAULT_USDC.vault,
      amount: "1.5",
    });
    expect(mockOracle).toHaveBeenCalledWith(VAULT_USDC.underlying_mint);
  });

  it("oracle blocked → 409", async () => {
    mockOracle.mockResolvedValue({
      ...okOracle(),
      status: "blocked",
      block_reason: "oracle_both_stale",
    });
    const res = await post("/protocols/kamino/vault-deposit-tx", {
      user: VALID_USER,
      vault: VAULT_SOL.vault,
      amount: "1000000000",
    });
    expect(res.statusCode).toBe(409);
    expect(mockVaultDeposit).not.toHaveBeenCalled();
  });

  it("未知 vault → 400 unsupported_vault", async () => {
    const res = await post("/protocols/kamino/vault-deposit-tx", {
      user: VALID_USER,
      vault: "NotAVault1111111111111111111111111111111111",
      amount: "1",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("unsupported_vault");
  });
});

describe("POST /protocols/kamino/vault-withdraw-tx", () => {
  it("withdraw は share 建て: shares smallest→human (shares_decimals) 変換", async () => {
    const res = await post("/protocols/kamino/vault-withdraw-tx", {
      user: VALID_USER,
      vault: VAULT_SOL.vault,
      amount: "2500000", // 2.5 shares (shares_decimals=6、underlying SOL=9 と異なる)
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().transaction).toBe("KVAULT_WD_TX");
    expect(mockVaultWithdraw).toHaveBeenCalledWith({
      wallet: VALID_USER,
      kvault: VAULT_SOL.vault,
      amount: "2.5",
    });
  });
});

describe("truncateDecimal", () => {
  it("指定桁で切り捨て (文字列操作のみ)", () => {
    expect(truncateDecimal("1.23456789", 4)).toBe("1.2345");
    expect(truncateDecimal("5", 4)).toBe("5");
    expect(truncateDecimal("0.999999999999999", 12)).toBe("0.999999999999");
  });
  it("不正入力は '0'", () => {
    expect(truncateDecimal("abc", 4)).toBe("0");
  });
});

describe("mapKaminoVaultPositionsToEarnPositions", () => {
  const metrics = new Map([
    [
      VAULT_SOL.vault,
      { apy: "0.112", tokensPerShare: "1.5", tokenPrice: "80" },
    ],
  ]);

  it("human shares → smallest、tokensPerShare/tokenPrice で underlying/USD 換算", () => {
    const out = mapKaminoVaultPositionsToEarnPositions(
      [
        {
          vaultAddress: VAULT_SOL.vault,
          stakedShares: "4.999998",
          unstakedShares: "0",
          totalShares: "4.999998",
        },
      ],
      metrics
    );
    expect(out).toHaveLength(1);
    const p = out[0]!;
    expect(p.share_mint).toBe(VAULT_SOL.vault);
    expect(p.shares).toBe("4999998"); // 4.999998 × 10^6
    // underlying = 4.999998 shares × 1.5 SOL/share = 7.499997 SOL = 7499997000000 lamports? →
    // 7.499997 × 10^9 = 7499997000
    expect(p.underlying_amount).toBe("7499997000");
    // USD = 7.499997 × 80 = 599.99976
    expect(p.underlying_usd).toBe("599.99976000");
    expect(p.supply_rate_bps).toBe(1120);
    expect(p.asset_symbol).toBe("SOL");
  });

  it("metrics 無し → shares のみ (underlying '0' / APY null) の degrade", () => {
    const out = mapKaminoVaultPositionsToEarnPositions(
      [
        {
          vaultAddress: VAULT_USDC.vault,
          stakedShares: "1",
          unstakedShares: "0",
          totalShares: "1",
        },
      ],
      new Map()
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.shares).toBe("1000000");
    expect(out[0]!.underlying_amount).toBe("0");
    expect(out[0]!.supply_rate_bps).toBeNull();
  });

  it("未登録 vault / 0 shares は除外", () => {
    const out = mapKaminoVaultPositionsToEarnPositions(
      [
        { vaultAddress: "UnknownVault111111111111111111111", stakedShares: "9", unstakedShares: "0", totalShares: "9" },
        { vaultAddress: VAULT_USDC.vault, stakedShares: "0", unstakedShares: "0", totalShares: "0" },
      ],
      new Map()
    );
    expect(out).toHaveLength(0);
  });

  it("過剰精度の shares は切り捨てて処理 (throw しない)", () => {
    const out = mapKaminoVaultPositionsToEarnPositions(
      [
        {
          vaultAddress: VAULT_USDC.vault,
          stakedShares: "1.23456789012345",
          unstakedShares: "0",
          totalShares: "1.23456789012345",
        },
      ],
      new Map()
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.shares).toBe("1234567"); // 6 桁切り捨て
  });
});
