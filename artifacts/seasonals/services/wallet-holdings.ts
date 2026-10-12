/**
 * wallet-holdings — `/positions` の wallet 系 raw position を deposit 判定の入力に写す純関数 (2026-10-13)。
 *
 * MenuDrawer (どの token で deposit を開くか) と ActionModal (残高 / Pay with toggle) が
 * 同じ規則で保有を読むための共通部品。判定は **mint** が基準 — DAS の symbol は表記揺れ
 * (jupUSD / JupUSD) するので、symbol 一致は mint が無い行の fallback に留める。
 * 型は lib から import (CLAUDE.md §1)、金額は smallest unit string のまま (§4.5)。
 */
import type { Position } from "@workspace/lib/types";
import type { WalletHolding } from "@workspace/lib/derive/deposit-funding";
import type { RouteInputToken } from "@workspace/lib/derive/solana-action";

/** wrapped SOL mint。native SOL 残高は DAS の token 行と一致しないので mint 照合から外す */
const WSOL_MINT = "So11111111111111111111111111111111111111112";

function isWalletRow(p: Position): boolean {
  return p.protocol_id.startsWith("wallet_");
}

function mintOf(p: Position): string | null {
  const mint = p.raw_state?.mint;
  return typeof mint === "string" && mint.length > 0 ? mint : null;
}

/** wallet 系 row → `{ mint, amount }` (lib `chooseDepositFunding` の入力)。mint の無い行は落とす */
export function walletHoldingsOf(positions: readonly Position[]): WalletHolding[] {
  const out: WalletHolding[] = [];
  for (const p of positions) {
    if (!isWalletRow(p)) continue;
    const mint = mintOf(p);
    if (mint) out.push({ mint, amount: p.current_amount });
  }
  return out;
}

/** mint の保有が正 (smallest unit string が 0 でない) か */
export function holdsMint(holdings: readonly WalletHolding[], mint: string): boolean {
  return holdings.some(
    (h) => h.mint === mint && /^[0-9]+$/.test(h.amount) && !/^0+$/.test(h.amount)
  );
}

/**
 * deposit の支払い token に当たる wallet row。route の入力 mint で引き (symbol の表記揺れに
 * 強い)、無ければ従来どおり asset symbol で引く。SOL は native 残高の扱いを変えないため symbol のみ
 */
export function findWalletRow(
  positions: readonly Position[],
  input: RouteInputToken | null,
  asset: string
): Position | undefined {
  if (input && input.mint !== WSOL_MINT) {
    const byMint = positions.find((p) => isWalletRow(p) && mintOf(p) === input.mint);
    if (byMint) return byMint;
  }
  return positions.find((p) => isWalletRow(p) && p.asset_symbol === asset);
}
