/**
 * save-tx — Save (旧 Solend) main pool client (Phase 8.15c)
 *
 * tx 構築は @solendprotocol/solend-sdk 0.14.27 の SolendActionCore を使う
 * (unsigned-tx REST が無いため)。data は api.save.finance の REST:
 *   - /v1/markets/configs → pool/reserve の SDK 入力 config (oracle / fee receiver)
 *   - /v1/reserves?ids=  → supplyInterest (% string) + cTokenExchangeRate
 *
 * flow は pure-supply (reserve liquidity):
 *   deposit  = buildDepositReserveLiquidityTxns  (underlying → cToken を wallet に mint)
 *   withdraw = buildRedeemReserveCollateralTxns  (cToken → underlying)
 * ※ obligation collateral 型 (buildDepositTxns) は使わない — cToken を wallet に残し、
 *   positions/withdraw を mint-keyed (8.15 LST パターン) に統一するため。
 *
 * SDK は自前の web3.js 1.92.3 を固定依存に持つ (BFF は 1.95.3)。class の private field
 * 差で nominal 型が合わないため、SDK 境界は Parameters<> 抽出型 + cast で渡す。
 * runtime は RPC surface が互換なので問題ない。SDK object は外に出さず、
 * VersionedTransaction を base64 化した string[] だけを返す (§4.5: amount は
 * smallest-unit string を SDK に passthrough、parse しない)。
 */

import { Connection, PublicKey } from "@solana/web3.js";
import { SolendActionCore } from "@solendprotocol/solend-sdk";

import type { SaveMarket } from "@workspace/lib/config/save-markets";
import { fetchWithTimeout } from "./http"; // Phase 8.38 (B9): 共通 timeout

const SAVE_API_BASE = "https://api.save.finance";
const HELIUS_MAINNET_URL = "https://mainnet.helius-rpc.com";

// ── SDK 境界型 (InputPoolType 等は SDK から export されていないため Parameters<> で抽出) ──
type BuildFn = typeof SolendActionCore.buildDepositReserveLiquidityTxns;
type SdkPool = Parameters<BuildFn>[0];
type SdkReserve = Parameters<BuildFn>[1];
type SdkConnection = Parameters<BuildFn>[2];
type SdkWallet = Parameters<BuildFn>[4];
type SdkConfig = Parameters<BuildFn>[5];

function getMainnetConnection(): Connection {
  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey) {
    throw new Error("HELIUS_API_KEY is not set");
  }
  return new Connection(`${HELIUS_MAINNET_URL}/?api-key=${apiKey}`, "confirmed");
}

// ── market config (SDK 入力) — REST から取得して 10 分 cache ──────────────────

interface RawConfigReserve {
  address: string;
  liquidityAddress: string;
  collateralMintAddress: string;
  collateralSupplyAddress: string;
  pythOracle: string;
  switchboardOracle: string;
  extraOracle?: string;
  liquidityFeeReceiverAddress: string;
  liquidityToken: { mint: string; symbol: string; decimals: number };
}
interface RawConfigMarket {
  name: string | null;
  address: string;
  owner: string;
  authorityAddress: string;
  lookupTableAddress?: string;
  reserves: RawConfigReserve[];
}

let configCache: { at: number; markets: RawConfigMarket[] } | null = null;
const CONFIG_TTL_MS = 10 * 60 * 1000;

async function fetchMarketConfigs(): Promise<RawConfigMarket[]> {
  if (configCache && Date.now() - configCache.at < CONFIG_TTL_MS) {
    return configCache.markets;
  }
  const res = await fetchWithTimeout(
    `${SAVE_API_BASE}/v1/markets/configs?scope=solend&deployment=production`,
    { headers: { accept: "application/json" } }
  );
  if (!res.ok) {
    throw new Error(`Save configs HTTP ${res.status}`);
  }
  const markets = (await res.json()) as RawConfigMarket[];
  configCache = { at: Date.now(), markets };
  return markets;
}

/** SaveMarket (lib registry) → SDK の pool/reserve 入力を REST config から解決。 */
async function resolveSdkInputs(
  market: SaveMarket
): Promise<{ pool: SdkPool; reserve: SdkReserve; lookupTableAddress?: string }> {
  const markets = await fetchMarketConfigs();
  const pool = markets.find((m) => m.address === market.market);
  if (!pool) {
    throw new Error(`Save market config not found: ${market.market}`);
  }
  const raw = pool.reserves.find((r) => r.address === market.reserve);
  if (!raw) {
    throw new Error(`Save reserve config not found: ${market.reserve}`);
  }
  const sdkPool = {
    address: pool.address,
    owner: pool.owner,
    name: pool.name,
    authorityAddress: pool.authorityAddress,
    reserves: pool.reserves.map((r) => ({
      address: r.address,
      pythOracle: r.pythOracle,
      switchboardOracle: r.switchboardOracle,
      mintAddress: r.liquidityToken.mint,
      liquidityFeeReceiverAddress: r.liquidityFeeReceiverAddress,
      extraOracle: r.extraOracle,
    })),
  } as SdkPool;
  const sdkReserve = {
    address: raw.address,
    liquidityAddress: raw.liquidityAddress,
    cTokenMint: raw.collateralMintAddress,
    cTokenLiquidityAddress: raw.collateralSupplyAddress,
    pythOracle: raw.pythOracle,
    switchboardOracle: raw.switchboardOracle,
    mintAddress: raw.liquidityToken.mint,
    liquidityFeeReceiverAddress: raw.liquidityFeeReceiverAddress,
  } as SdkReserve;
  return { pool: sdkPool, reserve: sdkReserve, lookupTableAddress: pool.lookupTableAddress };
}

