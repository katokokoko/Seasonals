/**
 * agent-plan-estimate — AgentPlan simulate の「受け取り量」見積り (2026-10-08、spec §11.7 / §24.9)
 *
 * 旧 simulate は mock registry (Kamino だけ 30 日 APY 見込み、他は全部 "0") を返し、単位も入力 asset
 * だった。ここでは resolveSolanaRoute が解決した route ごとに、**人が使う tx builder と同じ見積り元**
 * を読む:
 *   - swap-earn (Jupiter Lend / LST / USD* 等): Jupiter quote (builder と同じ slippage 50bps)。
 *     LST は償還価値ガード (swap-fair-value.ts) の判定を warning として添える
 *   - Kamino reserve: 受け取り量 = 入力量 (担保は underlying 建てで管理される)。預入停止は warning
 *   - Kamino kVault: vault metrics の tokensPerShare で shares ⇄ underlying を換算
 *   - Save: reserve の cTokenExchangeRate で cToken ⇄ underlying を換算
 *   - Meteora / Orca (LP position) と Exponent PT redeem: 単一の数値を出さない
 *
 * simulate は情報提供 (§4.6) なので **throw しない**。上流の失敗は failure_reason に落とし、warn log を残す。
 * fair value の乖離もここでは止めず warning にする (実際の拒否は execute の buildSwapEarnTx)。
 * fee は出さない — priority fee は auto で tx 本数も build 後にしか分からず、署名なしで正直な値が無い。
 *
 * §4.5: amount / out はすべて smallest unit string。換算は exchange-rate-math.ts の bigint 演算のみ。
 */
import type { FastifyBaseLogger } from "fastify";

import type {
  SimulationEstimateKind,
  SimulationResult,
  SimulationWarning,
} from "@workspace/lib/types";
import { isValidTokenAmount } from "@workspace/lib/utils/numeric";
import type { SolanaRoute } from "@workspace/lib/derive/solana-action";
import { findMarketByShareMint } from "@workspace/lib/config/swap-earn-markets";
import {
  findKaminoMarketByReserve,
  findKaminoVaultByAddress,
} from "@workspace/lib/config/kamino-markets";
import {
  findSaveMarketByCToken,
  findSaveMarketByReserve,
} from "@workspace/lib/config/save-markets";

import { fetchSwapQuote } from "./clients/jupiter-swap";
import { fetchKaminoVaultMetrics } from "./clients/kamino-tx";
import { fetchSaveReserveRates } from "./clients/save-tx";
import { SWAP_EARN_SLIPPAGE_BPS } from "./agent-plan-executor";
import { evaluateSwapFairValue } from "./swap-fair-value";
import {
  kvaultSharesToUnderlying,
  kvaultUnderlyingToShares,
  saveCTokenToUnderlying,
  saveUnderlyingToCToken,
} from "./exchange-rate-math";

/**
 * SimulationResult のうち見積りが埋める部分 (simulation_id / bundle_hash / oracle は route handler が持つ)。
 * estimated_fee は意図的に含めない (上の説明)
 */
export type PlanEstimate = Pick<
  SimulationResult,
  | "estimated_out"
  | "estimated_out_mint"
  | "estimated_out_symbol"
  | "estimated_out_decimals"
  | "min_out"
  | "slippage_bps"
  | "warnings"
  | "failure_reason"
  | "metadata"
> & { estimate_kind: SimulationEstimateKind };

type Log = Pick<FastifyBaseLogger, "warn">;

