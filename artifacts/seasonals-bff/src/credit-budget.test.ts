/**
 * Phase B3: Helius credit の予算 test (route 単位)。
 *
 * Seeker は `/positions` / `/positions/earn` / `/time-events/wallet` を並列に叩く。B3 以前は各 handler が
 * wallet の DAS / Enhanced tx / Meteora / Orca / Kamino / Jupiter Lend / stake を独立に読んでいた
 * (cold 実測 DAS ×4、Enhanced ×3、Meteora GPA ×6)。wallet snapshot で「wallet ごとに 1 回」に束ねたことを
 * client mock の呼び出し回数で固定する。
 *
 * Phase D: `usageSnapshot().approxCredits` の上限。`usage.ts` は本来 limiter の onDispatch から供給
 * されるので、mock client が **実 client と同じ上流 request** を `recordUpstreamCall` で計上する
 * (`UPSTREAM_COST`、2026-10-12 の live 計測 `scripts/measure-usage.mjs` の byMethod から per-wallet 分を割り当て)。
 * wallet 非依存の読み (oracle / pool / reserve、live で ≈ 22 RPC credit) は全 user で共有され、ここでは
 * mock なので数えない。
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
import {
  fetchWalletTxPage,
  fetchWalletTxs,
  walletTxBackend,
} from "./clients/tx-history";
import { fetchPriceSeries } from "./clients/pyth-history";
import { fetchLlamaPriceSeries } from "./clients/llama-history";
import { heliusTxHistoryApi } from "./flags";
import { _resetUsageForTest, recordUpstreamCall, usageSnapshot, type HeliusApi } from "./usage";
import {
  fetchStakeAccounts,
  getEpochInfo,
  sendTransactionViaHelius,
} from "./clients/helius-rpc";
import { fetchLstSolValues } from "./clients/lst-rates";
import { getOracleResult, getOracleResults } from "./clients/oracle";
import { _clearWalletSnapshotForTest } from "./wallet-snapshot";
import { _clearPortfolioHistoryCacheForTest } from "./server";

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
jest.mock("./clients/tx-history");
jest.mock("./clients/lst-rates");
jest.mock("./clients/pyth-history", () => ({
  ...jest.requireActual("./clients/pyth-history"),
  fetchPriceSeries: jest.fn(),
}));
jest.mock("./clients/llama-history", () => ({
  ...jest.requireActual("./clients/llama-history"),
  fetchLlamaPriceSeries: jest.fn(),
}));

/**
 * Phase D: mock client 1 回の呼び出しが上流に出す Helius request (credit: RPC 1 / GPA 10 / DAS 10 /
 * Enhanced 100 / Parsed 10)。live cold (positions + earn + events + history、2026-10-12、enhanced) の
 * byMethod = DAS 1、Enhanced 2 (snapshot 1 + history 1 page)、getProgramAccounts 4、getTokenAccountsByOwner 2、
 * 他 RPC 20 (oracle / pool / reserve / epoch — wallet 非依存、ここでは数えない) のうち per-wallet 分:
 */
const UPSTREAM_COST: Record<string, Array<{ api: HeliusApi; method: string }>> = {
  das: [{ api: "das", method: "getAssetsByOwner" }],
  meteora: [{ api: "rpc", method: "getProgramAccounts" }],
  orca: [
    { api: "rpc", method: "getTokenAccountsByOwner" },
    { api: "rpc", method: "getTokenAccountsByOwner" },
  ],
  kaminoObligations: [{ api: "rpc", method: "getProgramAccounts" }],
  kvault: [{ api: "rpc", method: "getProgramAccounts" }],
  jupiterLend: [], // Jupiter の REST (Helius ではない)
  stake: [{ api: "rpc", method: "getProgramAccounts" }],
};

/** tx 履歴 1 request (backend は HELIUS_TX_HISTORY_API) */
function txHistoryCall(): { api: HeliusApi; method: string } {
  return heliusTxHistoryApi() === "parsed"
    ? { api: "parsed", method: "parsed-events" }
    : { api: "enhanced", method: "addresses.transactions" };
}

