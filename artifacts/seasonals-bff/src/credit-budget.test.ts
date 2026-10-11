/**
 * Phase B3: Helius credit の予算 test (route 単位)。
 *
 * Seeker は `/positions` / `/positions/earn` / `/time-events/wallet` を並列に叩く。B3 以前は各 handler が
 * wallet の DAS / Enhanced tx / Meteora / Orca / Kamino / Jupiter Lend / stake を独立に読んでいた
 * (cold 実測 DAS ×4、Enhanced ×3、Meteora GPA ×6)。wallet snapshot で「wallet ごとに 1 回」に束ねたことを
 * client mock の呼び出し回数で固定する。
 *
 * `usageSnapshot()` (src/usage.ts) は limiter の onDispatch から供給されるので mock client では動かない。
 * TODO(Phase D): fetch spy + DAS / tx-history fixture で `approxCredits ≤ N` (N = 導入時実測 + 10%) を足す。
 *
 * mock は softfail.test.ts の流儀 (SDK を掴む client は requireActual + 個別 jest.fn)。
 */
import type { FastifyInstance } from "fastify";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";

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
import {
  fetchStakeAccounts,
  getEpochInfo,
  sendTransactionViaHelius,
} from "./clients/helius-rpc";
import { fetchLstSolValues } from "./clients/lst-rates";
import { getOracleResult, getOracleResults } from "./clients/oracle";
import { _clearWalletSnapshotForTest } from "./wallet-snapshot";

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
jest.mock("./clients/helius-rpc", () => ({
  ...jest.requireActual("./clients/helius-rpc"),
  fetchStakeAccounts: jest.fn(),
  getEpochInfo: jest.fn(),
  sendTransactionViaHelius: jest.fn(),
}));
jest.mock("./clients/oracle");
jest.mock("./clients/kamino-tx");
jest.mock("./clients/save-tx");
jest.mock("./clients/rates");
jest.mock("./clients/helius");
jest.mock("./clients/jupiter-lend");
jest.mock("./clients/helius-tx");
jest.mock("./clients/lst-rates");

/** wallet ごとに 1 回だけ読まれるべき per-wallet client (snapshot の 8 source) */
const PER_WALLET = {
  das: fetchAssetsByOwner,
  enhanced: fetchEnhancedTransactions,
  meteora: fetchMeteoraPositions,
  orca: fetchOrcaPositions,
  kaminoObligations: fetchKaminoObligations,
  kvault: fetchKaminoVaultUserPositions,
  jupiterLend: fetchEarnPositions,
  stake: fetchStakeAccounts,
} as unknown as Record<string, jest.Mock>;

function okOracle(): OracleResult {
  return {
    asset_symbol: "SOL",
    status: "ok",
    primary: "pyth",
    price_usd: "90.00000000",
    pyth: { available: true, price_usd: "90.00000000", age_seconds: 1 },
    secondary: { source: null, available: false, price_usd: null, age_seconds: null },
    tier: "C",
    divergence_pct: null,
    warnings: [],
    block_reason: null,
  };
}

function callCounts(): Record<string, number> {
  return Object.fromEntries(
    Object.entries(PER_WALLET).map(([k, fn]) => [k, fn.mock.calls.length])
  );
}

function callsFor(fn: jest.Mock, wallet: string): number {
  return fn.mock.calls.filter((c) => c.includes(wallet)).length;
}

/** snapshot の settle → cache.set の microtask 連鎖を流し切る */
const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

const WALLET = Keypair.generate().publicKey.toBase58();
const OTHER = Keypair.generate().publicKey.toBase58();

let app: FastifyInstance;

beforeEach(async () => {
  jest.clearAllMocks();
  _clearWalletSnapshotForTest();
  for (const fn of Object.values(PER_WALLET)) fn.mockResolvedValue([]);
  (fetchKaminoReserveMetrics as jest.Mock).mockResolvedValue([]);
  (fetchEarnMarkets as jest.Mock).mockResolvedValue([]);
  (getEpochInfo as jest.Mock).mockRejectedValue(new Error("off"));
  (fetchMeteoraPoolStats as jest.Mock).mockResolvedValue(new Map());
  (fetchOrcaPoolStats as jest.Mock).mockResolvedValue(new Map());
  (fetchKaminoVaultMetrics as jest.Mock).mockRejectedValue(new Error("off"));
  (fetchSaveReserveRates as jest.Mock).mockResolvedValue([]);
  (fetchSanctumSolValues as jest.Mock).mockResolvedValue(new Map());
  (fetchLstSolValues as jest.Mock).mockResolvedValue(new Map());
  (fetchJupiterRateOut as jest.Mock).mockResolvedValue(1_000_000n);
  (fetchLstApys as jest.Mock).mockResolvedValue(new Map());
  (fetchExponentApys as jest.Mock).mockResolvedValue(new Map());
  (getOracleResult as jest.Mock).mockResolvedValue(okOracle());
  (getOracleResults as jest.Mock).mockImplementation(async (mints: string[]) =>
    new Map(await Promise.all(mints.map(async (m) => [m, await getOracleResult(m)] as const)))
  );
  (sendTransactionViaHelius as jest.Mock).mockResolvedValue("SIG");
  app = await buildServer({ logger: false });
});

