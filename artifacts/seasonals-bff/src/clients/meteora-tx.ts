/**
 * meteora-tx — Meteora DLMM LP client (Phase 8.17)
 *
 * @meteora-ag/dlmm v1.9.12 を lazy require で bundle (save と同型 — SDK は BFF 内に
 * 閉じ、base64 / string だけ返す)。module export は DLMM class そのもの
 * (`module.exports = DLMM`、statics に create / StrategyType 等)。
 *
 * 実地検証済み (2026-07-10):
 *   - 両 pool の X/Y mint・activeBin price を on-chain 確認
 *   - single-sided deposit: initializePositionAndAddLiquidityByStrategy
 *     (deposit 側でない amount を BN(0)) → 単一 legacy Transaction
 *   - **ephemeral position keypair の部分署名**: legacy → v0 変換 →
 *     vtx.sign([positionKeypair]) → serialize/deserialize round-trip で署名保持を確認
 *
 * §32.2 "秘密鍵を保持しない" との整合:
 *   ここで生成する Keypair は **position account のアドレス用 ephemeral** であり、
 *   user の資金鍵ではない (position の owner/withdraw 権限は user pubkey。keypair は
 *   tx build 後に参照を捨て、漏れても資金リスク無し)。mobile / lib は Keypair 0 件を維持。
 *
 * §4.5: amount は smallest-unit string → BN(string)。SDK の string/BN 返り値は
 * integer string に正規化して返す (decimal 揺れは server 側 mapper が吸収)。
 */

import { Connection, Keypair, PublicKey } from "@solana/web3.js";

import {
  METEORA_MARKETS,
  type MeteoraDlmmMarket,
} from "@workspace/lib/config/meteora-markets";
import { toV0Base64 } from "./tx-utils";

const HELIUS_MAINNET_URL = "https://mainnet.helius-rpc.com";
/** active bin から片側に取る bin 数 (Spot strategy、range UI を出さない preset) */
const ONE_SIDED_BINS = 20;
/** 全量 withdraw の bps */
export const FULL_WITHDRAW_BPS = 10_000;

// ── lazy SDK ─────────────────────────────────────────────────────────────────

type DlmmClass = typeof import("@meteora-ag/dlmm").default;
type DlmmInstance = InstanceType<DlmmClass>;
type InitParams = Parameters<DlmmInstance["initializePositionAndAddLiquidityByStrategy"]>[0];
type DlmmBN = InitParams["totalXAmount"];

let sdkCache: (DlmmClass & { StrategyType: { Spot: number } }) | null = null;
function getDlmm(): DlmmClass & { StrategyType: { Spot: number } } {
  if (!sdkCache) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    sdkCache = require("@meteora-ag/dlmm") as DlmmClass & {
      StrategyType: { Spot: number };
    };
  }
  return sdkCache;
}

function bn(value: string | number): DlmmBN {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const BN = require("bn.js");
  return new BN(value) as DlmmBN;
}

function getConnection(): Connection {
  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey) throw new Error("HELIUS_API_KEY is not set");
  return new Connection(`${HELIUS_MAINNET_URL}/?api-key=${apiKey}`, "confirmed");
}

// pool instance cache (60s — activeBin/state は build 時に SDK が再読するため軽め)
const poolCache = new Map<string, { at: number; pool: DlmmInstance }>();
const POOL_TTL_MS = 60_000;

async function getPool(market: MeteoraDlmmMarket): Promise<DlmmInstance> {
  const hit = poolCache.get(market.pool_address);
  if (hit && Date.now() - hit.at < POOL_TTL_MS) return hit.pool;
  const DLMM = getDlmm();
  const pool = await DLMM.create(
    getConnection(),
    new PublicKey(market.pool_address)
  );
  poolCache.set(market.pool_address, { at: Date.now(), pool });
  return pool;
}

// v0 変換 + ephemeral 部分署名は共通 helper (clients/tx-utils.ts) を使用 (8.18 で共通化)

// ── deposit ──────────────────────────────────────────────────────────────────

/**
 * single-sided deposit (deposit_mint の 1 トークンのみ)。
 * Spot strategy で active bin から片側 ONE_SIDED_BINS に配分。
 * 返り値の tx は **position ephemeral 分を部分署名済み** — user (feePayer) 署名は空。
 */
export async function buildMeteoraDepositTxns(p: {
  wallet: string;
  market: MeteoraDlmmMarket;
  amountSmallest: string;
}): Promise<{ transactions: string[]; position: string }> {
  const DLMM = getDlmm();
  const pool = await getPool(p.market);
  const user = new PublicKey(p.wallet);
  const active = await pool.getActiveBin();
  const depositIsX = p.market.deposit_side === "x";
  const minBinId = depositIsX ? active.binId : active.binId - ONE_SIDED_BINS;
  const maxBinId = depositIsX ? active.binId + ONE_SIDED_BINS : active.binId;

  // §32.2: position account 用 ephemeral (user 鍵ではない。build 後に破棄)
  const positionKeypair = Keypair.generate();
  const amount = bn(p.amountSmallest);
  const tx = await pool.initializePositionAndAddLiquidityByStrategy({
    positionPubKey: positionKeypair.publicKey,
    totalXAmount: depositIsX ? amount : bn(0),
    totalYAmount: depositIsX ? bn(0) : amount,
    strategy: {
      minBinId,
      maxBinId,
      strategyType: DLMM.StrategyType.Spot,
    },
    user,
  });
  const transactions = await toV0Base64(getConnection(), [tx], user, [positionKeypair]);
  return { transactions, position: positionKeypair.publicKey.toBase58() };
}

