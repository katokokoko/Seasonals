/**
 * Seasonals BFF — REST server (CLAUDE.md §1 / §10 task #5)
 *
 * 現状 (最小 stub):
 *   全 endpoint が `@workspace/lib/__fixtures__` の値を verbatim で返す。
 *   Postgres / Helius / Pyth は別 task で段階的に追加 (本層は wire のみ)。
 *
 * 規約:
 *   - 型は `@workspace/lib/types` を import (canonical 化、§32.2 same source of truth)
 *   - amount は smallest unit string のままレスポンス (§4.5、parse しない)
 *   - Mobile artifact と URL path / response shape を 1:1 で固定
 *
 * 拡張ポイント:
 *   - oracle 連携 (§4.6) を入れる時は services/oracle.ts を新設
 *   - Postgres を入れる時は services/db.ts + repository pattern
 */

import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import cors from "@fastify/cors";
import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";

import {
  fixtureUnifiedTimeEvents,
  fixturePositions,
  fixtureAgentPlans,
  fixtureApprovalTokens,
  fixtureUserPolicyDefault,
  fixtureWallets,
  fixtureProtocols,
  KNOWN_PROTOCOL_MINTS,
} from "@workspace/lib/__fixtures__";
import {
  AgentPlanStatus,
  TimeEventCategory,
  Urgency,
  type AgentPlan,
  type EarnPosition,
  type EarnPositionsResponse,
  type Position,
  type UnifiedTimeEventDTO,
} from "@workspace/lib/types";
import {
  fromBigInt,
  isValidTokenAmount,
  toBigInt,
  toHumanReadable,
  toSmallestUnit,
} from "@workspace/lib/utils/numeric";
import {
  deriveAllTimeEvents,
  deriveTimeEvents,
  type PositionSnapshot,
} from "@workspace/lib/derive/derive-time-events";
import { toDTO as timeEventToDTO } from "@workspace/lib/types";
import { getRegistry } from "@workspace/lib/adapters";

import { fetchAssetsByOwner, type HeliusAsset } from "./clients/helius";
import {
  fetchEarnMarkets,
  fetchEarnPositions,
  type JupiterLendMarket,
} from "./clients/jupiter-lend";
import {
  fetchEnhancedTransactions,
  fetchEnhancedTransactionsPage,
  type HeliusEnhancedTx,
  type HeliusTokenBalanceChange,
} from "./clients/helius-tx";
import {
  fetchSwapQuote,
  fetchSwapTransaction,
} from "./clients/jupiter-swap";
import {
  fetchStakeAccounts,
  getEpochInfo,
  getTokenSupplyUi,
  sendTransactionViaHelius,
  type StakeAccountInfo,
} from "./clients/helius-rpc";
import {
  getOracleResult,
  oracleMintForSymbol,
  pythFeedIdForSymbol,
} from "./clients/oracle";
// 8.58: 過去価格 (Pyth Benchmarks) と履歴組み立ての純関数
import {
  fetchPriceSeries,
  priceAtOrBefore,
  type PriceSeries,
} from "./clients/pyth-history";
// 8.64: Pyth feed が無い token の過去価格 (履歴表示専用。oracle 経路には入れない)
import { anchorSeries, fetchLlamaPriceSeries } from "./clients/llama-history";
import { isDepositedMint } from "@workspace/lib/config/deposited-mints";
import {
  buildHistorySeries,
  firstFundedTime,
  replayBalances,
  sampleTimestamps,
  HISTORY_PRICE_LAG_SEC,
  type BalanceDelta,
  type HistoryAsset,
  type HistoryPoint,
} from "./portfolio-history";
import {
  SWAP_EARN_MARKETS,
  findMarketByProtocolAsset,
  findMarketByShareMint,
  jupiterLendUnderlyingToShare,
} from "@workspace/lib/config/swap-earn-markets";
import {
  KAMINO_MAIN_MARKET,
  KAMINO_MARKETS,
  KAMINO_VAULTS,
  findKaminoMarketByReserve,
  findKaminoVaultByAddress,
  type KaminoVault,
} from "@workspace/lib/config/kamino-markets";
import {
  KaminoDoomedTxError,
  fetchKaminoDepositCaps,
  fetchKaminoDepositTx,
  fetchKaminoObligationPnl,
  fetchKaminoObligations,
  fetchKaminoReserveMetrics,
  fetchKaminoVaultDepositTx,
  fetchKaminoVaultMetrics,
  fetchKaminoVaultPnl,
  fetchKaminoVaultUserPositions,
  fetchKaminoVaultWithdrawTx,
  fetchKaminoWithdrawTx,
  type KaminoObligationPnl,
  type KaminoRawObligation,
  type KaminoReserveMetric,
  type KaminoVaultMetrics,
  type KaminoVaultPnl,
  type KaminoVaultUserPosition,
} from "./clients/kamino-tx";
import {
  fetchExponentApys,
  fetchExponentFullMarkets,
  fetchExponentSyRates,
  fetchJupiterRateOut,
  fetchLstApys,
  fetchPerenaUsdStarApy,
  fetchSanctumSolValues,
  type ExponentFullMarket,
} from "./clients/rates";
import {
  EXPONENT_MARKETS,
  exponentMaturityIso,
  exponentPoolId,
  exponentPoolName,
  activeExponentMarkets,
} from "@workspace/lib/config/exponent-markets";
import { buildExponentRedeemTx } from "./clients/exponent-tx";
import {
  METEORA_MARKETS,
  findMeteoraMarketByPool,
  type MeteoraDlmmMarket,
} from "@workspace/lib/config/meteora-markets";
import {
  FULL_WITHDRAW_BPS,
  buildMeteoraDepositTxns,
  buildMeteoraWithdrawTxns,
  fetchMeteoraPoolStats,
  fetchMeteoraPositions,
  type MeteoraPoolStats,
  type MeteoraRawPosition,
} from "./clients/meteora-tx";
import {
  ORCA_MARKETS,
  findOrcaMarketByPool,
} from "@workspace/lib/config/orca-markets";
import {
  buildOrcaDepositTxns,
  buildOrcaWithdrawTxns,
  fetchOrcaPoolStats,
  fetchOrcaPositions,
  type OrcaPoolStats,
  type OrcaRawPosition,
} from "./clients/orca-tx";
import {
  SAVE_MARKETS,
  findSaveMarketByCToken,
  findSaveMarketByReserve,
  type SaveMarket,
} from "@workspace/lib/config/save-markets";
import {
  buildSaveDepositTxns,
  buildSaveWithdrawTxns,
  fetchSaveReserveRates,
  type SaveReserveRate,
} from "./clients/save-tx";
import { fixtureMenuListings } from "@workspace/lib/__fixtures__";
import { isObjective } from "@workspace/lib/types";
import { canAutoExecute } from "@workspace/lib/policy/evaluate-policy";
import {
  getCurrentPolicy,
  patchCurrentPolicy,
  PolicyPatchError,
} from "./policy-store";
import {
  AutonomousDisabledError,
  getAutonomousStatus,
  dailyLimitFor,
  getDailyCount,
  incrementDaily,
  isAutonomousFeatureEnabled,
  isKilled,
  kill as killAutonomous,
  listExecutionRecords,
  resume as resumeAutonomous,
  runAutonomousCycle,
  type AutonomousDeps,
  type ExecutionPushPayload,
  type RunAutonomousOpts,
} from "./autonomous";
import type {
  ActionSpec,
  CandidateAction,
  ProtocolMenuEntry,
  ProtocolPool,
} from "@workspace/lib/types";
import { PositionCategory } from "@workspace/lib/types";
import {
  computeBundleHash,
  createPlan,
  getLatestTokenForPlan,
  getStoredPlan,
  getStoredToken,
  issueApprovalToken,
  listPushTokens,
  listStoredPlans,
  registerPushToken,
  updatePlan,
  validateAndConsumeToken,
} from "./plan-store";

// ─────────────────────────────────────────────────────────────────────────────
// Solana 接続 (Devnet) — approve endpoint で memo tx を構築するため
// ─────────────────────────────────────────────────────────────────────────────

const SOLANA_RPC_URL =
  process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const MEMO_PROGRAM_ID = new PublicKey(
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"
);

let cachedConnection: Connection | null = null;
function getConnection(): Connection {
  if (!cachedConnection) {
    cachedConnection = new Connection(SOLANA_RPC_URL, "confirmed");
  }
  return cachedConnection;
}

/**
 * 指定 wallet (feePayer) を signer とする Memo Program transaction を構築。
 * memo に "Seasonals approve <plan_id> @<timestamp>" を書き込む。
 * 成功すると base64 serialized tx を返す。
 *
 * NOTE: 実 production では §11.7 simulate_action で構築した bundle (lending /
 * staking / etc. の実 instruction) をここに置換する。本実装は MWA round-trip
 * を end-to-end で検証するための stub。
 */
async function buildMemoTransaction(
  feePayer: string,
  planId: string
): Promise<string> {
  const conn = getConnection();
  const { blockhash } = await conn.getLatestBlockhash();
  const memoText = `Seasonals approve ${planId} @${new Date().toISOString()}`;
  const ix = new TransactionInstruction({
    programId: MEMO_PROGRAM_ID,
    keys: [],
    data: Buffer.from(memoText, "utf-8"),
  });
  const tx = new Transaction({
    feePayer: new PublicKey(feePayer),
    recentBlockhash: blockhash,
  }).add(ix);
  // signer なしで serialize (mobile 側で MWA 経由で sign される)
  const serialized = tx.serialize({ requireAllSignatures: false });
  return Buffer.from(serialized).toString("base64");
}

/**
 * Phase 8.1: Helius DAS asset 配列を Position[] に正規化する。
 * - NFT / cNFT は skip (interface !== "FungibleToken")
 * - balance=0 はスキップ
 * - KNOWN_PROTOCOL_MINTS に hit すれば protocol_id / category / symbol を上書き
 * - 未知 mint は protocol_id="wallet_holding" + category=Other + metadata symbol
 * - 価格情報は token_info.price_info.price_per_token (float) を 8 decimals string に
 *
 * @see CLAUDE.md §11.3 Position、§4.5 数値表現規約 (string-only)
 */
/**
 * Phase 8.7: 未知 mint の raw 保有を asset 種別で protocol_id に振り分け。
 * これによって donut で stable / native SOL カテゴリに集計できる。
 */
function deriveWalletProtocol(assetSymbol: string): string {
  const stables = ["USDC", "USDT", "USDS", "USDG", "EURC", "JupUSD"];
  if (stables.includes(assetSymbol)) return "wallet_stable";
  if (assetSymbol === "SOL" || assetSymbol === "WSOL") return "wallet_sol";
  return "wallet_holding";
}

export function mapAssetsToPositions(
  assets: HeliusAsset[],
  walletAddress: string,
  // 8.70: mint → 単価 (8-dec string) の上書き。DAS 価格より権威ある出所がある
  // token 用 (現状 jlToken)。空 / 未指定なら従来どおり DAS 価格
  priceOverrides: Map<string, string> = new Map()
): Position[] {
  const out: Position[] = [];
  const now = new Date().toISOString();
  for (const asset of assets) {
    if (asset.interface !== "FungibleToken") continue;
    // Helius は balance を number / string 両方で返す既知挙動。CLAUDE.md §4.5 規約は
    // smallest unit string なので必ず String() に揃える。
    const rawBalance = asset.token_info?.balance;
    if (rawBalance === undefined || rawBalance === null) continue;
    const balance = String(rawBalance);
    if (balance === "0" || balance === "") continue;

    const known = KNOWN_PROTOCOL_MINTS[asset.id];
    const decimals = known?.decimals ?? asset.token_info?.decimals ?? 0;
    const symbol =
      known?.asset_symbol ??
      asset.token_info?.symbol ??
      asset.content?.metadata?.symbol ??
      asset.id.slice(0, 4);
    const priceFloat = asset.token_info?.price_info?.price_per_token;
    const dasPriceUsd =
      typeof priceFloat === "number" && Number.isFinite(priceFloat)
        ? priceFloat.toFixed(8)
        : "0.00000000";
    // 8.70: DAS の price_per_token は市場推定で、利回り token では実勢とずれる
    // (実測 jlUSDC: DAS 1.08643570 vs 償還価値 1.05380615 = 3.1% 高)
    const unitPriceUsd = priceOverrides.get(asset.id) ?? dasPriceUsd;

    out.push({
      position_id: `helius_${walletAddress}_${asset.id}`,
      wallet_id: walletAddress,
      protocol_id: known?.protocol_id ?? deriveWalletProtocol(symbol),
      asset_symbol: symbol,
      principal_amount: balance,
      current_amount: balance,
      accrued_yield_amount: "0",
      unit_price_usd: unitPriceUsd,
      unit_price_sol: "0.00000000",
      deposited_at: now,
      maturity_at: null,
      unlock_at: null,
      health_factor: null,
      auto_roll_rule: null,
      risk_score: 0.5,
      raw_state: {
        mint: asset.id,
        source: "helius_das",
        decimals,
        helius_interface: asset.interface,
      },
    });
  }
  return out;
}

/**
 * Phase 8.12: Jupiter Lend "8-decimal fixed-point integer string"
 *   ("3763527416" = $37.63527416) → §4.5 canonical decimal string ("37.63527416")
 * 不正値 (null / 空 / non-numeric) は "0" fallback。
 */
export function normalizeJup8DecimalUsd(
  raw: string | null | undefined
): string {
  if (raw === null || raw === undefined) return "0";
  if (!isValidTokenAmount(raw)) return "0";
  return toHumanReadable(raw, 8);
}

// ── Phase 8.58: portfolio history (tx 遡り + 過去価格) ───────────────────────

/** wallet+days 単位の応答 cache (5 分)。過去価格自体は pyth-history が別途保持 */
/** native SOL は DAS が WSOL mint の synthetic entry で返す (helius.ts:151) */
const WSOL_MINT = "So11111111111111111111111111111111111111112";

const historyCache = new Map<
  string,
  { at: number; data: PortfolioHistoryResponse }
>();
const HISTORY_CACHE_TTL_MS = 5 * 60_000;
/** tx ページングの安全弁 (100 件 × 10 = 1000 tx) */
const HISTORY_MAX_TX_PAGES = 10;

/**
 * 8.60: wallet 単位の上流キャッシュ。range が違っても「現在残高 + tx 差分」は
 * 同じなので、90/365/730 で Helius DAS と tx ページングを 3 回やり直していた。
 * range をまたいで共有する (価格系列は pyth-history 側が別途 cache)。
 */
interface WalletHistoryInputs {
  current: Map<string, bigint>;
  assets: HistoryAsset[];
  deltas: BalanceDelta[];
  oldestSeen: number;
  /** この差分が何日前まで遡れているか (これより長い range は再取得が要る) */
  fetchedDays: number;
}
const walletInputsCache = new Map<
  string,
  { at: number; data: WalletHistoryInputs }
>();

export function _clearPortfolioHistoryCacheForTest(): void {
  historyCache.clear();
  walletInputsCache.clear();
}

export interface PortfolioHistoryResponse {
  points: HistoryPoint[];
  /** 残高を保証できる最も古い時刻 (unix 秒、tx window の制約)。空なら null */
  oldest_at: number | null;
  /** その日の実価格が無く現在価格で近似した asset */
  approximated_symbols: string[];
}

/**
 * 8.60: 「現在残高 + tx 差分」を wallet 単位で取得・キャッシュする。
 * 要求 range より短い期間しか遡っていない cache は再取得する。
 */
async function loadWalletHistoryInputs(
  wallet: string,
  days: number,
  nowSeconds: number
): Promise<WalletHistoryInputs | null> {
  const cached = walletInputsCache.get(wallet);
  if (
    cached &&
    Date.now() - cached.at < HISTORY_CACHE_TTL_MS &&
    cached.data.fetchedDays >= days
  ) {
    return cached.data;
  }

  // 1. 現在残高 (DAS)。native SOL は WSOL mint の synthetic entry で入る。
  // 8.70: jlToken の単価は DAS ではなく protocol の交換レートを使う (取得失敗は
  // DAS に degrade)。ここを直さないと 8.64 のアンカーが誤差を系列全体に広げる
  const [assets, jupiterMarketsForPrice] = await Promise.all([
    fetchAssetsByOwner(wallet),
    fetchEarnMarkets().catch(() => [] as JupiterLendMarket[]),
  ]);
  const priceOverrides = jlSharePriceOverrides(jupiterMarketsForPrice);
  const current = new Map<string, bigint>();
  const historyAssets: HistoryAsset[] = [];
  for (const asset of assets) {
    if (asset.interface !== "FungibleToken") continue;
    const rawBalance = asset.token_info?.balance;
    if (rawBalance === undefined || rawBalance === null) continue;
    const balance = String(rawBalance);
    if (!isValidTokenAmount(balance) || balance === "0") continue;
    const known = KNOWN_PROTOCOL_MINTS[asset.id];
    const symbol =
      known?.asset_symbol ?? asset.token_info?.symbol ?? asset.id.slice(0, 4);
    const priceFloat = asset.token_info?.price_info?.price_per_token;
    current.set(asset.id, toBigInt(balance));
    historyAssets.push({
      mint: asset.id,
      symbol,
      decimals: known?.decimals ?? asset.token_info?.decimals ?? 0,
      feedId: pythFeedIdForSymbol(symbol),
      // 8.62: protocol への預入か (Total / Deposited の切り替えに使う)
      deposited: isDepositedMint(asset.id),
      currentUsd8:
        priceOverrides.get(asset.id) ??
        (typeof priceFloat === "number" && Number.isFinite(priceFloat)
          ? priceFloat.toFixed(8)
          : undefined),
    });
  }
  if (historyAssets.length === 0) return null;

  // native SOL は DAS が価格を持たない。過去価格が引けない点の保険として
  // oracle の現在価格を currentUsd8 に入れておく (/prices と同じ出所)
  await Promise.all(
    historyAssets
      .filter((a) => !a.currentUsd8 && a.feedId)
      .map(async (a) => {
        const mint = oracleMintForSymbol(a.symbol);
        if (!mint) return;
        const result = await getOracleResult(mint).catch(() => null);
        if (result && result.status !== "blocked" && result.price_usd) {
          a.currentUsd8 = result.price_usd;
        }
      })
  );

  // 2. tx を cutoff まで遡って符号付き差分を集める
  const cutoff = nowSeconds - days * 86_400;
  const deltas: BalanceDelta[] = [];
  let before: string | undefined;
  let oldestSeen = nowSeconds;
  for (let page = 0; page < HISTORY_MAX_TX_PAGES; page++) {
    const txs = await fetchEnhancedTransactionsPage(wallet, {
      limit: 100,
      ...(before ? { before } : {}),
    });
    if (txs.length === 0) break;
    for (const tx of txs) {
      oldestSeen = Math.min(oldestSeen, tx.timestamp);
      for (const account of tx.accountData ?? []) {
        // native SOL: wallet 自身の account の lamports 変化 (fee 込みの実変化)
        if (account.account === wallet && account.nativeBalanceChange) {
          deltas.push({
            timestamp: tx.timestamp,
            mint: WSOL_MINT,
            amount: BigInt(account.nativeBalanceChange),
          });
        }
        for (const change of account.tokenBalanceChanges ?? []) {
          if (change.userAccount !== wallet) continue;
          const raw = change.rawTokenAmount?.tokenAmount;
          if (typeof raw !== "string" || !/^-?[0-9]+$/.test(raw)) continue;
          deltas.push({
            timestamp: tx.timestamp,
            mint: change.mint,
            amount: BigInt(raw),
          });
        }
      }
    }
    before = txs[txs.length - 1]?.signature;
    if (!before || oldestSeen <= cutoff) break;
  }

  const data: WalletHistoryInputs = {
    current,
    assets: historyAssets,
    deltas,
    oldestSeen,
    fetchedDays: days,
  };
  walletInputsCache.set(wallet, { at: Date.now(), data });
  return data;
}

export async function buildPortfolioHistory(
  wallet: string,
  days: number,
  nowSeconds = Math.floor(Date.now() / 1000)
): Promise<PortfolioHistoryResponse> {
  const cacheKey = `${wallet}|${days}`;
  const cached = historyCache.get(cacheKey);
  if (cached && Date.now() - cached.at < HISTORY_CACHE_TTL_MS) {
    return cached.data;
  }

  const cutoff = nowSeconds - days * 86_400;
  const inputs = await loadWalletHistoryInputs(wallet, days, nowSeconds);
  if (!inputs) {
    return { points: [], oldest_at: null, approximated_symbols: [] };
  }
  const { current, assets: historyAssets, deltas, oldestSeen } = inputs;

  // 3. 描画する時刻の並び → 残高の逆算
  //
  // 8.59: 刻みは **実際に描ける期間** から決める。要求 range から決めると、
  // 履歴が range より短い wallet で密度が落ちる (1Y 指定なのに描けるのが 80 日
  // しかない場合、4 日刻みで 20 点にしかならず 3M より粗くなっていた)。
  // 最初に資産を持った時刻より前は差分から何も言えないので下限にする。
  // 途中のゼロ期間は 0 の点として描かれる (8.60)
  const fundedFrom = firstFundedTime(current, deltas, cutoff);
  const oldestProvable = Math.max(oldestSeen, cutoff, fundedFrom ?? 0);
  const provableDays = Math.max(1, (nowSeconds - oldestProvable) / 86_400);
  const stamps1 = sampleTimestamps(
    Math.min(days, provableDays),
    nowSeconds
  ).filter((at) => at >= oldestProvable);
  if (stamps1.length === 0) {
    return { points: [], oldest_at: null, approximated_symbols: [] };
  }
  const balancesByTime = replayBalances(current, deltas, stamps1);

  // 4. その時点の実価格。8.59: **symbol ごとに 1 リクエスト**で範囲全体の系列を
  // 取り、各点は「その時刻以前の直近」を引く。点ごとに個別取得すると ~90 本の
  // リクエストになり rate limit で大半が落ちていた (実機で平坦線として露見)
  const step = stamps1.length > 1 ? stamps1[1]! - stamps1[0]! : 86_400;
  // 先頭の点にも「その時刻以前の bar」が要るので刻み 2 個分手前から
  // (D 解像度は UTC 深夜境界なので、padding が無いと初日が近似落ちする)
  const priceFrom = stamps1[0]! - 2 * step;
  const priceTo = stamps1[stamps1.length - 1]!;
  const pricedSymbols = [
    ...new Set(
      historyAssets
        .filter((a) => a.feedId)
        .map((a) => (a.symbol === "WSOL" ? "SOL" : a.symbol))
    ),
  ];
  // 8.64: Pyth feed が無い asset (jlUSDC / LST / vault share) は DeFiLlama から。
  // これが無いと利回りで単価が上がる token の過去が全部「現在価格」になり、
  // Deposited のグラフが横一直線になっていた
  const feedlessMints = historyAssets
    .filter((a) => !a.feedId)
    .map((a) => a.mint);
  const [seriesBySymbol, llamaByMint] = await Promise.all([
    Promise.all(
      pricedSymbols.map(
        async (symbol) =>
          [
            symbol,
            await fetchPriceSeries(symbol, priceFrom, priceTo, step),
          ] as const
      )
    ).then((entries) => new Map(entries)),
    fetchLlamaPriceSeries(feedlessMints, priceFrom, priceTo, step),
  ]);

  // 8.64: 価格マップは **mint キー**。Pyth (symbol 単位) / llama (mint 単位) の
  // どちらの出所もここで同じ形に合流する
  const seriesByMint = new Map<string, PriceSeries>();
  for (const asset of historyAssets) {
    if (asset.feedId) {
      const symbol = asset.symbol === "WSOL" ? "SOL" : asset.symbol;
      const series = seriesBySymbol.get(symbol);
      if (series) seriesByMint.set(asset.mint, series);
      continue;
    }
    const llama = llamaByMint.get(asset.mint);
    // 見出しの現在値 (DAS 価格) と chart の右端を揃える。形は観測値のまま
    if (llama) seriesByMint.set(asset.mint, anchorSeries(llama, asset.currentUsd8));
  }
  const pricesByTime = new Map<number, Map<string, string>>();
  for (const at of stamps1) {
    const forPoint = new Map<string, string>();
    for (const [mint, series] of seriesByMint) {
      const usd8 = priceAtOrBefore(series, at);
      if (usd8) forPoint.set(mint, usd8);
    }
    if (forPoint.size > 0) pricesByTime.set(at, forPoint);
  }

  const series = buildHistorySeries(
    stamps1,
    balancesByTime,
    historyAssets,
    pricesByTime,
    WSOL_MINT
  );
  const data: PortfolioHistoryResponse = {
    points: series.points,
    oldest_at: series.points[0]?.at ?? null,
    approximated_symbols: series.approximatedSymbols,
  };
  historyCache.set(cacheKey, { at: Date.now(), data });
  return data;
}

