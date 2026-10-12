/**
 * wallet-holdings — ActionModal が deposit の支払い token の wallet 行を引く mobile 専用 helper (2026-10-13)。
 *
 * 保有の読み取り規則 (`/positions` → `{ mint, amount }`、wallet 行判定、mint の取り出し、保有の正負) は
 * lib `deposit-funding` の `walletHoldingsFromPositions` / `holdsMint` / `isWalletPosition` /
 * `walletPositionMint` が唯一の実装 (web と共有、#49 review で重複を 1 本化)。ここはその上に
 * 「行そのもの (current_amount を表示に使う)」を引く `findWalletRow` だけを置く。
 * 判定は **mint** が基準 — DAS の symbol は表記揺れ (jupUSD / JupUSD) するので、symbol 一致は
 * mint で引けない時の fallback に留める (完全一致。WSOL 行を native SOL と混ぜないため正規化しない)。
 * 型は lib から import (CLAUDE.md §1)、金額は smallest unit string のまま (§4.5)。
 */
import type { Position } from "@workspace/lib/types";
import {
  isWalletPosition,
  walletPositionMint,
} from "@workspace/lib/derive/deposit-funding";
import type { RouteInputToken } from "@workspace/lib/derive/solana-action";

/** wrapped SOL mint。native SOL 残高は DAS の token 行と一致しないので mint 照合から外す */
const WSOL_MINT = "So11111111111111111111111111111111111111112";

/**
 * deposit の支払い token に当たる wallet row。route の入力 mint で引き (symbol の表記揺れに
 * 強い)、無ければ asset symbol で引く。SOL は native 残高の扱いを変えないため symbol のみ
 */
export function findWalletRow(
  positions: readonly Position[],
  input: RouteInputToken | null,
  asset: string
): Position | undefined {
  if (input && input.mint !== WSOL_MINT) {
    const byMint = positions.find(
      (p) => isWalletPosition(p) && walletPositionMint(p) === input.mint
    );
    if (byMint) return byMint;
  }
  return positions.find((p) => isWalletPosition(p) && p.asset_symbol === asset);
}
