/**
 * MenuProduct — Explore (menu) に並べる chain 非依存の商品 (docs/web/WORKLOG.md)。
 * 既存 Solana の ProtocolMenuEntry / ProtocolPool は変更せず、Ethereum 商品はこの型で返す。
 * 利率は必ず label と出所 (source) を持つ (UI v2 §10: 金利を無ラベルの価格に見せない)。
 */
import type { ChainId } from "../config/chains";
import type { PositionCategory } from "./enums";
import type { TimelineMetric, TokenAmountView } from "./timeline";

export interface MenuProductRate {
  /** "APY" | "APR" | "Implied APY (fixed)" | "30-day avg yield" など */
  label: string;
  /** 0..1 の比率 */
  value: number;
  /** 率の意味を 1 行で補う (短い label の補足)。例: "Fixed if held to maturity" */
  basis?: string;
  source: string;
}

export interface MenuProduct {
  id: string;
  chain: ChainId;
  protocolId: string;
  protocolName: string;
  name: string;
  category: PositionCategory;
  rate: MenuProductRate | null;
  facts: TimelineMetric[];
  /** Pendle の PT (元本) / YT (利回り) の区別。Pendle 以外は undefined */
  tokenKind?: "pt" | "yt";
  /** 満期のある商品 (Pendle PT / YT) の満期 ISO */
  maturity?: string;
  url?: string;
  observedAt: string;
}

/**
 * address が menu 商品に預けている量 (GET /eth/holdings)。mainnet の on-chain 残高が正。
 * USD は取れた時だけ (8 decimals string)、推測しない。
 */
export interface MenuHolding {
  productId: string;
  /** 商品内のトークン別残高 (例: Lido は stETH と wstETH)。0 のトークンは含めない */
  amounts: TokenAmountView[];
  usd?: string;
  /** 引き出し待ち (例: Ethena の cooldown 中 USDe)。endsAt は ISO、表示の TZ は client */
  pending?: { label: string; amount: TokenAmountView; endsAt: string };
}

export interface MenuHoldingsResponse {
  address: string;
  holdings: MenuHolding[];
  /** 保有しているが Menu の一覧 (流動性上位) に無い商品。トグル ON 時に表示する */
  extraProducts: MenuProduct[];
  /** 取得に失敗した source (例: "pendle")。失敗分は「保有なし」とみなさない */
  failed: string[];
  observedAt: string;
}