// ── tx builders ──────────────────────────────────────────────────────────────

async function buildSaveTxns(
  action: "deposit" | "withdraw",
  p: { wallet: string; market: SaveMarket; amount: string }
): Promise<{ transactions: string[] }> {
  const connection = getMainnetConnection();
  const { pool, reserve, lookupTableAddress } = await resolveSdkInputs(p.market);
  const wallet = {
    publicKey: new PublicKey(p.wallet),
  } as unknown as SdkWallet;
  const config = {
    environment: "production",
    lookupTableAddress: lookupTableAddress
      ? new PublicKey(lookupTableAddress)
      : undefined,
  } as unknown as SdkConfig;

  const builder =
    action === "deposit"
      ? SolendActionCore.buildDepositReserveLiquidityTxns
      : SolendActionCore.buildRedeemReserveCollateralTxns;
  const solendAction = await builder(
    pool,
    reserve,
    connection as unknown as SdkConnection,
    p.amount, // smallest-unit string passthrough (§4.5)
    wallet,
    config
  );

  const blockhash = await connection.getLatestBlockhash("confirmed");
  const { preLendingTxn, lendingTxn, postLendingTxn, pullPriceTxns } =
    await solendAction.getTransactions(blockhash);

  // submit 順: oracle pull → pre (ATA 等) → 本体 → post。非 null のみ base64 化。
  const ordered = [
    ...(pullPriceTxns ?? []),
    preLendingTxn,
    lendingTxn,
    postLendingTxn,
  ].filter((t): t is NonNullable<typeof t> => t != null);
  if (ordered.length === 0) {
    throw new Error(`Save ${action}: SDK returned no transactions`);
  }
  return {
    transactions: ordered.map((t) =>
      Buffer.from(t.serialize()).toString("base64")
    ),
  };
}

/** deposit unsigned txns (underlying → cToken、amount = underlying smallest-unit string) */
export function buildSaveDepositTxns(p: {
  wallet: string;
  market: SaveMarket;
  amount: string;
}): Promise<{ transactions: string[] }> {
  return buildSaveTxns("deposit", p);
}

/** withdraw (redeem) unsigned txns (cToken → underlying、amount = cToken smallest-unit string) */
export function buildSaveWithdrawTxns(p: {
  wallet: string;
  market: SaveMarket;
  amount: string;
}): Promise<{ transactions: string[] }> {
  return buildSaveTxns("withdraw", p);
}

// ── reserve rates (APY + cToken exchange rate) ───────────────────────────────

export interface SaveReserveRate {
  reserve: string;
  /** supply APY (0..1 fraction) */
  supply_apy: number;
  /** cToken → underlying の交換レート (decimal string、表示/換算用) */
  ctoken_exchange_rate: string;
}

export async function fetchSaveReserveRates(
  reserveIds: string[]
): Promise<SaveReserveRate[]> {
  if (reserveIds.length === 0) return [];
  const res = await fetchWithTimeout(
    `${SAVE_API_BASE}/v1/reserves?ids=${reserveIds.join(",")}`,
    { headers: { accept: "application/json" } }
  );
  if (!res.ok) {
    throw new Error(`Save reserves HTTP ${res.status}`);
  }
  const json = (await res.json()) as {
    results?: {
      reserve?: { pubkey?: string };
      rates?: { supplyInterest?: string };
      cTokenExchangeRate?: string;
    }[];
  };
  const out: SaveReserveRate[] = [];
  for (const item of json.results ?? []) {
    const pubkey = item.reserve?.pubkey;
    if (!pubkey) continue;
    // supplyInterest は "% 表記の比率 string" ("2.03" = 2.03%)。0..1 に正規化
    // (§4.5 適用外: APY は Number 精度で十分)。
    const pct = Number(item.rates?.supplyInterest);
    out.push({
      reserve: pubkey,
      supply_apy: Number.isFinite(pct) ? pct / 100 : 0,
      ctoken_exchange_rate: item.cTokenExchangeRate ?? "1",
    });
  }
  return out;
}