/**
 * Phase 8.57: Jupiter Lend position の USD 評価額。
 *
 * 8.12 は `underlyingBalance` を「USD の 8-dec fixed point」と解釈していたが
 * **誤り**だった。実測 (2026-08-01、wallet 6QGJ…):
 *   underlyingAssets = 10206598 (10.206598 USDC) / underlyingBalance = 90262168
 * で、`underlyingBalance` は **wallet 側の underlying 残高** (asset decimals) と
 * 一致していた (同 wallet の USDC 残高 90.262168 とビット単位で同じ)。
 * これを USD として扱ったため 10.2 USDC の position が $0.90 と表示されていた。
 *
 * 正しくは `underlyingAssets × asset.price`。price は API の decimal string。
 * §4.5: 8-dec の bigint に落としてから乗算する (Number を挟まない)。
 */
export function jupiterLendUsd8(
  underlyingAssets: string,
  assetDecimals: number,
  // API は decimal string で返すが型定義は number。実データに合わせ両方受ける
  price: string | number | null | undefined
): string {
  if (!isValidTokenAmount(underlyingAssets)) return "0";
  if (price === null || price === undefined) return "0";
  const priceDecimalString =
    typeof price === "number"
      ? Number.isFinite(price)
        ? price.toFixed(8)
        : null
      : price;
  if (!priceDecimalString) return "0";
  const truncated = truncateDecimal(priceDecimalString, 8);
  if (truncated === "0") return "0";
  const price8 = toBigInt(toSmallestUnit(truncated, 8));
  const amount = toBigInt(underlyingAssets);
  return formatUsd8((amount * price8) / 10n ** BigInt(assetDecimals));
}

/**
 * Phase 8.70: jlMint → **1 share あたりの USD** (8-dec string) の上書き表。
 *
 * Helius DAS の `price_info.price_per_token` は市場推定で、利回りで単価が上がる
 * share token では実勢とずれる。実測 (2026-08-03):
 *   jlUSDC  DAS 1.08643570  vs  convertToAssets 由来 1.05380615  (3.1% 高)
 * この誤差で Portfolio の見出しが $10.52、Menu のドリルダウンが $10.21 と、
 * **同じ position が画面ごとに違う金額**になっていた。
 *
 * `convertToAssets` は「1 share = underlying 何 smallest unit か」= 償還価値
 * そのもので、protocol 自身が出している一次情報。DAS より優先する。
 *
 * 引けなかった market は **map に入れない** (0 を価格として配ると呼び手が
 * 「0 円」と誤解する。§4.6 fail-closed / `/prices` と同じ扱い)。
 */
export function jlSharePriceOverrides(
  markets: JupiterLendMarket[]
): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of markets) {
    if (!m.jlMint || !m.convertToAssets) continue;
    // 1 share 分の underlying を USD 評価する = そのまま share の単価になる
    const usd8 = jupiterLendUsd8(
      m.convertToAssets,
      m.underlyingDecimals,
      m.underlyingPriceRaw ?? m.underlyingPriceUsd
    );
    if (usd8 === "0") continue;
    out.set(m.jlMint, usd8);
  }
  return out;
}

/**
 * Phase 8.2: Jupiter Lend raw position → 共通 EarnPosition shape へ正規化。
 * shares === "0" は除外。
 *
 * Phase 8.12: Jupiter は USD を 8-dec integer string で返すため、
 * §4.5 decimal string contract に合わせて `normalizeJup8DecimalUsd` を経由。
 */
export function mapJupiterLendToEarnPositions(
  raws: Awaited<ReturnType<typeof fetchEarnPositions>>,
  costBasisByShareMint: Map<string, bigint> = new Map()
): EarnPosition[] {
  const out: EarnPosition[] = [];
  for (const raw of raws) {
    if (!raw.shares || raw.shares === "0") continue;

    // Phase 8.13: 実 accrued yield = 現在 underlying − cost-basis(純入金 underlying)。
    // cost-basis 不明 (tx 履歴 window 外 / 別 wallet / API 失敗 / 純入金<=0) は
    // "unknown" にして UI 概算 fallback に委ねる (フェイク 0 を出さない)。
    const costBasis = costBasisByShareMint.get(raw.token.address);
    let accrued_yield_amount = "0";
    let accrued_yield_sign: EarnPosition["accrued_yield_sign"] = "unknown";
    let cost_basis_amount: string | null = null;
    if (
      costBasis !== undefined &&
      costBasis > 0n &&
      isValidTokenAmount(raw.underlyingAssets)
    ) {
      const current = toBigInt(raw.underlyingAssets);
      const delta = current - costBasis;
      accrued_yield_sign = delta < 0n ? "loss" : "gain";
      accrued_yield_amount = fromBigInt(delta < 0n ? -delta : delta);
      cost_basis_amount = fromBigInt(costBasis);
    }

    out.push({
      protocol_id: "jupiter_lend",
      protocol_name: "Jupiter Lend",
      market_symbol: raw.token.asset.symbol,
      share_mint: raw.token.address,
      shares: raw.shares,
      share_decimals: raw.token.decimals,
      asset_symbol: raw.token.asset.symbol,
      underlying_amount: raw.underlyingAssets,
      underlying_decimals: raw.token.asset.decimals,
      // 8.57: underlyingBalance は USD ではなく wallet 残高だった (上記 doc 参照)
      underlying_usd: jupiterLendUsd8(
        raw.underlyingAssets,
        raw.token.asset.decimals,
        raw.token.asset.price
      ),
      supply_rate_bps: Number(raw.supplyRate) || 0,
      accrued_yield_amount,
      accrued_yield_sign,
      cost_basis_amount,
    });
  }
  return out;
}

/**
 * Phase 8.2 best-effort: Helius DAS の token metadata から "Kamino" 系 token を
 * 抽出する。Kamino 公式 API 不明のため APY / USD は null/0、表示は label のみ。
 */
function mapKaminoBestEffortFromHelius(assets: HeliusAsset[]): EarnPosition[] {
  const out: EarnPosition[] = [];
  for (const asset of assets) {
    if (asset.interface !== "FungibleToken") continue;
    const rawBalance = asset.token_info?.balance;
    if (rawBalance === undefined || rawBalance === null) continue;
    const balance = String(rawBalance);
    if (balance === "0" || balance === "") continue;

    const name = asset.content?.metadata?.name ?? "";
    const symbol =
      asset.content?.metadata?.symbol ?? asset.token_info?.symbol ?? "";
    const decimals = asset.token_info?.decimals ?? 0;

    const looksLikeKamino =
      /\bKamino\b/i.test(name) || /^k[A-Z]/.test(symbol);
    if (!looksLikeKamino) continue;

    out.push({
      protocol_id: "kamino",
      protocol_name: "Kamino",
      market_symbol: name || symbol || asset.id.slice(0, 4),
      share_mint: asset.id,
      shares: balance,
      share_decimals: decimals,
      asset_symbol: symbol || "—",
      underlying_amount: balance,
      underlying_decimals: decimals,
      underlying_usd: "0",
      supply_rate_bps: null,
      // Phase 8.13: Kamino は best-effort 検出のみで cost-basis 不明 → 常に unknown。
      accrued_yield_amount: "0",
      accrued_yield_sign: "unknown",
      cost_basis_amount: null,
    });
  }
  return out;
}

/** Phase 8.3: Jupiter Lend / Kamino share token mint registry。tx parsing で
 *  「これは earn deposit/withdraw」と判定するための whitelist。
 *  Jupiter Lend は v1 API 出典 (7 markets)、Kamino は metadata.name で best-effort 検出。
 */
const JUPITER_LEND_SHARE_MINTS: Record<string, string> = {
  "9BEcn9aPEmhSPbPQeFGjidRiEKki46fVQDyPpSQXPA2D": "USDC",  // jlUSDC
  "2uQsyo1fXXQkDtcpXnLofWy88PxcvnfH2L8FPSE62FVU": "SOL",   // jlWSOL
  Cmn4v2wipYV41dkakDvCgFJpxhtaaKt11NyWV8pjSE8A: "USDT",    // jlUSDT
  GcV9tEj62VncGithz4o4N9x6HWXARxuRgEAYk9zahNA8: "EURC",    // jlEURC
  "9fvHrYNw1A8Evpcj7X2yy4k4fT7nNHcA9L6UsamNHAif": "USDG",  // jlUSDG
  j14XLJZSVMcUYpAfajdZRpnfHUpJieZHS4aPektLWvh: "USDS",     // jlUSDS
  "7GxATsNMnaC88vdwd2t3mwrFuQwwGvmYPrUQ4D6FotXk": "JupUSD",// jlJupUSD
};

/**
 * Phase 8.5-8.6: underlying asset mint → jlToken (jupiter lend share) mint。
 * Phase 8.15: 共有 registry (lib/config/swap-earn-markets) の jupiter_lend 行から導出
 * (single source of truth、mint 重複定義を排除)。
 */
const UNDERLYING_TO_JL_SHARE_MINT: Record<string, string> =
  jupiterLendUnderlyingToShare();

/** Phase 8.13: jlToken share mint → underlying asset mint (UNDERLYING_TO_JL_SHARE_MINT の逆引き) */
const JL_SHARE_TO_UNDERLYING_MINT: Record<string, string> = Object.fromEntries(
  Object.entries(UNDERLYING_TO_JL_SHARE_MINT).map(([underlying, share]) => [
    share,
    underlying,
  ])
);

/**
 * Phase 8.15.x: cost-basis 対象の share mint → underlying mint (全 registry から導出)。
 *   - swap-earn 全行 (jl 7 + jitoSOL/mSOL/INF/USD*)
 *   - Save cToken (cUSDC/cSOL)
 * tx 内で share と underlying の両 SPL balance change が同 wallet に現れるものが対象
 * (native SOL は route 上 WSOL So111…112 として現れる)。Kamino obligation/kVault は
 * share が wallet に来ないため対象外 (earned は Kamino PnL API で取る)。
 */
const COST_BASIS_SHARE_TO_UNDERLYING: Record<string, string> = {
  ...Object.fromEntries(
    SWAP_EARN_MARKETS.map((m) => [m.share_mint, m.underlying_mint])
  ),
  ...Object.fromEntries(
    SAVE_MARKETS.map((m) => [m.ctoken_mint, m.underlying_mint])
  ),
};

/**
 * Phase 8.15: swap-earn 共通処理。oracle fail-closed gate (§4.6) → Jupiter Swap
 * quote → swap tx を組み立てて返す。Jupiter Lend / 汎用 swap-earn endpoint で共有。
 *   - oracleMint: fail-closed 判定する underlying mint (deposit/withdraw とも underlying)
 *   - blocked → reply 409 + oracle_blocked、swap 失敗 → 502。
 */
async function buildSwapEarnTx(
  req: FastifyRequest,
  reply: FastifyReply,
  p: {
    user: string;
    inputMint: string;
    outputMint: string;
    oracleMint: string;
    amount: string;
    slippageBps?: number;
  }
): Promise<Record<string, unknown>> {
  // Phase 8.37 (B3): §4.5 API boundary — 他の全 tx-build family と同じ検証。
  // これが無いと "1.5" / "-100" 等が Jupiter へ素通しだった (drift 修正)
  if (!isValidTokenAmount(p.amount)) {
    reply.code(400);
    return { error: "invalid_amount", amount: p.amount };
  }
  const oracle = await getOracleResult(p.oracleMint);
  if (oracle.status === "blocked") {
    reply.code(409);
    return { error: "oracle_blocked", block_reason: oracle.block_reason, oracle };
  }
  try {
    const quote = await fetchSwapQuote({
      inputMint: p.inputMint,
      outputMint: p.outputMint,
      amount: p.amount,
      slippageBps: p.slippageBps ?? 50,
    });
    const tx = await fetchSwapTransaction({
      quoteResponse: quote,
      userPublicKey: p.user,
      prioritizationFeeLamports: "auto",
      dynamicComputeUnitLimit: true,
    });
    return {
      swapTransaction: tx.swapTransaction,
      lastValidBlockHeight: tx.lastValidBlockHeight,
      outAmount: quote.outAmount,
      outputMint: p.outputMint,
      quote,
    };
  } catch (err) {
    req.log.error(
      { err: (err as Error).message, ...p },
      "swap-earn tx build failed"
    );
    reply.code(502);
    return { error: "jupiter_swap_failed", message: (err as Error).message };
  }
}

// ── Kamino Lend (Phase 8.15b) ────────────────────────────────────────────────

/** Kamino "scaled fraction" (value × 2^60) → USD 8-decimals string (§4.5、bigint 経由)。 */
export function sfToUsd8(marketValueSf: unknown): string {
  if (typeof marketValueSf !== "string" || !/^[0-9]+$/.test(marketValueSf)) {
    return "0";
  }
  // USD × 10^8 = sf × 10^8 / 2^60 (整数除算、Number 不使用)
  const scaled = (BigInt(marketValueSf) * 100_000_000n) >> 60n;
  const intPart = scaled / 100_000_000n;
  const frac = (scaled % 100_000_000n).toString().padStart(8, "0");
  return `${intPart.toString()}.${frac}`;
}

/** obligation の deposit を `depositReserve` で SWAP している placeholder かどうか。 */
const KAMINO_EMPTY_RESERVE = "11111111111111111111111111111111";

/**
 * Phase 8.16 fix: obligation の deposits/borrows は **top-level (friendly、空 {} の
 * こともある) と state 配下 (raw on-chain 形) の 2 形**が実 API に混在する。
 * top-level が空なら state 側に fallback する (live 検証: AfcZ… は top が {} で
 * state.deposits/borrows に実データ)。array / object どちらの形も許容。
 */
function obligationEntries(
  o: KaminoRawObligation,
  key: "deposits" | "borrows"
): unknown[] {
  const entriesOf = (raw: unknown): unknown[] =>
    Array.isArray(raw)
      ? raw
      : raw && typeof raw === "object"
        ? Object.values(raw as Record<string, unknown>)
        : [];
  const top = entriesOf((o as Record<string, unknown>)[key]);
  if (top.length > 0) return top;
  const state = (o as { state?: Record<string, unknown> }).state;
  return entriesOf(state?.[key]);
}

/**
 * Phase 8.15b: Kamino obligation 群 → EarnPosition[]。supported reserve
 * (KAMINO_MARKETS) に hit する deposit のみ surface する。
 *   - deposits の shape 揺れは obligationEntries が吸収 (top-level / state 両対応)。
 *   - `depositedAmount` は collateral cToken 量 (reserve decimals ≈ underlying、僅かに
 *     conservative)。position key/withdraw 入力に流用し、USD は marketValueSf から算出。
 */
export function mapKaminoObligationsToEarnPositions(
  obligations: KaminoRawObligation[],
  apyBpsByReserve: Map<string, number>
): EarnPosition[] {
  const out: EarnPosition[] = [];
  for (const o of obligations) {
    const deposits = obligationEntries(o, "deposits");
    for (const d of deposits) {
      const dep = d as {
        depositReserve?: unknown;
        depositedAmount?: unknown;
        marketValueSf?: unknown;
      };
      const reserve = dep.depositReserve;
      const amount = dep.depositedAmount;
      if (
        typeof reserve !== "string" ||
        reserve === KAMINO_EMPTY_RESERVE ||
        typeof amount !== "string" ||
        !/^[0-9]+$/.test(amount) ||
        amount === "0"
      ) {
        continue;
      }
      const mkt = findKaminoMarketByReserve(reserve);
      if (!mkt) continue; // supported reserve のみ表示
      out.push({
        protocol_id: "kamino",
        protocol_name: "Kamino",
        market_symbol: mkt.underlying_symbol,
        share_mint: mkt.reserve, // reserve = position key (withdraw 解決)
        shares: amount, // cToken 量 = withdraw 入力 (smallest unit)
        share_decimals: mkt.underlying_decimals,
        asset_symbol: mkt.underlying_symbol,
        underlying_amount: amount,
        underlying_decimals: mkt.underlying_decimals,
        underlying_usd: sfToUsd8(dep.marketValueSf),
        supply_rate_bps: apyBpsByReserve.get(reserve) ?? null,
        accrued_yield_amount: "0",
        accrued_yield_sign: "unknown", // cost-basis 実値化は follow-up
        cost_basis_amount: null,
      });
    }
  }
  return out;
}

/** reserve metrics → LendingReserveInfo[]（supported reserve のみ、実 APY/TVL）。 */
function kaminoMetricsToSummary(
  metrics: KaminoReserveMetric[]
): {
  reserve_id: string;
  name: string;
  asset_symbol: string;
  lend_apy: number;
  borrow_apy: number;
  utilization: number;
  tvl_usd: string;
}[] {
  const byReserve = new Map(metrics.map((m) => [m.reserve, m]));
  const out: {
    reserve_id: string;
    name: string;
    asset_symbol: string;
    lend_apy: number;
    borrow_apy: number;
    utilization: number;
    tvl_usd: string;
  }[] = [];
  for (const mkt of KAMINO_MARKETS) {
    const m = byReserve.get(mkt.reserve);
    if (!m) continue;
    // APY / utilization は 0..1 の比率 (§4.5 適用外、Number で十分)
    const supply = Number(m.totalSupplyUsd) || 0;
    const borrow = Number(m.totalBorrowUsd) || 0;
    out.push({
      reserve_id: m.reserve,
      name: `${m.liquidityToken} Main Market`,
      asset_symbol: mkt.underlying_symbol,
      lend_apy: Number(m.supplyApy) || 0,
      borrow_apy: Number(m.borrowApy) || 0,
      utilization: supply > 0 ? borrow / supply : 0,
      tvl_usd: truncateUsd8(m.totalSupplyUsd),
    });
  }
  return out;
}

/** 外部 API の USD 文字列を §4.5 の 8-decimals string に丸める (Number 不使用、桁切り)。 */
function truncateUsd8(raw: string): string {
  if (typeof raw !== "string" || !/^[0-9]+(\.[0-9]+)?$/.test(raw)) return "0";
  const [int, frac = ""] = raw.split(".");
  return frac ? `${int}.${frac.slice(0, 8)}` : (int as string);
}

/** reserve address → supply APY bps の Map (obligation の supply_rate_bps 用)。 */
function kaminoApyBpsByReserve(
  metrics: KaminoReserveMetric[]
): Map<string, number> {
  const map = new Map<string, number>();
  for (const m of metrics) {
    const apy = Number(m.supplyApy);
    if (Number.isFinite(apy)) map.set(m.reserve, Math.round(apy * 10000));
  }
  return map;
}

/**
 * Phase 8.53: 上流 (Kamino) の 4xx を Seasonals の error code に翻訳する。
 *
 * 例: ポジションを持たない wallet の withdraw に対し上流は 400 +
 * "Vanilla type Kamino Lend obligation does not exist for wallet …" を返す。
 * これを 502 にすると「Kamino が落ちている」と読めてしまい、実際の原因
 * (ユーザーが未保有) が失われる。Meteora / Orca と同じ **400 position_not_found**
 * に揃える。
 *
 * 認識できない 4xx は null = 従来どおり 502。我々のリクエスト組み立てのバグを
 * 「client 起因」と誤ってラベルしないための fail-safe。
 *
 * 判定は instanceof ではなく **形** で見る (`KaminoUpstreamError` は client module
 * にあり、テストでは module ごと mock されて identity が保てないため)。
 */
export function classifyKaminoUpstreamError(
  err: unknown
): { code: string; message: string } | null {
  const e = err as { status?: unknown; body?: unknown } | null;
  if (typeof e?.status !== "number" || e.status < 400 || e.status >= 500) {
    return null;
  }
  const body = typeof e.body === "string" ? e.body : "";
  if (/obligation does not exist/i.test(body)) {
    return {
      code: "position_not_found",
      message: "No Kamino position for this wallet in this reserve",
    };
  }
  return null;
}

/**
 * Phase 8.15b: Kamino deposit/withdraw の共通処理。oracle fail-closed gate (§4.6) →
 * smallest-unit → human/decimal 変換 → Kamino REST の unsigned tx builder。
 *   - reserve で market を解決し、oracle は underlying に掛ける。
 *   - blocked → 409、未知 reserve → 400、Kamino 失敗 → 502。
 */
async function buildKaminoTx(
  req: FastifyRequest,
  reply: FastifyReply,
  p: { user: string; reserve: string; amount: string; action: "deposit" | "withdraw" }
): Promise<Record<string, unknown>> {
  const mkt = findKaminoMarketByReserve(p.reserve);
  if (!mkt) {
    reply.code(400);
    return {
      error: "unsupported_reserve",
      message: "No Kamino market registered for this reserve",
      reserve: p.reserve,
    };
  }
  if (!isValidTokenAmount(p.amount)) {
    reply.code(400);
    return { error: "invalid_amount", amount: p.amount };
  }
  // 8.52: 上流の都合で必ず失敗する market は、上流も RPC も叩かずに即 409。
  // 上限とは独立した軸なので、枠に空きがあっても塞ぐ (registry が真実の源)
  if (p.action === "deposit" && mkt.deposit_blocked_reason) {
    reply.code(409);
    return {
      error: "deposit_unavailable",
      message: mkt.deposit_blocked_reason,
      reserve: p.reserve,
    };
  }
  // 8.51: 預入停止中のリザーブは tx を組む前に弾く (fail-closed、§32.2)。
  // 上流の tx builder は停止中でも tx を返してしまい、program まで行って
  // DepositLimitExceeded になる = ユーザーは署名後に失敗を知ることになる
  if (p.action === "deposit") {
    // Promise.resolve().then() で包むのは、jest の自動 mock が非 Promise を返す
    // ケースでも落ちないようにするため (8.37 の Exponent と同じ理由)
    const caps = await Promise.resolve()
      .then(() => fetchKaminoDepositCaps([p.reserve]))
      .catch(() => []);
    const cap = Array.isArray(caps) ? caps[0] : undefined;
    if (cap && cap.limit === 0n) {
      reply.code(409);
      return {
        error: "deposit_cap_reached",
        message: "This Kamino reserve is not accepting deposits right now",
        reserve: p.reserve,
      };
    }
  }
  const oracle = await getOracleResult(mkt.underlying_mint);
  if (oracle.status === "blocked") {
    reply.code(409);
    return { error: "oracle_blocked", block_reason: oracle.block_reason, oracle };
  }
  // Kamino API は human/decimal 単位。§4.5 smallest-unit → human へ変換して渡す。
  const amountHuman = toHumanReadable(p.amount, mkt.underlying_decimals);
  try {
    const fn =
      p.action === "deposit" ? fetchKaminoDepositTx : fetchKaminoWithdrawTx;
    const { transaction } = await fn({
      wallet: p.user,
      market: mkt.market,
      reserve: mkt.reserve,
      amount: amountHuman,
    });
    return {
      transaction,
      reserve: mkt.reserve,
      market: mkt.market,
      underlyingMint: mkt.underlying_mint,
    };
  } catch (err) {
    req.log.error(
      { err: (err as Error).message, reserve: p.reserve, action: p.action },
      "kamino tx build failed"
    );
    // 8.52: 「確実に失敗すると分かった tx」は上流障害ではない。ユーザーに提示
    // できる理由があるので 409 (§32.2 fail-closed、署名前に止める)
    if (err instanceof KaminoDoomedTxError) {
      reply.code(409);
      return { error: "deposit_would_fail", message: (err as Error).message };
    }
    // 8.53: 上流の 4xx (未保有等) は上流障害ではない。Meteora / Orca と同じ 400 へ
    const classified = classifyKaminoUpstreamError(err);
    if (classified) {
      reply.code(400);
      return {
        error: classified.code,
        message: classified.message,
        reserve: p.reserve,
      };
    }
    reply.code(502);
    return { error: "kamino_tx_failed", message: (err as Error).message };
  }
}

/** 外部 API の decimal string を指定桁で切り捨て (§4.5: parse せず文字列操作のみ)。 */
export function truncateDecimal(value: string, places: number): string {
  if (typeof value !== "string" || !/^[0-9]+(\.[0-9]+)?$/.test(value)) return "0";
  const [int, frac = ""] = value.split(".");
  const cut = frac.slice(0, places);
  return cut ? `${int}.${cut}` : (int as string);
}

/**
 * Phase 8.15.x: 外部 API の decimal string を正規化する (§4.5: Number() 不使用)。
 * 符号 (-/+) と指数表記 ("6.1998e-7" — Kamino PnL が返す) を文字列操作で plain
 * decimal に展開する。不正 shape は null。
 */
export function normalizeDecimalString(
  value: unknown
): { negative: boolean; abs: string } | null {
  if (typeof value !== "string") return null;
  let s = value.trim();
  let negative = false;
  if (s.startsWith("-")) {
    negative = true;
    s = s.slice(1);
  } else if (s.startsWith("+")) {
    s = s.slice(1);
  }
  const m = s.match(/^([0-9]+)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$/);
  if (!m) return null;
  const digits = m[1]! + (m[2] ?? "");
  // 指数は小整数 (§4.5 適用外) — 小数点位置の移動量としてのみ使う
  const exp = m[3] ? parseInt(m[3], 10) : 0;
  const pointPos = m[1]!.length + exp;
  let abs: string;
  if (pointPos <= 0) {
    abs = `0.${"0".repeat(-pointPos)}${digits}`;
  } else if (pointPos >= digits.length) {
    abs = digits + "0".repeat(pointPos - digits.length);
  } else {
    abs = `${digits.slice(0, pointPos)}.${digits.slice(pointPos)}`;
  }
  abs = abs.replace(/^0+(?=[0-9])/, "");
  const isZero = /^0*(\.0*)?$/.test(abs);
  return { negative: negative && !isZero, abs: isZero ? "0" : abs };
}