// ── positions read (raw — § 数値変換は server 側 mapper が行う) ───────────────

export interface MeteoraRawPosition {
  pool_id: string;
  position_address: string;
  /** SDK の string をそのまま (integer/decimal 揺れは mapper が正規化) */
  total_x: string;
  total_y: string;
  fee_x: string;
  fee_y: string;
  /** activeBin.price — X smallest 1 単位あたりの Y smallest (decimal string) */
  price_raw: string;
  lower_bin_id: number;
  upper_bin_id: number;
}

export async function fetchMeteoraPositions(
  wallet: string
): Promise<MeteoraRawPosition[]> {
  const user = new PublicKey(wallet);
  const out: MeteoraRawPosition[] = [];
  for (const market of METEORA_MARKETS) {
    const pool = await getPool(market);
    const { activeBin, userPositions } = await pool.getPositionsByUserAndLbPair(user);
    for (const pos of userPositions) {
      out.push({
        pool_id: market.pool_id,
        position_address: pos.publicKey.toBase58(),
        total_x: String(pos.positionData.totalXAmount),
        total_y: String(pos.positionData.totalYAmount),
        fee_x: pos.positionData.feeX.toString(),
        fee_y: pos.positionData.feeY.toString(),
        price_raw: String(activeBin.price),
        lower_bin_id: pos.positionData.lowerBinId,
        upper_bin_id: pos.positionData.upperBinId,
      });
    }
  }
  return out;
}

// ── pool stats (Phase 8.24 — 新データ API dlmm.datapi.meteora.ag) ─────────────

const METEORA_DATAPI_URL = "https://dlmm.datapi.meteora.ag";

export interface MeteoraPoolStats {
  /** 24h ベース APY (bps)。API は % 単位で返すため ×100 で bps 化 */
  apy_bps: number;
  /** 表示専用 USD (§4.5 適用外) */
  tvl_usd: number;
}

let statsCache: { at: number; map: Map<string, MeteoraPoolStats> } | null = null;
const STATS_TTL_MS = 60_000;

/**
 * 旧 dlmm-api.meteora.ag は撤去済 (全 route 404、2026-07 確認)。後継の
 * dlmm.datapi.meteora.ag (docs.meteora.ag/llms.txt 記載、auth 不要) から
 * 登録 pool の apy/tvl を取得。**apr/apy は % 単位** (apr 0.0036/日 ↔
 * apy 1.338/年 の整合を live 確認済) — fraction と取り違えないこと。
 * global fetch は isomorphic-fetch (solend) に上書きされているため
 * undici (Node native 実装) を明示利用 (orca-tx と同じ対策)。
 */
export async function fetchMeteoraPoolStats(): Promise<
  Map<string, MeteoraPoolStats>
> {
  if (statsCache && Date.now() - statsCache.at < STATS_TTL_MS) {
    return statsCache.map;
  }
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { fetch: undiciFetch } = require("undici") as { fetch: typeof fetch };
  const map = new Map<string, MeteoraPoolStats>();
  const results = await Promise.allSettled(
    METEORA_MARKETS.map(async (m) => {
      const res = await undiciFetch(
        `${METEORA_DATAPI_URL}/pools/${m.pool_address}`,
        { headers: { accept: "application/json" } }
      );
      if (!res.ok) throw new Error(`Meteora datapi HTTP ${res.status}`);
      const json = (await res.json()) as {
        data?: { apy?: number; tvl?: number };
        apy?: number;
        tvl?: number;
      };
      return [m.pool_address, json.data ?? json] as const;
    })
  );
  for (const r of results) {
    if (r.status !== "fulfilled") continue;
    const [addr, p] = r.value;
    if (typeof p.apy !== "number" || !Number.isFinite(p.apy)) continue;
    map.set(addr, {
      apy_bps: Math.round(p.apy * 100), // % → bps
      tvl_usd: typeof p.tvl === "number" && Number.isFinite(p.tvl) ? p.tvl : 0,
    });
  }
  if (map.size === 0) throw new Error("Meteora datapi: no pool stats");
  statsCache = { at: Date.now(), map };
  return map;
}

// ── withdraw ─────────────────────────────────────────────────────────────────

/**
 * remove liquidity (bps 指定、10000 = 全量 + fee claim + close)。
 * user 単独署名 (ephemeral 不要) の unsigned v0 tx 群。
 */
export async function buildMeteoraWithdrawTxns(p: {
  wallet: string;
  market: MeteoraDlmmMarket;
  positionAddress: string;
  bps: number;
  fromBinId: number;
  toBinId: number;
}): Promise<{ transactions: string[] }> {
  const pool = await getPool(p.market);
  const user = new PublicKey(p.wallet);
  const txs = await pool.removeLiquidity({
    user,
    position: new PublicKey(p.positionAddress),
    fromBinId: p.fromBinId,
    toBinId: p.toBinId,
    bps: bn(p.bps),
    shouldClaimAndClose: p.bps === FULL_WITHDRAW_BPS,
  });
  const list = Array.isArray(txs) ? txs : [txs];
  const transactions = await toV0Base64(getConnection(), list, user, []);
  return { transactions };
}
