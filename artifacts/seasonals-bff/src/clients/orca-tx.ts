/**
 * orca-tx — Orca Whirlpools full-range LP client (Phase 8.18)
 *
 * legacy @orca-so/whirlpools-sdk v0.21.0 (web3.js v1) を lazy require で bundle
 * (save / meteora と同型 — SDK は BFF 内に閉じ、base64 / string だけ返す)。
 *
 * deposit は **zap-in の 2 tx**:
 *   tx1 = Jupiter swap (入金 USDC の半分 → 相方 token、user 単独署名)
 *   tx2 = full-range open + increase (position mint ephemeral の部分署名済み)
 * full-range CLMM は両 token を価格比で要求するため、swap 脚で single-token 入金に
 * 変換する。increase 側入力は swap 見積 outAmount × 99/100 (1% margin) — quote の
 * tokenMax が実消費を制限し、swap 端数 / 未消費分 (dust) は wallet に残る仕様。
 *
 * 実地検証済み (2026-07-10、orca-boot.mjs):
 *   - 両 pool の A/B mint・tickSpacing on-chain 確認
 *   - openPosition → tx.build() の payload.transaction は **既に VersionedTransaction**、
 *     payload.signers = [position mint keypair]
 *   - 部分署名 round-trip: sig 状態 0:EMPTY (user) / 1:SIGNED (mint) 保持
 *
 * §32.2 "秘密鍵を保持しない" との整合:
 *   部分署名する keypair は SDK が内部生成する **position mint (NFT) 用 ephemeral**
 *   であり、user の資金鍵ではない (position の owner/withdraw 権限は user pubkey。
 *   build 後に参照を捨て、漏れても資金リスク無し)。mobile / lib は Keypair 0 件を維持。
 *
 * §4.5: amount は smallest-unit string → bigint / BN(string)。BN 返り値は
 * .toString() で integer string に正規化して返す。
 */

import { Connection, PublicKey } from "@solana/web3.js";

import {
  ORCA_MARKETS,
  type OrcaWhirlpoolMarket,
} from "@workspace/lib/config/orca-markets";
import { fetchSwapQuote, fetchSwapTransaction } from "./jupiter-swap";
import { toV0Base64 } from "./tx-utils";
import { heliusRpcFetch } from "./helius-limiter";
import { TtlCache } from "../cache/ttl-cache";

const HELIUS_MAINNET_URL = "https://mainnet.helius-rpc.com";
const ORCA_STATS_URL = "https://api.mainnet.orca.so/v1/whirlpool/list";
/** 全量 withdraw の bps (meteora と同一慣習) */
export const ORCA_FULL_WITHDRAW_BPS = 10_000;
/** zap 第2脚の入力 margin (swap 実受領が見積を下回る分の吸収): outAmount × 99/100 */
const ZAP_MARGIN_NUM = 99n;
const ZAP_MARGIN_DEN = 100n;

// ── lazy SDK ─────────────────────────────────────────────────────────────────

type OrcaSdk = typeof import("@orca-so/whirlpools-sdk");
type CommonSdk = typeof import("@orca-so/common-sdk");
// BN は anchor (直接依存) 経由で取得 — bn.js は @types が無い
type AnchorLib = typeof import("@coral-xyz/anchor");
type BN = InstanceType<AnchorLib["BN"]>;

let orcaCache: OrcaSdk | null = null;
function getOrca(): OrcaSdk {
  if (!orcaCache) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    orcaCache = require("@orca-so/whirlpools-sdk") as OrcaSdk;
  }
  return orcaCache;
}

let commonCache: CommonSdk | null = null;
function getCommon(): CommonSdk {
  if (!commonCache) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    commonCache = require("@orca-so/common-sdk") as CommonSdk;
  }
  return commonCache;
}

function bn(value: string | number | bigint): BN {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { BN: BNClass } = require("@coral-xyz/anchor") as AnchorLib;
  return new BNClass(value.toString());
}

function getConnection(): Connection {
  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey) throw new Error("HELIUS_API_KEY is not set");
  // B1: SDK の RPC read も Helius の列 (同時実行数 / 間隔) に並べ、usage に数える
  return new Connection(`${HELIUS_MAINNET_URL}/?api-key=${apiKey}`, { commitment: "confirmed", fetch: heliusRpcFetch });
}

/** 1% slippage (increase / decrease quote 共通、boot 検証値) */
function slippage() {
  return getCommon().Percentage.fromFraction(1, 100);
}

/**
 * read-only wallet stub — BFF は署名しない (署名は mobile MWA)。
 * ctx.wallet は builder の default owner/funder 解決にのみ使われる。
 */
