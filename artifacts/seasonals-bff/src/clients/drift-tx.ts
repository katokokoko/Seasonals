/**
 * drift-tx — Drift spot lending client (Phase 8.15e)
 *
 * Drift は unsigned-tx REST を持たないため @drift-labs/sdk (v2.156.0 stable) を
 * BFF に bundle する (Save 8.15c と同型 — SDK object は外に出さず base64 だけ返す)。
 *
 * 実地検証済みの構成 (2026-07-10):
 *   - subscription は **websocket** (polling の BulkAccountLoader は batched JSON-RPC を
 *     使い、Helius free plan が 403 で拒否する)
 *   - DriftClient は module-level lazy singleton (subscribe ~200ms) + **mutex 直列化**
 *     (updateWallet が共有状態を書き換えるため並行 build を許さない)
 *   - 初回 deposit は createInitializeUserAccountAndDepositCollateralIxs で
 *     User account 作成 + deposit を 1 tx に合成 (4 ixs → v0 tx ~590B)
 *   - withdraw は **reduceOnly: true** (預金超が借入に転化しない、over は cap)
 *
 * 規約 (§4.5): amount は smallest-unit string → new BN(string)。SDK の BN は
 * .toString() で integer string に戻す。Number() は APY (0..1 比率) のみ。
 */

import { Connection, PublicKey } from "@solana/web3.js";
import type {
  DriftClient,
  IWallet,
  SpotPosition,
  UserAccount,
} from "@drift-labs/sdk";

import { DRIFT_MARKETS, type DriftMarket } from "@workspace/lib/config/drift-markets";

const HELIUS_MAINNET_URL = "https://mainnet.helius-rpc.com";

// SDK は重量 (~1s load、grpc 系 dep 込み) なので遅延 require。
// server.ts を import しただけの test suite / 起動パスでは load されない。
type DriftSdk = typeof import("@drift-labs/sdk");
let sdkCache: DriftSdk | null = null;
function getSdk(): DriftSdk {
  if (!sdkCache) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    sdkCache = require("@drift-labs/sdk") as DriftSdk;
  }
  return sdkCache;
}

function readOnlyWallet(publicKey: PublicKey): IWallet {
  return {
    publicKey,
    signTransaction: async (tx) => tx,
    signAllTransactions: async (txs) => txs,
  };
}

// ── singleton client + mutex ─────────────────────────────────────────────────

let clientPromise: Promise<DriftClient> | null = null;

async function getDriftClient(): Promise<DriftClient> {
  if (!clientPromise) {
    clientPromise = (async () => {
      const apiKey = process.env.HELIUS_API_KEY;
      if (!apiKey) {
        throw new Error("HELIUS_API_KEY is not set");
      }
      const connection = new Connection(
        `${HELIUS_MAINNET_URL}/?api-key=${apiKey}`,
        "confirmed"
      );
      const client = new (getSdk().DriftClient)({
        connection,
        // placeholder wallet — build 時に updateWallet で対象 user に切替える
        wallet: readOnlyWallet(PublicKey.default),
        env: "mainnet-beta",
        accountSubscription: { type: "websocket" },
        spotMarketIndexes: DRIFT_MARKETS.map((m) => m.market_index),
        perpMarketIndexes: [],
        skipLoadUsers: true,
      });
      const ok = await client.subscribe();
      if (!ok) {
        clientPromise = null;
        throw new Error("Drift client subscribe failed");
      }
      return client;
    })().catch((e) => {
      clientPromise = null; // 失敗した promise を捨てて次回リトライ可能に
      throw e;
    });
  }
  return clientPromise;
}

// 直列化: updateWallet / addUser が client 共有状態を書き換えるため
let chain: Promise<unknown> = Promise.resolve();
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => undefined);
  return next;
}

// ── tx builders ──────────────────────────────────────────────────────────────

async function buildDriftTxns(
  action: "deposit" | "withdraw",
  p: { wallet: string; market: DriftMarket; amountSmallest: string }
): Promise<{ transaction: string; firstDeposit: boolean }> {
  return serialized(async () => {
    const client = await getDriftClient();
    const user = new PublicKey(p.wallet);
    const amount = new (getSdk().BN)(p.amountSmallest);
    // authority を対象 user に切替 (subAccount の自動 load はしない)
    await client.updateWallet(readOnlyWallet(user), [], 0);
    const accounts = await client.getUserAccountsForAuthority(user);
    const hasUser = accounts.length > 0;
    // SOL (market 1) は native 扱いで wrap を SDK に任せる
    const useNative = p.market.underlying_symbol === "SOL";
    const ata = await client.getAssociatedTokenAccount(
      p.market.market_index,
      useNative,
      undefined,
      user
    );

    let ixs;
    let firstDeposit = false;
    if (action === "deposit") {
      if (!hasUser) {
        firstDeposit = true;
        const res = await client.createInitializeUserAccountAndDepositCollateralIxs(
          amount,
          ata,
          p.market.market_index,
          0
        );
        ixs = res.ixs;
      } else {
        await client.addUser(0, user, accounts[0]);
        ixs = await client.getDepositTxnIx(
          amount,
          p.market.market_index,
          ata,
          0
        );
      }
    } else {
      if (!hasUser) {
        throw new Error("No Drift account for this wallet");
      }
      await client.addUser(0, user, accounts[0]);
      // reduceOnly: 預金超 withdraw が借入化しないよう cap
      ixs = await client.getWithdrawalIxs(
        amount,
        p.market.market_index,
        ata,
        true,
        0
      );
    }

    const tx = await client.buildTransaction(ixs);
    const bytes =
      "version" in tx
        ? tx.serialize()
        : tx.serialize({ requireAllSignatures: false, verifySignatures: false });
    return {
      transaction: Buffer.from(bytes).toString("base64"),
      firstDeposit,
    };
  });
}

