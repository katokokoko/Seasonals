/**
 * deposit-funding — swap-earn market にどの token で deposit するかを保有から決める純関数 (2026-10-13)。
 *
 * Menu の行 (例: Jupiter Lend JupUSD) をタップした時、wallet に underlying (JupUSD) が無く
 * registry の funding token (USDC) があれば、USDC で支払う funding deposit を開く。
 * 判定は **mint** で行う (symbol は DAS の表記揺れ jupUSD / JupUSD で外れる)。
 */
import type { SwapEarnFundingToken, SwapEarnMarket } from "../config/swap-earn-markets";
import type { Position } from "../types/position";
import { isValidTokenAmount } from "../utils/numeric";

export interface WalletHolding {
  mint: string;
  /** smallest unit string (§4.5)。"0" や不正値は未保有扱い */
  amount: string;
}

export type DepositFundingChoice =
  /** underlying を保有 (両方持っていても underlying を優先 — swap 1 段少なく、fair value 判定も不要) */
  | { kind: "underlying" }
  /** underlying は無いが allowlist の funding token を保有 */
  | { kind: "funding"; token: SwapEarnFundingToken }
  /** どちらも無い (CTA は disabled、hint を出す) */
  | { kind: "none"; accepts: string[] };

/** 残高が正の保有か (§4.5: 整数 string のみ、"0" / "00" は未保有) */
export function holdsMint(holdings: WalletHolding[], mint: string): boolean {
  return holdings.some((h) => h.mint === mint && isValidTokenAmount(h.amount) && !/^0+$/.test(h.amount));
}

/** /positions の wallet 行か (`wallet_holding` / `wallet_sol` 等、protocol_id が wallet_ で始まる) */
export function isWalletPosition(p: Pick<Position, "protocol_id">): boolean {
  return p.protocol_id.startsWith("wallet_");
}

/** wallet 行の mint (BFF は raw_state.mint に入れる。native SOL は WSOL mint の合成行) */
export function walletPositionMint(p: Pick<Position, "raw_state">): string | undefined {
  const mint = (p.raw_state as { mint?: unknown } | undefined)?.mint;
  return typeof mint === "string" && mint.length > 0 ? mint : undefined;
}

/**
 * /positions → 保有一覧 (mint, smallest amount)。mobile / web が同じ変換を使う (#49 review で重複を 1 本化)。
 * mint の無い行 (fixture 等) は落とす
 */
export function walletHoldingsFromPositions(positions: readonly Position[]): WalletHolding[] {
  const out: WalletHolding[] = [];
  for (const p of positions) {
    if (!isWalletPosition(p)) continue;
    const mint = walletPositionMint(p);
    if (!mint) continue;
    out.push({ mint, amount: p.current_amount });
  }
  return out;
}

export function chooseDepositFunding(
  market: SwapEarnMarket,
  holdings: WalletHolding[]
): DepositFundingChoice {
  if (holdsMint(holdings, market.underlying_mint)) return { kind: "underlying" };
  const funding = (market.funding ?? []).find((f) => holdsMint(holdings, f.mint));
  if (funding) return { kind: "funding", token: funding };
  return { kind: "none", accepts: depositAcceptedSymbols(market) };
}

/** 保有に関係なく market が受け付ける token の symbol 一覧 (hint 表示用) */
export function depositAcceptedSymbols(market: SwapEarnMarket): string[] {
  return [market.underlying_symbol, ...(market.funding ?? []).map((f) => f.symbol)];
}
