/**
 * holding-view — Wallet holdings 行の表示モデル (Phase 8.55)
 *
 * 8.55 以前は全行がトグル通貨に換算した値だけを出していて、SOL の行に
 * 「50.15 USDC」が並ぶ不整合があった。行の主表示は **トークンそのものの量**
 * (ネイティブ単位) にし、換算 (USDC / SOL 両方) はタップ展開で見せる。
 *
 * §4.5: `current_amount` は smallest unit string。ネイティブ量は
 * `toHumanReadable` で文字列のまま桁を落とす (Number を経由しない)。
 * USD / SOL 換算は表示専用の Number 演算 (§3 carve-out、allocation.ts と同じ)。
 */
import type { Position } from "@workspace/lib/types";
import { TOKEN_DECIMALS, toHumanReadable } from "@workspace/lib/utils/numeric";

import {
  positionSolValue,
  positionUsdValue,
  solUsdPrice,
  type PriceMap,
} from "./allocation";

export interface HoldingView {
  /** 表示 symbol (WSOL は SOL に正規化) */
  symbol: string;
  /** ネイティブ量 (human 文字列、小数 4 桁まで) */
  nativeAmount: string;
  /** USD 換算 (display only) */
  usd: number;
  /** SOL 換算 (display only) */
  sol: number;
  /** 換算に使ったレートが引けたか (未知 asset は false → 換算行を出さない) */
  priced: boolean;
}

function decimalsOf(asset: string): number {
  if (asset in TOKEN_DECIMALS) {
    return (TOKEN_DECIMALS as Record<string, number>)[asset]!;
  }
  return 6;
}

/** human 文字列の小数部を最大 4 桁に切り詰める (§4.5: parse しない文字列操作) */
function trimDecimals(human: string, places: number): string {
  const [int = "0", frac = ""] = human.split(".");
  const cut = frac.slice(0, places).replace(/0+$/, "");
  return cut ? `${int}.${cut}` : int;
}

export function holdingView(
  position: Position,
  prices: PriceMap = {}
): HoldingView {
  const symbol = position.asset_symbol === "WSOL" ? "SOL" : position.asset_symbol;
  // WSOL は TOKEN_DECIMALS / 価格テーブルの両方に無いので、decimals (9) と
  // 価格を正しく引くため **正規化した symbol** で評価する
  const normalized =
    symbol === position.asset_symbol
      ? position
      : ({ ...position, asset_symbol: symbol } as Position);
  const decimals = decimalsOf(symbol);
  const nativeAmount = trimDecimals(
    toHumanReadable(position.current_amount, decimals),
    4
  );
  const usd = positionUsdValue(normalized, prices);
  return {
    symbol,
    nativeAmount,
    usd,
    sol: positionSolValue(normalized, prices),
    // 価格が引けない asset は usd 0 になる (allocation.ts)。
    // 0 保有と区別できないが、どちらも「換算を出さない」で正しい
    priced: usd > 0,
  };
}

/** 展開行の換算テキスト (`≈ 50.15 USDC · 0.2975 SOL`) */
export function conversionLine(view: HoldingView): string {
  const usd = view.usd.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  // SOL は行のネイティブ表示と同じ**切り捨て**に揃える (toFixed は四捨五入で、
  // 同じ量が行 0.2975 / 展開 0.2976 と食い違って見えた)
  const sol = trimDecimals(view.sol.toFixed(6), 4);
  return `≈ ${usd} USDC · ${sol} SOL`;
}

/**
 * 展開行のレート注記。8.57: live 価格 (oracle) を出す。
 * 価格が取れていなければ注記自体を出さない (レートを騙らない)。
 */
export function rateLine(prices: PriceMap): string | null {
  const sol = solUsdPrice(prices);
  if (sol === null) return null;
  return `1 SOL = ${sol.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} USDC`;
}
