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

import Fastify, { type FastifyInstance } from "fastify";
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
} from "@workspace/lib/utils/numeric";
import { getRegistry } from "@workspace/lib/adapters";

import { fetchAssetsByOwner, type HeliusAsset } from "./clients/helius";
import {
  fetchEarnMarkets,
  fetchEarnPositions,
  type JupiterLendMarket,
} from "./clients/jupiter-lend";
import {
  fetchEnhancedTransactions,
  type HeliusEnhancedTx,
  type HeliusTokenBalanceChange,
} from "./clients/helius-tx";
import {
  fetchSwapQuote,
  fetchSwapTransaction,
} from "./clients/jupiter-swap";
import { sendTransactionViaHelius } from "./clients/helius-rpc";
import { getOracleResult } from "./clients/oracle";

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

function mapAssetsToPositions(
  assets: HeliusAsset[],
  walletAddress: string
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
    const unitPriceUsd =
      typeof priceFloat === "number" && Number.isFinite(priceFloat)
        ? priceFloat.toFixed(8)
        : "0.00000000";

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
      underlying_usd: normalizeJup8DecimalUsd(raw.underlyingBalance),
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
 * Phase 8.5: underlying asset mint → jlToken (jupiter lend share) mint。
 * Jupiter Swap が USDC → jlUSDC を直接 route するので、deposit-tx で output として渡す。
 * Phase 8.6: 7 markets 全部対応。
 */
const UNDERLYING_TO_JL_SHARE_MINT: Record<string, string> = {
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v:
    "9BEcn9aPEmhSPbPQeFGjidRiEKki46fVQDyPpSQXPA2D", // USDC → jlUSDC
  So11111111111111111111111111111111111111112:
    "2uQsyo1fXXQkDtcpXnLofWy88PxcvnfH2L8FPSE62FVU", // SOL → jlWSOL
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB:
    "Cmn4v2wipYV41dkakDvCgFJpxhtaaKt11NyWV8pjSE8A", // USDT → jlUSDT
  HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr:
    "GcV9tEj62VncGithz4o4N9x6HWXARxuRgEAYk9zahNA8", // EURC → jlEURC
  USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA:
    "j14XLJZSVMcUYpAfajdZRpnfHUpJieZHS4aPektLWvh", // USDS → jlUSDS
  "2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH":
    "9fvHrYNw1A8Evpcj7X2yy4k4fT7nNHcA9L6UsamNHAif", // USDG → jlUSDG
  JuprjznTrTSp2UFa3ZBUFgwdAmtZCq4MQCwysN55USD:
    "7GxATsNMnaC88vdwd2t3mwrFuQwwGvmYPrUQ4D6FotXk", // JupUSD → jlJupUSD
};

/** Phase 8.13: jlToken share mint → underlying asset mint (UNDERLYING_TO_JL_SHARE_MINT の逆引き) */
const JL_SHARE_TO_UNDERLYING_MINT: Record<string, string> = Object.fromEntries(
  Object.entries(UNDERLYING_TO_JL_SHARE_MINT).map(([underlying, share]) => [
    share,
    underlying,
  ])
);

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

    for (const shareMint of Object.keys(JUPITER_LEND_SHARE_MINTS)) {
      // この tx で wallet の share mint が動いたか (deposit/withdraw のシグナル)
      const shareMoved = changes.some(
        (c) => c.mint === shareMint && c.userAccount === walletAddress
      );
      if (!shareMoved) continue;

      const underlyingMint = JL_SHARE_TO_UNDERLYING_MINT[shareMint];
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
 * Phase 8.3: Helius Enhanced Tx を UnifiedTimeEventDTO[] に変換。
 * - jlToken mint の transfer in/out → Jupiter Lend deposit/withdraw
 * - tokenTransfers のみ見る (depth 1)、Kamino は本 phase 軽量検出 (mint name 検査は
 *   Helius Enhanced API では取れないので Phase 8.2 同様 wallet 保有検出のみ、tx 履歴
 *   側からの Kamino detection は将来 SDK 連携時に拡張)。
 *
 * UnifiedTimeEventDTO に変換 (BFF は DTO で返す、Mobile 側で Date に復元)。
 * category は 8-fixed 中 "Epoch" を generic temporal marker として流用。
 */
function mapTxsToWalletTimeEvents(
  txs: HeliusEnhancedTx[],
  walletAddress: string
): UnifiedTimeEventDTO[] {
  const out: UnifiedTimeEventDTO[] = [];
  for (const tx of txs) {
    const transfers = tx.tokenTransfers ?? [];
    let idx = 0;
    for (const t of transfers) {
      const jlAsset = JUPITER_LEND_SHARE_MINTS[t.mint];
      if (!jlAsset) continue;
      const isDeposit = t.toUserAccount === walletAddress;
      const isWithdraw = t.fromUserAccount === walletAddress;
      if (!isDeposit && !isWithdraw) continue;
      const verb = isDeposit ? "Deposited" : "Withdrew";
      out.push({
        id: `tx_${tx.signature}_${idx}`,
        protocol: "jupiter_lend",
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
          headline: `${verb} ${t.tokenAmount.toFixed(4)} ${jlAsset} on Jupiter Lend`,
          direction: isDeposit ? "deposit" : "withdraw",
          jl_share_mint: t.mint,
        },
      });
      idx += 1;
    }
  }
  return out;
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
        const assets = await fetchAssetsByOwner(wallet);
        return mapAssetsToPositions(assets, wallet);
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
  app.get("/user-policy", async () => fixtureUserPolicyDefault);

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
      try {
        const txs = await fetchEnhancedTransactions(wallet);
        return mapTxsToWalletTimeEvents(txs, wallet);
      } catch (err) {
        req.log.warn(
          { err: (err as Error).message, wallet },
          "helius enhanced-tx fetch failed; returning empty wallet events"
        );
        return [] as UnifiedTimeEventDTO[];
      }
    }
  );

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
      const [jupRes, heliusRes, txRes] = await Promise.allSettled([
        fetchEarnPositions(wallet),
        fetchAssetsByOwner(wallet),
        fetchEnhancedTransactions(wallet),
      ]);

      const costBasisByShareMint =
        txRes.status === "fulfilled"
          ? computeCostBasisByShareMint(txRes.value, wallet)
          : new Map<string, bigint>();

      const jupiterLend: EarnPosition[] =
        jupRes.status === "fulfilled"
          ? mapJupiterLendToEarnPositions(jupRes.value, costBasisByShareMint)
          : [];
      const kaminoBestEffort: EarnPosition[] =
        heliusRes.status === "fulfilled"
          ? mapKaminoBestEffortFromHelius(heliusRes.value)
          : [];

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
      if (txRes.status === "rejected") {
        req.log.warn(
          { err: (txRes.reason as Error).message },
          "helius tx fetch failed (cost-basis unknown, earnings fall back to estimate)"
        );
      }

      const response: EarnPositionsResponse = {
        jupiterLend,
        kaminoBestEffort,
      };
      return response;
    }
  );

  // ── agent plans (list + read + approve/reject) ───────────────────────
  app.get("/agent-plans", async () => fixtureAgentPlans);

  app.get<{ Params: { planId: string } }>(
    "/agent-plans/:planId",
    async (req, reply) => {
      const { planId } = req.params;
      const found = fixtureAgentPlans.find((p) => p.plan_id === planId);
      if (!found) {
        reply.code(404);
        return { error: "agent_plan_not_found", plan_id: planId };
      }
      return found;
    }
  );

  app.post<{
    Params: { planId: string };
    Body: { fee_payer?: string };
  }>("/agent-plans/:planId/approve", async (req, reply) => {
    const { planId } = req.params;
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

  app.get("/protocols/kamino/reserves", async () => {
    const registry = getRegistry();
    const adapter = registry.getLending("kamino");
    if (!adapter) return { reserves: [] };
    return {
      reserves: await adapter.fetchReserves({
        wallet_address: "stub",
        chain: "solana:devnet",
      }),
    };
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
    // Phase 8.14 §4.6: fail-closed oracle gate。両 stale / 乖離>5% / 両未取得 は
    // swapTransaction を返さず 409。未設定 asset (not_configured) は通す。
    const oracle = await getOracleResult(outputMint);
    if (oracle.status === "blocked") {
      reply.code(409);
      return { error: "oracle_blocked", block_reason: oracle.block_reason, oracle };
    }
    try {
      const quote = await fetchSwapQuote({
        inputMint: jlMint,
        outputMint,
        amount,
        slippageBps: slippageBps ?? 50,
      });
      const tx = await fetchSwapTransaction({
        quoteResponse: quote,
        userPublicKey: user,
        prioritizationFeeLamports: "auto",
        dynamicComputeUnitLimit: true,
      });
      return {
        swapTransaction: tx.swapTransaction,
        lastValidBlockHeight: tx.lastValidBlockHeight,
        outAmount: quote.outAmount,
        outputMint,
        quote,
      };
    } catch (err) {
      req.log.error(
        { err: (err as Error).message, user, jlMint, amount },
        "jupiter swap withdraw-tx failed"
      );
      reply.code(502);
      return {
        error: "jupiter_swap_failed",
        message: (err as Error).message,
      };
    }
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
    // Phase 8.14 §4.6: fail-closed oracle gate。deposit する underlying (inputMint) を
    // 判定し、blocked なら swapTransaction を返さず 409。未設定 asset は通す。
    const oracle = await getOracleResult(inputMint);
    if (oracle.status === "blocked") {
      reply.code(409);
      return { error: "oracle_blocked", block_reason: oracle.block_reason, oracle };
    }
    try {
      const quote = await fetchSwapQuote({
        inputMint,
        outputMint,
        amount,
        slippageBps: slippageBps ?? 50,
      });
      const tx = await fetchSwapTransaction({
        quoteResponse: quote,
        userPublicKey: user,
        prioritizationFeeLamports: "auto",
        dynamicComputeUnitLimit: true,
      });
      return {
        swapTransaction: tx.swapTransaction,
        lastValidBlockHeight: tx.lastValidBlockHeight,
        outAmount: quote.outAmount,
        outputMint,
        quote,
      };
    } catch (err) {
      req.log.error(
        { err: (err as Error).message, user, inputMint, amount },
        "jupiter swap deposit-tx failed"
      );
      reply.code(502);
      return {
        error: "jupiter_swap_failed",
        message: (err as Error).message,
      };
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
  app.post<{ Params: { planId: string } }>(
    "/agent-plans/:planId/simulate",
    async (req, reply) => {
      const { planId } = req.params;
      const found = fixtureAgentPlans.find((p) => p.plan_id === planId);
      if (!found) {
        reply.code(404);
        return { error: "agent_plan_not_found", plan_id: planId };
      }
      const action = found.selected_action;
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

      const sim = {
        simulation_id: `sim_${planId}_${Date.now()}`,
        estimated_out,
        estimated_fee,
        slippage_bps,
        bundle_hash: `0x${Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, "0")}…`,
        oracle: {
          primary: "pyth" as const,
          primary_age_seconds: Math.floor(Math.random() * 10),
          divergence_pct: 0.3,
          warnings: [] as string[],
        },
        metadata: meta,
      };
      return { plan_id: planId, simulation: sim };
    }
  );

  // ── approval tokens ──────────────────────────────────────────────────
  app.get<{ Params: { tokenId: string } }>(
    "/approval-tokens/:tokenId",
    async (req, reply) => {
      const { tokenId } = req.params;
      const found = fixtureApprovalTokens.find((t) => t.token_id === tokenId);
      if (!found) {
        reply.code(404);
        return { error: "approval_token_not_found", token_id: tokenId };
      }
      return found;
    }
  );

  // ── push tokens (no-op mock; 本実装は §17 / §25 で Redis + Postgres) ───
  app.post<{ Body: { token: string; device_id?: string } }>(
    "/push-tokens",
    async (req, reply) => {
      const body = req.body ?? {};
      if (!body.token || typeof body.token !== "string") {
        reply.code(400);
        return { error: "invalid_push_token" };
      }
      return { registered_at: new Date().toISOString() };
    }
  );

  return app;
}