/**
 * 符号付き decimal string → smallest unit の magnitude + 符号。
 * 不正 / 変換不能は { magnitude: "0", negative: false } (graceful degrade)。
 */
export function signedDecimalToSmallest(
  value: unknown,
  decimals: number
): { magnitude: string; negative: boolean } {
  const norm = normalizeDecimalString(value);
  if (!norm) return { magnitude: "0", negative: false };
  try {
    const smallest = toSmallestUnit(truncateDecimal(norm.abs, decimals), decimals);
    return { magnitude: smallest, negative: norm.negative && smallest !== "0" };
  } catch {
    return { magnitude: "0", negative: false };
  }
}

/** USD scaled bigint (×1e8) → §4.5 の 8-dec string ("10.08128552")。 */
function formatUsd8(scaled8: bigint): string {
  const neg = scaled8 < 0n;
  const v = neg ? -scaled8 : scaled8;
  const intPart = v / 100_000_000n;
  const frac = (v % 100_000_000n).toString().padStart(8, "0");
  return `${neg ? "-" : ""}${intPart.toString()}.${frac}`;
}

/** oracle price_usd (8-dec decimal string) → scaled bigint (×1e8)。不明は null。 */
function priceUsd8ToScaled(priceUsd: string | null): bigint | null {
  if (!priceUsd) return null;
  try {
    return toBigInt(toSmallestUnit(truncateDecimal(priceUsd, 8), 8));
  } catch {
    return null;
  }
}

/** kVault rate/価格演算の bigint スケール (12 桁精度)。 */
const KVAULT_RATE_SCALE = 12;

/**
 * Phase 8.15d: kVault 保有 positions → EarnPosition[]。登録済 vault のみ surface。
 *   - API の shares は human decimal string → `toSmallestUnit` で §4.5 smallest 化。
 *   - underlying = shares × tokensPerShare、USD = underlying × tokenPrice。
 *     decimal×decimal は bigint スケール乗算 (Number() 不使用)。
 *   - metrics 取得失敗時は shares のみ (underlying "0" / APY null) の graceful degrade。
 */
export function mapKaminoVaultPositionsToEarnPositions(
  positions: KaminoVaultUserPosition[],
  metricsByVault: Map<string, KaminoVaultMetrics>
): EarnPosition[] {
  const out: EarnPosition[] = [];
  for (const p of positions) {
    const vault = findKaminoVaultByAddress(p.vaultAddress);
    if (!vault) continue;
    let sharesSmallest: string;
    try {
      sharesSmallest = toSmallestUnit(
        truncateDecimal(p.totalShares, vault.shares_decimals),
        vault.shares_decimals
      );
    } catch {
      continue; // 不正 shape は silent に落とさず skip (§4.5 boundary)
    }
    if (sharesSmallest === "0") continue;

    const m = metricsByVault.get(p.vaultAddress);
    let underlyingSmallest = "0";
    let usd8 = "0";
    let apyBps: number | null = null;
    if (m) {
      // underlying_smallest = shares(human) × tokensPerShare × 10^u_dec
      //   = sharesSmallest × rateScaled × 10^u_dec / (10^s_dec × 10^SCALE)
      const rateScaled = toBigInt(
        toSmallestUnit(truncateDecimal(m.tokensPerShare, KVAULT_RATE_SCALE), KVAULT_RATE_SCALE)
      );
      const shares = toBigInt(sharesSmallest);
      const underlying =
        (shares * rateScaled * 10n ** BigInt(vault.underlying_decimals)) /
        (10n ** BigInt(vault.shares_decimals) * 10n ** BigInt(KVAULT_RATE_SCALE));
      underlyingSmallest = fromBigInt(underlying);
      // USD (8-dec) = underlying × tokenPrice
      const priceScaled = toBigInt(
        toSmallestUnit(truncateDecimal(m.tokenPrice, 8), 8)
      );
      const usdScaled8 =
        (underlying * priceScaled) / 10n ** BigInt(vault.underlying_decimals);
      const intPart = usdScaled8 / 100_000_000n;
      const frac = (usdScaled8 % 100_000_000n).toString().padStart(8, "0");
      usd8 = `${intPart.toString()}.${frac}`;
      const apy = Number(m.apy);
      apyBps = Number.isFinite(apy) ? Math.round(apy * 10000) : null;
    }
    out.push({
      protocol_id: "kamino",
      protocol_name: "Kamino",
      market_symbol: vault.display_name,
      share_mint: vault.vault, // vault address = position key (withdraw 解決)
      shares: sharesSmallest,
      share_decimals: vault.shares_decimals,
      asset_symbol: vault.underlying_symbol,
      underlying_amount: underlyingSmallest,
      underlying_decimals: vault.underlying_decimals,
      underlying_usd: usd8,
      supply_rate_bps: apyBps,
      accrued_yield_amount: "0",
      accrued_yield_sign: "unknown",
      cost_basis_amount: null,
    });
  }
  return out;
}

// ── Phase 8.15.x: earnings 実値化 ────────────────────────────────────────────

/** Helius DAS asset から (mint → smallest balance bigint) を安全に引く。 */
function assetBalanceSmallest(asset: HeliusAsset): bigint | null {
  const raw = asset.token_info?.balance;
  const s = typeof raw === "number" ? String(raw) : raw;
  if (typeof s !== "string" || !/^[0-9]+$/.test(s)) return null;
  return BigInt(s);
}

/**
 * 保有 LST/USD* (swap-earn share、jupiter_lend 除く) を enriched EarnPosition に。
 *   underlying = shares × rate (SOL 系: Sanctum sol-value、USD* / eUSX: Jupiter quote out/probe)
 *   USD = underlying × oracle price、earned = underlying − cost-basis (取れた場合)
 * rate が無い share は旧 semantics (share 建て表示 + unknown) に degrade。
 * Phase 8.24: USD* 専用だった quote rate を share_symbol キーの Map に一般化 (eUSX 対応)。
 */
export function mapSwapEarnHoldingsToEarnPositions(
  assets: HeliusAsset[],
  solValuesBySymbol: Map<string, bigint>,
  quoteRatesBySymbol: Map<string, { probe: bigint; out: bigint }>,
  priceUsd8ByMint: Map<string, bigint>,
  costBasisByShareMint: Map<string, bigint>,
  // Phase 8.23: LST symbol → APY (0..1)。未指定/miss は従来通り null
  lstApysBySymbol: Map<string, number> = new Map()
): EarnPosition[] {
  const out: EarnPosition[] = [];
  for (const asset of assets) {
    const m = findMarketByShareMint(asset.id);
    if (!m || m.protocol_id === "jupiter_lend") continue; // jl は jupiterLend 配列で処理
    const shares = assetBalanceSmallest(asset);
    if (shares === null || shares === 0n) continue;

    // underlying 換算 (bigint スケール演算のみ)
    let underlying: bigint | null = null;
    const solValue = solValuesBySymbol.get(m.share_symbol);
    const quoteRate = quoteRatesBySymbol.get(m.share_symbol);
    if (solValue !== undefined && solValue > 0n) {
      // shares(share smallest) × lamports-per-whole ÷ 10^share_dec → lamports
      underlying =
        (shares * solValue) / 10n ** BigInt(m.share_decimals);
    } else if (quoteRate && quoteRate.probe > 0n) {
      underlying = (shares * quoteRate.out) / quoteRate.probe;
    }

    const protocolName =
      m.protocol_id.charAt(0).toUpperCase() + m.protocol_id.slice(1);
    if (underlying === null) {
      // rate 不明 → 旧 semantics (share 建て表示、フェイク値は出さない)
      out.push({
        protocol_id: m.protocol_id,
        protocol_name: protocolName,
        market_symbol: m.underlying_symbol,
        share_mint: m.share_mint,
        shares: fromBigInt(shares),
        share_decimals: m.share_decimals,
        asset_symbol: m.share_symbol,
        underlying_amount: fromBigInt(shares),
        underlying_decimals: m.share_decimals,
        underlying_usd: "0",
        supply_rate_bps: null,
        accrued_yield_amount: "0",
        accrued_yield_sign: "unknown",
        cost_basis_amount: null,
      });
      continue;
    }

    // USD (underlying × price / 10^u_dec、8-dec string)
    const price8 = priceUsd8ByMint.get(m.underlying_mint);
    const usd8 =
      price8 !== undefined
        ? formatUsd8((underlying * price8) / 10n ** BigInt(m.underlying_decimals))
        : "0";

    // earned (underlying 建て) = current − cost-basis
    let accrued = "0";
    let sign: EarnPosition["accrued_yield_sign"] = "unknown";
    let costBasisAmount: string | null = null;
    const costBasis = costBasisByShareMint.get(m.share_mint);
    if (costBasis !== undefined && costBasis > 0n) {
      const delta = underlying - costBasis;
      sign = delta < 0n ? "loss" : "gain";
      accrued = fromBigInt(delta < 0n ? -delta : delta);
      costBasisAmount = fromBigInt(costBasis);
    }

    // Phase 8.23: LST APY (Sanctum、0..1) → bps。miss は null (従来表示)
    const lstApy = lstApysBySymbol.get(m.share_symbol);
    const supplyRateBps =
      lstApy !== undefined && Number.isFinite(lstApy)
        ? Math.round(lstApy * 10000)
        : null;

    out.push({
      protocol_id: m.protocol_id,
      protocol_name: protocolName,
      market_symbol: m.share_symbol, // "jitoSOL" (ラベル)
      share_mint: m.share_mint,
      shares: fromBigInt(shares),
      share_decimals: m.share_decimals,
      asset_symbol: m.underlying_symbol, // 表示は underlying 建て ("SOL")
      underlying_amount: fromBigInt(underlying),
      underlying_decimals: m.underlying_decimals,
      underlying_usd: usd8,
      supply_rate_bps: supplyRateBps,
      accrued_yield_amount: accrued,
      accrued_yield_sign: sign,
      cost_basis_amount: costBasisAmount,
    });
  }
  return out;
}

/**
 * 保有 Save cToken を enriched EarnPosition に。
 *   underlying = cToken × ctoken_exchange_rate (cToken decimals = underlying decimals)
 *   earned = underlying − cost-basis (cUSDC/USDC は同一 tx の SPL⇄SPL なので 8.13 機構が効く)
 */
export function mapSaveHoldingsToEarnPositions(
  assets: HeliusAsset[],
  saveRates: { reserve: string; supply_apy: number; ctoken_exchange_rate: string }[],
  priceUsd8ByMint: Map<string, bigint>,
  costBasisByShareMint: Map<string, bigint>
): EarnPosition[] {
  const rateByReserve = new Map(saveRates.map((r) => [r.reserve, r]));
  const out: EarnPosition[] = [];
  for (const asset of assets) {
    const m = findSaveMarketByCToken(asset.id);
    if (!m) continue;
    const shares = assetBalanceSmallest(asset);
    if (shares === null || shares === 0n) continue;

    const rate = rateByReserve.get(m.reserve);
    let underlying: bigint | null = null;
    if (rate) {
      try {
        const rateScaled = toBigInt(
          toSmallestUnit(truncateDecimal(rate.ctoken_exchange_rate, 12), 12)
        );
        if (rateScaled > 0n) {
          // cToken decimals == underlying decimals → スケール補正不要
          underlying = (shares * rateScaled) / 10n ** 12n;
        }
      } catch {
        underlying = null;
      }
    }
    const apyBps =
      rate && Number.isFinite(rate.supply_apy)
        ? Math.round(rate.supply_apy * 10000)
        : null;

    if (underlying === null) {
      // rate 不明 → 旧 semantics (cToken 建て表示)
      out.push({
        protocol_id: "savefi",
        protocol_name: "Save",
        market_symbol: m.underlying_symbol,
        share_mint: m.ctoken_mint,
        shares: fromBigInt(shares),
        share_decimals: m.underlying_decimals,
        asset_symbol: m.ctoken_symbol,
        underlying_amount: fromBigInt(shares),
        underlying_decimals: m.underlying_decimals,
        underlying_usd: "0",
        supply_rate_bps: apyBps,
        accrued_yield_amount: "0",
        accrued_yield_sign: "unknown",
        cost_basis_amount: null,
      });
      continue;
    }

    const price8 = priceUsd8ByMint.get(m.underlying_mint);
    const usd8 =
      price8 !== undefined
        ? formatUsd8((underlying * price8) / 10n ** BigInt(m.underlying_decimals))
        : "0";

    let accrued = "0";
    let sign: EarnPosition["accrued_yield_sign"] = "unknown";
    let costBasisAmount: string | null = null;
    const costBasis = costBasisByShareMint.get(m.ctoken_mint);
    if (costBasis !== undefined && costBasis > 0n) {
      const delta = underlying - costBasis;
      sign = delta < 0n ? "loss" : "gain";
      accrued = fromBigInt(delta < 0n ? -delta : delta);
      costBasisAmount = fromBigInt(costBasis);
    }

    out.push({
      protocol_id: "savefi",
      protocol_name: "Save",
      market_symbol: m.ctoken_symbol, // "cUSDC" (ラベル)
      share_mint: m.ctoken_mint,
      shares: fromBigInt(shares),
      share_decimals: m.underlying_decimals,
      asset_symbol: m.underlying_symbol, // 表示は underlying 建て ("USDC")
      underlying_amount: fromBigInt(underlying),
      underlying_decimals: m.underlying_decimals,
      underlying_usd: usd8,
      supply_rate_bps: apyBps,
      accrued_yield_amount: accrued,
      accrued_yield_sign: sign,
      cost_basis_amount: costBasisAmount,
    });
  }
  return out;
}

/**
 * kVault positions に Kamino 算出の実 PnL (token 建て) を合流。
 * pnl が正規化できない position は unknown のまま (フェイク値は出さない)。
 */
export function attachKaminoVaultPnl(
  positions: EarnPosition[],
  pnlByVault: Map<string, KaminoVaultPnl>
): EarnPosition[] {
  return positions.map((p) => {
    const pnl = pnlByVault.get(p.share_mint);
    if (!pnl) return p;
    const earned = signedDecimalToSmallest(pnl.pnlToken, p.underlying_decimals);
    const cost = signedDecimalToSmallest(pnl.costBasisToken, p.underlying_decimals);
    // pnlToken が不正 shape (normalize 失敗で "0"/false) でも costBasis > 0 なら
    // break-even として扱えるが、区別できないため cost>0 のときのみ実値扱い。
    if (cost.magnitude === "0") return p;
    return {
      ...p,
      accrued_yield_amount: earned.magnitude,
      accrued_yield_sign: earned.negative ? ("loss" as const) : ("gain" as const),
      cost_basis_amount: cost.magnitude,
    };
  });
}

/**
 * Kamino reserve (obligation) positions に obligation PnL を合流。
 * 帰属が明確な「supported deposit がちょうど 1 つの obligation」由来の position のみ。
 * underlying=SOL は pnl.sol をそのまま、USDC は pnl.usd を oracle price で USDC 換算
 * (peg 近似はしない)。
 */
export function attachKaminoObligationPnl(
  positions: EarnPosition[],
  pnlByReserve: Map<string, KaminoObligationPnl>,
  priceUsd8ByMint: Map<string, bigint>
): EarnPosition[] {
  const SOL_MINT = "So11111111111111111111111111111111111111112";
  return positions.map((p) => {
    if (p.protocol_id !== "kamino") return p;
    const pnl = pnlByReserve.get(p.share_mint); // reserve address キー
    if (!pnl) return p;
    const mkt = findKaminoMarketByReserve(p.share_mint);
    if (!mkt) return p;
    let earned: { magnitude: string; negative: boolean } | null = null;
    if (mkt.underlying_mint === SOL_MINT) {
      earned = signedDecimalToSmallest(pnl.sol, mkt.underlying_decimals);
    } else {
      // USD 建て PnL → oracle price で underlying (USDC) に換算
      const price8 = priceUsd8ByMint.get(mkt.underlying_mint);
      const norm = normalizeDecimalString(pnl.usd);
      if (price8 !== undefined && price8 > 0n && norm) {
        try {
          const usdScaled8 = toBigInt(
            toSmallestUnit(truncateDecimal(norm.abs, 8), 8)
          );
          const underlying =
            (usdScaled8 * 10n ** BigInt(mkt.underlying_decimals)) / price8;
          earned = { magnitude: fromBigInt(underlying), negative: norm.negative };
        } catch {
          earned = null;
        }
      }
    }
    if (!earned) return p;
    return {
      ...p,
      accrued_yield_amount: earned.magnitude,
      accrued_yield_sign: earned.negative ? ("loss" as const) : ("gain" as const),
    };
  });
}

/**
 * obligation PnL の帰属が明確な reserve → obligationAddress の Map を作る。
 * 条件: (a) 借入なし (供給専用 — PnL ≈ 累積利息)、(b) 非空 deposit がちょうど 1 つ、
 * (c) その deposit が supported reserve、(d) 同一 reserve が複数 obligation に
 * 現れない (曖昧なら除外)。条件外は unknown 継続 (フェイク値を出さない)。
 */
export function singleSupportedDepositObligations(
  obligations: KaminoRawObligation[]
): Map<string, string> {
  const candidate = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const o of obligations) {
    const deposits = obligationEntries(o, "deposits");
    const borrows = obligationEntries(o, "borrows");
    const hasBorrow = borrows.some((b) => {
      const br = b as { borrowReserve?: unknown };
      return (
        typeof br.borrowReserve === "string" &&
        br.borrowReserve !== KAMINO_EMPTY_RESERVE
      );
    });
    if (hasBorrow) continue;
    const nonEmpty: string[] = [];
    for (const d of deposits) {
      const dep = d as { depositReserve?: unknown; depositedAmount?: unknown };
      if (
        typeof dep.depositReserve !== "string" ||
        dep.depositReserve === KAMINO_EMPTY_RESERVE ||
        typeof dep.depositedAmount !== "string" ||
        dep.depositedAmount === "0"
      ) {
        continue;
      }
      nonEmpty.push(dep.depositReserve);
    }
    const addr = (o as { obligationAddress?: unknown }).obligationAddress;
    if (
      nonEmpty.length === 1 &&
      typeof addr === "string" &&
      findKaminoMarketByReserve(nonEmpty[0]!)
    ) {
      const reserve = nonEmpty[0]!;
      if (candidate.has(reserve)) ambiguous.add(reserve);
      else candidate.set(reserve, addr);
    }
  }
  for (const r of ambiguous) candidate.delete(r);
  return candidate;
}

/**
 * Phase 8.15d: kVault deposit/withdraw 共通処理。oracle gate (§4.6 underlying) →
 * §4.5 変換 → Kamino REST unsigned tx。
 *   deposit  : amount = underlying smallest → human (underlying_decimals)
 *   withdraw : amount = shares smallest → human (shares_decimals、share 建て確認済)
 */
async function buildKaminoVaultTx(
  req: FastifyRequest,
  reply: FastifyReply,
  p: { user: string; vault: string; amount: string; action: "deposit" | "withdraw" }
): Promise<Record<string, unknown>> {
  const vault: KaminoVault | undefined = findKaminoVaultByAddress(p.vault);
  if (!vault) {
    reply.code(400);
    return {
      error: "unsupported_vault",
      message: "No Kamino vault registered for this address",
      vault: p.vault,
    };
  }
  if (!isValidTokenAmount(p.amount)) {
    reply.code(400);
    return { error: "invalid_amount", amount: p.amount };
  }
  const oracle = await getOracleResult(vault.underlying_mint);
  if (oracle.status === "blocked") {
    reply.code(409);
    return { error: "oracle_blocked", block_reason: oracle.block_reason, oracle };
  }
  const amountHuman =
    p.action === "deposit"
      ? toHumanReadable(p.amount, vault.underlying_decimals)
      : toHumanReadable(p.amount, vault.shares_decimals);
  try {
    const fn =
      p.action === "deposit" ? fetchKaminoVaultDepositTx : fetchKaminoVaultWithdrawTx;
    const { transaction } = await fn({
      wallet: p.user,
      kvault: vault.vault,
      amount: amountHuman,
    });
    return {
      transaction,
      vault: vault.vault,
      underlyingMint: vault.underlying_mint,
    };
  } catch (err) {
    req.log.error(
      { err: (err as Error).message, vault: p.vault, action: p.action },
      "kamino vault tx build failed"
    );
    // 8.53: klend と同じく上流の 4xx (未保有等) は 400 に翻訳する
    const classified = classifyKaminoUpstreamError(err);
    if (classified) {
      reply.code(400);
      return {
        error: classified.code,
        message: classified.message,
        vault: p.vault,
      };
    }
    reply.code(502);
    return { error: "kamino_tx_failed", message: (err as Error).message };
  }
}

/**
 * Phase 8.15c: Save (旧 Solend) deposit/withdraw の共通処理。oracle fail-closed gate
 * (§4.6) → solend-sdk で unsigned v0 tx 群 (最大: pull-price + pre + 本体 + post) を
 * 構築して base64 string[] を返す。amount は smallest-unit string を SDK に passthrough。
 */
async function buildSaveTx(
  req: FastifyRequest,
  reply: FastifyReply,
  p: {
    user: string;
    market: SaveMarket;
    amount: string;
    action: "deposit" | "withdraw";
  }
): Promise<Record<string, unknown>> {
  if (!isValidTokenAmount(p.amount)) {
    reply.code(400);
    return { error: "invalid_amount", amount: p.amount };
  }
  const oracle = await getOracleResult(p.market.underlying_mint);
  if (oracle.status === "blocked") {
    reply.code(409);
    return { error: "oracle_blocked", block_reason: oracle.block_reason, oracle };
  }
  try {
    const fn = p.action === "deposit" ? buildSaveDepositTxns : buildSaveWithdrawTxns;
    const { transactions } = await fn({
      wallet: p.user,
      market: p.market,
      amount: p.amount,
    });
    return {
      transactions,
      reserve: p.market.reserve,
      ctokenMint: p.market.ctoken_mint,
      underlyingMint: p.market.underlying_mint,
    };
  } catch (err) {
    req.log.error(
      { err: (err as Error).message, reserve: p.market.reserve, action: p.action },
      "save tx build failed"
    );
    reply.code(502);
    return { error: "save_tx_failed", message: (err as Error).message };
  }
}

// ── Phase 8.17: Meteora DLMM ─────────────────────────────────────────────────

/** SDK の amount 文字列 (integer / decimal 揺れあり) → 整数 smallest bigint。不正は null。 */
function meteoraAmountToBigInt(value: string): bigint | null {
  if (/^[0-9]+$/.test(value)) return BigInt(value);
  const norm = normalizeDecimalString(value);
  if (!norm || norm.negative) return null;
  // decimal 表現は端数 (除算由来) — 整数部のみ採用 (§4.5: raw smallest 単位)
  return BigInt(truncateDecimal(norm.abs, 0));
}

const METEORA_PRICE_SCALE = 12;

/**
 * DLMM position の X/Y 残高を deposit token 建てに一本化した総額 (smallest bigint)。
 * price_raw = X smallest 1 単位あたりの Y smallest (on-chain activeBin.price、検証済)。
 */
export function meteoraTotalsInDepositTerms(
  raw: Pick<MeteoraRawPosition, "total_x" | "total_y" | "fee_x" | "fee_y" | "price_raw">,
  depositSide: "x" | "y"
): { total: bigint; fee: bigint } | null {
  const x = meteoraAmountToBigInt(raw.total_x);
  const y = meteoraAmountToBigInt(raw.total_y);
  const feeX = meteoraAmountToBigInt(raw.fee_x);
  const feeY = meteoraAmountToBigInt(raw.fee_y);
  const priceNorm = normalizeDecimalString(raw.price_raw);
  if (x === null || y === null || feeX === null || feeY === null || !priceNorm) {
    return null;
  }
  let priceScaled: bigint;
  try {
    priceScaled = toBigInt(
      toSmallestUnit(truncateDecimal(priceNorm.abs, METEORA_PRICE_SCALE), METEORA_PRICE_SCALE)
    );
  } catch {
    return null;
  }
  if (priceScaled <= 0n) return null;
  const scale = 10n ** BigInt(METEORA_PRICE_SCALE);
  if (depositSide === "x") {
    // Y → X: y / price
    return {
      total: x + (y * scale) / priceScaled,
      fee: feeX + (feeY * scale) / priceScaled,
    };
  }
  // X → Y: x × price
  return {
    total: y + (x * priceScaled) / scale,
    fee: feeY + (feeX * priceScaled) / scale,
  };
}

/**
 * Phase 8.19: LP position の earned フィールドを決める共通ロジック。
 * cost-basis 判明時: earned = (現在総額 + 未請求 fee) − cost — **IL 込み** の実損益
 * (8.13 と同じ magnitude + sign 方式)。不明時: 従来の fee-only "gain" を維持
 * (fee は真の下限情報なので 8.13 の "unknown → —" にはしない)。
 */
function lpEarnedFields(
  totals: { total: bigint; fee: bigint },
  cost: bigint | undefined
): Pick<
  EarnPosition,
  "accrued_yield_amount" | "accrued_yield_sign" | "cost_basis_amount"