afterEach(async () => {
  await app.close();
});

function openWallet(wallet: string) {
  return Promise.all([
    app.inject({ method: "GET", url: `/positions?wallet=${wallet}` }),
    app.inject({ method: "GET", url: `/positions/earn?wallet=${wallet}` }),
    app.inject({ method: "GET", url: `/time-events/wallet?wallet=${wallet}` }),
  ]);
}

describe("B3 credit budget: 3 display route の per-wallet 読み", () => {
  it("cold の並列 3 route → 各 per-wallet client は 1 回、直後の 2 周目は +0", async () => {
    const cold = await openWallet(WALLET);
    for (const res of cold) {
      expect(res.statusCode).toBe(200);
      expect(Number(res.headers["x-seasonals-data-age-ms"])).toBeGreaterThanOrEqual(0);
    }
    expect(callCounts()).toEqual({
      das: 1,
      enhanced: 1,
      meteora: 1,
      orca: 1,
      kaminoObligations: 1,
      kvault: 1,
      jupiterLend: 1,
      stake: 1,
    });
    // Oracle: earn の SOL / USDC は 1 回の batch
    expect(getOracleResults).toHaveBeenCalledTimes(1);

    await flush();
    const warm = await openWallet(WALLET);
    for (const res of warm) expect(res.statusCode).toBe(200);
    expect(Object.values(callCounts())).toEqual(Array(8).fill(1));
  });

  it("別 wallet は別 snapshot (それぞれ 1 回)", async () => {
    await Promise.all([openWallet(WALLET), openWallet(OTHER)]);
    for (const fn of Object.values(PER_WALLET)) {
      expect(callsFor(fn, WALLET)).toBe(1);
      expect(callsFor(fn, OTHER)).toBe(1);
    }
  });
});

describe("B3: POST /tx/submit は送った wallet (fee payer) の snapshot だけを bust する", () => {
  function signedTxFor(payer: string, version: "v0" | "legacy"): string {
    const payerKey = new PublicKey(payer);
    const message = new TransactionMessage({
      payerKey,
      recentBlockhash: "11111111111111111111111111111111",
      instructions: [
        SystemProgram.transfer({
          fromPubkey: payerKey,
          toPubkey: Keypair.generate().publicKey,
          lamports: 1,
        }),
      ],
    });
    const compiled =
      version === "v0" ? message.compileToV0Message() : message.compileToLegacyMessage();
    // 署名は 0 埋め (sendTransactionViaHelius は mock)
    return Buffer.from(new VersionedTransaction(compiled).serialize()).toString("base64");
  }

  it.each(["v0", "legacy"] as const)("%s tx: 次の /positions で DAS を読み直し、他 wallet はそのまま", async (version) => {
    await Promise.all([
      app.inject({ method: "GET", url: `/positions?wallet=${WALLET}` }),
      app.inject({ method: "GET", url: `/positions?wallet=${OTHER}` }),
    ]);
    await flush();
    const das = fetchAssetsByOwner as jest.Mock;
    expect(callsFor(das, WALLET)).toBe(1);
    expect(callsFor(das, OTHER)).toBe(1);

    const res = await app.inject({
      method: "POST",
      url: "/tx/submit",
      payload: { signedTx: signedTxFor(WALLET, version) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ signature: "SIG" });

    await app.inject({ method: "GET", url: `/positions?wallet=${WALLET}` });
    await app.inject({ method: "GET", url: `/positions?wallet=${OTHER}` });
    expect(callsFor(das, WALLET)).toBe(2);
    expect(callsFor(das, OTHER)).toBe(1);
  });

  it("deserialize できない signedTx でも送信成功なら 200 (bust は best effort)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/tx/submit",
      payload: { signedTx: "bm90LWEtdHg=" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ signature: "SIG" });
  });
});

describe("B3: snapshot 経由でも route ごとの degrade 規則は不変", () => {
  it("/positions: DAS 失敗は従来どおり 502 helius_fetch_failed", async () => {
    (fetchAssetsByOwner as jest.Mock).mockRejectedValue(new Error("das down"));
    const res = await app.inject({ method: "GET", url: `/positions?wallet=${WALLET}` });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: "helius_fetch_failed", message: "das down" });
  });

  it("/time-events/wallet: wallet 由来 source が全滅でも 200 + 部分結果 (空)", async () => {
    for (const fn of Object.values(PER_WALLET)) fn.mockRejectedValue(new Error("down"));
    const res = await app.inject({ method: "GET", url: `/time-events/wallet?wallet=${WALLET}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });
});
