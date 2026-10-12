/**
 * deposit-funding — swap-earn market にどの token で deposit するかを保有から決める純関数 (2026-10-13)。
 *
 * Menu の行 (例: Jupiter Lend JupUSD) をタップした時、wallet に underlying (JupUSD) が無く
 * registry の funding token (USDC) があれば、USDC で支払う funding deposit を開く。
 * 判定は **mint** で行う (symbol は DAS の表記揺れ jupUSD / JupUSD で外れる)。
 */
import type { SwapEarnFundingToken, SwapEarnMarket } from "../config/swap-earn-markets";

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

function held(holdings: WalletHolding[], mint: string): boolean {
  return holdings.some((h) => h.mint === mint && /^[0-9]+$/.test(h.amount) && h.amount !== "0" && !/^0+$/.test(h.amount));
}

export function chooseDepositFunding(
  market: SwapEarnMarket,
  holdings: WalletHolding[]
): DepositFundingChoice {
  if (held(holdings, market.underlying_mint)) return { kind: "underlying" };
  const funding = (market.funding ?? []).find((f) => held(holdings, f.mint));
  if (funding) return { kind: "funding", token: funding };
  return {
    kind: "none",
    accepts: [market.underlying_symbol, ...(market.funding ?? []).map((f) => f.symbol)],
  };
}

/** 保有に関係なく market が受け付ける token の symbol 一覧 (hint 表示用) */
export function depositAcceptedSymbols(market: SwapEarnMarket): string[] {
  return [market.underlying_symbol, ...(market.funding ?? []).map((f) => f.symbol)];
}