> {
  if (cost === undefined || cost <= 0n) {
    return {
      accrued_yield_amount: fromBigInt(totals.fee),
      accrued_yield_sign: "gain",
      cost_basis_amount: null,
    };
  }
  const delta = totals.total + totals.fee - cost;
  return {
    accrued_yield_amount: fromBigInt(delta < 0n ? -delta : delta),
    accrued_yield_sign: delta < 0n ? "loss" : "gain",
    cost_basis_amount: fromBigInt(cost),
  };
}

/**
 * Meteora DLMM positions → EarnPosition[]。share_mint = position account pubkey。
 * underlying は deposit token 建て総額。earned は lpCostBasis 判明時 IL 込み実損益、
 * 不明時は未請求 swap fee (gain 固定) — Phase 8.19。
 * APY は新データ API の pool stats (Phase 8.24、取得失敗時 null)。
 */
export function mapMeteoraPositionsToEarnPositions(
  positions: MeteoraRawPosition[],
  priceUsd8ByMint: Map<string, bigint>,
  lpCostBasis: Map<string, bigint> = new Map(),
  statsByAddress: Map<string, MeteoraPoolStats> = new Map()
): EarnPosition[] {
  const out: EarnPosition[] = [];
  for (const raw of positions) {
    const m = METEORA_MARKETS.find((mk) => mk.pool_id === raw.pool_id);
    if (!m) continue;
    const totals = meteoraTotalsInDepositTerms(raw, m.deposit_side);
    if (!totals || totals.total === 0n) continue;
    const price8 = priceUsd8ByMint.get(m.deposit_mint);
    const usd8 =
      price8 !== undefined
        ? formatUsd8((totals.total * price8) / 10n ** BigInt(m.deposit_decimals))
        : "0";
    const stats = statsByAddress.get(m.pool_address);
    out.push({
      protocol_id: "meteora",
      protocol_name: "Meteora",
      market_symbol: m.pair_name,
      share_mint: raw.position_address, // position account 実 pubkey (withdraw キー)
      shares: fromBigInt(totals.total),
      share_decimals: m.deposit_decimals,
      asset_symbol: m.deposit_symbol,
      underlying_amount: fromBigInt(totals.total),
      underlying_decimals: m.deposit_decimals,
      underlying_usd: usd8,
      supply_rate_bps: stats ? stats.apy_bps : null,
      ...lpEarnedFields(totals, lpCostBasis.get(raw.position_address)),
    });
  }
  return out;
}

/**
 * LP withdraw の bps 計算 (Meteora / Orca 共通、8.18 で共通化):
 * 要求額 / 現在総額 (deposit 建て)。round、1..10000 clamp。総額以上 → 10000 (全量)。
 */
export function withdrawBpsFor(requested: bigint, total: bigint | null): number {
  if (total === null || total <= 0n || requested >= total) {
    return FULL_WITHDRAW_BPS;
  }
  const bps = Number((requested * 10_000n + total / 2n) / total);
  return Math.max(1, Math.min(FULL_WITHDRAW_BPS, bps));
}

/** Whirlpool sqrtPrice (X64) → B smallest per A smallest ×10^12 (bigint)。 */
const ORCA_PRICE_SCALE = 12;

function orcaIntOrNull(value: string): bigint | null {
  return /^[0-9]+$/.test(value) ? BigInt(value) : null;
}

/**
 * Whirlpool position の A/B 残高を deposit token 建てに一本化した総額 (smallest bigint)。
 * price = (sqrtPrice / 2^64)^2 が「A smallest 1 単位あたりの B smallest」(on-chain、検証済)。
 */
export function orcaTotalsInDepositTerms(
  raw: Pick<OrcaRawPosition, "token_a" | "token_b" | "fee_owed_a" | "fee_owed_b" | "sqrt_price">,
  depositSide: "a" | "b"
): { total: bigint; fee: bigint } | null {
  const a = orcaIntOrNull(raw.token_a);
  const b = orcaIntOrNull(raw.token_b);
  const feeA = orcaIntOrNull(raw.fee_owed_a);
  const feeB = orcaIntOrNull(raw.fee_owed_b);
  const sqrt = orcaIntOrNull(raw.sqrt_price);
  if (a === null || b === null || feeA === null || feeB === null || sqrt === null) {
    return null;
  }
  const scale = 10n ** BigInt(ORCA_PRICE_SCALE);
  const priceScaled = (sqrt * sqrt * scale) >> 128n;
  if (priceScaled <= 0n) return null;
  if (depositSide === "a") {
    // B → A: b / price
    return {
      total: a + (b * scale) / priceScaled,
      fee: feeA + (feeB * scale) / priceScaled,
    };
  }
  // A → B: a × price
  return {
    total: b + (a * priceScaled) / scale,
    fee: feeB + (feeA * priceScaled) / scale,
  };
}

/**
 * Orca Whirlpool positions → EarnPosition[]。share_mint = position mint (NFT) 実 pubkey
 * (withdraw キー)。underlying は deposit token 建て総額。earned は lpCostBasis 判明時
 * IL 込み実損益、不明時は feeOwed (gain 固定) — Phase 8.19。
 * APY は pool stats API の totalApr.day (実値、取得失敗時 null)。
 */
export function mapOrcaPositionsToEarnPositions(
  positions: OrcaRawPosition[],
  priceUsd8ByMint: Map<string, bigint>,
  statsByAddress: Map<string, OrcaPoolStats>,
  lpCostBasis: Map<string, bigint> = new Map()
): EarnPosition[] {
  const out: EarnPosition[] = [];
  for (const raw of positions) {
    const m = ORCA_MARKETS.find((mk) => mk.pool_id === raw.pool_id);
    if (!m) continue;
    const totals = orcaTotalsInDepositTerms(raw, m.deposit_side);
    if (!totals || totals.total === 0n) continue;
    const price8 = priceUsd8ByMint.get(m.deposit_mint);
    const usd8 =
      price8 !== undefined
        ? formatUsd8((totals.total * price8) / 10n ** BigInt(m.deposit_decimals))
        : "0";
    const stats = statsByAddress.get(m.pool_address);
    out.push({
      protocol_id: "orca",
      protocol_name: "Orca",
      market_symbol: m.pair_name,
      share_mint: raw.position_mint, // position mint (NFT) 実 pubkey (withdraw キー)
      shares: fromBigInt(totals.total),
      share_decimals: m.deposit_decimals,
      asset_symbol: m.deposit_symbol,
      underlying_amount: fromBigInt(totals.total),
      underlying_decimals: m.deposit_decimals,
      underlying_usd: usd8,
      supply_rate_bps: stats ? stats.apr_day_bps : null,
      ...lpEarnedFields(totals, lpCostBasis.get(raw.position_mint)),
    });
  }
  return out;
}

// ── Phase 8.19: LP cost-basis (IL 込み earned) ───────────────────────────────

/** Whirlpool の全 tick 範囲 (±443636 を tick_spacing に整列 — TickUtil と同義)。 */
function orcaFullRangeTick(tickSpacing: number): number {
  return Math.floor(443636 / tickSpacing) * tickSpacing;
}

/**
 * LP position の cost-basis (deposit token 建て純入金、smallest bigint) を
 * wallet の tx 履歴から計算する。key は EarnPosition.share_mint に一致:
 * meteora → position account pubkey、orca → position mint (NFT) pubkey。
 *
 * 検出: position account が tx の accountData に載る tx (open / increase /
 * decrease / claim / close) を position の lifecycle tx とする (live 検証済
 * 2026-07-10 — Orca open tx で position PDA + user の両脚 delta を確認)。
 *
 * cost 計算 (§4.5 全 bigint、8.13 と同じ delta 集計規約):
 * - stable pair (USDC-USDT): cost = Σ −(depositΔ + otherΔ) — 1:1 換算で
 *   open / increase / 部分 withdraw / fee claim 全形状を正しく積む
 *   (claim は cost を減らす = realized earnings が earned に反映される)。
 * - volatile pair (SOL-USDC): 過去価格が取れないため自アプリのフロー形のみ:
 *     orca   — tx 1 件 (zap open) + full-range + deposit 脚流出 → −depositΔ × 2
 *              (full-range は 50:50 value split、live tx で実証。SOL 脚は
 *              一時 WSOL account 側に付き user delta に出ない)
 *     meteora — 全 tx で other 脚 0 (single-sided) → Σ −depositΔ
 *   該当しない形 (部分 withdraw 済 / 集中レンジ / 外部 UI 由来) は cost 不明。
 *
 * **open 可視性ガード**: window は履歴の suffix なので、position account の作成
 * (rent 入金 = accountData.nativeBalanceChange > 0、live 検証済) が window 内に
 * 見えている場合のみ全 lifecycle tx が揃っていると保証できる。open が window 外の
 * position は「直近の increase/claim だけを積んだ過小 cost」になるため cost 不明に
 * 倒す (実 wallet で観測した欠陥への対策)。
 *
 * 注: zap の swap 脚 (tx1) は position を触らないため検出外 — swap fee/slippage
 * (~0.05%) 分 cost が過小 = earned が僅かに過大。cost <= 0 は 8.13 同様 skip。
 * tx window (直近 50 件) 外の古い position も不明 → fee-only 表示に fallback。
 *
 * Phase 8.27: volatile orca で deposit 脚 (SOL) が一時 WSOL account 経由になり
 * user delta に出ないケース (jitoSOL-SOL zap) 向けに、**相方脚 × otherLegRates
 * (deposit 建て換算、LST は rate がゆっくりで現在値換算の誤差僅少) × 2** の
 * fallback を追加。rate は呼び手が入力として渡す (決定性維持)。
 */
export function computeLpCostBasisByPositionKey(
  txs: HeliusEnhancedTx[],
  walletAddress: string,
  orcaPositions: OrcaRawPosition[],
  meteoraPositions: MeteoraRawPosition[],
  /** other_mint → deposit smallest 換算 rate (num/den)。8.27 */
  otherLegRates: Map<string, { num: bigint; den: bigint }> = new Map()
): Map<string, bigint> {
  const out = new Map<string, bigint>();
  interface LpTarget {
    key: string;
    address: string;
    depositMint: string;
    otherMint: string;
    stablePair: boolean;
    kind: "orca" | "meteora";
    fullRange: boolean;
  }
  const targets: LpTarget[] = [];
  for (const p of orcaPositions) {
    const m = ORCA_MARKETS.find((mk) => mk.pool_id === p.pool_id);
    if (!m) continue;
    const full = orcaFullRangeTick(m.tick_spacing);
    targets.push({
      key: p.position_mint,
      address: p.position_address,
      depositMint: m.deposit_mint,
      otherMint: m.other_mint,
      stablePair: m.stable_pair,
      kind: "orca",
      fullRange: p.tick_lower === -full && p.tick_upper === full,
    });
  }
  for (const p of meteoraPositions) {
    const m = METEORA_MARKETS.find((mk) => mk.pool_id === p.pool_id);
    if (!m) continue;
    targets.push({
      key: p.position_address,
      address: p.position_address,
      depositMint: m.deposit_mint,
      otherMint: m.other_mint,
      stablePair: m.stable_pair,
      kind: "meteora",
      fullRange: false,
    });
  }
  if (targets.length === 0) return out;

  for (const t of targets) {
    const posTxs = txs.filter((tx) =>
      (tx.accountData ?? []).some((a) => a.account === t.address)
    );
    if (posTxs.length === 0) continue;
    // open 可視性ガード: 作成 tx (position account への rent 入金) が window 内に無い
    // = 履歴が部分的にしか見えていない → cost 不明
    const sawOpen = posTxs.some((tx) =>
      (tx.accountData ?? []).some(
        (a) => a.account === t.address && (a.nativeBalanceChange ?? 0) > 0
      )
    );
    if (!sawOpen) continue;
    // 各 tx の wallet 視点 deposit/other 脚 delta (入金 = 負)
    const deltas = posTxs.map((tx) => {
      let dep = 0n;
      let oth = 0n;
      for (const a of tx.accountData ?? []) {
        for (const c of a.tokenBalanceChanges ?? []) {
          if (c.userAccount !== walletAddress) continue;
          const rawStr = c.rawTokenAmount?.tokenAmount;
          if (!rawStr || !/^-?[0-9]+$/.test(rawStr)) continue;
          if (c.mint === t.depositMint) dep += BigInt(rawStr);
          else if (c.mint === t.otherMint) oth += BigInt(rawStr);
        }
      }
      return { dep, oth };
    });
    let cost: bigint | null = null;
    if (t.stablePair) {
      cost = deltas.reduce((acc, d) => acc - d.dep - d.oth, 0n);
    } else if (t.kind === "orca") {
      if (posTxs.length === 1 && t.fullRange && deltas[0]!.dep < 0n) {
        cost = -deltas[0]!.dep * 2n;
      } else if (posTxs.length === 1 && t.fullRange && deltas[0]!.oth < 0n) {
        // 8.27: deposit 脚が一時 WSOL account 経由で user delta に出ない zap 向け —
        // 相方脚 (user ATA 経由で確実に出る) を deposit 建てに換算して ×2
        const rate = otherLegRates.get(t.otherMint);
        if (rate && rate.den > 0n) {
          cost = ((-deltas[0]!.oth * rate.num) / rate.den) * 2n;
        }
      }
    } else if (
      deltas.every((d) => d.oth === 0n) &&
      deltas.some((d) => d.dep !== 0n)
    ) {
      cost = deltas.reduce((acc, d) => acc - d.dep, 0n);
    }
    if (cost !== null && cost > 0n) out.set(t.key, cost);
  }
  return out;
}

/**
 * Phase 8.13: tx 履歴から share_mint 別の cost-basis (純入金 underlying 量) を計算。
 *
 *   cost-basis = Σ(deposit underlying) − Σ(withdraw underlying)
 *
 * Jupiter Lend の deposit は `USDC → jlUSDC` を 1 tx で route するので、同 tx の
 * accountData[].tokenBalanceChanges に share mint と underlying mint の両方が動く。
 * share mint の balance change を検出した tx で、同 wallet の underlying mint の
 * 符号付き rawTokenAmount を読み、入金 (wallet 減少 = 負) を加算・出金 (正) を減算する。
 *
 * 全演算 bigint (§4.5)。float の tokenTransfers.tokenAmount は使わない。
 * 符号付き string は BigInt() で直接 parse (toBigInt は "-" を弾くため不可)。
 *
 * 注: jlWSOL は WSOL(So111…112) の balance change として出る。native SOL change は
 *     route 上 wrap 済なので無視。WSOL change が無ければその tx は cost-basis に寄与しない。
 */
export function computeCostBasisByShareMint(
  txs: HeliusEnhancedTx[],
  walletAddress: string
): Map<string, bigint> {
  const net = new Map<string, bigint>();
  for (const tx of txs) {
    const changes: HeliusTokenBalanceChange[] = (tx.accountData ?? []).flatMap(
      (a) => a.tokenBalanceChanges ?? []
    );
    if (changes.length === 0) continue;

    // Phase 8.15.x: jl だけでなく LST/USD*/Save cToken も対象 (registry 導出 map)。
    for (const shareMint of Object.keys(COST_BASIS_SHARE_TO_UNDERLYING)) {
      // この tx で wallet の share mint が動いたか (deposit/withdraw のシグナル)
      const shareMoved = changes.some(
        (c) => c.mint === shareMint && c.userAccount === walletAddress
      );
      if (!shareMoved) continue;

      const underlyingMint = COST_BASIS_SHARE_TO_UNDERLYING[shareMint];
      if (!underlyingMint) continue;

      // 同 tx・同 wallet の underlying balance change を合算 (符号付き)。
      let underlyingDelta = 0n;
      let sawUnderlying = false;
      for (const c of changes) {
        if (c.mint !== underlyingMint || c.userAccount !== walletAddress) {
          continue;
        }
        const rawStr = c.rawTokenAmount?.tokenAmount;
        if (rawStr === undefined || rawStr === null || rawStr === "") continue;
        if (!/^-?[0-9]+$/.test(rawStr)) continue;
        underlyingDelta += BigInt(rawStr);
        sawUnderlying = true;
      }
      if (!sawUnderlying) continue;

      // wallet 視点で underlying が減る = 入金 (cost-basis 増)。符号反転して加算。
      const prev = net.get(shareMint) ?? 0n;
      net.set(shareMint, prev - underlyingDelta);
    }
  }
  return net;
}

/**
 * Phase 8.16: wallet イベント検出用の share mint registry (全 registry 導出)。
 * swap-earn (jl 7 + jitoSOL/mSOL/INF/USD*) + Save cToken。表示名/decimals 込み。
 */
const WALLET_EVENT_SHARE_REGISTRY: Record<
  string,
  {
    protocol_id: string;
    display: string;
    share_symbol: string;
    share_decimals: number;
  }
> = {
  ...Object.fromEntries(
    SWAP_EARN_MARKETS.map((m) => [
      m.share_mint,
      {
        protocol_id: m.protocol_id,
        display:
          m.protocol_id === "jupiter_lend"
            ? "Jupiter Lend"
            : m.protocol_id.charAt(0).toUpperCase() + m.protocol_id.slice(1),
        share_symbol: m.share_symbol,
        share_decimals: m.share_decimals,
      },
    ])
  ),
  ...Object.fromEntries(
    SAVE_MARKETS.map((m) => [
      m.ctoken_mint,
      {
        protocol_id: "savefi",
        display: "Save",
        share_symbol: m.ctoken_symbol,
        share_decimals: m.underlying_decimals,
      },
    ])
  ),
};

/**
 * Phase 8.3 → 8.16: Helius Enhanced Tx を UnifiedTimeEventDTO[] に変換。
 * - 全 protocol の share mint (WALLET_EVENT_SHARE_REGISTRY) の入出金を検出
 * - 金額は accountData[].tokenBalanceChanges の bigint (§4.5、float の tokenTransfers
 *   は使わない)。同一 tx 内の同一 mint change は合算して 1 イベント。
 * - category は 8-fixed 中 "Epoch" を temporal marker として流用 (droplet shape は
 *   mobile 側が metadata.source === "helius_tx" で deposit_history に解決)。
 */
export function mapTxsToWalletTimeEvents(
  txs: HeliusEnhancedTx[],
  walletAddress: string
): UnifiedTimeEventDTO[] {
  const out: UnifiedTimeEventDTO[] = [];
  for (const tx of txs) {
    const changes: HeliusTokenBalanceChange[] = (tx.accountData ?? []).flatMap(
      (a) => a.tokenBalanceChanges ?? []
    );
    if (changes.length === 0) continue;
    // share mint ごとに wallet の delta を合算 (bigint)
    const deltaByMint = new Map<string, bigint>();
    for (const ch of changes) {
      const reg = WALLET_EVENT_SHARE_REGISTRY[ch.mint];
      if (!reg || ch.userAccount !== walletAddress) continue;
      const raw = ch.rawTokenAmount?.tokenAmount;
      if (typeof raw !== "string" || !/^-?[0-9]+$/.test(raw)) continue;
      deltaByMint.set(ch.mint, (deltaByMint.get(ch.mint) ?? 0n) + BigInt(raw));
    }
    let idx = 0;
    for (const [mint, delta] of deltaByMint) {
      if (delta === 0n) continue;
      const reg = WALLET_EVENT_SHARE_REGISTRY[mint]!;
      const isDeposit = delta > 0n;
      const magnitude = fromBigInt(delta < 0n ? -delta : delta);
      const human = toHumanReadable(magnitude, reg.share_decimals);
      const verb = isDeposit ? "Deposited" : "Withdrew";
      out.push({
        id: `tx_${tx.signature}_${idx}`,
        protocol: reg.protocol_id,
        category: TimeEventCategory.Epoch,
        triggerAt: new Date(tx.timestamp * 1000).toISOString(),
        urgency: Urgency.Info,
        walletAddress,
        positionRef: null,
        actions: [],
        agentReadable: true,
        metadata: {
          source: "helius_tx",
          signature: tx.signature,
          tx_type: tx.type,
          headline: `${verb} ${human} ${reg.share_symbol} on ${reg.display}`,
          direction: isDeposit ? "deposit" : "withdraw",
          share_mint: mint,
        },
      });
      idx += 1;
    }
  }
  return out;
}

/**
 * Phase 8.16: LST 保有者向けの実 epoch 境界イベント (staking 報酬確定タイミング)。
 * holdsLst=false なら null。境界時刻は slotsRemaining × 400ms の概算 (日単位表示に十分)。
 */
export function buildEpochBoundaryEvent(
  epochInfo: { epoch: number; slotIndex: number; slotsInEpoch: number },
  holdsLst: boolean,
  walletAddress: string,
  now: Date
): UnifiedTimeEventDTO | null {
  if (!holdsLst) return null;
  const remaining = epochInfo.slotsInEpoch - epochInfo.slotIndex;
  if (!Number.isFinite(remaining) || remaining < 0) return null;
  // Phase 8.20: 導出は lib deriveAllTimeEvents (§26.2) — snapshot 0 件でも
  // ctx.epoch から wallet-scoped の epoch イベントを 1 回だけ返す。
  const endsAtIso = new Date(now.getTime() + remaining * 400).toISOString();
  const events = deriveAllTimeEvents([], {
    now,
    wallet: walletAddress,
    epoch: { epoch: epochInfo.epoch, endsAtIso, holdsLst },
  });
  return events[0] ? timeEventToDTO(events[0]) : null;
}

/**
 * Phase 8.16: Kamino obligation の health イベント (§11.4 Health)。
 * 借入がある obligation のみ対象 (供給専用は liquidation リスク無し)。
 *   LTV/liqLTV ≥ 0.9 → Critical、≥ 0.7 → Watch、未満 → イベント無し。
 * actions は空 (repay 経路未実装のため fail-closed でボタンを出さない)。
 * LTV は 0..1 比率 (§4.5 適用外 — Number 可)。
 */
export function mapObligationsToHealthEvents(
  obligations: KaminoRawObligation[],
  walletAddress: string,
  now: Date
): UnifiedTimeEventDTO[] {
  // Phase 8.20: 閾値判定・urgency・headline は lib deriveTimeEvents に移譲。
  // ここは obligation の raw parse → PositionSnapshot 構築のみ。
  const snapshots: PositionSnapshot[] = [];
  for (const o of obligations) {
    const borrows = obligationEntries(o, "borrows");
    const hasBorrow = borrows.some((b) => {
      const br = b as { borrowReserve?: unknown };
      return (
        typeof br.borrowReserve === "string" &&
        br.borrowReserve !== KAMINO_EMPTY_RESERVE
      );
    });
    if (!hasBorrow) continue;
    const stats = (o as { refreshedStats?: unknown }).refreshedStats as
      | { loanToValue?: unknown; liquidationLtv?: unknown }
      | undefined;
    const ltv = Number(stats?.loanToValue);
    const liq = Number(stats?.liquidationLtv);
    if (!Number.isFinite(ltv) || !Number.isFinite(liq) || liq <= 0) continue;
    const addr = (o as { obligationAddress?: unknown }).obligationAddress;
    snapshots.push({
      protocol: "kamino",
      position_ref: typeof addr === "string" ? addr : null,
      health: { ltv, liquidation_ltv: liq },
      metadata: { source: "kamino_obligation" },
    });
  }
  const ctx = { now, wallet: walletAddress };
  return snapshots.flatMap((s) => deriveTimeEvents(s, ctx).map(timeEventToDTO));
}

/**
 * Phase 8.20: LP position (Meteora / Orca) の未請求 fee → claim イベント (§11.4)。
 * fee > 0 の position のみ。event には "Withdraw & claim" action と synthetic
 * withdraw plan 用 metadata (share_mint / shares / decimals) が付く — mobile の
 * handleActionPress がカレンダーから直接 ActionModal を起動できる (§29.1)。
 */
/**
 * claim イベントを watch に上げる fee 閾値 (~$1 相当、deposit token smallest)。
 * 未登録 symbol は undefined = 常に info。
 */
const CLAIM_WATCH_THRESHOLD: Record<string, string> = {
  USDC: "1000000", // 1 USDC
  SOL: "10000000", // 0.01 SOL
};

