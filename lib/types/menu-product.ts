/**
 * MenuProduct — Explore (menu) に並べる chain 非依存の商品 (docs/web/WORKLOG.md)。
 * 既存 Solana の ProtocolMenuEntry / ProtocolPool は変更せず、Ethereum 商品はこの型で返す。
 * 利率は必ず label と出所 (source) を持つ (UI v2 §10: 金利を無ラベルの価格に見せない)。
 */
import type { ChainId } from "../config/chains";
import type { PositionCategory } from "./enums";
import type { TimelineMetric } from "./timeline";

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