function none(failure_reason: NonNullable<PlanEstimate["failure_reason"]>): PlanEstimate {
  return { estimate_kind: "none", failure_reason };
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function estimateSwapEarn(
  route: Extract<SolanaRoute, { kind: "swap_earn_deposit" | "swap_earn_withdraw" }>,
  amount: string,
  log: Log
): Promise<PlanEstimate> {
  const market = findMarketByShareMint(route.shareMint);
  if (!market) return none("unsupported_market");
  const deposit = route.kind === "swap_earn_deposit";
  const out = deposit
    ? { mint: market.share_mint, symbol: market.share_symbol, decimals: market.share_decimals }
    : { mint: market.underlying_mint, symbol: market.underlying_symbol, decimals: market.underlying_decimals };

  let quote: Awaited<ReturnType<typeof fetchSwapQuote>>;
  try {
    quote = await fetchSwapQuote({
      inputMint: deposit ? market.underlying_mint : market.share_mint,
      outputMint: deposit ? market.share_mint : market.underlying_mint,
      amount,
      slippageBps: SWAP_EARN_SLIPPAGE_BPS,
    });
  } catch (err) {
    log.warn({ err: errMessage(err), route: route.kind, share: market.share_symbol }, "simulate: swap quote failed");
    return none("quote_unavailable");
  }
  if (!quote || !isValidTokenAmount(quote.outAmount)) {
    log.warn({ route: route.kind, share: market.share_symbol }, "simulate: swap quote has no valid outAmount");
    return none("quote_unavailable");
  }

  const warnings: SimulationWarning[] = [];
  const metadata: Record<string, unknown> = {};
  if (typeof quote.priceImpactPct === "string") metadata.price_impact_pct = quote.priceImpactPct;
  // 8.72 の償還価値ガード。simulate では止めず warning にする (execute の builder が 409 で止める)
  const verdict = await evaluateSwapFairValue(log, quote, {
    direction: deposit ? "deposit" : "withdraw",
    shareSymbol: market.share_symbol,
  }).catch((err) => {
    log.warn({ err: errMessage(err), route: route.kind }, "simulate: fair value check failed");
    return { status: "blocked", reason: "fair_value_unavailable" } as const;
  });
  if (verdict.status !== "no_reference") metadata.fair_value = verdict;
  if (verdict.status === "blocked") warnings.push(verdict.reason);

  return {
    estimate_kind: "quote",
    estimated_out: quote.outAmount,
    estimated_out_mint: out.mint,
    estimated_out_symbol: out.symbol,
    estimated_out_decimals: out.decimals,
    ...(isValidTokenAmount(quote.otherAmountThreshold) ? { min_out: quote.otherAmountThreshold } : {}),
    slippage_bps: SWAP_EARN_SLIPPAGE_BPS,
    ...(warnings.length > 0 ? { warnings } : {}),
    metadata,
  };
}

function estimateKaminoReserve(
  route: Extract<SolanaRoute, { kind: "kamino_deposit" | "kamino_withdraw" }>,
  amount: string
): PlanEstimate {
  const market = findKaminoMarketByReserve(route.reserve);
  if (!market) return none("unsupported_market");
  // deposit / withdraw とも underlying 建て (withdraw の amount も BFF が underlying_decimals で変換する)
  const blocked = route.kind === "kamino_deposit" ? market.deposit_blocked_reason : undefined;
  return {
    estimate_kind: "same_as_input",
    estimated_out: amount,
    estimated_out_mint: market.underlying_mint,
    estimated_out_symbol: market.underlying_symbol,
    estimated_out_decimals: market.underlying_decimals,
    // 静的 config の預入停止だけを見る (on-chain の deposit cap は execute の builder が見る)
    ...(blocked ? { warnings: ["deposit_unavailable"], metadata: { deposit_blocked_reason: blocked } } : {}),
  };
}

async function estimateKaminoVault(
  route: Extract<SolanaRoute, { kind: "kamino_vault_deposit" | "kamino_vault_withdraw" }>,
  amount: string,
  log: Log
): Promise<PlanEstimate> {
  const vault = findKaminoVaultByAddress(route.vault);
  if (!vault) return none("unsupported_market");
  let tokensPerShare: string | undefined;
  try {
    tokensPerShare = (await fetchKaminoVaultMetrics(vault.vault))?.tokensPerShare;
  } catch (err) {
    log.warn({ err: errMessage(err), vault: vault.vault }, "simulate: kVault metrics fetch failed");
    return none("rate_unavailable");
  }
  const deposit = route.kind === "kamino_vault_deposit";
  const out =
    typeof tokensPerShare === "string"
      ? deposit
        ? kvaultUnderlyingToShares(amount, tokensPerShare, vault.shares_decimals, vault.underlying_decimals)
        : kvaultSharesToUnderlying(amount, tokensPerShare, vault.shares_decimals, vault.underlying_decimals)
      : null;
  if (out === null) {
    log.warn({ vault: vault.vault }, "simulate: kVault tokensPerShare missing or not positive");
    return none("rate_unavailable");
  }
  return {
    estimate_kind: "exchange_rate",
    estimated_out: out,
    // kVault の share は farm に auto-stake され wallet に SPL が来ない → mint は出さない
    ...(deposit
      ? {
          estimated_out_symbol: `${vault.display_name} shares`,
          estimated_out_decimals: vault.shares_decimals,
        }
      : {
          estimated_out_mint: vault.underlying_mint,
          estimated_out_symbol: vault.underlying_symbol,
          estimated_out_decimals: vault.underlying_decimals,
        }),
    metadata: { tokens_per_share: tokensPerShare },
  };
}

async function estimateSave(
  route: Extract<SolanaRoute, { kind: "save_deposit" | "save_withdraw" }>,
  amount: string,
  log: Log
): Promise<PlanEstimate> {
  const market =
    route.kind === "save_deposit"
      ? findSaveMarketByReserve(route.reserve)
      : findSaveMarketByCToken(route.ctokenMint);
  if (!market) return none("unsupported_market");
  let rate: string | undefined;
  try {
    const rates = await fetchSaveReserveRates([market.reserve]);
    rate = rates?.find((r) => r.reserve === market.reserve)?.ctoken_exchange_rate;
  } catch (err) {
    log.warn({ err: errMessage(err), reserve: market.reserve }, "simulate: Save reserve rate fetch failed");
    return none("rate_unavailable");
  }
  const deposit = route.kind === "save_deposit";
  const out =
    typeof rate === "string"
      ? deposit
        ? saveUnderlyingToCToken(amount, rate)
        : saveCTokenToUnderlying(amount, rate)
      : null;
  if (out === null) {
    log.warn({ reserve: market.reserve }, "simulate: Save cToken exchange rate missing or not positive");
    return none("rate_unavailable");
  }
  // cToken decimals = underlying decimals (save-markets.ts)
  return {
    estimate_kind: "exchange_rate",
    estimated_out: out,
    estimated_out_mint: deposit ? market.ctoken_mint : market.underlying_mint,
    estimated_out_symbol: deposit ? market.ctoken_symbol : market.underlying_symbol,
    estimated_out_decimals: market.underlying_decimals,
    metadata: { ctoken_exchange_rate: rate },
  };
}

/**
 * route + 入力量 (smallest unit、呼び手が §4.5 検証済み・0 でない) → 見積り。throw しない
 */
export async function estimatePlanAction(
  route: SolanaRoute,
  amount: string,
  log: Log
): Promise<PlanEstimate> {
  if (!isValidTokenAmount(amount) || amount === "0") return none("amount_required");
  try {
    switch (route.kind) {
      case "swap_earn_deposit":
      case "swap_earn_withdraw":
        return await estimateSwapEarn(route, amount, log);
      case "kamino_deposit":
      case "kamino_withdraw":
        return estimateKaminoReserve(route, amount);
      case "kamino_vault_deposit":
      case "kamino_vault_withdraw":
        return await estimateKaminoVault(route, amount, log);
      case "save_deposit":
      case "save_withdraw":
        return await estimateSave(route, amount, log);
      case "meteora_deposit":
      case "meteora_withdraw":
      case "orca_deposit":
      case "orca_withdraw":
        // LP position は 2 token + range で、単一の受け取り量が無い
        return { estimate_kind: "lp_position" };
      case "exponent_redeem":
        // 換算 (syExchangeRate) は JS Number の値で式も未検証 → §4.5 に従い数値を出さない
        return { estimate_kind: "pt_redeem" };
    }
  } catch (err) {
    // 想定外の例外も simulate を落とさない (どの kind の失敗かで reason を寄せる)
    log.warn({ err: errMessage(err), route: route.kind }, "simulate: estimate failed");
    return none(route.kind.startsWith("swap_earn") ? "quote_unavailable" : "rate_unavailable");
  }
}