export function mapLpPositionsToClaimEvents(
  orcaPositions: OrcaRawPosition[],
  meteoraPositions: MeteoraRawPosition[],
  walletAddress: string,
  now: Date
): UnifiedTimeEventDTO[] {
  const snapshots: PositionSnapshot[] = [];
  for (const raw of orcaPositions) {
    const m = ORCA_MARKETS.find((mk) => mk.pool_id === raw.pool_id);
    if (!m) continue;
    const totals = orcaTotalsInDepositTerms(raw, m.deposit_side);
    if (!totals || totals.fee <= 0n) continue;
    snapshots.push({
      protocol: "orca",
      position_ref: raw.position_mint,
      claimable: {
        amount: fromBigInt(totals.fee),
        symbol: m.deposit_symbol,
        decimals: m.deposit_decimals,
        watch_amount: CLAIM_WATCH_THRESHOLD[m.deposit_symbol],
        withdraw: {
          share_mint: raw.position_mint,
          share_decimals: m.deposit_decimals,
          underlying_decimals: m.deposit_decimals,
          underlying_amount: fromBigInt(totals.total),
          shares: fromBigInt(totals.total),
          asset_symbol: m.deposit_symbol,
        },
      },
      metadata: { source: "lp_fee", pool_id: m.pool_id, pair: m.pair_name },
    });
  }
  for (const raw of meteoraPositions) {
    const m = METEORA_MARKETS.find((mk) => mk.pool_id === raw.pool_id);
    if (!m) continue;
    const totals = meteoraTotalsInDepositTerms(raw, m.deposit_side);
    if (!totals || totals.fee <= 0n) continue;
    snapshots.push({
      protocol: "meteora",
      position_ref: raw.position_address,
      claimable: {
        amount: fromBigInt(totals.fee),
        symbol: m.deposit_symbol,
        decimals: m.deposit_decimals,
        watch_amount: CLAIM_WATCH_THRESHOLD[m.deposit_symbol],
        withdraw: {
          share_mint: raw.position_address,
          share_decimals: m.deposit_decimals,
          underlying_decimals: m.deposit_decimals,
          underlying_amount: fromBigInt(totals.total),
          shares: fromBigInt(totals.total),
          asset_symbol: m.deposit_symbol,
        },
      },
      metadata: { source: "lp_fee", pool_id: m.pool_id, pair: m.pair_name },
    });
  }
  const ctx = { now, wallet: walletAddress };
  return snapshots.flatMap((s) => deriveTimeEvents(s, ctx).map(timeEventToDTO));
}

/** deactivation 未要求の sentinel (u64::MAX) */
const STAKE_ACTIVE_SENTINEL = "18446744073709551615";

/**
 * Phase 8.20: native stake account の解除状態 → lockup_end イベント (§11.4)。
 *   deactivationEpoch == 現 epoch  → 今 epoch 境界で解除 (cooldown 中)
 *   deactivationEpoch <  現 epoch  → 解除済 = withdrawable now (watch)
 *   u64::MAX (active)              → イベント無し
 */
export function mapStakeAccountsToLockupEvents(
  stakes: StakeAccountInfo[],
  epochInfo: { epoch: number; slotIndex: number; slotsInEpoch: number },
  walletAddress: string,
  now: Date
): UnifiedTimeEventDTO[] {
  const remaining = epochInfo.slotsInEpoch - epochInfo.slotIndex;
  const boundaryIso = new Date(
    now.getTime() + Math.max(0, remaining) * 400
  ).toISOString();
  const snapshots: PositionSnapshot[] = [];
  for (const s of stakes) {
    if (s.deactivation_epoch === STAKE_ACTIVE_SENTINEL) continue;
    if (!/^[0-9]+$/.test(s.deactivation_epoch)) continue;
    const deactivated = BigInt(s.deactivation_epoch) < BigInt(epochInfo.epoch);
    const human = toHumanReadable(s.stake_lamports, 9);
    snapshots.push({
      protocol: "solana",
      position_ref: s.address,
      // 解除済は unlock_at = now (lib が unlocked=true / watch にする)
      unlock_at: deactivated ? now.toISOString() : boundaryIso,
      metadata: {
        source: "stake_account",
        stake_lamports: s.stake_lamports,
        headline: deactivated
          ? `${human} SOL unstaked — withdrawable now`
          : `${human} SOL unstaking — withdrawable after epoch ${epochInfo.epoch}`,
      },
    });
  }
  const ctx = { now, wallet: walletAddress };
  return snapshots.flatMap((s) => deriveTimeEvents(s, ctx).map(timeEventToDTO));
}

// ── Phase 8.33: Exponent PT (read-only 統合、§11.4 maturity) ─────────────────

/** lib registry snapshot を ExponentFullMarket 形へ正規化 (degrade / backstop 用)。 */
function registryAsFullMarkets(): ExponentFullMarket[] {
  return EXPONENT_MARKETS.map((m) => ({
    ticker: m.underlying_symbol,
    underlying_mint: m.underlying_mint,
    underlying_decimals: m.underlying_decimals,
    pt_mint: m.pt_mint,
    yt_mint: m.yt_mint,
    vault_address: m.vault_address,
    pt_decimals: m.pt_decimals,
    maturity_ts: m.maturity_ts,
    implied_apy: m.implied_apy,
    underlying_apy: null,
    total_market_size: m.total_market_size,
    quote_ticker: m.quote_ticker,
    pt_price_in_asset: 1,
    market_status: "registry",
  }));
}

/**
 * live markets ∪ registry snapshot (pt_mint キー、live 優先)。
 * 満期後に live の active 一覧から消えた PT も registry で解決し続ける
 * (過去日 maturity → critical は「満期を過ぎている」正しい通知)。
 */
export function exponentMarketUnion(
  live: ExponentFullMarket[] | undefined
): ExponentFullMarket[] {
  const byPt = new Map<string, ExponentFullMarket>();
  for (const m of registryAsFullMarkets()) byPt.set(m.pt_mint, m);
  for (const m of live ?? []) byPt.set(m.pt_mint, m);
  return [...byPt.values()];
}

/**
 * 保有 PT/YT (Exponent) → maturity イベント (§11.4)。read-only v1 のため actions 空
 * (deriveTimeEvents の maturity 分岐が空 actions で emit する)。
 * YT も出す — YT は満期で価値 0 になるため締切通知の価値が最大。
 */
export function mapPtHoldingsToMaturityEvents(
  assets: HeliusAsset[],
  markets: ExponentFullMarket[],
  walletAddress: string,
  now: Date
): UnifiedTimeEventDTO[] {
  const byPt = new Map(markets.map((m) => [m.pt_mint, m] as const));
  const byYt = new Map(markets.map((m) => [m.yt_mint, m] as const));
  const snapshots: PositionSnapshot[] = [];
  for (const asset of assets) {
    const pt = byPt.get(asset.id);
    const yt = pt === undefined ? byYt.get(asset.id) : undefined;
    const m = pt ?? yt;
    if (!m) continue;
    const side = pt !== undefined ? "PT" : "YT";
    const balance = assetBalanceSmallest(asset);
    if (balance === null || balance === 0n) continue;
    // Phase 8.34: 満期済 PT には Redeem action 用の maturity_redeem を付与
    // (lib derive が満期済 + maturity_redeem の時だけ action を積む。YT は対象外)
    const matured = m.maturity_ts * 1000 <= now.getTime();
    const dDiff = m.underlying_decimals - m.pt_decimals;
    const underlying =
      dDiff >= 0
        ? balance * 10n ** BigInt(dDiff)
        : balance / 10n ** BigInt(-dDiff);
    snapshots.push({
      protocol: "exponent",
      position_ref: asset.id,
      maturity_at: exponentMaturityIso(m.maturity_ts),
      ...(side === "PT" && matured
        ? {
            maturity_redeem: {
              share_mint: m.pt_mint,
              share_decimals: m.pt_decimals,
              underlying_decimals: m.underlying_decimals,
              underlying_amount: fromBigInt(underlying),
              shares: fromBigInt(balance),
              asset_symbol: `PT-${m.ticker}`,
            },
          }
        : {}),
      metadata: {
        source: "exponent_pt",
        side,
        underlying_symbol: m.ticker,
        pt_amount: fromBigInt(balance), // smallest-unit string (§4.5)
        pt_decimals: m.pt_decimals,
        headline:
          side === "PT"
            ? `PT ${m.ticker} matures — redeemable 1:1 for ${m.ticker}`
            : `YT ${m.ticker} expires — yield accrual ends`,
      },
    });
  }
  const ctx = { now, wallet: walletAddress };
  return snapshots.flatMap((s) => deriveTimeEvents(s, ctx).map(timeEventToDTO));
}

/**
 * 保有 PT (Exponent) → EarnPosition (read-only、maturity_at 付き)。YT は v1 対象外
 * (評価軸が別物)。underlying_amount は「満期で 1 PT = 1 underlying」前提の
 * decimals 変換 (満期前は ptPriceInAsset 分だけ割引されるが、それは USD 側に反映)。
 *
 * USD 換算 (§4.5 note): 上流 float の pt_price_in_asset は **境界で 1 回だけ**
 * ×1e8 の bigint に変換し、以後 bigint 演算のみ。表示・概算専用で実行入力には
 * 使わない (v1 に実行経路なし)。oracle 価格が無い stable 系 ticker は 1.0 と
 * みなし、それ以外の不明 underlying は "0" (偽 USD を出さない)。
 */
const EXPONENT_STABLE_TICKERS = new Set(["USX", "eUSX", "hyUSD", "ONyc"]);

export function mapExponentHoldingsToEarnPositions(
  assets: HeliusAsset[],
  markets: ExponentFullMarket[],
  priceUsd8ByMint: Map<string, bigint>
): EarnPosition[] {
  const byPt = new Map(markets.map((m) => [m.pt_mint, m] as const));
  const out: EarnPosition[] = [];
  for (const asset of assets) {
    const m = byPt.get(asset.id);
    if (!m) continue;
    const shares = assetBalanceSmallest(asset);
    if (shares === null || shares === 0n) continue;

    // PT smallest → underlying smallest (decimals 差の pow10 変換のみ、bigint)
    const dDiff = m.underlying_decimals - m.pt_decimals;
    const underlying =
      dDiff >= 0
        ? shares * 10n ** BigInt(dDiff)
        : shares / 10n ** BigInt(-dDiff);

    // USD: shares × ptPrice8 × underlyingPrice8 / 10^(pt_dec + 8)
    const ptPrice8 = BigInt(Math.round(m.pt_price_in_asset * 1e8));
    const underlyingPrice8 =
      priceUsd8ByMint.get(m.underlying_mint) ??
      (EXPONENT_STABLE_TICKERS.has(m.ticker) ? 100_000_000n : undefined);
    const usd8 =
      underlyingPrice8 !== undefined && underlyingPrice8 > 0n
        ? formatUsd8(
            (shares * ptPrice8 * underlyingPrice8) /
              10n ** BigInt(m.pt_decimals + 8)
          )
        : "0";

    out.push({
      protocol_id: "exponent",
      protocol_name: "Exponent",
      market_symbol: m.ticker,
      share_mint: m.pt_mint,
      shares: fromBigInt(shares),
      share_decimals: m.pt_decimals,
      asset_symbol: `PT-${m.ticker}`,
      underlying_amount: fromBigInt(underlying),
      underlying_decimals: m.underlying_decimals,
      underlying_usd: usd8,
      supply_rate_bps: Number.isFinite(m.implied_apy)
        ? Math.round(m.implied_apy * 10000)
        : null,
      accrued_yield_amount: "0",
      accrued_yield_sign: "unknown",
      cost_basis_amount: null,
      maturity_at: exponentMaturityIso(m.maturity_ts),
    });
  }
  return out;
}

/**
 * live/registry markets → menu pools (§3 display carve-out)。
 * 満期 (`maturity_ts <= nowSec`) は live/degrade どちらの経路でも除外 —
 * 世代交代で腐った snapshot pool が menu に出ることはない。
 * tvl_usd は totalMarketSize (**quote 資産建て**) の USD 近似:
 *   quote "USD" / stable 系 → ×1、quote "SOL" → × SOL oracle 価格、
 *   それ以外 (xSOL / SLX 等の変動 token quote) → 換算不能として 0
 *   (偽 USD を出さない。SOL 換算の LST premium ~0-20% 誤差は表示バッジ用途で許容)。
 */
const EXPONENT_USD_QUOTES = new Set(["USD", "USX", "eUSX", "hyUSD", "USDC"]);

export function buildExponentMenuPools(
  markets: ExponentFullMarket[],
  nowSec: number,
  solPriceUsd: number | undefined
): ProtocolPool[] {
  return activeExponentMarkets(markets, nowSec)
    .filter((m) => m.market_status === "active" || m.market_status === "registry")
    .sort((a, b) => a.maturity_ts - b.maturity_ts)
    .map((m) => {
      const unitUsd = EXPONENT_USD_QUOTES.has(m.quote_ticker)
        ? 1
        : m.quote_ticker === "SOL"
          ? solPriceUsd ?? 0
          : 0;
      return {
        pool_id: exponentPoolId(m.ticker, m.maturity_ts),
        name: exponentPoolName(m.ticker, m.maturity_ts),
        category: PositionCategory.PTYT,
        asset: m.ticker,
        apy: m.implied_apy, // implied APY = PT 固定利回り
        tvl_usd: m.total_market_size * unitUsd,
        display_only: true, // v1 は read-only (deposit 経路なし)
      };
    });
}

// ── Phase 8.22: /menu-listings (live APY/TVL overlay) ────────────────────────

/**
 * /menu-listings の live ソース束。undefined のソースは fixture 値のまま
 * (graceful degrade — 呼び手が allSettled で詰める)。
 */
export interface MenuLiveSources {
  jupiterMarkets?: JupiterLendMarket[];
  kaminoReserves?: KaminoReserveMetric[];
  /** vault address → metrics */
  kaminoVaults?: Map<string, KaminoVaultMetrics>;
  /** 8.51: reserve address → deposit limit (smallest unit)。0 は預入停止中 */
  kaminoCaps?: Map<string, bigint>;
  saveRates?: SaveReserveRate[];
  /** whirlpool address → stats */
  orcaStats?: Map<string, OrcaPoolStats>;
  /**
   * yield token symbol → APY (0..1)。Sanctum LST (8.23) + Exponent underlyingApy
   * (8.24、eUSX 等) の merge 済み Map。
   */
  lstApys?: Map<string, number>;
  /** DLMM pool_address → stats (Phase 8.24、dlmm.datapi.meteora.ag) */
  meteoraStats?: Map<string, MeteoraPoolStats>;
  /** Phase 8.26: eUSX 総供給 × syExchangeRate (表示専用 USD) */
  solsticeTvlUsd?: number;
  /**
   * Phase 8.33: Exponent PT markets (live)。undefined = fetch 失敗 → lib registry
   * snapshot へ degrade (どちらも buildExponentMenuPools が maturity filter する)。
   */
  exponentMarkets?: ExponentFullMarket[];
  /** Phase 8.33: SOL quote market の TVL 換算用 (表示専用 Number) */
  solPriceUsd?: number;
  /** Phase 8.33: maturity filter 基準時刻 (unix 秒)。未指定は実時刻 */
  nowSec?: number;
}

/**
 * Phase 8.23/8.24: yield token 系 menu pool → APY symbol の対応。
 * fixture の LST pool は asset が全て "SOL" のため明示 map で引く。
 * jito_restaking_vault は LST APY ではないため対象外 (fixture 維持)。
 */
export const LST_POOL_SYMBOLS: Record<string, string> = {
  sanctum_inf: "INF",
  sanctum_jitosol: "jitoSOL",
  sanctum_bsol: "bSOL",
  marinade_msol: "mSOL",
  jito_jitosol: "jitoSOL",
  solstice_eusx: "eUSX", // Exponent underlyingApy (8.24)
  perena_usd_star: "USD*", // Perena app の非公開 endpoint (8.25)
  hylo_hylosol: "hyloSOL", // Exponent underlyingApy (8.27)
};

/** 有限 number のみ採用 (不正値は fixture 維持)。 */
function finite(n: number): number | null {
  return Number.isFinite(n) ? n : null;
}

/**
 * fixture menu listing に live APY/TVL を pool 単位で overlay する純関数。
 * apy (0..1 fraction) / tvl_usd / borrowed_usd (USD number) は ProtocolPool の
 * documented display carve-out (§3) — smallest-unit string 規約の適用外。
 * 対応 protocol: jupiter / kamino (reserve + kVault) / savefi / orca。
 * それ以外 (LST / meteora / perena / solstice) は live ソースが無く fixture 値。
 * Phase 8.33: exponent entry のみ patch でなく pools **置換** (market 世代交代対応)。
 */
export function applyMenuLiveOverlays(
  listings: ProtocolMenuEntry[],
  s: MenuLiveSources
): ProtocolMenuEntry[] {
  return listings.map((entry) => {
    // Phase 8.33: Exponent は live markets から pools を作り直す (degrade は registry)。
    if (entry.protocol_id === "exponent") {
      const nowSec = s.nowSec ?? Math.floor(Date.now() / 1000);
      return {
        ...entry,
        pools: buildExponentMenuPools(
          s.exponentMarkets ?? registryAsFullMarkets(),
          nowSec,
          s.solPriceUsd
        ),
      };
    }
    return {
    ...entry,
    pools: entry.pools.map((pool) => {
      const out = { ...pool };
      if (entry.protocol_id === "jupiter" && s.jupiterMarkets) {
        // MenuDrawer の client 側 override (Phase 8.6) と同じ換算式。
        // 8.26: jl API は SOL market を "WSOL" で返すため alias で match
        // (mobile 側 MenuDrawer と同じ規約)
        const norm = (sym: string) => (sym === "WSOL" ? "SOL" : sym);
        const m = s.jupiterMarkets.find(
          (mk) => norm(mk.underlyingSymbol) === norm(pool.asset)
        );
        if (m) {
          const apy = finite(m.supplyRateBps / 10000);
          const tvl = finite(
            (Number(m.tvlUnderlying) / 10 ** m.underlyingDecimals) *
              m.underlyingPriceUsd
          );
          if (apy !== null) out.apy = apy;
          if (tvl !== null) out.tvl_usd = tvl;
        }
      } else if (entry.protocol_id === "kamino") {
        const reserve = KAMINO_MARKETS.find((mk) => mk.pool_id === pool.pool_id);
        const metric =
          reserve && s.kaminoReserves
            ? s.kaminoReserves.find((r) => r.reserve === reserve.reserve)
            : undefined;
        if (metric) {
          const apy = finite(Number(metric.supplyApy));
          const tvl = finite(Number(metric.totalSupplyUsd));
          const borrowed = finite(Number(metric.totalBorrowUsd));
          if (apy !== null) out.apy = apy;
          if (tvl !== null) out.tvl_usd = tvl;
          if (borrowed !== null) out.borrowed_usd = borrowed;
          // Phase 8.26: 稼働率 = borrow/supply (1.0 clamp、withdraw 流動性リスク可視化)
          if (tvl !== null && borrowed !== null && tvl > 0) {
            out.utilization = Math.min(1, borrowed / tvl);
          }
          // 8.51: 預入枠。cap は on-chain (offset 5016)、used は metrics の
          // totalSupply (トークン単位) を smallest unit に揃える。
          // cap===0 は「預入停止中」(JLP が該当) なので CTA を落とす
          const cap = reserve ? s.kaminoCaps?.get(reserve.reserve) : undefined;
          if (cap !== undefined && reserve) {
            const dec = reserve.underlying_decimals;
            // §4.5: totalSupply は API の decimal string。Number() を経由せず
            // 桁を切り捨ててから smallest unit へ (API は decimals より多い桁を返す)
            const used = toSmallestUnit(
              truncateDecimal(metric.totalSupply, dec),
              dec
            );
            out.deposit_cap = cap.toString();
            out.deposit_used = used;
            out.deposit_open = cap > 0n && BigInt(used) < cap;
          }
        }
        // 8.52: 上流の都合で必ず失敗する market は、枠の取得可否と**独立**に塞ぐ
        // (metric / cap が取れない日でも doomed な導線を出さない、§32.2)
        if (reserve?.deposit_blocked_reason) out.deposit_open = false;
        const vault = KAMINO_VAULTS.find((v) => v.pool_id === pool.pool_id);
        const vm = vault ? s.kaminoVaults?.get(vault.vault) : undefined;
        if (vm) {
          const apy = finite(Number(vm.apy));
          if (apy !== null) out.apy = apy; // TVL は metrics に無く fixture 維持
        }
      } else if (entry.protocol_id === "savefi" && s.saveRates) {
        const mkt = SAVE_MARKETS.find((mk) => mk.pool_id === pool.pool_id);
        const rate = mkt
          ? s.saveRates.find((r) => r.reserve === mkt.reserve)
          : undefined;
        const apy = rate ? finite(rate.supply_apy) : null;
        if (apy !== null) out.apy = apy;
      } else if (entry.protocol_id === "orca" && s.orcaStats) {
        const mkt = ORCA_MARKETS.find((mk) => mk.pool_id === pool.pool_id);
        const stats = mkt ? s.orcaStats.get(mkt.pool_address) : undefined;
        if (stats) {
          const apy = finite(stats.apr_day_bps / 10000);
          const tvl = finite(stats.tvl_usd);
          if (apy !== null) out.apy = apy;
          if (tvl !== null) out.tvl_usd = tvl;
        }
      } else if (
        (entry.protocol_id === "jito" ||
          entry.protocol_id === "marinade" ||
          entry.protocol_id === "sanctum" ||
          entry.protocol_id === "solstice" ||
          entry.protocol_id === "perena" ||
          entry.protocol_id === "hylo") &&
        s.lstApys
      ) {
        // Phase 8.23/8.24: yield token APY (TVL は原則ソース無し、fixture 維持)
        const sym = LST_POOL_SYMBOLS[pool.pool_id];
        const apy = sym !== undefined ? s.lstApys.get(sym) : undefined;
        if (apy !== undefined && finite(apy) !== null) out.apy = apy;
        // Phase 8.26: solstice のみ供給 × syRate で実 TVL
        if (
          pool.pool_id === "solstice_eusx" &&
          s.solsticeTvlUsd !== undefined &&
          finite(s.solsticeTvlUsd) !== null &&
          s.solsticeTvlUsd > 0
        ) {
          out.tvl_usd = s.solsticeTvlUsd;
        }
      } else if (entry.protocol_id === "meteora" && s.meteoraStats) {
        // Phase 8.24: 新データ API (dlmm.datapi.meteora.ag) の実 apy/tvl
        const mkt = METEORA_MARKETS.find((mk) => mk.pool_id === pool.pool_id);
        const stats = mkt ? s.meteoraStats.get(mkt.pool_address) : undefined;
        if (stats) {
          const apy = finite(stats.apy_bps / 10000);
          const tvl = finite(stats.tvl_usd);
          if (apy !== null) out.apy = apy;
          if (tvl !== null && tvl > 0) out.tvl_usd = tvl;
        }
      }
      return out;
    }),
    };
  });
}

export interface ServerOptions {
  /** Fastify logger config (test では false にして noise を抑制) */
  logger?: boolean;
}

/**
 * Fastify instance を作成。テストは `fastify.inject()` で本関数の戻り値を使う。
 * 本番は src/index.ts が `app.listen({ port })` で実起動する。
 */