/** deposit unsigned tx。初回は User account 作成込み 1 tx (firstDeposit=true)。 */
export function buildDriftDepositTx(p: {
  wallet: string;
  market: DriftMarket;
  amountSmallest: string;
}): Promise<{ transaction: string; firstDeposit: boolean }> {
  return buildDriftTxns("deposit", p);
}

/** withdraw unsigned tx (reduceOnly、amount = underlying smallest-unit string)。 */
export function buildDriftWithdrawTx(p: {
  wallet: string;
  market: DriftMarket;
  amountSmallest: string;
}): Promise<{ transaction: string; firstDeposit: boolean }> {
  return buildDriftTxns("withdraw", p);
}

// ── positions read ───────────────────────────────────────────────────────────

export interface DriftSpotHolding {
  market_index: number;
  /** deposit 残高 (underlying smallest-unit string、cumulative interest 込み) */
  token_amount: string;
  /** deposit APY (0..1、取得不能なら null) */
  supply_apy: number | null;
}

// ── market-level rates (Phase 8.22、/menu-listings 用) ───────────────────────

export interface DriftMarketRate {
  /** deposit APY (0..1) */
  apy: number;
  /**
   * 稼働率 borrow/supply (0..1 clamp、Phase 8.26)。1.0 = 貸出満杯 —
   * withdraw が流動性不足で滞る可能性 (実測: USDC market が 100% のことがある)
   */
  utilization: number;
}

let ratesCache: { at: number; map: Map<number, DriftMarketRate> } | null = null;
const RATES_TTL_MS = 60_000;

/**
 * 登録 spot market の deposit APY + utilization を wallet 無しで取得 (menu 表示用)。
 * subscribe 済み client の market account を読むだけ。60s cache。
 */
export async function fetchDriftSpotMarketRates(): Promise<
  Map<number, DriftMarketRate>
> {
  if (ratesCache && Date.now() - ratesCache.at < RATES_TTL_MS) {
    return ratesCache.map;
  }
  return serialized(async () => {
    if (ratesCache && Date.now() - ratesCache.at < RATES_TTL_MS) {
      return ratesCache.map;
    }
    const client = await getDriftClient();
    const sdk = getSdk();
    const precision = Number(sdk.PERCENTAGE_PRECISION.toString());
    const map = new Map<number, DriftMarketRate>();
    for (const m of DRIFT_MARKETS) {
      const spotMarket = client.getSpotMarketAccount(m.market_index);
      if (!spotMarket) continue;
      try {
        const rate = sdk.calculateDepositRate(spotMarket);
        const util = sdk.calculateUtilization(spotMarket);
        map.set(m.market_index, {
          apy: Number(rate.toString()) / precision,
          utilization: Math.min(1, Number(util.toString()) / precision),
        });
      } catch {
        // 取得不能 market は skip (menu は fixture 値のまま)
      }
    }
    ratesCache = { at: Date.now(), map };
    return map;
  });
}

/**
 * wallet の Drift spot deposit 残高 (登録 market のみ、全 subaccount 合算)。
 * scaledBalance → token amount は SDK の getTokenAmount (interest 込み変換)。
 */
export async function fetchDriftSpotPositions(
  wallet: string
): Promise<DriftSpotHolding[]> {
  return serialized(async () => {
    const client = await getDriftClient();
    const sdk = getSdk();
    const user = new PublicKey(wallet);
    const accounts: UserAccount[] = await client.getUserAccountsForAuthority(user);
    if (accounts.length === 0) return [];

    const out: DriftSpotHolding[] = [];
    for (const m of DRIFT_MARKETS) {
      const spotMarket = client.getSpotMarketAccount(m.market_index);
      if (!spotMarket) continue;
      let total = new sdk.BN(0);
      for (const acc of accounts) {
        for (const pos of acc.spotPositions as SpotPosition[]) {
          if (pos.marketIndex !== m.market_index) continue;
          if (!("deposit" in (pos.balanceType as object))) continue; // borrow は除外
          if (pos.scaledBalance.isZero()) continue;
          total = total.add(
            sdk.getTokenAmount(pos.scaledBalance, spotMarket, pos.balanceType)
          );
        }
      }
      if (total.isZero()) continue;
      // APY: calculateDepositRate は PERCENTAGE_PRECISION (1e6) スケール
      let apy: number | null = null;
      try {
        const rate = sdk.calculateDepositRate(spotMarket);
        apy = Number(rate.toString()) / Number(sdk.PERCENTAGE_PRECISION.toString());
      } catch {
        apy = null;
      }
      out.push({
        market_index: m.market_index,
        token_amount: total.toString(),
        supply_apy: apy,
      });
    }
    return out;
  });
}
