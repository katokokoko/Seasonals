/**
 * asset-symbol — token symbol の表記揺れを吸収する唯一の正規化 (2026-10-13、#49 review で 4 箇所の重複を 1 本化)。
 *
 *   - 大文字小文字 (JitoSOL / jitoSOL、jupUSD / JupUSD — Helius DAS と Jupiter Lend API で揺れる)
 *   - wrapped SOL (WSOL = SOL)
 *
 * 残高や market の照合は原則 **mint** で行い、symbol 比較はこの helper 経由だけにする
 * (lib/config/swap-earn-markets.ts、lib/derive/solana-action.ts、BFF の menu overlay、client の UI)。
 */
export function normalizeAssetSymbol(symbol: string): string {
  const upper = symbol.trim().toUpperCase();
  return upper === "WSOL" ? "SOL" : upper;
}

export function sameAssetSymbol(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  return normalizeAssetSymbol(a) === normalizeAssetSymbol(b);
}
