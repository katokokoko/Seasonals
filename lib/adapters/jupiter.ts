/**
 * Jupiter SwapAdapter — mock 実装 (CLAUDE.md §31 競合認識 + 価格 fallback)
 *
 * 現状 (Phase C): fixture price + ratio で in/out を計算する mock。
 * 将来 mainnet SDK (`@jup-ag/api`) に差し替える際の置換ポイント:
 *   - `quote` → `createJupiterApiClient().quoteGet({ inputMint, outputMint, amount, slippageBps })`
 *   - `buildTransaction` → `createJupiterApiClient().swapPost({ quoteResponse, userPublicKey })`
 *
 * @see https://github.com/jup-ag
 * @see https://station.jup.ag/docs/apis/swap-api
 */

import {
  PositionCategory,
  TrustLevel,
} from "../types/enums";

import type {
  AdapterContext,
  AdapterMeta,
  AdapterRouteHop,
  SwapAdapter,
  SwapQuoteInput,
  SwapQuoteResult,
} from "./types";

const META: AdapterMeta = {
  protocol_id: "jupiter",
  display_name: "Jupiter Aggregator",
  // Jupiter は厳密には swap aggregator なので PositionCategory に直接 fit しないが、
  // 「他カテゴリで分類されない utility protocol」として Other 扱い。
  category: PositionCategory.Other,
  trust_level: TrustLevel.S,
  program_id_mainnet: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
  program_id_devnet: null,
};

// Mainnet token mints — mock でも token symbol → mint 解決に使う
const MINTS: Record<string, string> = {
  SOL: "So11111111111111111111111111111111111111112",
  USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  mSOL: "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So",
  jitoSOL: "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn",
  bSOL: "bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1",
};

/**
 * mock 価格表 (USD per 1 token、8 decimals string で扱うが quote 計算では Number)。
 * 実装: 後で Pyth / Switchboard / Jupiter price API に置換。
 */
const MOCK_PRICES: Record<string, number> = {
  SOL: 168.5,
  USDC: 1,
  USDT: 1,
  mSOL: 176.4,
  jitoSOL: 176.5,
  bSOL: 175.2,
  JLP: 4.62,
};

const TOKEN_DECIMALS: Record<string, number> = {
  SOL: 9,
  USDC: 6,
  USDT: 6,
  mSOL: 9,
  jitoSOL: 9,
  bSOL: 9,
  JLP: 6,
};

function findSymbolByMint(mint: string): string | undefined {
  return Object.keys(MINTS).find((sym) => MINTS[sym] === mint);
}

export const jupiterAdapter: SwapAdapter = {
  meta: META,

  async quote(input: SwapQuoteInput): Promise<SwapQuoteResult> {
    const inSym = findSymbolByMint(input.input_mint) ?? "USDC";
    const outSym = findSymbolByMint(input.output_mint) ?? "SOL";
    const inDecimals = TOKEN_DECIMALS[inSym] ?? 6;
    const outDecimals = TOKEN_DECIMALS[outSym] ?? 6;
    const inPrice = MOCK_PRICES[inSym] ?? 1;
    const outPrice = MOCK_PRICES[outSym] ?? 1;

    // input smallest unit → human → USD → output human → output smallest unit
    const inHuman = Number(input.amount) / Math.pow(10, inDecimals);
    const usd = inHuman * inPrice;
    // 0.05% Jupiter fee + 0.05% spread (mock)
    const usdAfterFee = usd * 0.999;
    const outHuman = usdAfterFee / outPrice;
    const outSmallest = Math.floor(outHuman * Math.pow(10, outDecimals));
    const minOutSmallest = Math.floor(
      outSmallest * (1 - input.slippage_bps / 10_000)
    );

    // mock route — Jupiter は通常 1-3 hop。複雑なケースは Orca + Raydium split。
    const route: AdapterRouteHop[] = [
      {
        input_mint: input.input_mint,
        output_mint: input.output_mint,
        amm_key: inSym === "USDC" || outSym === "USDC" ? "Orca" : "Raydium",
        percent: 100,
      },
    ];

    return {
      input_mint: input.input_mint,
      output_mint: input.output_mint,
      in_amount: input.amount,
      out_amount: String(outSmallest),
      min_out_amount: String(minOutSmallest),
      slippage_bps: input.slippage_bps,
      route,
      quoted_at: new Date().toISOString(),
    };
  },

  async buildTransaction(
    _ctx: AdapterContext,
    _quote: SwapQuoteResult
  ): Promise<{ tx_base64: string }> {
    // mock: BFF 側で memo tx を返す。将来 jup-ag/api の swapPost で実 tx を構築。
    return { tx_base64: "" };
  },
};

export const JUPITER_MINTS = MINTS;
export const JUPITER_TOKEN_DECIMALS = TOKEN_DECIMALS;