function ctxAndClient(user: PublicKey) {
  const orca = getOrca();
  const wallet = {
    publicKey: user,
    signTransaction: async (tx: unknown) => tx,
    signAllTransactions: async (txs: unknown) => txs,
  } as unknown as Parameters<typeof orca.WhirlpoolContext.from>[1];
  const ctx = orca.WhirlpoolContext.from(
    getConnection(),
    wallet,
    undefined,
    undefined,
    undefined,
    orca.ORCA_WHIRLPOOL_PROGRAM_ID
  );
  return { ctx, client: orca.buildWhirlpoolClient(ctx) };
}

/**
 * B2: 共有 pool cache (下の readPoolCache) の miss を読む read-only context は module で 1 つ。
 * wallet stub は default owner/funder の解決にしか使われないので user に依らない。
 * HELIUS_API_KEY が変わったら作り直す (test / key rotation)。
 *
 * **positions の読みには使わない**: SDK の SimpleAccountFetcher (common-sdk 0.7) の cache は
 * set のみで evict しない Map で、getAllPositionAccountsByOwner は IGNORE_CACHE でも候補 position
 * PDA を全部書き込む。共有すると問い合わせた全 wallet の口座が process 寿命で溜まる (multi-user BFF)。
 * pool の読みが書くのは ORCA_MARKETS の pool と付随口座だけなので有界。
 * positions / deposit / withdraw は呼び出しごとの context (= 呼び出し後に GC される fetcher)
 */
let readCtx: { apiKey: string; value: ReturnType<typeof ctxAndClient> } | null = null;
function readOnlyCtxAndClient(): ReturnType<typeof ctxAndClient> {
  const apiKey = process.env.HELIUS_API_KEY ?? "";
  if (!readCtx || readCtx.apiKey !== apiKey) {
    readCtx = { apiKey, value: ctxAndClient(PublicKey.default) };
  }
  return readCtx.value;
}

type OrcaWhirlpool = Awaited<ReturnType<ReturnType<typeof ctxAndClient>["client"]["getPool"]>>;

/**
 * B2: positions 表示用の pool (sqrtPrice 等) を全 user で共有 (30 秒、同時 miss は 1 回の取得に合流)。
 * 我々の miss では SDK 側 fetcher cache を使わず読む (IGNORE_CACHE — cache を二重にしない)。
 * deposit / withdraw の tx build は live の getPool のまま
 */
const readPoolCache = new TtlCache<OrcaWhirlpool>({
  name: "orca.pool",
  ttlMs: 30_000,
  maxEntries: 20,
  now: () => Date.now(),
});

function getReadPool(poolAddress: string): Promise<OrcaWhirlpool> {
  return readPoolCache.getOrLoad(poolAddress, () =>
    readOnlyCtxAndClient().client.getPool(poolAddress, getOrca().IGNORE_CACHE)
  );
}

// ── deposit (zap-in) ─────────────────────────────────────────────────────────

/**
 * zap-in deposit: [tx1 = Jupiter swap 半分, tx2 = full-range open+increase]。
 * tx2 は position mint ephemeral 分を部分署名済み — user (feePayer) 署名は空。
 * tx1 成功 + tx2 失敗でも資金は wallet に残る (swap 結果 + 未消費 USDC)。
 */
