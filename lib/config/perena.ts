/**
 * Perena 固有の定数 (Mobile / Web / BFF 共有)。
 *
 * 2026-10-05 の調査 (docs/web/WORKLOG.md「Perena」):
 * - 現行の USD* は Perena Star V2 program の新 mint (swap-earn-markets.ts の perena 行)
 * - 旧 USD* (`PERENA_LEGACY_USD_STAR_MINT`) は Tri-Stable Pool (USDC / USDT / PYUSD) の LP token。
 *   mint 権限は pool PDA (`PERENA_TRI_STABLE_POOL`、`@perena/numeraire-sdk` の PRODUCTION_POOLS.tripool)。
 *   市場では実質売れず (Jupiter Ultra: 100 → 16.3 USDC)、正規の引き出しは Numeraire の remove_liquidity。
 *   Seasonals では表示と Perena app への案内だけを行う (ユーザー決定)
 */

export const PERENA_APP_URL = "https://app.perena.org/earn";

export const PERENA_LEGACY_USD_STAR_MINT = "BenJy1n3WTx9mTjEvy63e8Q1j4RqUc6E4VBMz3ir4Wo6";
export const PERENA_LEGACY_USD_STAR_DECIMALS = 6;

export const PERENA_TRI_STABLE_POOL = "2w4A1eGyjRutakyFdmVyBiLPf98qKxNTC2LpuwhaCruZ";

export interface PerenaVault {
  symbol: string;
  mint: string;
  /** pool PDA が owner の token account */
  vault: string;
  decimals: number;
  token2022?: boolean;
}

/**
 * Tri-Stable Pool の vault (2026-10-05 に getTokenAccountsByOwner(pool) で確認)。
 * pool PDA は airdrop された spam token も大量に持つので、owner で一覧せず vault を固定して読む
 */
export const PERENA_TRI_STABLE_VAULTS: readonly PerenaVault[] = [
  { symbol: "USDC", mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", vault: "6B8k8At9879r5EsZAWg8W6DEpxzJ798Cwj48twu3pq4b", decimals: 6 },
  { symbol: "USDT", mint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", vault: "DJfYbGicp4AFXWsragNWv1baugqcdFhw6eFTcK2YWdyK", decimals: 6 },
  { symbol: "PYUSD", mint: "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo", vault: "4jV62TqjV4oUyNBioPo9dJZGyjTcgfBDkuG4VbgxfqWC", decimals: 6, token2022: true },
];
