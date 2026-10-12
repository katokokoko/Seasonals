/**
 * exchange-rate-math — 交換レート (decimal string) で share ⇄ underlying を換算する純関数 (2026-10-08)
 *
 * Kamino kVault の `tokensPerShare` と Save の `cTokenExchangeRate` は外部 API が返す decimal string。
 * positions 表示 (server.ts の mapKaminoVaultPositionsToEarnPositions / mapSaveHoldingsToEarnPositions) と
 * agent plan の simulate 見積り (agent-plan-estimate.ts) が同じ式を使うよう、ここに 1 か所にまとめる。
 *
 * §4.5: rate は `truncateDecimal` → `toSmallestUnit` で 12 桁の固定小数 bigint にしてから掛け割りする
 * (Number() を通さない)。結果は切り捨て。rate が 0 以下 / 不正なら null (呼び手が degrade を選ぶ)。
 */
import { isValidTokenAmount, toBigInt, toSmallestUnit } from "@workspace/lib/utils/numeric";

/** 外部 API の decimal string を指定桁で切り捨て (§4.5: parse せず文字列操作のみ)。 */
export function truncateDecimal(value: string, places: number): string {
  if (typeof value !== "string" || !/^[0-9]+(\.[0-9]+)?$/.test(value)) return "0";
  const [int, frac = ""] = value.split(".");
  const cut = frac.slice(0, places);
  return cut ? `${int}.${cut}` : (int as string);
}

/** rate 演算の bigint スケール (12 桁精度、kVault / Save 共通) */
export const EXCHANGE_RATE_SCALE = 12;
const SCALE = 10n ** BigInt(EXCHANGE_RATE_SCALE);

/** decimal string の rate → ×1e12 の bigint。0 以下 / 不正は null */
function rateToScaled(rate: string): bigint | null {
  try {
    const scaled = toBigInt(
      toSmallestUnit(truncateDecimal(rate, EXCHANGE_RATE_SCALE), EXCHANGE_RATE_SCALE)
    );
    return scaled > 0n ? scaled : null;
  } catch {
    return null;
  }
}

function pow10(decimals: number): bigint {
  return 10n ** BigInt(decimals);
}

function validDecimals(d: number): boolean {
  return Number.isInteger(d) && d >= 0 && d <= 18;
}

/**
 * kVault shares (smallest) → underlying (smallest)。
 *   underlying = shares × tokensPerShare × 10^u_dec / 10^s_dec
 */
export function kvaultSharesToUnderlying(
  sharesSmallest: string,
  tokensPerShare: string,
  sharesDecimals: number,
  underlyingDecimals: number
): string | null {
  if (!isValidTokenAmount(sharesSmallest)) return null;
  if (!validDecimals(sharesDecimals) || !validDecimals(underlyingDecimals)) return null;
  const rate = rateToScaled(tokensPerShare);
  if (rate === null) return null;
  const out =
    (BigInt(sharesSmallest) * rate * pow10(underlyingDecimals)) /
    (pow10(sharesDecimals) * SCALE);
  return out.toString();
}

/**
 * underlying (smallest) → kVault shares (smallest)。deposit で受け取る share の見積り。
 *   shares = underlying × 10^s_dec / (tokensPerShare × 10^u_dec)
 */
export function kvaultUnderlyingToShares(
  underlyingSmallest: string,
  tokensPerShare: string,
  sharesDecimals: number,
  underlyingDecimals: number
): string | null {
  if (!isValidTokenAmount(underlyingSmallest)) return null;
  if (!validDecimals(sharesDecimals) || !validDecimals(underlyingDecimals)) return null;
  const rate = rateToScaled(tokensPerShare);
  if (rate === null) return null;
  const out =
    (BigInt(underlyingSmallest) * pow10(sharesDecimals) * SCALE) /
    (rate * pow10(underlyingDecimals));
  return out.toString();
}

/**
 * Save cToken (smallest) → underlying (smallest)。cToken decimals = underlying decimals なので
 * スケール補正は rate だけ。underlying = cToken × ctoken_exchange_rate
 */
export function saveCTokenToUnderlying(
  ctokenSmallest: string,
  ctokenExchangeRate: string
): string | null {
  if (!isValidTokenAmount(ctokenSmallest)) return null;
  const rate = rateToScaled(ctokenExchangeRate);
  if (rate === null) return null;
  return ((BigInt(ctokenSmallest) * rate) / SCALE).toString();
}

/** underlying (smallest) → Save cToken (smallest)。cToken = underlying / ctoken_exchange_rate */
export function saveUnderlyingToCToken(
  underlyingSmallest: string,
  ctokenExchangeRate: string
): string | null {
  if (!isValidTokenAmount(underlyingSmallest)) return null;
  const rate = rateToScaled(ctokenExchangeRate);
  if (rate === null) return null;
  return ((BigInt(underlyingSmallest) * SCALE) / rate).toString();
}