export async function buildOrcaDepositTxns(p: {
  wallet: string;
  market: OrcaWhirlpoolMarket;
  amountSmallest: string;
}): Promise<{ transactions: string[]; position: string }> {
  const orca = getOrca();
  const user = new PublicKey(p.wallet);
  const total = BigInt(p.amountSmallest);
  const half = total / 2n;
  if (half <= 0n) throw new Error("amount too small for zap-in");

  // tx1: 入金 token の半分を相方 token へ (残り total - half >= half が increase の原資)
  const swapQuote = await fetchSwapQuote({
    inputMint: p.market.deposit_mint,
    outputMint: p.market.other_mint,
    amount: half.toString(),
    slippageBps: 50,
  });
  const swapTx = await fetchSwapTransaction({
    quoteResponse: swapQuote,
    userPublicKey: p.wallet,
  });

  // tx2: full-range open + increase — 相方側入力 = swap 見積 × 99/100
  const { ctx, client } = ctxAndClient(user);
  const pool = await client.getPool(p.market.pool_address);
  const data = pool.getData();
  const [lower, upper] = orca.TickUtil.getFullRangeTickIndex(data.tickSpacing);
  const tokenExtensionCtx = await orca.TokenExtensionUtil.buildTokenExtensionContext(
    ctx.fetcher,
    data
  );
  const otherInput = (BigInt(swapQuote.outAmount) * ZAP_MARGIN_NUM) / ZAP_MARGIN_DEN;
  if (otherInput <= 0n) throw new Error("swap quote outAmount too small");
  const quote = orca.increaseLiquidityQuoteByInputTokenWithParams({
    inputTokenAmount: bn(otherInput),
    inputTokenMint: new PublicKey(p.market.other_mint),
    tokenMintA: pool.getTokenAInfo().mint,
    tokenMintB: pool.getTokenBInfo().mint,
    tickCurrentIndex: data.tickCurrentIndex,
    sqrtPrice: data.sqrtPrice,
    tickLowerIndex: lower,
    tickUpperIndex: upper,
    slippageTolerance: slippage(),
    tokenExtensionCtx,
  });
  // 型上は ByTokenAmountsParams (min/maxSqrtPrice 必須) だが、runtime は option —
  // 未指定なら価格 bound 無しで、消費上限は quote.tokenMaxA/B (1% slippage) が守る
  // (orca-boot.mjs で quote 直渡しの build + 部分署名 round-trip を実地検証済)
  const { positionMint, tx } = await pool.openPosition(
    lower,
    upper,
    quote as unknown as Parameters<typeof pool.openPosition>[2],
    user,
    user
  );
  // §32.2: payload.signers = position mint 用 ephemeral (user 鍵ではない。ここで破棄)
  const payload = await tx.build();
  const openTxs = await toV0Base64(
    getConnection(),
    [payload.transaction],
    user,
    payload.signers
  );
  return {
    transactions: [swapTx.swapTransaction, ...openTxs],
    position: positionMint.toBase58(),
  };
}

// ── positions read (raw — 数値変換は server 側 mapper が行う) ─────────────────

export interface OrcaRawPosition {
  pool_id: string;
  /** position account (PDA) address */
  position_address: string;
  /** position mint (NFT) — EarnPosition.share_mint に流用 */
  position_mint: string;
  liquidity: string;
  /** 現在価格での token A / B 換算量 (smallest unit integer string) */
  token_a: string;
  token_b: string;
  fee_owed_a: string;
  fee_owed_b: string;
  /** pool の sqrtPrice (X64、integer string) — B/A 価格換算は mapper が bigint で行う */
  sqrt_price: string;
  tick_lower: number;
  tick_upper: number;
}

export async function fetchOrcaPositions(
  wallet: string
): Promise<OrcaRawPosition[]> {
  const orca = getOrca();
  const user = new PublicKey(wallet);
  // 呼び出しごとの context: fetcher cache に溜まる position 口座を呼び出しと一緒に捨てる
  // (共有 context だと wallet ごとの口座が evict されず残る — readOnlyCtxAndClient の注記)
  const { ctx } = ctxAndClient(user);
  const map = await orca.getAllPositionAccountsByOwner({
    ctx,
    owner: user,
    includesPositions: true,
    includesPositionsWithTokenExtensions: true,
    includesBundledPositions: false,
  });
  const entries = [
    ...map.positions.entries(),
    ...map.positionsWithTokenExtensions.entries(),
  ];
  const out: OrcaRawPosition[] = [];
  for (const market of ORCA_MARKETS) {
    const hits = entries.filter(
      ([, pos]) => pos.whirlpool.toBase58() === market.pool_address
    );
    if (hits.length === 0) continue;
    const pool = await getReadPool(market.pool_address);
    const data = pool.getData();
    for (const [address, pos] of hits) {
      const amounts = orca.PoolUtil.getTokenAmountsFromLiquidity(
        pos.liquidity,
        data.sqrtPrice,
        orca.PriceMath.tickIndexToSqrtPriceX64(pos.tickLowerIndex),
        orca.PriceMath.tickIndexToSqrtPriceX64(pos.tickUpperIndex),
        false
      );
      out.push({
        pool_id: market.pool_id,
        position_address: address.toString(),
        position_mint: pos.positionMint.toBase58(),
        liquidity: pos.liquidity.toString(),
        token_a: amounts.tokenA.toString(),
        token_b: amounts.tokenB.toString(),
        fee_owed_a: pos.feeOwedA.toString(),
        fee_owed_b: pos.feeOwedB.toString(),
        sqrt_price: data.sqrtPrice.toString(),
        tick_lower: pos.tickLowerIndex,
        tick_upper: pos.tickUpperIndex,
      });
    }
  }
  return out;
}

// ── withdraw ─────────────────────────────────────────────────────────────────

