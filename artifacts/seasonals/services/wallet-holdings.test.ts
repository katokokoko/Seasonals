/**
 * wallet-holdings — `findWalletRow` (mobile 専用、lib deposit-funding の wallet 行判定の上に立つ)。
 * 保有変換そのもの (walletHoldingsFromPositions / holdsMint) は lib/derive/deposit-funding.test.ts が持つ。
 */
import type { Position } from "@workspace/lib/types";
import { findMarketByProtocolAsset } from "@workspace/lib/config/swap-earn-markets";

import type { RouteInputToken } from "@workspace/lib/derive/solana-action";

import { findWalletRow } from "./wallet-holdings";

const MARKET = findMarketByProtocolAsset("jupiter_lend", "JupUSD")!;
const JUPUSD_MINT = MARKET.underlying_mint;
const USDC_MINT = MARKET.funding![0]!.mint;
const WSOL_MINT = "So11111111111111111111111111111111111111112";

function row(
  protocol_id: string,
  symbol: string,
  mint: string | null,
  amount = "1"
): Position {
  return {
    position_id: `${protocol_id}_${symbol}`,
    protocol_id,
    asset_symbol: symbol,
    current_amount: amount,
    raw_state: mint ? { mint } : {},
  } as unknown as Position;
}

describe("findWalletRow", () => {
  it("route の入力 mint で引く (DAS の 'jupUSD' 表記でも JupUSD の行になる)", () => {
    const jup = row("wallet_stable", "jupUSD", JUPUSD_MINT, "2000000");
    const got = findWalletRow(
      [row("wallet_stable", "USDC", USDC_MINT), jup],
      {
        symbol: "JupUSD",
        mint: JUPUSD_MINT,
        decimals: 6,
      } satisfies RouteInputToken,
      "JupUSD"
    );
    expect(got).toBe(jup);
  });

  it("wallet 以外の行は mint が一致しても引かない", () => {
    const lend = row("jupiter_lend", "USDC", USDC_MINT);
    expect(
      findWalletRow(
        [lend],
        {
          symbol: "USDC",
          mint: USDC_MINT,
          decimals: 6,
        } satisfies RouteInputToken,
        "USDC"
      )
    ).toBeUndefined();
  });

  it("mint で引けなければ symbol 完全一致の fallback", () => {
    const usdc = row("wallet_stable", "USDC", null);
    expect(
      findWalletRow(
        [usdc],
        {
          symbol: "USDC",
          mint: USDC_MINT,
          decimals: 6,
        } satisfies RouteInputToken,
        "USDC"
      )
    ).toBe(usdc);
    expect(findWalletRow([usdc], null, "USDC")).toBe(usdc);
  });

  it("SOL (WSOL mint) は mint 照合せず symbol で引く (native 残高の行を使う)", () => {
    const wrapped = row("wallet_token", "WSOL", WSOL_MINT, "5");
    const native = row("wallet_sol", "SOL", null, "900");
    expect(
      findWalletRow(
        [wrapped, native],
        {
          symbol: "SOL",
          mint: WSOL_MINT,
          decimals: 9,
        } satisfies RouteInputToken,
        "SOL"
      )
    ).toBe(native);
  });
});
