/**
 * Seasonals — Numeric utilities
 *
 * 仕様書 §4.5 数値表現規約の canonical 実装。
 *
 * 設計原則:
 * - API boundary では string のまま受け取り、regex 検証のみ行う (parse はしない)
 * - Core Service 内では bigint (token amount) または decimal.js (USD 等) で演算
 * - DB 書き込み境界では ORM が NUMERIC(38, 0) / NUMERIC(38, 8) にマッピング
 * - response 直前に string に戻す (`bigint.toString()`)
 *
 * §32.2 整合性チェック:
 * - "accurate amounts" → smallest unit を NUMERIC(38, 0) で格納
 * - "string と数値が壊れない" → API boundary 検証 → bigint/decimal → NUMERIC
 *
 * 禁止事項 (金融値のみ、§4.5 末尾参照):
 * - parseInt / Number() で金融値を扱う
 * - string のまま算術演算
 * - 文字列結合で SQL 組み立て
 */

// ─────────────────────────────────────────────────────────────────────────────
// API boundary 検証用 regex (§4.5)
// ─────────────────────────────────────────────────────────────────────────────

/** token amount (smallest unit) — 整数のみ、負数 / 小数を拒否 */
export const TOKEN_AMOUNT_REGEX = /^[0-9]+$/;

/** USD 換算 (8 decimals) — 整数または小数 (1〜8 桁) */
export const USD_AMOUNT_REGEX = /^[0-9]+(\.[0-9]{1,8})?$/;

/**
 * token amount string が valid な smallest unit 表現か検証。
 * API boundary で使う (Core Service には parse 結果ではなく string を渡す)。
 */
export function isValidTokenAmount(value: unknown): value is string {
  return typeof value === "string" && TOKEN_AMOUNT_REGEX.test(value);
}

/**
 * USD 8 decimals string か検証。
 */
export function isValidUsdAmount(value: unknown): value is string {
  return typeof value === "string" && USD_AMOUNT_REGEX.test(value);
}

/**
 * API boundary で投げる validation error。REST は 400 / MCP は invalid_argument にマップ。
 */
export class InvalidAmountError extends Error {
  readonly kind: "token_amount" | "usd_amount";
  readonly received: unknown;
  constructor(kind: "token_amount" | "usd_amount", received: unknown) {
    super(`invalid_amount: expected ${kind}, got ${JSON.stringify(received)}`);
    this.name = "InvalidAmountError";
    this.kind = kind;
    this.received = received;
  }
}

/**
 * API boundary で string を assert。失敗時は InvalidAmountError を throw。
 * 戻り値は input と同一の string (parse はしない)。
 */
export function assertTokenAmount(value: unknown): string {
  if (!isValidTokenAmount(value)) {
    throw new InvalidAmountError("token_amount", value);
  }
  return value;
}

export function assertUsdAmount(value: unknown): string {
  if (!isValidUsdAmount(value)) {
    throw new InvalidAmountError("usd_amount", value);
  }
  return value;
}

// ─────────────────────────────────────────────────────────────────────────────
// Core Service 用: string ↔ bigint
// ─────────────────────────────────────────────────────────────────────────────

/**
 * smallest unit string を bigint に変換。Core Service 内の演算用。
 * 事前に assertTokenAmount で検証済みであることを前提とする。
 *
 * @example
 *   const a = toBigInt("1500000"); // 1.5 USDC (decimals=6)
 *   const b = toBigInt("500000000"); // 0.5 SOL (lamports)
 *   const sum = a + b; // 警告: 単位が違うと意味のない結果になる
 */
export function toBigInt(amount: string): bigint {
  if (!isValidTokenAmount(amount)) {
    throw new InvalidAmountError("token_amount", amount);
  }
  return BigInt(amount);
}

/**
 * bigint を smallest unit string に戻す (API response 直前に使用)。
 */
export function fromBigInt(amount: bigint): string {
  return amount.toString();
}

// ─────────────────────────────────────────────────────────────────────────────
// 表示用: smallest unit ↔ human-readable
// ─────────────────────────────────────────────────────────────────────────────

/**
 * smallest unit string を human-readable な小数表現に変換 (UI 直前で使う)。
 *
 * NOTE: これは **表示用** のみ。API には常に smallest unit string を送る。
 * UI でフォーマット (1,500.00 USDC 等) する際の前段として使う。
 *
 * @param amount smallest unit string ("1500000")
 * @param decimals token の decimals (USDC=6, SOL=9 等)
 * @returns "1.5" のような文字列
 *
 * @example
 *   toHumanReadable("1500000", 6); // "1.5"
 *   toHumanReadable("500000000", 9); // "0.5"
 *   toHumanReadable("0", 6); // "0"
 *   toHumanReadable("1", 6); // "0.000001"
 */
export function toHumanReadable(amount: string, decimals: number): string {
  if (!isValidTokenAmount(amount)) {
    throw new InvalidAmountError("token_amount", amount);
  }
  if (decimals < 0 || !Number.isInteger(decimals)) {
    throw new RangeError(`decimals must be a non-negative integer, got ${decimals}`);
  }
  if (decimals === 0) return amount;

  const padded = amount.padStart(decimals + 1, "0");
  const intPart = padded.slice(0, padded.length - decimals);
  const fracPart = padded.slice(padded.length - decimals).replace(/0+$/, "");
  return fracPart.length === 0 ? intPart : `${intPart}.${fracPart}`;
}