function charge(calls: Array<{ api: HeliusApi; method: string }>): void {
  for (const c of calls) recordUpstreamCall({ ...c, status: 200 });
}

/** wallet ごとに 1 回だけ読まれるべき per-wallet client (snapshot の 8 source) */
const PER_WALLET = {
  das: fetchAssetsByOwner,
  enhanced: fetchWalletTxs,
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
  _clearPortfolioHistoryCacheForTest();
  _resetUsageForTest();
  for (const [name, fn] of Object.entries(PER_WALLET)) {
    fn.mockImplementation(async () => {
      charge(name === "enhanced" ? [txHistoryCall()] : UPSTREAM_COST[name]!);
      return [];
    });
  }
  (walletTxBackend as jest.Mock).mockImplementation(() => heliusTxHistoryApi());
  (fetchWalletTxPage as jest.Mock).mockImplementation(async () => {
    charge([txHistoryCall()]);
    return { txs: [], scanned: 0 };
  });
  (fetchPriceSeries as jest.Mock).mockResolvedValue({ t: [], usd8: [] });
  (fetchLlamaPriceSeries as jest.Mock).mockResolvedValue(new Map());
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
  delete process.env.HELIUS_TX_HISTORY_API;
  jest.restoreAllMocks();
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

/**
 * Phase D: cold open (3 route 並列) の Helius credit 上限。N = 下の内訳 + 10% (切り上げ)。
 * 内訳 (wallet 1 つ、per-wallet 分のみ):
 *   DAS getAssetsByOwner 10 + tx 履歴 1 request + Meteora GPA 10 + Orca getTokenAccountsByOwner ×2 = 2
 *   + Kamino obligations GPA 10 + kVault GPA 10 + stake GPA 10 = 52 + tx 履歴 (直近 50 件) 1 request
 *   - enhanced (既定): 52 + 100 = 152 → N = 168
 *   - parsed: 52 + 10 = 62 → N = 69
 * 2 回目 (snapshot の fresh TTL 内) は +0。
 */
describe("Phase D: approxCredits budget (cold 3 route)", () => {
  it.each([
    ["enhanced", 152, 168],
    ["parsed", 62, 69],
  ] as const)("%s: cold ≤ N, 2 回目 +0", async (backend, expected, budget) => {
    process.env.HELIUS_TX_HISTORY_API = backend;
    await openWallet(WALLET);
    const cold = usageSnapshot().approxCredits;
    expect(cold).toBe(expected);
    expect(cold).toBeLessThanOrEqual(budget);
    expect(usageSnapshot().byApi[backend === "parsed" ? "parsed" : "enhanced"]).toBe(1);

    await flush();
    await openWallet(WALLET);
    expect(usageSnapshot().approxCredits).toBe(cold);
  });
});

describe("Phase C: /portfolio/history (parsed) — window 打ち切り / 増分 / 予算", () => {
  const WSOL = "So11111111111111111111111111111111111111112";
  const HOLDING = [
    {
      id: WSOL,
      interface: "FungibleToken",
      token_info: { balance: 2_000_000_000, decimals: 9, symbol: "SOL", price_info: { price_per_token: 90 } },
    },
  ];

  function walletTx(signature: string, timestamp: number, lamports: number) {
    return {
      signature,
      timestamp,
      type: "TRANSFER",
      fee: 5000,
      accountData: [{ account: WALLET, nativeBalanceChange: lamports, tokenBalanceChanges: [] }],
    };
  }

  beforeEach(() => {
    process.env.HELIUS_TX_HISTORY_API = "parsed";
    (fetchAssetsByOwner as jest.Mock).mockImplementation(async () => {
      charge(UPSTREAM_COST.das!);
      return HOLDING;
    });
  });

  it("window 内に tx が無い wallet でも点が出る (time.gte で取り切った = cutoff まで遡れている)", async () => {
    const res = await app.inject({ method: "GET", url: `/portfolio/history?wallet=${WALLET}&days=30` });
    expect(res.statusCode).toBe(200);
    expect(res.json().points.length).toBeGreaterThan(10);
    const calls = (fetchWalletTxPage as jest.Mock).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0]![1]).toEqual({ limit: 100, timeGte: expect.any(Number) });
    // cold history = 現在残高の DAS 1 回 (10) + 履歴 Parsed Events 1 page (10、window 内 0 件 → token 無しで終端)。
    // review #39: history 単独の呼び出しは wallet snapshot (8 source、52 + 直近 tx 10) を起こさない
    expect(usageSnapshot().approxCredits).toBe(20);
    expect(usageSnapshot().byApi.parsed).toBe(1);
    expect(usageSnapshot().byApi.das).toBe(1);
  });

  it("期限切れ後の再計算は afterSignature の増分 1 page、差分は signature で重複排除して merge", async () => {
    const now = Math.floor(Date.now() / 1000);
    const page = fetchWalletTxPage as jest.Mock;
    page.mockImplementationOnce(async () => {
      charge([txHistoryCall()]);
      return {
        txs: [walletTx("S2", now - 2 * 86_400, -1_000_000_000), walletTx("S1", now - 5 * 86_400, 3_000_000_000)],
        scanned: 2,
        nextCursor: { limit: 100, paginationToken: "t1", timeGte: now - 30 * 86_400 },
      };
    });
    const first = await app.inject({ method: "GET", url: `/portfolio/history?wallet=${WALLET}&days=30` });
    expect(first.statusCode).toBe(200);
    expect(page).toHaveBeenCalledTimes(2); // 2 page 目 (空) で終端
    expect(page.mock.calls[1]![1]).toMatchObject({ paginationToken: "t1" });

    // engine の TTL (5 分) と snapshot の TTL を越える
    const realNow = Date.now;
    jest.spyOn(Date, "now").mockImplementation(() => realNow() + 6 * 60_000);
    page.mockImplementationOnce(async () => {
      charge([txHistoryCall()]);
      // S2 (前回の最新) は afterSignature で排他のはずだが、重なっても二重計上しない
      return { txs: [walletTx("S3", now - 60, 500_000_000), walletTx("S2", now - 2 * 86_400, -1_000_000_000)], scanned: 2 };
    });
    _resetUsageForTest();
    const stale = await app.inject({ method: "GET", url: `/portfolio/history?wallet=${WALLET}&days=30` });
    expect(stale.json()).toEqual(first.json()); // SWR: 旧値を即返し
    for (let i = 0; i < 20 && page.mock.calls.length < 3; i++) await flush();
    expect(page).toHaveBeenCalledTimes(3);
    expect(page.mock.calls[2]![1]).toEqual({ limit: 100, afterSignature: "S2" });
    for (let i = 0; i < 5; i++) await flush();
    // 増分 refresh = 現在残高の DAS 1 回 (10) + 履歴 Parsed Events 1 page (10)。snapshot は起こさない (review #39)。
    // enhanced なら全 page の取り直し (100 × page 数) + DAS
    expect(usageSnapshot().byApi.parsed).toBe(1);
    expect(usageSnapshot().byApi.das).toBe(1);
    expect(usageSnapshot().approxCredits).toBe(20);

    // merge の結果: 現在 2 SOL − S3 (+0.5) = 1.5 (S2 以降)、さらに − S2 (−1) = 2.5 (S1〜S2 の間)。
    // S2 を二重に数えると 3.5 になる。単価は過去価格が無いので現在値 90 (近似)
    const refreshed = (await app.inject({ method: "GET", url: `/portfolio/history?wallet=${WALLET}&days=30` })).json();
    const between = refreshed.points.filter(
      (p: { at: number }) => p.at > now - 5 * 86_400 + 3600 && p.at < now - 2 * 86_400 - 3600
    );
    expect(between.length).toBeGreaterThan(0);
    for (const p of between) expect(p.usd).toBe("225.00000000");
    const afterS2 = refreshed.points.filter(
      (p: { at: number }) => p.at > now - 2 * 86_400 + 3600 && p.at < now - 3600
    );
    for (const p of afterS2) expect(p.usd).toBe("135.00000000");
  });
});