export async function buildServer(
  opts: ServerOptions = {}
): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false });

  await app.register(cors, {
    // dev は any origin で OK (Mobile emulator は IP/host 多様)
    origin: true,
  });

  // ── health ────────────────────────────────────────────────────────────
  app.get("/health", async () => ({
    status: "ok",
    timestamp: new Date().toISOString(),
  }));

  // ── time events / positions / wallets / protocols / user policy ──────
  // Phase 8.4: production cleanup — fixture を返さず空配列。
  // wallet 接続時は別途 /time-events/wallet?wallet=<addr> で Helius tx を引く。
  app.get("/time-events", async () => [] as UnifiedTimeEventDTO[]);

  /**
   * Phase 8.1: /positions?wallet=<base58 address> で Helius DAS から
   * 実 mainnet 保有を取得。wallet 未指定なら従来通り fixture を返す。
   */
  app.get<{ Querystring: { wallet?: string } }>(
    "/positions",
    async (req, reply) => {
      const wallet = req.query?.wallet?.trim();
      // Phase 8.4: production cleanup — wallet 無指定なら空配列を返す。
      // 接続済 wallet があれば Helius DAS 経由で実 positions を返す path に行く。
      if (!wallet) return [] as Position[];

      // 簡易 base58 validation (44 chars max、空白なし)。詳細は @solana/web3.js
      // PublicKey の方が確実だが BFF deps を増やしたくないので長さで guard。
      if (wallet.length < 32 || wallet.length > 44 || /\s/.test(wallet)) {
        reply.code(400);
        return { error: "invalid_wallet_address", wallet };
      }

      try {
        // 8.70: jlToken は DAS 価格ではなく protocol 自身の交換レートで評価する。
        // markets は 30s cache 済で追加の上流コストはほぼ無い。取得に失敗しても
        // DAS 価格に degrade するだけ (positions 自体は返す)
        const [assets, markets] = await Promise.all([
          fetchAssetsByOwner(wallet),
          fetchEarnMarkets().catch(() => [] as JupiterLendMarket[]),
        ]);
        return mapAssetsToPositions(
          assets,
          wallet,
          jlSharePriceOverrides(markets)
        );
      } catch (err) {
        req.log.error(
          { err: (err as Error).message, wallet },
          "helius fetch failed"
        );
        reply.code(502);
        return {
          error: "helius_fetch_failed",
          message: (err as Error).message,
        };
      }
    }
  );

  app.get("/wallets", async () => fixtureWallets);
  app.get("/protocols", async () => fixtureProtocols);
  // Phase 8.29: override 無しは fixture と byte 一致 (回帰安全)
  app.get("/user-policy", async () => getCurrentPolicy());

  /** Phase 8.29: policy 編集 (auto 設定 / caps)。§6.4 の editable フィールドのみ。 */
  app.patch<{ Body: Record<string, unknown> }>(
    "/user-policy",
    async (req, reply) => {
      try {
        return patchCurrentPolicy(req.body ?? {});
      } catch (err) {
        reply.code(400);
        return {
          error: "invalid_policy_field",
          field: (err as PolicyPatchError).field,
        };
      }
    }
  );

  /**
   * Phase 8.3: 接続済 wallet の tx 履歴を Helius Enhanced API で引いて、
   * Jupiter Lend deposit/withdraw を UnifiedTimeEventDTO[] に変換。
   * 失敗時は空配列を返し、calendar には既存 fixture event のみ表示する fallback。
   */
  app.get<{ Querystring: { wallet?: string } }>(
    "/time-events/wallet",
    async (req, reply) => {
      const wallet = req.query?.wallet?.trim();
      if (!wallet) {
        reply.code(400);
        return { error: "wallet_required" };
      }
      if (wallet.length < 32 || wallet.length > 44 || /\s/.test(wallet)) {
        reply.code(400);
        return { error: "invalid_wallet_address", wallet };
      }
      // Phase 8.16: tx 履歴 (入出金イベント) + epoch (LST 保有時) + Kamino health を
      // 並列取得。source 単位で graceful degrade (全滅でも 200 + 部分結果)。
      // Phase 8.20: LP fee (claim) + native stake (lockup_end) を追加。
      const [txsR, assetsR, epochR, obligR, orcaR, meteoraR, stakeR, expMktR] =
        await Promise.allSettled([
          fetchEnhancedTransactions(wallet),
          fetchAssetsByOwner(wallet),
          getEpochInfo(),
          fetchKaminoObligations(KAMINO_MAIN_MARKET, wallet),
          fetchOrcaPositions(wallet),
          fetchMeteoraPositions(wallet),
          fetchStakeAccounts(wallet),
          // Phase 8.33: PT maturity 解決用 (失敗しても registry backstop がある)
          fetchExponentFullMarkets(),
        ]);
      for (const [r, label] of [
        [txsR, "helius tx"],
        [assetsR, "helius das"],
        [epochR, "epoch info"],
        [obligR, "kamino obligations"],
        [orcaR, "orca positions"],
        [meteoraR, "meteora positions"],
        [stakeR, "stake accounts"],
        [expMktR, "exponent pt markets"],
      ] as const) {
        if (r.status === "rejected") {
          req.log.warn(
            { err: (r.reason as Error).message, wallet },
            `${label} fetch failed (wallet events degrade)`
          );
        }
      }

      const events: UnifiedTimeEventDTO[] =
        txsR.status === "fulfilled"
          ? mapTxsToWalletTimeEvents(txsR.value, wallet)
          : [];

      // LST (SOL 系 swap-earn share) 保有時のみ実 epoch 境界イベントを 1 件追加
      if (assetsR.status === "fulfilled" && epochR.status === "fulfilled") {
        const SOL_MINT = "So11111111111111111111111111111111111111112";
        const lstMints = new Set(
          SWAP_EARN_MARKETS.filter(
            (m) => m.underlying_mint === SOL_MINT && m.protocol_id !== "jupiter_lend"
          ).map((m) => m.share_mint)
        );
        const holdsLst = assetsR.value.some((a) => {
          if (!lstMints.has(a.id)) return false;
          const bal = a.token_info?.balance;
          const s = typeof bal === "number" ? String(bal) : bal;
          return typeof s === "string" && /^[0-9]+$/.test(s) && s !== "0";
        });
        const epochEvent = buildEpochBoundaryEvent(
          epochR.value,
          holdsLst,
          wallet,
          new Date()
        );
        if (epochEvent) events.push(epochEvent);
      }

      // Kamino 借入 obligation の health イベント
      if (obligR.status === "fulfilled") {
        events.push(
          ...mapObligationsToHealthEvents(obligR.value, wallet, new Date())
        );
      }

      // Phase 8.20: LP 未請求 fee → claim イベント (Withdraw & claim action 付き)
      const orcaRaws = orcaR.status === "fulfilled" ? orcaR.value : [];
      const meteoraRaws = meteoraR.status === "fulfilled" ? meteoraR.value : [];
      if (orcaRaws.length > 0 || meteoraRaws.length > 0) {
        events.push(
          ...mapLpPositionsToClaimEvents(orcaRaws, meteoraRaws, wallet, new Date())
        );
      }

      // Phase 8.20: native stake の解除状態 → lockup_end イベント
      if (stakeR.status === "fulfilled" && epochR.status === "fulfilled") {
        events.push(
          ...mapStakeAccountsToLockupEvents(
            stakeR.value,
            epochR.value,
            wallet,
            new Date()
          )
        );
      }

      // Phase 8.33: 保有 PT/YT (Exponent) → maturity イベント (§11.4 の実データ源)
      if (assetsR.status === "fulfilled") {
        events.push(
          ...mapPtHoldingsToMaturityEvents(
            assetsR.value,
            exponentMarketUnion(
              expMktR.status === "fulfilled" ? expMktR.value : undefined
            ),
            wallet,
            new Date()
          )
        );
      }

      return events;
    }
  );

  /**
   * Phase 8.22: menu listing (fixture skeleton + live APY/TVL overlay)。
   * mobile は getMenuListings → useMenuListings (staleTime 60s) で既に配線済み。
   * 全ソース allSettled — 失敗した protocol は fixture 値のまま 200 を返す。
   * 組み立て結果は 60s cache (buildServer instance 単位 — テスト間で漏れない)。
   */
  let menuCache: { at: number; data: ProtocolMenuEntry[] } | null = null;
  const MENU_CACHE_TTL_MS = 60_000;
  app.get("/menu-listings", async (req) => {
    if (menuCache && Date.now() - menuCache.at < MENU_CACHE_TTL_MS) {
      return menuCache.data;
    }
    const [
      jupR,
      kaminoR,
      kvaultR,
      saveR,
      orcaR,
      lstR,
      expR,
      metR,
      perenaR,
      solTvlR,
      expMktR,
      solPriceR,
    ] = await Promise.allSettled([
        fetchEarnMarkets(),
        fetchKaminoReserveMetrics(KAMINO_MAIN_MARKET),
        Promise.allSettled(
          KAMINO_VAULTS.map(
            async (v) => [v.vault, await fetchKaminoVaultMetrics(v.vault)] as const
          )
        ),
        fetchSaveReserveRates(SAVE_MARKETS.map((m) => m.reserve)),
        fetchOrcaPoolStats(),
        fetchLstApys([...new Set(Object.values(LST_POOL_SYMBOLS))]),
        fetchExponentApys(),
        fetchMeteoraPoolStats(),
        fetchPerenaUsdStarApy(),
        // Phase 8.26: Solstice TVL = eUSX 総供給 × syExchangeRate (≈USD)
        (async () => {
          const eusx = SWAP_EARN_MARKETS.find(
            (m) => m.protocol_id === "solstice"
          );
          if (!eusx) throw new Error("solstice market not registered");
          const [supply, syRates] = await Promise.all([
            getTokenSupplyUi(eusx.share_mint),
            fetchExponentSyRates(),
          ]);
          const rate = syRates.get(eusx.share_symbol);
          if (rate === undefined) throw new Error("no eUSX syExchangeRate");
          return supply * rate;
        })(),
        // Phase 8.33: Exponent PT markets + SOL 価格 (SOL quote market の TVL 換算用)
        fetchExponentFullMarkets(),
        getOracleResult("So11111111111111111111111111111111111111112"),
      ]);
    for (const [r, label] of [
      [jupR, "jupiter lend markets"],
      [kaminoR, "kamino reserves"],
      [saveR, "save rates"],
      [orcaR, "orca stats"],
      [lstR, "lst apys"],
      [expR, "exponent apys"],
      [metR, "meteora stats"],
      [perenaR, "perena apy"],
      [solTvlR, "solstice tvl"],
      [expMktR, "exponent pt markets"],
      [solPriceR, "sol oracle price"],
    ] as const) {
      if (r.status === "rejected") {
        req.log.warn(
          { err: (r.reason as Error).message },
          `${label} fetch failed (menu fixture 値のまま)`
        );
      }
    }
    const kaminoVaults = new Map<string, KaminoVaultMetrics>();
    if (kvaultR.status === "fulfilled") {
      for (const r of kvaultR.value) {
        if (r.status === "fulfilled") kaminoVaults.set(r.value[0], r.value[1]);
      }
    }
    // Sanctum LST + Exponent underlyingApy + Perena USD* を 1 つの symbol→APY Map
    // に merge (各ソースの失敗は他に影響しない)。instanceof guard は不正 resolve 対策
    const yieldApys = new Map<string, number>([
      ...(lstR.status === "fulfilled" && lstR.value instanceof Map
        ? lstR.value
        : new Map<string, number>()),
      ...(expR.status === "fulfilled" && expR.value instanceof Map
        ? expR.value
        : new Map<string, number>()),
    ]);
    if (perenaR.status === "fulfilled" && Number.isFinite(perenaR.value)) {
      yieldApys.set("USD*", perenaR.value);
    }
    // 8.51: Kamino の預入枠 (on-chain)。getMultipleAccounts 1 回。失敗しても
    // 空 Map で degrade する (UI は枠表示を出さないだけ)
    const kaminoCaps = new Map<string, bigint>();
    const capList = await Promise.resolve()
      .then(() => fetchKaminoDepositCaps(KAMINO_MARKETS.map((m) => m.reserve)))
      .catch(() => []);
    if (Array.isArray(capList)) {
      for (const cap of capList) kaminoCaps.set(cap.reserve, cap.limit);
    }
    const data = applyMenuLiveOverlays(fixtureMenuListings, {
      jupiterMarkets: jupR.status === "fulfilled" ? jupR.value : undefined,
      kaminoReserves: kaminoR.status === "fulfilled" ? kaminoR.value : undefined,
      kaminoVaults,
      kaminoCaps: kaminoCaps.size > 0 ? kaminoCaps : undefined,
      saveRates: saveR.status === "fulfilled" ? saveR.value : undefined,
      orcaStats: orcaR.status === "fulfilled" ? orcaR.value : undefined,
      lstApys: yieldApys.size > 0 ? yieldApys : undefined,
      meteoraStats: metR.status === "fulfilled" ? metR.value : undefined,
      solsticeTvlUsd: solTvlR.status === "fulfilled" ? solTvlR.value : undefined,
      // Phase 8.33: Exponent (失敗時は undefined → registry snapshot へ degrade)
      exponentMarkets: expMktR.status === "fulfilled" ? expMktR.value : undefined,
      solPriceUsd:
        solPriceR.status === "fulfilled" &&
        typeof solPriceR.value?.price_usd === "string" &&
        Number.isFinite(Number(solPriceR.value.price_usd))
          ? Number(solPriceR.value.price_usd) // §3 display carve-out (menu TVL 換算のみ)
          : undefined,
    });
    menuCache = { at: Date.now(), data };
    return data;
  });

  /**
   * Phase 8.2: 接続済 wallet の Jupiter Lend / Kamino earn positions を返す。
   * MenuDrawer "Your Positions" section が消費。
   *   - Jupiter Lend: 公式 lite API (v1) から確定取得
   *   - Kamino: Helius DAS metadata から best-effort 検出 (APY null)
   */
  app.get<{ Querystring: { wallet?: string } }>(
    "/positions/earn",
    async (req, reply) => {
      const wallet = req.query?.wallet?.trim();
      if (!wallet) {
        reply.code(400);
        return { error: "wallet_required" };
      }
      if (wallet.length < 32 || wallet.length > 44 || /\s/.test(wallet)) {
        reply.code(400);
        return { error: "invalid_wallet_address", wallet };
      }

      // Jupiter / Helius DAS / Helius tx 履歴を並列実行 (一部失敗しても他方を返せるよう Promise.allSettled)。
      // Phase 8.13: tx 履歴は cost-basis (実 accrued yield) 計算に使う。失敗時は空 Map →
      // 全 position が accrued_yield_sign:"unknown" に graceful degrade (フェイク 0 を出さない)。
      // Phase 8.15d: kVault 保有 + 登録 vault の metrics (main の allSettled と並走)。
      // 失敗は graceful degrade (positions → 空、metrics → shares のみ表示)。
      const kvaultPosPromise: Promise<KaminoVaultUserPosition[]> =
        fetchKaminoVaultUserPositions(wallet).catch((err) => {
          req.log.warn(
            { err: (err as Error).message },
            "kvault positions fetch failed"
          );
          return [];
        });
      const kvaultMetricsPromise = Promise.allSettled(
        KAMINO_VAULTS.map(async (v) => [v.vault, await fetchKaminoVaultMetrics(v.vault)] as const)
      );

      // Phase 8.17: Meteora DLMM positions (SDK read、失敗は空)
      const meteoraPositionsPromise = fetchMeteoraPositions(wallet).catch(
        (err) => {
          req.log.warn(
            { err: (err as Error).message },
            "meteora positions fetch failed"
          );
          return [] as MeteoraRawPosition[];
        }
      );
      // Phase 8.18: Orca Whirlpool positions + pool stats (実 APY。失敗は空)
      const orcaPositionsPromise = fetchOrcaPositions(wallet).catch((err) => {
        req.log.warn(
          { err: (err as Error).message },
          "orca positions fetch failed"
        );
        return [] as OrcaRawPosition[];
      });
      const orcaStatsPromise = fetchOrcaPoolStats().catch((err) => {
        req.log.warn({ err: (err as Error).message }, "orca pool stats failed");
        return new Map<string, OrcaPoolStats>();
      });

      // Phase 8.15.x: earnings 実値化用の rate / oracle 価格 (全て失敗許容、並走)。
      const SOL_MINT = "So11111111111111111111111111111111111111112";
      const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
      const sanctumPromise = fetchSanctumSolValues(["jitoSOL", "mSOL", "INF"]).catch(
        (err) => {
          req.log.warn({ err: (err as Error).message }, "sanctum rates failed");
          return new Map<string, bigint>();
        }
      );
      // Phase 8.23-8.25: yield token 行の supply_rate_bps 用 — Sanctum LST +
      // Exponent (eUSX) + Perena (USD*) を merge (各失敗は他に影響しない)
      const lstApysPromise = Promise.allSettled([
        fetchLstApys(["jitoSOL", "mSOL", "INF"]),
        fetchExponentApys(),
        fetchPerenaUsdStarApy(),
      ]).then(([a, b, c]) => {
        const map = new Map<string, number>([
          ...(a.status === "fulfilled" && a.value instanceof Map
            ? a.value
            : new Map<string, number>()),
          ...(b.status === "fulfilled" && b.value instanceof Map
            ? b.value
            : new Map<string, number>()),
        ]);
        if (c.status === "fulfilled" && Number.isFinite(c.value)) {
          map.set("USD*", c.value);
        }
        return map;
      });
      // Phase 8.24: meteora positions の実 APY (失敗は null 表示に degrade)
      const meteoraStatsPromise = fetchMeteoraPoolStats().catch(
        () => new Map<string, MeteoraPoolStats>()
      );
      // Phase 8.24: USD* 専用だった quote rate を share_symbol キー Map に一般化
      // (perena USD* + solstice eUSX)。個別失敗はその symbol だけ degrade。
      const quoteRateMarkets = SWAP_EARN_MARKETS.filter(
        (m) =>
          m.protocol_id === "perena" ||
          m.protocol_id === "solstice" ||
          m.protocol_id === "hylo" // 8.27: hyloSOL / sHYUSD とも quote 換算
      );
      const quoteRatesPromise = Promise.allSettled(
        quoteRateMarkets.map(async (m) => {
          const probe = 10n ** BigInt(m.share_decimals);
          const out = await fetchJupiterRateOut(
            m.share_mint,
            m.underlying_mint,
            probe.toString()
          );
          return [m.share_symbol, { probe, out }] as const;
        })
      ).then((rs) => {
        const map = new Map<string, { probe: bigint; out: bigint }>();
        for (const r of rs) {
          if (r.status === "fulfilled") map.set(r.value[0], r.value[1]);
        }
        return map;
      });
      const saveRatesPromise = fetchSaveReserveRates(
        SAVE_MARKETS.map((m) => m.reserve)
      ).catch(() => [] as Awaited<ReturnType<typeof fetchSaveReserveRates>>);
      const solPricePromise = getOracleResult(SOL_MINT).catch(() => null);
      const usdcPricePromise = getOracleResult(USDC_MINT).catch(() => null);
      // Phase 8.33: Exponent PT markets (失敗は undefined → registry backstop)。
      // Promise.resolve 包みは test automock (非 Promise 戻り) への防御
      const exponentMarketsPromise = Promise.resolve()
        .then(() => fetchExponentFullMarkets())
        .catch(() => undefined);

      const [jupRes, heliusRes, txRes, kaminoObRes, kaminoResRes] =
        await Promise.allSettled([
          fetchEarnPositions(wallet),
          fetchAssetsByOwner(wallet),
          fetchEnhancedTransactions(wallet),
          // Phase 8.15b: 実 Kamino obligation + reserve APY
          fetchKaminoObligations(KAMINO_MAIN_MARKET, wallet),
          fetchKaminoReserveMetrics(KAMINO_MAIN_MARKET),
        ]);

      const kvaultPositions = await kvaultPosPromise;
      const kvaultMetricsByVault = new Map<string, KaminoVaultMetrics>();
      for (const r of await kvaultMetricsPromise) {
        if (r.status === "fulfilled") kvaultMetricsByVault.set(r.value[0], r.value[1]);
      }

      const costBasisByShareMint =
        txRes.status === "fulfilled"
          ? computeCostBasisByShareMint(txRes.value, wallet)
          : new Map<string, bigint>();

      const jupiterLend: EarnPosition[] =
        jupRes.status === "fulfilled"
          ? mapJupiterLendToEarnPositions(jupRes.value, costBasisByShareMint)
          : [];

      // Phase 8.15b: 実 obligation が取れればそれを使い (reserve-keyed → withdraw 可能)、
      // 失敗時のみ DAS best-effort 検出に fallback (share_mint が違い withdraw 不可)。
      const kaminoApyBps =
        kaminoResRes.status === "fulfilled"
          ? kaminoApyBpsByReserve(kaminoResRes.value)
          : new Map<string, number>();
      const kaminoReal: EarnPosition[] =
        kaminoObRes.status === "fulfilled"
          ? mapKaminoObligationsToEarnPositions(kaminoObRes.value, kaminoApyBps)
          : [];
      // Phase 8.15d: kVault 保有 (登録 vault のみ) を Kamino positions に合流
      const kaminoVaultPositions = mapKaminoVaultPositionsToEarnPositions(
        kvaultPositions,
        kvaultMetricsByVault
      );

      // ── Phase 8.15.x: earnings 実値化 ──
      // oracle 価格 (underlying mint → USD ×1e8)
      const priceUsd8ByMint = new Map<string, bigint>();
      const solOracle = await solPricePromise;
      const usdcOracle = await usdcPricePromise;
      const solPrice8 = priceUsd8ToScaled(solOracle?.price_usd ?? null);
      if (solPrice8 !== null && solPrice8 > 0n) priceUsd8ByMint.set(SOL_MINT, solPrice8);
      const usdcPrice8 = priceUsd8ToScaled(usdcOracle?.price_usd ?? null);
      if (usdcPrice8 !== null && usdcPrice8 > 0n) priceUsd8ByMint.set(USDC_MINT, usdcPrice8);

      // kVault: 保有 vault の実 PnL (token 建て) を attach
      const pnlByVault = new Map<string, KaminoVaultPnl>();
      const heldVaults = kaminoVaultPositions.map((p) => p.share_mint);
      if (heldVaults.length > 0) {
        const rs = await Promise.allSettled(
          heldVaults.map(
            async (v) => [v, await fetchKaminoVaultPnl(wallet, v)] as const
          )
        );
        for (const r of rs) {
          if (r.status === "fulfilled") pnlByVault.set(r.value[0], r.value[1]);
        }
      }
      const kaminoVaultWithPnl = attachKaminoVaultPnl(
        kaminoVaultPositions,
        pnlByVault
      );

      // Kamino reserve: 帰属が明確な obligation のみ実 PnL を attach
      const obligPnlByReserve = new Map<string, KaminoObligationPnl>();
      if (kaminoObRes.status === "fulfilled" && kaminoReal.length > 0) {
        const singles = singleSupportedDepositObligations(kaminoObRes.value);
        const rs = await Promise.allSettled(
          [...singles].map(
            async ([reserve, ob]) =>
              [reserve, await fetchKaminoObligationPnl(KAMINO_MAIN_MARKET, ob)] as const
          )
        );
        for (const r of rs) {
          if (r.status === "fulfilled") obligPnlByReserve.set(r.value[0], r.value[1]);
        }
      }
      const kaminoRealWithPnl = attachKaminoObligationPnl(
        kaminoReal,
        obligPnlByReserve,
        priceUsd8ByMint
      );

      const kaminoBestEffort: EarnPosition[] = [
        ...(kaminoRealWithPnl.length > 0
          ? kaminoRealWithPnl
          : heliusRes.status === "fulfilled"
            ? mapKaminoBestEffortFromHelius(heliusRes.value)
            : []),
        ...kaminoVaultWithPnl,
      ];

      // LST/USD* + Save cToken の enriched 保有 (rate 換算 + USD + cost-basis earned)
      const heliusAssets = heliusRes.status === "fulfilled" ? heliusRes.value : [];
      const swapEarn = mapSwapEarnHoldingsToEarnPositions(
        heliusAssets,
        await sanctumPromise,
        await quoteRatesPromise,
        priceUsd8ByMint,
        costBasisByShareMint,
        await lstApysPromise
      );
      const save = mapSaveHoldingsToEarnPositions(
        heliusAssets,
        await saveRatesPromise,
        priceUsd8ByMint,
        costBasisByShareMint
      );
      // Phase 8.33: Exponent PT 保有 (read-only、maturity_at 付き)
      const exponent = mapExponentHoldingsToEarnPositions(
        heliusAssets,
        exponentMarketUnion(await exponentMarketsPromise),
        priceUsd8ByMint
      );
      // Phase 8.19: LP cost-basis (IL 込み earned) — tx 履歴は既存 txRes を再利用
      const meteoraRaws = await meteoraPositionsPromise;
      const orcaRaws = await orcaPositionsPromise;
      // 8.27: jitoSOL-SOL zap の相方脚換算用 rate (sanctum sol-value、SOL 建て)
      const JITOSOL_MINT = "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn";
      const otherLegRates = new Map<string, { num: bigint; den: bigint }>();
      const jitoSolValue = (await sanctumPromise).get("jitoSOL");
      if (jitoSolValue !== undefined && jitoSolValue > 0n) {
        otherLegRates.set(JITOSOL_MINT, { num: jitoSolValue, den: 10n ** 9n });
      }
      const lpCostBasis =
        txRes.status === "fulfilled"
          ? computeLpCostBasisByPositionKey(
              txRes.value,
              wallet,
              orcaRaws,
              meteoraRaws,
              otherLegRates
            )
          : new Map<string, bigint>();
      // Phase 8.17: Meteora DLMM positions (8.24: 実 APY 付き)
      const meteora = mapMeteoraPositionsToEarnPositions(
        meteoraRaws,
        priceUsd8ByMint,
        lpCostBasis,
        await meteoraStatsPromise
      );
      // Phase 8.18: Orca Whirlpool positions (実 APY 付き)
      const orca = mapOrcaPositionsToEarnPositions(
        orcaRaws,
        priceUsd8ByMint,
        await orcaStatsPromise,
        lpCostBasis
      );

      if (jupRes.status === "rejected") {
        req.log.warn(
          { err: (jupRes.reason as Error).message },
          "jupiter lend fetch failed"
        );
      }
      if (heliusRes.status === "rejected") {
        req.log.warn(
          { err: (heliusRes.reason as Error).message },
          "helius fetch failed (kamino detection skipped)"
        );
      }
      if (kaminoObRes.status === "rejected") {
        req.log.warn(
          { err: (kaminoObRes.reason as Error).message },
          "kamino obligations fetch failed (falling back to best-effort)"
        );
      }
      if (txRes.status === "rejected") {
        req.log.warn(
          { err: (txRes.reason as Error).message },
          "helius tx fetch failed (cost-basis unknown, earnings fall back to estimate)"
        );
      }

      const response: EarnPositionsResponse = {
        jupiterLend,
        kaminoBestEffort,
        swapEarn,
        save,
        exponent,
        meteora,
        orca,
      };
      return response;
    }
  );

  // ── agent plans (list + read + approve/reject) ───────────────────────
  // Phase 8.28: MCP 由来の store plan と fixture を merge (store 優先)
  app.get("/agent-plans", async () => [
    ...listStoredPlans(),
    ...fixtureAgentPlans,
  ]);

  app.get<{ Params: { planId: string } }>(
    "/agent-plans/:planId",
    async (req, reply) => {
      const { planId } = req.params;
      const found =
        getStoredPlan(planId) ??
        fixtureAgentPlans.find((p) => p.plan_id === planId);
      if (!found) {
        reply.code(404);
        return { error: "agent_plan_not_found", plan_id: planId };
      }
      return found;
    }
  );

  /**
   * Phase 8.28: MCP compare_opportunities が draft plan を作成する (§11.7)。
   * store 保存 (in-memory — §17/§25 の永続化前段)。
   */
  app.post<{
    Body: {
      objective?: string;
      user_id?: string;
      mcp_client_id?: string;
      constraints?: AgentPlan["constraints"];
      candidate_actions?: CandidateAction[];
    };
  }>("/agent-plans", async (req, reply) => {
    const body = req.body ?? {};
    if (!body.objective || typeof body.objective !== "string") {
      reply.code(400);
      return { error: "missing_required_field", required: ["objective"] };
    }
    const plan = createPlan({
      objective: body.objective as AgentPlan["objective"],
      user_id: body.user_id,
      mcp_client_id: body.mcp_client_id,
      constraints: body.constraints,
      candidate_actions: body.candidate_actions,
    });
    reply.code(201);
    return plan;
  });

  /**
   * Phase 8.28: MCP request_user_approval — status を pending_user にし、
   * 登録済み push token へ Expo push を best-effort 送信 (ApprovalPushPayload
   * 契約 = mobile services/push.ts)。push 失敗/token 無しでも 200 (poll で成立)。
   */
  app.post<{ Params: { planId: string }; Body: { timeout_seconds?: number } }>(
    "/agent-plans/:planId/request-approval",
    async (req, reply) => {
      const { planId } = req.params;
      const plan = getStoredPlan(planId);
      if (!plan) {
        reply.code(404);
        return { error: "agent_plan_not_found", plan_id: planId };
      }
      if (
        plan.status !== AgentPlanStatus.Simulated &&
        plan.status !== AgentPlanStatus.PendingUser
      ) {
        reply.code(409);
        return {
          error: "invalid_status_transition",
          current: plan.status,
          target: AgentPlanStatus.PendingUser,
        };
      }
      // Phase 8.29: auto-approve 短絡 — approval_mode=auto かつ flag ON かつ
      // kill されていなければ、push/待機なしで即 approved + token 発行
      // (§11.6)。MCP poll (GET /:id/approval) が即 approved+token を観測する。
      //
      // Phase 8.29 fix (F3, §32.2 policy-aware execution): selected_action が
      // policy の enabled_protocols / enabled_assets を満たす時のみ短絡する。
      // 満たさなければ fall through して通常の人手承認 (pending_user) を要求 =
      // fail-closed。金額/TVL/risk の厳密 cap は follow-up (ActionSpec に
      // amount_usd8 / category を持たないため)。自律 /tick 経路は既に full
      // evaluatePolicy 済 (autonomous.ts) なので穴なし。
      const autoPolicy = getCurrentPolicy();
      const autoAct = plan.selected_action;
      const autoPolicyOk =
        !!autoAct &&
        autoPolicy.enabled_protocols.includes(autoAct.protocol) &&
        (autoAct.asset === undefined ||
          autoPolicy.enabled_assets.includes(autoAct.asset));
      // Phase 8.37 (B4): 日次上限は自律 /tick 経路と共有 (min(policy, hard cap))。
      // 超過時は短絡せず pending_user へ fall through = 人手承認要求 (fail-closed)
      const autoDailyOk = getDailyCount() < dailyLimitFor(autoPolicy);
      if (
        plan.status === AgentPlanStatus.Simulated &&
        !isKilled() &&
        canAutoExecute(autoPolicy, isAutonomousFeatureEnabled()) &&
        plan.selected_action &&
        plan.simulation_result &&
        autoPolicyOk &&
        autoDailyOk
      ) {
        issueApprovalToken({
          user_id: plan.user_id,
          plan_id: plan.plan_id,
          mcp_client_id: plan.mcp_client_id,
          bundle_hash: plan.simulation_result.bundle_hash,
        });
        incrementDaily(); // auto 承認も日次枠を消費 (自律実行と合算の保守側運用)
        return updatePlan(planId, { status: AgentPlanStatus.Approved })!;
      }
      // idempotent (§10.3): pending_user なら push を再送しない
      const alreadyPending = plan.status === AgentPlanStatus.PendingUser;
      const next = updatePlan(planId, {
        status: AgentPlanStatus.PendingUser,
      })!;
      if (!alreadyPending) {
        const pushTokens = listPushTokens();
        if (pushTokens.length > 0) {
          try {
            await fetch("https://exp.host/--/api/v2/push/send", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(
                pushTokens.map((to) => ({
                  to,
                  title: "Seasonals — approval requested",
                  body: `Agent plan ${planId} awaits your approval`,
                  data: { type: "approval", plan_id: planId },
                }))
              ),
            });
          } catch (err) {
            req.log.warn(
              { err: (err as Error).message },
              "approval push send failed (poll fallback)"
            );
          }
        }
      }
      return next;
    }
  );

  /**
   * Phase 8.28: MCP request_user_approval の poll 先 — 承認状態と、承認済み
   * なら発行済み approval_token を返す (§24.9)。v1 は client 認証の無い dev
   * 前提 (plan_id を知る者が token を取得できる — README に明記、v2 で auth)。
   */
  app.get<{ Params: { planId: string } }>(
    "/agent-plans/:planId/approval",
    async (req, reply) => {
      const { planId } = req.params;
      const plan = getStoredPlan(planId);
      if (!plan) {
        reply.code(404);
        return { error: "agent_plan_not_found", plan_id: planId };
      }
      const token =
        plan.status === AgentPlanStatus.Approved
          ? getLatestTokenForPlan(planId)
          : undefined;
      return {
        plan_id: planId,
        status: plan.status,
        approval_token: token ?? null,
      };
    }
  );

  app.post<{
    Params: { planId: string };
    Body: { fee_payer?: string };
  }>("/agent-plans/:planId/approve", async (req, reply) => {
    const { planId } = req.params;
    // Phase 8.28: store plan は永続遷移 + ApprovalToken 発行
    const stored = getStoredPlan(planId);
    if (stored) {
      if (
        stored.status !== AgentPlanStatus.Simulated &&
        stored.status !== AgentPlanStatus.PendingUser
      ) {
        reply.code(409);
        return {
          error: "invalid_status_transition",
          current: stored.status,
          target: AgentPlanStatus.Approved,
        };
      }
      if (!stored.selected_action || !stored.simulation_result) {
        reply.code(409);
        return { error: "simulation_required", plan_id: planId };
      }
      const token = issueApprovalToken({
        user_id: stored.user_id,
        plan_id: stored.plan_id,
        mcp_client_id: stored.mcp_client_id,
        bundle_hash: stored.simulation_result.bundle_hash,
      });
      const next = updatePlan(planId, { status: AgentPlanStatus.Approved })!;
      return { ...next, approval_token: token };
    }

    const found = fixtureAgentPlans.find((p) => p.plan_id === planId);
    if (!found) {
      reply.code(404);
      return { error: "agent_plan_not_found", plan_id: planId };
    }
    if (
      found.status !== AgentPlanStatus.Simulated &&
      found.status !== AgentPlanStatus.PendingUser
    ) {
      reply.code(409);
      return {
        error: "invalid_status_transition",
        current: found.status,
        target: AgentPlanStatus.Approved,
      };
    }
    const next: AgentPlan & { tx?: string } = {
      ...found,
      status: AgentPlanStatus.Approved,
      updated_at: new Date().toISOString(),
    };
    // fee_payer が渡された場合、Devnet RPC から blockhash 取得 + memo tx を構築。
    // fee_payer 不在 / Devnet RPC 失敗時は plan のみ返す (mobile 側で sign skip)。
    const feePayer = req.body?.fee_payer;
    if (feePayer && typeof feePayer === "string" && feePayer.length > 0) {
      try {
        next.tx = await buildMemoTransaction(feePayer, planId);
      } catch (err) {
        // Devnet RPC が落ちている等。tx field を欠落させるだけで approve 自体は成功扱い
        req.log.warn(
          { err: (err as Error).message },
          "memo tx build failed"
        );
      }
    }
    return next;
  });

  app.post<{ Params: { planId: string }; Body: { reason?: string } }>(
    "/agent-plans/:planId/reject",
    async (req, reply) => {
      const { planId } = req.params;
      // Phase 8.28: store plan は永続遷移
      const stored = getStoredPlan(planId);
      if (stored) {
        return updatePlan(planId, { status: AgentPlanStatus.Rejected })!;
      }
      const found = fixtureAgentPlans.find((p) => p.plan_id === planId);
      if (!found) {
        reply.code(404);
        return { error: "agent_plan_not_found", plan_id: planId };
      }
      const next: AgentPlan = {
        ...found,
        status: AgentPlanStatus.Rejected,
        updated_at: new Date().toISOString(),
      };
      return next;
    }
  );

  /**
   * Phase 8.28: MCP execute_approved_action (§24.9 / §29.3)。
   * approval_token を単一操作で検証+消費 (single-use / TTL / bundle_hash /
   * plan 一致)。v1 は swap-earn の deposit / withdraw のみ unsigned tx を構築。
   * Agent は unsigned tx を受け取るだけで署名しない (§6.5)。
   */
  app.post<{
    Params: { planId: string };
    Body: { approval_token?: string };
  }>("/agent-plans/:planId/execute", async (req, reply) => {
    const { planId } = req.params;
    const tokenId = req.body?.approval_token;
    if (!tokenId || typeof tokenId !== "string") {
      reply.code(400);
      return { error: "missing_required_field", required: ["approval_token"] };
    }
    const plan = getStoredPlan(planId);
    if (!plan) {
      reply.code(404);
      return { error: "agent_plan_not_found", plan_id: planId };
    }
    if (plan.status !== AgentPlanStatus.Approved) {
      reply.code(409);
      return {
        error: "invalid_status_transition",
        current: plan.status,
        target: AgentPlanStatus.Executing,
      };
    }
    const action = plan.selected_action;
    if (!action) {
      reply.code(409);
      return { error: "selected_action_required", plan_id: planId };
    }

    // v1: swap-earn (Jupiter routable) の deposit / withdraw のみ。
    // Phase 8.37: 実行可否と oracle gate を **token 消費より前** に判定する —
    // 単発 token を oracle block / 非対応 action で無駄に消費させない (§29.3)
    const market = action.asset
      ? findMarketByProtocolAsset(action.protocol, action.asset)
      : undefined;
    if (
      !market ||
      (action.action_type !== "deposit" && action.action_type !== "withdraw") ||
      !action.amount ||
      !isValidTokenAmount(action.amount)
    ) {
      reply.code(422);
      return {
        error: "unsupported_action_v1",
        message:
          "v1 executes swap-earn deposit/withdraw only (valid amount required)",
      };
    }

    // Phase 8.37 (B1): execute にも §4.6 fail-closed gate — 直接 tx-build endpoint
    // (buildSwapEarnTx 等) と同一の判定。agent 経路だけ oracle 無検査で署名可能
    // tx を返していた drift の修正
    const oracle = await getOracleResult(market.underlying_mint);
    if (oracle.status === "blocked") {
      req.log.warn(
        { planId, block_reason: oracle.block_reason },
        "execute blocked by oracle gate"
      );
      reply.code(409);
      return { error: "oracle_blocked", block_reason: oracle.block_reason, oracle };
    }

    const validation = validateAndConsumeToken(tokenId, {
      plan_id: planId,
      bundle_hash: computeBundleHash(action),
    });
    if (!validation.valid) {
      reply.code(403);
      return { error: "approval_token_invalid", reason: validation.reason };
    }
    const isDeposit = action.action_type === "deposit";
    try {
      const quote = await fetchSwapQuote({
        inputMint: isDeposit ? market.underlying_mint : market.share_mint,
        outputMint: isDeposit ? market.share_mint : market.underlying_mint,
        amount: action.amount,
        slippageBps: 50,
      });
      const tx = await fetchSwapTransaction({
        quoteResponse: quote,
        userPublicKey: action.wallet_id,
      });
      const next = updatePlan(planId, { status: AgentPlanStatus.Executing })!;
      return {
        execution_id: `exec_${planId}`,
        status: "pushed_to_mobile",
        plan: next,
        unsigned_transactions: [
          {
            index: 0,
            label: `${action.action_type} ${action.asset} on ${action.protocol}`,
            tx_base64: tx.swapTransaction,
          },
        ],
      };
    } catch (err) {
      req.log.error(
        { err: (err as Error).message, planId },
        "execute tx build failed"
      );
      updatePlan(planId, { status: AgentPlanStatus.Failed });
      reply.code(502);
      return { error: "execute_tx_build_failed", message: (err as Error).message };
    }
  });

  // ── adapter-driven endpoints (CLAUDE.md §13 / §26) ───────────────────

  /** Kamino reserves 一覧 (UI の "explore lending" で使う候補) */
  /**
   * Phase 8.6: Jupiter Lend Earn の 7 markets (jlUSDC / jlWSOL / jlUSDT 等) を
   * lite API から正規化して返す。MenuDrawer の Jupiter drill-down 動的化用。
   * 失敗時は空配列を返し、UI は fixture pools fallback (Phase 6) で表示。
   */
  app.get("/protocols/jupiter-lend/markets", async (req) => {
    try {
      return await fetchEarnMarkets();
    } catch (err) {
      req.log.warn(
        { err: (err as Error).message },
        "jupiter lend markets fetch failed; returning empty"
      );
      return [] as JupiterLendMarket[];
    }
  });

  app.get("/protocols/kamino/reserves", async (req) => {
    // Phase 8.15b: 実 Kamino API の reserve metrics (supported reserve のみ、実 APY/TVL)。
    // 失敗時は mock adapter に fallback (fixture、graceful degrade)。
    try {
      const metrics = await fetchKaminoReserveMetrics(KAMINO_MAIN_MARKET);
      return { reserves: kaminoMetricsToSummary(metrics) };
    } catch (err) {
      req.log.warn(
        { err: (err as Error).message },
        "kamino reserves fetch failed, falling back to adapter fixture"
      );
      const adapter = getRegistry().getLending("kamino");
      if (!adapter) return { reserves: [] };
      return {
        reserves: await adapter.fetchReserves({
          wallet_address: "stub",
          chain: "solana:devnet",
        }),
      };
    }
  });

  /**
   * Phase 8.14 §4.6: underlying mint の実 oracle 判定 (Pyth→Switchboard fail-closed)。
   * Mobile ActionModal が review 時に引いて WarningArea 表示 / CTA gate に使う。
   * deposit/withdraw-tx の server 強制 gate と同じ getOracleResult を共有。
   */
  app.get<{ Querystring: { mint?: string } }>(
    "/oracle/status",
    async (req, reply) => {
      const mint = req.query?.mint?.trim();
      if (!mint) {
        reply.code(400);
        return { error: "mint_required" };
      }
      return getOracleResult(mint);
    }
  );

  /**
   * Phase 8.58: wallet の tx から復元した **過去の評価額**。
   *
   * 現在残高 (DAS) から enhanced tx の符号付き差分を遡って各日の残高を作り、
   * その日の実価格 (Pyth Benchmarks) で値付けする。端末側の日次スナップショット
   * (8.56) より前の期間を埋めるのが目的。
   *
   * 上流が落ちた時は **空 points** で返す (fixture の履歴を捏造しない)。
   */
  app.get<{ Querystring: { wallet?: string; days?: string } }>(
    "/portfolio/history",
    async (req, reply) => {
      const wallet = req.query?.wallet?.trim();
      if (!wallet) {
        reply.code(400);
        return { error: "wallet_required" };
      }
      const requested = Number(req.query?.days ?? "30");
      const days = Number.isFinite(requested)
        ? Math.min(730, Math.max(1, Math.floor(requested)))
        : 30;
      try {
        return await buildPortfolioHistory(wallet, days);
      } catch (err) {
        req.log.warn(
          { err: (err as Error).message, wallet },
          "portfolio history failed; returning empty"
        );
        return { points: [], oldest_at: null, approximated_symbols: [] };
      }
    }
  );

  /**
   * Phase 8.57: symbol → 実 USD 価格 (8 decimals string、§4.5)。
   *
   * mobile は wallet holdings の価格を position の `unit_price_usd`
   * (Helius DAS 由来) から取るが、**native SOL には DAS の price_info が無く
   * 0 で来る**。そこを埋めるのがこの口 (oracle registry にある asset のみ)。
   *
   * §4.6 fail-closed の一貫性: blocked / 価格不明の symbol は **返さない**。
   * 0 を返すと呼び手が「0 円」と誤解するため、キー自体を落とす。
   */
  app.get<{ Querystring: { symbols?: string } }>(
    "/prices",
    async (req, reply) => {
      const raw = req.query?.symbols?.trim();
      if (!raw) {
        reply.code(400);
        return { error: "symbols_required" };
      }
      const symbols = raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 20); // 上限 (registry は 4 asset なので実質十分)
      const prices: Record<string, string> = {};
      await Promise.all(
        symbols.map(async (symbol) => {
          const mint = oracleMintForSymbol(symbol);
          if (!mint) return;
          try {
            const result = await getOracleResult(mint);
            if (result.status !== "blocked" && result.price_usd) {
              prices[symbol] = result.price_usd;
            }
          } catch (err) {
            req.log.warn(
              { err: (err as Error).message, symbol },
              "price lookup failed"
            );
          }
        })
      );
      return { prices };
    }
  );

  /**
   * Phase 8.8: Mobile が MWA で署名した raw tx を base64 で受け取り、Helius
   * mainnet RPC 経由で broadcast。Phantom の signAndSendTransactions が
   * empty result を返す問題の回避策。
   */
  app.post<{ Body: { signedTx?: string; skipPreflight?: boolean } }>(
    "/tx/submit",
    async (req, reply) => {
      const { signedTx, skipPreflight } = req.body ?? {};
      if (!signedTx || typeof signedTx !== "string") {
        reply.code(400);
        return { error: "missing_signed_tx" };
      }
      try {
        const signature = await sendTransactionViaHelius(signedTx, {
          skipPreflight: Boolean(skipPreflight),
        });
        return { signature };
      } catch (err) {
        req.log.error(
          { err: (err as Error).message },
          "tx submit failed"
        );
        reply.code(502);
        return {
          error: "submit_failed",
          message: (err as Error).message,
        };
      }
    }
  );

  /**
   * Phase 8.9: One-tap withdraw — jlToken → underlying mint の Jupiter Swap tx。
   * deposit と inverse の swap route で同じ Jupiter Lend Earn AMM を通る。
   *
   * body: { user, jlMint, amount: shares smallest unit, slippageBps?: number }
   *   jlMint = jlToken mint (jlUSDC 等)。output = underlying mint (registry 逆引き)。
   */
  app.post<{
    Body: {
      user: string;
      jlMint: string;
      amount: string;
      slippageBps?: number;
    };
  }>("/protocols/jupiter-lend/withdraw-tx", async (req, reply) => {
    const { user, jlMint, amount, slippageBps } = req.body ?? {};
    if (!user || !jlMint || !amount) {
      reply.code(400);
      return {
        error: "missing_required_field",
        required: ["user", "jlMint", "amount"],
      };
    }
    if (user.length < 32 || user.length > 44 || /\s/.test(user)) {
      reply.code(400);
      return { error: "invalid_wallet_address", user };
    }
    // jlMint → underlying mint (inverse of UNDERLYING_TO_JL_SHARE_MINT)
    const inverse = Object.entries(UNDERLYING_TO_JL_SHARE_MINT).find(
      ([, jl]) => jl === jlMint
    );
    if (!inverse) {
      reply.code(400);
      return {
        error: "unsupported_jl_mint",
        message: "Unknown Jupiter Lend share mint",
        jlMint,
      };
    }
    const outputMint = inverse[0]!;
    // Phase 8.15: oracle gate (underlying=outputMint) + swap tx を共通 helper に委譲。
    return buildSwapEarnTx(req, reply, {
      user,
      inputMint: jlMint,
      outputMint,
      oracleMint: outputMint,
      amount,
      slippageBps,
    });
  });

  /**
   * Phase 8.5: One-tap deposit primitive — Jupiter Swap API 経由で underlying mint →
   * jlToken mint の swap tx を取得。返り値の swapTransaction (base64 versioned tx) を
   * Mobile 側で MWA 経由 sign + mainnet broadcast する。
   *
   * body: { user, inputMint, amount: smallest unit, slippageBps?: number }
   *   inputMint は underlying token (USDC mint 等)。output (jlToken) は registry で解決。
   */
  app.post<{
    Body: {
      user: string;
      inputMint: string;
      amount: string;
      slippageBps?: number;
    };
  }>("/protocols/jupiter-lend/deposit-tx", async (req, reply) => {
    const { user, inputMint, amount, slippageBps } = req.body ?? {};
    if (!user || !inputMint || !amount) {
      reply.code(400);
      return {
        error: "missing_required_field",
        required: ["user", "inputMint", "amount"],
      };
    }
    if (user.length < 32 || user.length > 44 || /\s/.test(user)) {
      reply.code(400);
      return { error: "invalid_wallet_address", user };
    }
    const outputMint = UNDERLYING_TO_JL_SHARE_MINT[inputMint];
    if (!outputMint) {
      reply.code(400);
      return {
        error: "unsupported_input_mint",
        message: "Jupiter Lend does not support deposit for this mint via Seasonals",
        inputMint,
      };
    }
    // Phase 8.15: oracle gate (underlying=inputMint) + swap tx を共通 helper に委譲。
    return buildSwapEarnTx(req, reply, {
      user,
      inputMint,
      outputMint,
      oracleMint: inputMint,
      amount,
      slippageBps,
    });
  });

  /**
   * Phase 8.15: protocol 汎用 swap-earn deposit-tx。Jupiter Lend で実証済の
   * "deposit = underlying→share の Jupiter Swap" を SWAP_EARN_MARKETS で一般化。
   * shareMint で market を解決 → input=underlying, output=share, oracle=underlying。
   *   body: { user, shareMint, amount: underlying smallest unit, slippageBps? }
   */
  app.post<{
    Body: {
      user: string;
      shareMint: string;
      amount: string;
      slippageBps?: number;
    };
  }>("/protocols/swap-earn/deposit-tx", async (req, reply) => {
    const { user, shareMint, amount, slippageBps } = req.body ?? {};
    if (!user || !shareMint || !amount) {
      reply.code(400);
      return {
        error: "missing_required_field",
        required: ["user", "shareMint", "amount"],
      };
    }
    if (user.length < 32 || user.length > 44 || /\s/.test(user)) {
      reply.code(400);
      return { error: "invalid_wallet_address", user };
    }
    const market = findMarketByShareMint(shareMint);
    if (!market) {
      reply.code(400);
      return {
        error: "unsupported_share_mint",
        message: "No swap-earn market registered for this share mint",
        shareMint,
      };
    }
    // deposit: underlying → share。oracle gate は underlying に掛ける。
    return buildSwapEarnTx(req, reply, {
      user,
      inputMint: market.underlying_mint,
      outputMint: market.share_mint,
      oracleMint: market.underlying_mint,
      amount,
      slippageBps,
    });
  });

  /**
   * Phase 8.15: protocol 汎用 swap-earn withdraw-tx。share→underlying の Jupiter Swap。
   * shareMint で market を解決 → input=share, output=underlying, oracle=underlying。
   *   body: { user, shareMint, amount: share smallest unit, slippageBps? }
   */
  app.post<{
    Body: {
      user: string;
      shareMint: string;
      amount: string;
      slippageBps?: number;
    };
  }>("/protocols/swap-earn/withdraw-tx", async (req, reply) => {
    const { user, shareMint, amount, slippageBps } = req.body ?? {};
    if (!user || !shareMint || !amount) {
      reply.code(400);
      return {
        error: "missing_required_field",
        required: ["user", "shareMint", "amount"],
      };
    }
    if (user.length < 32 || user.length > 44 || /\s/.test(user)) {
      reply.code(400);
      return { error: "invalid_wallet_address", user };
    }
    const market = findMarketByShareMint(shareMint);
    if (!market) {
      reply.code(400);
      return {
        error: "unsupported_share_mint",
        message: "No swap-earn market registered for this share mint",
        shareMint,
      };
    }
    // withdraw: share → underlying。oracle gate は underlying に掛ける。
    return buildSwapEarnTx(req, reply, {
      user,
      inputMint: market.share_mint,
      outputMint: market.underlying_mint,
      oracleMint: market.underlying_mint,
      amount,
      slippageBps,
    });
  });

  /**
   * Phase 8.15b: Kamino Lend deposit-tx。api.kamino.finance の unsigned tx builder を
   * 叩き base64 tx を返す（swap でなく lending obligation deposit）。
   *   body: { user, reserve, amount(smallest-unit string) }
   */
  app.post<{
    Body: { user: string; reserve: string; amount: string };
  }>("/protocols/kamino/deposit-tx", async (req, reply) => {
    const { user, reserve, amount } = req.body ?? {};
    if (!user || !reserve || !amount) {
      reply.code(400);
      return {
        error: "missing_required_field",
        required: ["user", "reserve", "amount"],
      };
    }
    if (user.length < 32 || user.length > 44 || /\s/.test(user)) {
      reply.code(400);
      return { error: "invalid_wallet_address", user };
    }
    return buildKaminoTx(req, reply, { user, reserve, amount, action: "deposit" });
  });

  /**
   * Phase 8.15b: Kamino Lend withdraw-tx（reserve → underlying、amount は保有 cToken
   * 相当の smallest-unit。Kamino API は残高で cap するので over でも安全）。
   */
  app.post<{
    Body: { user: string; reserve: string; amount: string };
  }>("/protocols/kamino/withdraw-tx", async (req, reply) => {
    const { user, reserve, amount } = req.body ?? {};
    if (!user || !reserve || !amount) {
      reply.code(400);
      return {
        error: "missing_required_field",
        required: ["user", "reserve", "amount"],
      };
    }
    if (user.length < 32 || user.length > 44 || /\s/.test(user)) {
      reply.code(400);
      return { error: "invalid_wallet_address", user };
    }
    return buildKaminoTx(req, reply, { user, reserve, amount, action: "withdraw" });
  });

  /**
   * Phase 8.15d: Kamino Earn vault (kVault) deposit-tx。
   *   body: { user, vault, amount(underlying smallest-unit string) }
   */
  app.post<{
    Body: { user: string; vault: string; amount: string };
  }>("/protocols/kamino/vault-deposit-tx", async (req, reply) => {
    const { user, vault, amount } = req.body ?? {};
    if (!user || !vault || !amount) {
      reply.code(400);
      return {
        error: "missing_required_field",
        required: ["user", "vault", "amount"],
      };
    }
    if (user.length < 32 || user.length > 44 || /\s/.test(user)) {
      reply.code(400);
      return { error: "invalid_wallet_address", user };
    }
    return buildKaminoVaultTx(req, reply, { user, vault, amount, action: "deposit" });
  });

  /**
   * Phase 8.15d: kVault withdraw-tx (share 建て。over-balance は Kamino 側で cap)。
   *   body: { user, vault, amount(share smallest-unit string) }
   */
  app.post<{
    Body: { user: string; vault: string; amount: string };
  }>("/protocols/kamino/vault-withdraw-tx", async (req, reply) => {
    const { user, vault, amount } = req.body ?? {};
    if (!user || !vault || !amount) {
      reply.code(400);
      return {
        error: "missing_required_field",
        required: ["user", "vault", "amount"],
      };
    }
    if (user.length < 32 || user.length > 44 || /\s/.test(user)) {
      reply.code(400);
      return { error: "invalid_wallet_address", user };
    }
    return buildKaminoVaultTx(req, reply, { user, vault, amount, action: "withdraw" });
  });

  /**
   * Phase 8.15c: Save (旧 Solend) deposit-tx。solend-sdk (BFF 内) で pure-supply の
   * unsigned v0 tx 群を構築 (cToken を wallet に mint)。複数 tx は mobile が MWA
   * 一括署名 → 順次 submit する。
   *   body: { user, reserve, amount(underlying smallest-unit string) }
   */
  app.post<{
    Body: { user: string; reserve: string; amount: string };
  }>("/protocols/save/deposit-tx", async (req, reply) => {
    const { user, reserve, amount } = req.body ?? {};
    if (!user || !reserve || !amount) {
      reply.code(400);
      return {
        error: "missing_required_field",
        required: ["user", "reserve", "amount"],
      };
    }
    if (user.length < 32 || user.length > 44 || /\s/.test(user)) {
      reply.code(400);
      return { error: "invalid_wallet_address", user };
    }
    const market = findSaveMarketByReserve(reserve);
    if (!market) {
      reply.code(400);
      return {
        error: "unsupported_reserve",
        message: "No Save market registered for this reserve",
        reserve,
      };
    }
    return buildSaveTx(req, reply, { user, market, amount, action: "deposit" });
  });

  /**
   * Phase 8.15c: Save withdraw-tx (redeem cToken → underlying)。
   *   body: { user, ctokenMint, amount(cToken smallest-unit string) }
   */
  app.post<{
    Body: { user: string; ctokenMint: string; amount: string };
  }>("/protocols/save/withdraw-tx", async (req, reply) => {
    const { user, ctokenMint, amount } = req.body ?? {};
    if (!user || !ctokenMint || !amount) {
      reply.code(400);
      return {
        error: "missing_required_field",
        required: ["user", "ctokenMint", "amount"],
      };
    }
    if (user.length < 32 || user.length > 44 || /\s/.test(user)) {
      reply.code(400);
      return { error: "invalid_wallet_address", user };
    }
    const market = findSaveMarketByCToken(ctokenMint);
    if (!market) {
      reply.code(400);
      return {
        error: "unsupported_ctoken",
        message: "No Save market registered for this cToken mint",
        ctokenMint,
      };
    }
    return buildSaveTx(req, reply, { user, market, amount, action: "withdraw" });
  });

  /**
   * Phase 8.34: Exponent PT 満期 redeem tx (wrapper_merge)。read-only 統合 (8.33)
   * への実行系第一弾 — 満期済 PT のみ。満期前は 400 not_matured (fail-closed、
   * builder 側でも on-chain maturity を再検査する二重化)。
   *   body: { user, ptMint, amount (PT smallest-unit string §4.5) }
   */
  app.post<{
    Body: { user: string; ptMint: string; amount: string };
  }>("/protocols/exponent/redeem-tx", async (req, reply) => {
    const { user, ptMint, amount } = req.body ?? {};
    if (!user || !ptMint || !amount) {
      reply.code(400);
      return {
        error: "missing_required_field",
        required: ["user", "ptMint", "amount"],
      };
    }
    if (user.length < 32 || user.length > 44 || /\s/.test(user)) {
      reply.code(400);
      return { error: "invalid_wallet_address", user };
    }
    if (!isValidTokenAmount(amount)) {
      reply.code(400);
      return { error: "invalid_amount", amount };
    }
    // live ∪ registry で解決 (満期後に live から消えた PT も registry が引く)
    const markets = exponentMarketUnion(
      await Promise.resolve()
        .then(() => fetchExponentFullMarkets())
        .catch(() => undefined)
    );
    const market = markets.find((m) => m.pt_mint === ptMint);
    if (!market || market.vault_address.length === 0) {
      reply.code(400);
      return {
        error: "unsupported_market",
        message: "No Exponent PT market registered for this mint",
        ptMint,
      };
    }
    // fast-path 満期チェック (authoritative は builder の on-chain 検査)
    if (market.maturity_ts * 1000 > Date.now()) {
      reply.code(400);
      return {
        error: "not_matured",
        maturity_at: exponentMaturityIso(market.maturity_ts),
      };
    }
    const oracle = await getOracleResult(market.underlying_mint);
    if (oracle.status === "blocked") {
      reply.code(409);
      return { error: "oracle_blocked", block_reason: oracle.block_reason, oracle };
    }
    try {
      const { transaction } = await buildExponentRedeemTx({
        wallet: user,
        market: {
          pt_mint: market.pt_mint,
          yt_mint: market.yt_mint,
          vault_address: market.vault_address,
          underlying_mint: market.underlying_mint,
        },
        amountSmallest: amount,
      });
      return { transaction, ptMint, underlyingMint: market.underlying_mint };
    } catch (err) {
      const msg = (err as Error).message;
      if (msg === "not_matured") {
        reply.code(400);
        return { error: "not_matured" };
      }
      if (msg === "redeem_template_unavailable") {
        // 当該 vault にまだ誰も redeem していない (新満期直後など) — fail-closed
        reply.code(409);
        return { error: "redeem_template_unavailable", ptMint };
      }
      req.log.error({ err: msg, ptMint }, "exponent redeem tx build failed");
      reply.code(502);
      return { error: "exponent_tx_failed", message: msg };
    }
  });

  /**
   * Phase 8.17: Meteora DLMM single-sided LP deposit-tx。
   * server が Spot strategy (active bin 片側 20 bins) を決める — range UI 無し。
   * 返る tx は **position ephemeral keypair の部分署名済み** (user 署名スロットは空)。
   *   body: { user, poolKey(pool_id), amount(deposit token smallest-unit) }
   */
  app.post<{
    Body: { user: string; poolKey: string; amount: string };
  }>("/protocols/meteora/deposit-tx", async (req, reply) => {
    const { user, poolKey, amount } = req.body ?? {};
    if (!user || !poolKey || !amount) {
      reply.code(400);
      return {
        error: "missing_required_field",
        required: ["user", "poolKey", "amount"],
      };
    }
    if (user.length < 32 || user.length > 44 || /\s/.test(user)) {
      reply.code(400);
      return { error: "invalid_wallet_address", user };
    }
    const market = findMeteoraMarketByPool(poolKey);
    if (!market) {
      reply.code(400);
      return {
        error: "unsupported_pool",
        message: "No Meteora DLMM pool registered for this key",
        poolKey,
      };
    }
    if (!isValidTokenAmount(amount)) {
      reply.code(400);
      return { error: "invalid_amount", amount };
    }
    const oracle = await getOracleResult(market.deposit_mint);
    if (oracle.status === "blocked") {
      reply.code(409);
      return { error: "oracle_blocked", block_reason: oracle.block_reason, oracle };
    }
    try {
      const { transactions, position } = await buildMeteoraDepositTxns({
        wallet: user,
        market,
        amountSmallest: amount,
      });
      return { transactions, position, poolAddress: market.pool_address };
    } catch (err) {
      req.log.error(
        { err: (err as Error).message, poolKey },
        "meteora deposit tx build failed"
      );
      reply.code(502);
      return { error: "meteora_tx_failed", message: (err as Error).message };
    }
  });

  /**
   * Phase 8.17: Meteora DLMM withdraw-tx。amount (deposit token 建て smallest) と
   * 現在総額から bps を計算 (総額以上 → 10000 = 全量 + fee claim + close)。
   *   body: { user, position(account pubkey), amount }
   */
  app.post<{
    Body: { user: string; position: string; amount: string };
  }>("/protocols/meteora/withdraw-tx", async (req, reply) => {
    const { user, position, amount } = req.body ?? {};
    if (!user || !position || !amount) {
      reply.code(400);
      return {
        error: "missing_required_field",
        required: ["user", "position", "amount"],
      };
    }
    if (user.length < 32 || user.length > 44 || /\s/.test(user)) {
      reply.code(400);
      return { error: "invalid_wallet_address", user };
    }
    if (!isValidTokenAmount(amount)) {
      reply.code(400);
      return { error: "invalid_amount", amount };
    }
    try {
      const rawPositions = await fetchMeteoraPositions(user);
      const raw = rawPositions.find((r) => r.position_address === position);
      const market: MeteoraDlmmMarket | undefined = raw
        ? METEORA_MARKETS.find((m) => m.pool_id === raw.pool_id)
        : undefined;
      if (!raw || !market) {
        reply.code(400);
        return {
          error: "position_not_found",
          message: "No Meteora position for this wallet/address",
          position,
        };
      }
      const oracle = await getOracleResult(market.deposit_mint);
      if (oracle.status === "blocked") {
        reply.code(409);
        return { error: "oracle_blocked", block_reason: oracle.block_reason, oracle };
      }
      // bps 計算 (共通 helper): 要求額 / 現在総額 (deposit 建て)。round、1..10000 clamp。
      const totals = meteoraTotalsInDepositTerms(raw, market.deposit_side);
      const bps = withdrawBpsFor(toBigInt(amount), totals?.total ?? null);
      const { transactions } = await buildMeteoraWithdrawTxns({
        wallet: user,
        market,
        positionAddress: position,
        bps,
        fromBinId: raw.lower_bin_id,
        toBinId: raw.upper_bin_id,
      });
      return { transactions, bps, poolAddress: market.pool_address };
    } catch (err) {
      req.log.error(
        { err: (err as Error).message, position },
        "meteora withdraw tx build failed"
      );
      reply.code(502);
      return { error: "meteora_tx_failed", message: (err as Error).message };
    }
  });

  /**
   * Phase 8.18: Orca Whirlpools full-range LP deposit-tx (zap-in)。
   * 返る transactions は 2 本:
   *   [0] Jupiter swap (入金 USDC の半分 → 相方 token、user 単独署名)
   *   [1] full-range open + increase (**position mint ephemeral の部分署名済み**)
   *   body: { user, poolKey(pool_id), amount(deposit token smallest-unit) }
   */
  app.post<{
    Body: { user: string; poolKey: string; amount: string };
  }>("/protocols/orca/deposit-tx", async (req, reply) => {
    const { user, poolKey, amount } = req.body ?? {};
    if (!user || !poolKey || !amount) {
      reply.code(400);
      return {
        error: "missing_required_field",
        required: ["user", "poolKey", "amount"],
      };
    }
    if (user.length < 32 || user.length > 44 || /\s/.test(user)) {
      reply.code(400);
      return { error: "invalid_wallet_address", user };
    }
    const market = findOrcaMarketByPool(poolKey);
    if (!market) {
      reply.code(400);
      return {
        error: "unsupported_pool",
        message: "No Orca whirlpool registered for this key",
        poolKey,
      };
    }
    if (!isValidTokenAmount(amount)) {
      reply.code(400);
      return { error: "invalid_amount", amount };
    }
    const oracle = await getOracleResult(market.deposit_mint);
    if (oracle.status === "blocked") {
      reply.code(409);
      return { error: "oracle_blocked", block_reason: oracle.block_reason, oracle };
    }
    try {
      const { transactions, position } = await buildOrcaDepositTxns({
        wallet: user,
        market,
        amountSmallest: amount,
      });
      return { transactions, position, poolAddress: market.pool_address };
    } catch (err) {
      req.log.error(
        { err: (err as Error).message, poolKey },
        "orca deposit tx build failed"
      );
      reply.code(502);
      return { error: "orca_tx_failed", message: (err as Error).message };
    }
  });

  /**
   * Phase 8.18: Orca Whirlpools withdraw-tx。amount (deposit token 建て smallest) と
   * 現在総額から bps を計算 (総額以上 → 10000 = closePosition: fee 回収 + 全量 + NFT burn)。
   *   body: { user, position(= position mint pubkey), amount }
   */
  app.post<{
    Body: { user: string; position: string; amount: string };
  }>("/protocols/orca/withdraw-tx", async (req, reply) => {
    const { user, position, amount } = req.body ?? {};
    if (!user || !position || !amount) {
      reply.code(400);
      return {
        error: "missing_required_field",
        required: ["user", "position", "amount"],
      };
    }
    if (user.length < 32 || user.length > 44 || /\s/.test(user)) {
      reply.code(400);
      return { error: "invalid_wallet_address", user };
    }
    if (!isValidTokenAmount(amount)) {
      reply.code(400);
      return { error: "invalid_amount", amount };
    }
    try {
      const rawPositions = await fetchOrcaPositions(user);
      const raw = rawPositions.find((r) => r.position_mint === position);
      const market = raw
        ? ORCA_MARKETS.find((m) => m.pool_id === raw.pool_id)
        : undefined;
      if (!raw || !market) {
        reply.code(400);
        return {
          error: "position_not_found",
          message: "No Orca position for this wallet/mint",
          position,
        };
      }
      const oracle = await getOracleResult(market.deposit_mint);
      if (oracle.status === "blocked") {
        reply.code(409);
        return { error: "oracle_blocked", block_reason: oracle.block_reason, oracle };
      }
      const totals = orcaTotalsInDepositTerms(raw, market.deposit_side);
      const bps = withdrawBpsFor(toBigInt(amount), totals?.total ?? null);
      const { transactions } = await buildOrcaWithdrawTxns({
        wallet: user,
        market,
        positionMint: position,
        bps,
      });
      return { transactions, bps, poolAddress: market.pool_address };
    } catch (err) {
      req.log.error(
        { err: (err as Error).message, position },
        "orca withdraw tx build failed"
      );
      reply.code(502);
      return { error: "orca_tx_failed", message: (err as Error).message };
    }
  });

  /** Phase 8.15c: Save reserve 実 rates (supply APY + cToken exchange rate)。失敗時は空。 */
  app.get("/protocols/save/reserves", async (req) => {
    try {
      const rates = await fetchSaveReserveRates(SAVE_MARKETS.map((m) => m.reserve));
      const bySymbol = new Map(SAVE_MARKETS.map((m) => [m.reserve, m]));
      return {
        reserves: rates.map((r) => ({
          reserve_id: r.reserve,
          asset_symbol: bySymbol.get(r.reserve)?.underlying_symbol ?? "?",
          lend_apy: r.supply_apy,
          ctoken_exchange_rate: r.ctoken_exchange_rate,
        })),
      };
    } catch (err) {
      req.log.warn(
        { err: (err as Error).message },
        "save reserves fetch failed"
      );
      return { reserves: [] };
    }
  });

  /** Jupiter quote (input → output の swap route preview) */
  app.post<{
    Body: {
      input_mint: string;
      output_mint: string;
      amount: string;
      slippage_bps?: number;
    };
  }>("/protocols/jupiter/quote", async (req, reply) => {
    const { input_mint, output_mint, amount, slippage_bps } = req.body ?? {};
    if (!input_mint || !output_mint || !amount) {
      reply.code(400);
      return {
        error: "missing_required_field",
        required: ["input_mint", "output_mint", "amount"],
      };
    }
    const registry = getRegistry();
    const adapter = registry.getSwap("jupiter");
    if (!adapter) {
      reply.code(404);
      return { error: "swap_adapter_not_registered", protocol_id: "jupiter" };
    }
    return await adapter.quote({
      input_mint,
      output_mint,
      amount,
      slippage_bps: slippage_bps ?? 50,
    });
  });

  /**
   * AgentPlan の simulate 経路 (CLAUDE.md §11.7、ApprovalToken 発行前段階)。
   * adapter から estimated_out / fee / route を取得して SimulationResult として返す。
   */
  app.post<{
    Params: { planId: string };
    Body: { action_spec?: ActionSpec };
  }>("/agent-plans/:planId/simulate", async (req, reply) => {
      const { planId } = req.params;
      // Phase 8.28: store plan は body.action_spec を selected_action に採用し、
      // simulation_result を永続 (status→simulated)。bundle_hash は決定的 sha256。
      const stored = getStoredPlan(planId);
      const found =
        stored ?? fixtureAgentPlans.find((p) => p.plan_id === planId);
      if (!found) {
        reply.code(404);
        return { error: "agent_plan_not_found", plan_id: planId };
      }
      const action = stored
        ? (req.body?.action_spec ?? stored.selected_action)
        : found.selected_action;
      if (!action) {
        reply.code(400);
        return { error: "selected_action_required" };
      }

      const registry = getRegistry();
      const lendingAdapter = registry.getLending(action.protocol);
      const swapAdapter = action.to_protocol
        ? registry.getSwap(action.to_protocol)
        : undefined;

      const ctx = {
        wallet_address: "stub",
        chain: "solana:devnet" as const,
      };

      // protocol が lending adapter を持つなら simulate
      let estimated_out = "0";
      let estimated_fee = "0";
      let slippage_bps: number | undefined;
      const meta: Record<string, unknown> = {};

      if (lendingAdapter) {
        const sim = await lendingAdapter.simulate(ctx, action);
        estimated_out = sim.estimated_out;
        estimated_fee = sim.estimated_fee;
        slippage_bps = sim.slippage_bps;
        Object.assign(meta, sim.metadata ?? {});
      }
      // rotate (to_protocol あり) で swap adapter があれば quote 取得して route を載せる
      if (swapAdapter && action.to_protocol === "jupiter") {
        // input/output mints は本来 protocol 固有の解決が必要。stub では USDC ↔ SOL。
        const quote = await swapAdapter.quote({
          input_mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
          output_mint: "So11111111111111111111111111111111111111112",
          amount: action.amount ?? "1000000",
          slippage_bps: slippage_bps ?? 50,
        });
        Object.assign(meta, { jupiter_quote: quote });
      }

      // Phase 8.37 (B2): oracle 健全性は捏造 stub でなく **実 getOracleResult** を
      // 反映する (§4.6)。simulate の decision table: 両 stale / 両未取得は 409 拒否、
      // >5% 乖離は「通す + warning」(execute 側 8.37-B1 が拒否する)。
      // swap-earn registry で解決できない asset は oracle field を **省略** する
      // (偽の健全表示をしない — optional field の正直な不在)
      let simOracle:
        | {
            primary: "pyth" | "switchboard";
            primary_age_seconds: number;
            divergence_pct?: number;
            warnings: string[];
          }
        | undefined;
      const oracleMarket = action.asset
        ? findMarketByProtocolAsset(action.protocol, action.asset)
        : undefined;
      if (oracleMarket) {
        const oracle = await getOracleResult(oracleMarket.underlying_mint);
        if (
          oracle.status === "blocked" &&
          oracle.block_reason !== "oracle_divergence_too_large"
        ) {
          // oracle_both_stale / oracle_unavailable — simulate も拒否 (§4.6 表)
          reply.code(409);
          return {
            error: "oracle_blocked",
            block_reason: oracle.block_reason,
            oracle,
          };
        }
        // SimulationResult.oracle.warnings は string[] (§11.7) — block_reason の
        // 強警告も混載するため WarningKind union より広い型で持つ
        const warnings: string[] = oracle.warnings.map((w) => w.kind);
        if (oracle.block_reason === "oracle_divergence_too_large") {
          warnings.push("oracle_divergence_too_large"); // simulate は通すが強警告
        }
        if (oracle.primary) {
          simOracle = {
            primary: oracle.primary,
            primary_age_seconds: oracle[oracle.primary].age_seconds ?? 0,
            divergence_pct: oracle.divergence_pct ?? undefined,
            warnings,
          };
        } else if (warnings.length > 0) {
          Object.assign(meta, { oracle_warnings: warnings });
        }
      }

      const sim = {
        simulation_id: `sim_${planId}_${Date.now()}`,
        estimated_out,
        estimated_fee,
        slippage_bps,
        // Phase 8.28: ランダム stub を決定的 hash に置換 (§11.7 改ざんガード実体)
        bundle_hash: computeBundleHash(action),
        ...(simOracle ? { oracle: simOracle } : {}),
        metadata: meta,
      };
      // store plan は selected_action + simulation_result を永続 (§11.7)
      if (stored) {
        updatePlan(planId, {
          selected_action: action,
          simulation_result: sim,
          status: AgentPlanStatus.Simulated,
        });
      }
      return { plan_id: planId, simulation: sim };
    }
  );

  // ── approval tokens (8.28: store 発行分を優先、fixture は回帰用) ────────
  app.get<{ Params: { tokenId: string } }>(
    "/approval-tokens/:tokenId",
    async (req, reply) => {
      const { tokenId } = req.params;
      const found =
        getStoredToken(tokenId) ??
        fixtureApprovalTokens.find((t) => t.token_id === tokenId);
      if (!found) {
        reply.code(404);
        return { error: "approval_token_not_found", token_id: tokenId };
      }
      return found;
    }
  );

  // ── push tokens (8.28: in-memory 登録に昇格。永続化は §17/§25) ─────────
  app.post<{ Body: { token: string; device_id?: string } }>(
    "/push-tokens",
    async (req, reply) => {
      const body = req.body ?? {};
      if (!body.token || typeof body.token !== "string") {
        reply.code(400);
        return { error: "invalid_push_token" };
      }
      registerPushToken(body.token);
      return { registered_at: new Date().toISOString() };
    }
  );

  // ── Phase 8.29: 自律実行 (bounded 委任署名 / devnet) ──────────────────────
  const autonomousDeps = buildAutonomousDeps(app);

  app.post<{ Body: { objective?: string; asset?: string; dry_run?: boolean } }>(
    "/autonomous/tick",
    async (req, reply) => {
      const body = req.body ?? {};
      if (!isObjective(body.objective)) {
        reply.code(400);
        return { error: "invalid_objective", objective: body.objective };
      }
      const opts: RunAutonomousOpts = {
        objective: body.objective,
        asset: body.asset,
        dry_run: body.dry_run,
      };
      try {
        return await runAutonomousCycle(opts, autonomousDeps);
      } catch (err) {
        if (err instanceof AutonomousDisabledError) {
          reply.code(
            err.code === "kill_switch_active"
              ? 503
              : err.code === "no_delegate"
                ? 409
                : 403
          );
          return { error: "autonomous_disabled", reason: err.code };
        }
        req.log.error({ err: (err as Error).message }, "autonomous tick failed");
        reply.code(500);
        return { error: "autonomous_tick_failed", message: (err as Error).message };
      }
    }
  );

  app.get("/autonomous/log", async () => listExecutionRecords());
  app.get("/autonomous/status", async () => getAutonomousStatus());
  app.post("/autonomous/kill", async () => {
    killAutonomous();
    return getAutonomousStatus();
  });
  app.post("/autonomous/resume", async () => {
    resumeAutonomous();
    return getAutonomousStatus();
  });

  return app;
}

/**
 * Phase 8.29: 自律サイクルの依存を組み立てる。fetchMenu は app.inject で
 * live /menu-listings を再利用 (overlay + cache そのまま)。scheduler も同じ deps。
 */
export function buildAutonomousDeps(app: FastifyInstance): AutonomousDeps {
  return {
    fetchMenu: async () => {
      const res = await app.inject({ method: "GET", url: "/menu-listings" });
      return res.json();
    },
    getPolicy: () => getCurrentPolicy(),
    sendExecutionPush: async (payload: ExecutionPushPayload) => {
      const tokens = listPushTokens();
      if (tokens.length === 0) return;
      await fetch("https://exp.host/--/api/v2/push/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          tokens.map((to) => ({
            to,
            title: "Seasonals — funds moved (devnet)",
            body: `${payload.protocol} ${payload.action_type} $${payload.amount_usd8} — sig ${(payload.tx_signature ?? "").slice(0, 8)}…`,
            data: payload,
          }))
        ),
      });
    },
  };
}