/**
 * withdraw (bps 指定):
 *   10000 → closePosition (fee 回収 + 全流動性引出 + position NFT burn / rent 回収)
 *   <10000 → decreaseLiquidity (liquidity × bps / 10000。fee は close 時に回収 —
 *            meteora の部分 withdraw と同じ意味論)
 * user 単独署名の unsigned v0 tx 群 (ephemeral 不要)。
 */
export async function buildOrcaWithdrawTxns(p: {
  wallet: string;
  market: OrcaWhirlpoolMarket;
  positionMint: string;
  bps: number;
}): Promise<{ transactions: string[] }> {
  const orca = getOrca();
  const user = new PublicKey(p.wallet);
  const { ctx, client } = ctxAndClient(user);
  const positionPda = orca.PDAUtil.getPosition(
    ctx.program.programId,
    new PublicKey(p.positionMint)
  ).publicKey;

  const payloads: {
    transaction: import("@solana/web3.js").Transaction | import("@solana/web3.js").VersionedTransaction;
    signers: import("@solana/web3.js").Signer[];
  }[] = [];
  if (p.bps >= ORCA_FULL_WITHDRAW_BPS) {
    const pool = await client.getPool(p.market.pool_address);
    const builders = await pool.closePosition(positionPda, slippage());
    for (const b of builders) payloads.push(await b.build());
  } else {
    const position = await client.getPosition(positionPda);
    const posData = position.getData();
    const poolData = (await client.getPool(p.market.pool_address)).getData();
    const part =
      (BigInt(posData.liquidity.toString()) * BigInt(p.bps)) /
      BigInt(ORCA_FULL_WITHDRAW_BPS);
    if (part <= 0n) throw new Error("withdraw amount too small");
    const tokenExtensionCtx =
      await orca.TokenExtensionUtil.buildTokenExtensionContext(ctx.fetcher, poolData);
    const quote = orca.decreaseLiquidityQuoteByLiquidityWithParams({
      liquidity: bn(part),
      tickCurrentIndex: poolData.tickCurrentIndex,
      sqrtPrice: poolData.sqrtPrice,
      tickLowerIndex: posData.tickLowerIndex,
      tickUpperIndex: posData.tickUpperIndex,
      tokenExtensionCtx,
      slippageTolerance: slippage(),
    });
    payloads.push(await (await position.decreaseLiquidity(quote)).build());
  }
  const transactions = await toV0Base64(
    getConnection(),
    payloads.map((pl) => pl.transaction),
    user,
    payloads.flatMap((pl) => pl.signers)
  );
  return { transactions };
}

// ── pool stats (実 APY / TVL — live API、auth 不要) ──────────────────────────

export interface OrcaPoolStats {
  /** UI 表示専用 (§4.5 適用外の比率/概算値) */
  tvl_usd: number;
  /** totalApr.day (0..1 fraction) → bps */
  apr_day_bps: number;
}

let statsCache: { at: number; map: Map<string, OrcaPoolStats> } | null = null;
const STATS_TTL_MS = 60_000;

/**
 * global fetch は solend-sdk の isomorphic-fetch polyfill で node-fetch に
 * 上書きされており、Orca の Cloudflare がその fingerprint を 403 で弾く
 * (live 検証済 2026-07-10)。stats のみ undici (Node native 実装) を明示利用。
 */
function undiciFetch(): typeof fetch {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return (require("undici") as { fetch: typeof fetch }).fetch;
}

/** whirlpool address → stats。対象 (ORCA_MARKETS) のみ保持、失敗時は空 Map。 */
export async function fetchOrcaPoolStats(): Promise<Map<string, OrcaPoolStats>> {
  if (statsCache && Date.now() - statsCache.at < STATS_TTL_MS) {
    return statsCache.map;
  }
  const targets = new Set(ORCA_MARKETS.map((m) => m.pool_address));
  const map = new Map<string, OrcaPoolStats>();
  const res = await undiciFetch()(ORCA_STATS_URL, {
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw new Error(`Orca stats HTTP ${res.status}`);
  const json = (await res.json()) as {
    whirlpools?: {
      address?: string;
      tvl?: number;
      totalApr?: { day?: number };
    }[];
  };
  for (const w of json.whirlpools ?? []) {
    if (!w.address || !targets.has(w.address)) continue;
    map.set(w.address, {
      tvl_usd: w.tvl ?? 0,
      // APR fraction (0..1) は §4.5 適用外 — Number で bps 丸め
      apr_day_bps: Math.round((w.totalApr?.day ?? 0) * 10_000),
    });
  }
  statsCache = { at: Date.now(), map };
  return map;
}
