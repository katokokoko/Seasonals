/**
 * Portfolio history / holdings — BFF ↔ client の wire 型 (chain 非依存)
 *
 * 評価額の履歴は「現在残高 − tx 差分 → 各時刻の残高 × その時刻の価格」で
 * BFF が復元する (Solana 8.58〜、Ethereum は web Dashboard 追加時)。設計と
 * 新チェーン追加の手順は docs/portfolio-history-design.md。
 *
 * 金額はすべて USD 8-dec string / smallest unit string (CLAUDE.md §3, spec §4.5)。
 */

import type { ChainId } from "../config/chains";
import type { PositionCategory } from "./enums";
import type { TokenAmountView } from "./timeline";

export interface PortfolioHistoryPoint {
  /** unix 秒 */
  at: number;
  /** その時点の評価額 (全資産、USD 8-dec) */
  usd: string;
  /** その時点の native 建て評価額 (Solana = SOL、Ethereum = ETH)。価格が無い点は "0" */
  native: string;
  /** protocol に預けた分のみ (Total / Deposited トグル) */
  deposited_usd: string;
  deposited_native: string;
  /**
   * 直前の点からの間の **残高変化** に由来する増減 (USD 8-dec、符号付き)。
   * 価格変動は含まない。client は入出金マーカーに使う (8.65)
   */
  flow_usd: string;
  deposited_flow_usd: string;
  /** Solana 応答のみ: mobile 互換の alias (= native / deposited_native) */
  sol?: string;
  deposited_sol?: string;
}

export interface PortfolioHistoryResponse {
  chain: ChainId;
  points: PortfolioHistoryPoint[];
  /** 残高を保証できる最古の時刻 (unix 秒)。これより前は返さない */
  oldest_at: number | null;
  /**
   * 系列の先頭が「最初に資産を持った時刻」で決まったか。true ならそれ以前の
   * 残高は **ゼロと確定** (複数アドレス合算で 0 として扱える)。false なら
   * tx window / range の制約で、それ以前は不明
   */
  starts_at_funding?: boolean;
  /** 過去価格 / 過去残高が近似の asset (現在価格で固定、rebase を追えない 等) */
  approximated_symbols: string[];
  /** 現在は保有しているが履歴に含められないもの (例: "Aave V4") */
  excluded_from_history?: string[];
}

export interface PortfolioHolding {
  chain: ChainId;
  address: string;
  symbol: string;
  /** protocol の識別子 (ProtocolBadge / ブランド色の key) */
  protocol_id: string;
  category: PositionCategory;
  amount?: TokenAmountView;
  /** 現在の評価額 (USD 8-dec) */
  usd: string;
  /** protocol への預入か (Deposited スコープの集計に使う) */
  deposited: boolean;
  /** 資産推移グラフに含まれているか (false = 現在値のみ、例: Aave V4) */
  in_history: boolean;
}

export interface PortfolioHoldingsResponse {
  chain: ChainId;
  address: string;
  holdings: PortfolioHolding[];
}