/**
 * human-readable な小数表現を smallest unit string に変換 (UI 入力 → API 送信前)。
 *
 * @example
 *   toSmallestUnit("1.5", 6); // "1500000"
 *   toSmallestUnit("0.5", 9); // "500000000"
 *   toSmallestUnit("1", 6); // "1000000"
 */
export function toSmallestUnit(humanAmount: string, decimals: number): string {
  if (decimals < 0 || !Number.isInteger(decimals)) {
    throw new RangeError(`decimals must be a non-negative integer, got ${decimals}`);
  }
  // 簡単な構文検証 (空 / 二重小数点 / 不正文字を排除)
  if (!/^[0-9]+(\.[0-9]+)?$/.test(humanAmount)) {
    throw new InvalidAmountError("token_amount", humanAmount);
  }

  const [intPart, fracPart = ""] = humanAmount.split(".");
  if (fracPart.length > decimals) {
    throw new RangeError(
      `fractional part has ${fracPart.length} digits, exceeds decimals=${decimals}`
    );
  }
  const fracPadded = fracPart.padEnd(decimals, "0");
  // 先頭ゼロを削除 (ただし "0" のままにする)
  const combined = (intPart + fracPadded).replace(/^0+(?!$)/, "") || "0";
  return combined;
}

// ─────────────────────────────────────────────────────────────────────────────
// 表示用フォーマッタ (UI 専用)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 通貨フォーマット ("$12,847.30" 等)。UI の最終表示で使う。
 *
 * NOTE: 内部演算には使わない。表示直前のみ。
 *
 * @param amount smallest unit string
 * @param decimals token decimals
 * @param options Intl.NumberFormat オプション
 */
export function formatTokenAmount(
  amount: string,
  decimals: number,
  options: { locale?: string; minFractionDigits?: number; maxFractionDigits?: number } = {}
): string {
  const human = toHumanReadable(amount, decimals);
  // human は decimal string なので Number() で表示用に変換 (precision loss 許容)
  // ただし amount が極端に大きい (>2^53) と Number() で正確に表示できないため、
  // その場合は plain string を返す
  const numericValue = Number(human);
  if (!Number.isFinite(numericValue)) return human;

  const { locale = "en-US", minFractionDigits = 0, maxFractionDigits = 6 } = options;
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: minFractionDigits,
    maximumFractionDigits: maxFractionDigits,
  }).format(numericValue);
}

/**
 * USD 8 decimals string を "$1,234.56" 形式にフォーマット。
 */
export function formatUsd(
  amount: string,
  options: { locale?: string; minFractionDigits?: number; maxFractionDigits?: number } = {}
): string {
  if (!isValidUsdAmount(amount)) {
    throw new InvalidAmountError("usd_amount", amount);
  }
  const numericValue = Number(amount);
  if (!Number.isFinite(numericValue)) return amount;

  const { locale = "en-US", minFractionDigits = 2, maxFractionDigits = 2 } = options;
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: minFractionDigits,
    maximumFractionDigits: maxFractionDigits,
  }).format(numericValue);
}

// ─────────────────────────────────────────────────────────────────────────────
// パーセンテージ系 (APY / risk_score、適用外として扱う、§4.5 末尾)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 0..1 の小数を "8.42%" 形式にフォーマット。
 *
 * NOTE: APY / risk_score は §4.5 「適用外」(精度落ちが致命的でない領域)。
 * Number 精度で問題ない範囲。
 */
export function formatPercentage(
  ratio: number,
  options: { locale?: string; minFractionDigits?: number; maxFractionDigits?: number; signDisplay?: "auto" | "always" } = {}
): string {
  const { locale = "en-US", minFractionDigits = 2, maxFractionDigits = 2, signDisplay = "auto" } = options;
  return new Intl.NumberFormat(locale, {
    style: "percent",
    minimumFractionDigits: minFractionDigits,
    maximumFractionDigits: maxFractionDigits,
    signDisplay,
  }).format(ratio);
}

// ─────────────────────────────────────────────────────────────────────────────
// 共通定数
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 主要 token の decimals。
 * adapter が動的に解決すべきだが、頻出するものは定数で定義しておく。
 *
 * NOTE: ここに登録されない token を `current_amount` の正規化に使うと、fallback
 * (=6) で不正な値が出る (例: SEAS は 9 decimals だが fallback で 6 にすると
 * 1000 倍ずれて total が 10^3 倍に膨らむ)。新 token を fixture / 実 portfolio に
 * 追加するときは必ず本 table を更新する。
 */
export const TOKEN_DECIMALS = {
  USDC: 6,
  USDT: 6,
  SOL: 9,
  mSOL: 9,
  jitoSOL: 9,
  bSOL: 9,
  SEAS: 9,
  JLP: 6,
} as const;

/** USD 8 decimals string の "1.0" (1 USD) */
export const USD_ONE: string = "1.00000000";
/** USD 8 decimals string の zero */
export const USD_ZERO: string = "0.00000000";
