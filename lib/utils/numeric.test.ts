/**
 * numeric utilities — テスト
 *
 * §4.5 数値表現規約の canonical 実装の単体テスト。
 * §32.2 整合性チェック「accurate amounts」「string と数値が壊れない」の担保。
 *
 * 環境: jest (Node、Mobile artifact 側でも同じ test を流すなら jest-expo)
 */

import {
  // regex / type guards
  TOKEN_AMOUNT_REGEX,
  USD_AMOUNT_REGEX,
  isValidTokenAmount,
  isValidUsdAmount,
  // assertions
  assertTokenAmount,
  assertUsdAmount,
  InvalidAmountError,
  // bigint
  toBigInt,
  fromBigInt,
  usd8ToBigInt,
  compareUsd8,
  // human ↔ smallest
  toHumanReadable,
  toSmallestUnit,
  // formatters
  formatTokenAmount,
  formatUsd,
  formatPercentage,
  // constants
  TOKEN_DECIMALS,
  USD_ONE,
  USD_ZERO,
} from "./numeric";

// ─────────────────────────────────────────────────────────────────────────────
// regex / type guards
// ─────────────────────────────────────────────────────────────────────────────

describe("TOKEN_AMOUNT_REGEX", () => {
  it.each([
    ["0", true],
    ["1", true],
    ["1500000", true],
    ["340282366920938463463374607431768211455", true], // 2^128 - 1
    ["-1", false],
    ["1.5", false],
    ["1e6", false],
    ["", false],
    [" 100", false],
    ["100 ", false],
    ["0x10", false],
  ])("'%s' → %s", (input, expected) => {
    expect(TOKEN_AMOUNT_REGEX.test(input)).toBe(expected);
  });
});

describe("USD_AMOUNT_REGEX", () => {
  it.each([
    ["0", true],
    ["1234", true],
    ["1234.5", true],
    ["1234.56789012", true],
    ["0.00000001", true],
    ["1234.567890123", false], // 9 decimals over limit
    ["-1", false],
    ["1.", false],
    [".5", false],
    ["1,000", false],
  ])("'%s' → %s", (input, expected) => {
    expect(USD_AMOUNT_REGEX.test(input)).toBe(expected);
  });
});

describe("isValidTokenAmount", () => {
  it("string で valid なら true", () => {
    expect(isValidTokenAmount("1500000")).toBe(true);
    expect(isValidTokenAmount("0")).toBe(true);
  });
  it("非 string / invalid string なら false", () => {
    expect(isValidTokenAmount(1500000)).toBe(false);
    expect(isValidTokenAmount(null)).toBe(false);
    expect(isValidTokenAmount(undefined)).toBe(false);
    expect(isValidTokenAmount("1.5")).toBe(false);
    expect(isValidTokenAmount("-1")).toBe(false);
  });

  // Phase 8.13: accrued_yield_amount は「magnitude string + sign enum」方式。
  // 負数 string を許さない (これが magnitude 方式を採った理由) ことを固定する。
  it("accrued yield: magnitude は valid / 負数 string は invalid", () => {
    expect(isValidTokenAmount("500000")).toBe(true); // 損失額も magnitude なら valid
    expect(isValidTokenAmount("0")).toBe(true); // unknown / break-even
    expect(isValidTokenAmount("-500000")).toBe(false); // 負数 string は禁止
  });
});

describe("isValidUsdAmount", () => {
  it("USD 8 decimals string なら true", () => {
    expect(isValidUsdAmount("1234.56789012")).toBe(true);
    expect(isValidUsdAmount("0")).toBe(true);
    expect(isValidUsdAmount("1234")).toBe(true);
  });
  it("9 decimals 以上 / 非 string なら false", () => {
    expect(isValidUsdAmount("1234.567890123")).toBe(false);
    expect(isValidUsdAmount(1234.5)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// assertions
// ─────────────────────────────────────────────────────────────────────────────

describe("assertTokenAmount", () => {
  it("valid なら同じ string をそのまま返す (parse しない)", () => {
    const input = "1500000";
    expect(assertTokenAmount(input)).toBe(input);
    // type guard により返り値は string として narrow される
  });

  it("invalid なら InvalidAmountError を throw、kind と received を保持", () => {
    try {
      assertTokenAmount("1.5");
      fail("should throw");
    } catch (e) {
      expect(e).toBeInstanceOf(InvalidAmountError);
      const err = e as InvalidAmountError;
      expect(err.kind).toBe("token_amount");
      expect(err.received).toBe("1.5");
      expect(err.message).toMatch(/invalid_amount/);
    }
  });

  it("Number / null / undefined を渡しても throw", () => {
    expect(() => assertTokenAmount(1500000 as unknown)).toThrow(
      InvalidAmountError
    );
    expect(() => assertTokenAmount(null as unknown)).toThrow(InvalidAmountError);
    expect(() => assertTokenAmount(undefined as unknown)).toThrow(
      InvalidAmountError
    );
  });
});

describe("assertUsdAmount", () => {
  it("valid なら同じ string をそのまま返す", () => {
    expect(assertUsdAmount("1234.56789012")).toBe("1234.56789012");
  });

  it("9 decimals は throw", () => {
    expect(() => assertUsdAmount("1.234567891")).toThrow(InvalidAmountError);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// bigint conversion
// ─────────────────────────────────────────────────────────────────────────────

describe("toBigInt / fromBigInt", () => {
  it("smallest unit string ↔ bigint で値が一致 (round-trip)", () => {
    const cases = ["0", "1", "1500000", "340282366920938463463374607431768211455"];
    for (const c of cases) {
      const b = toBigInt(c);
      expect(typeof b).toBe("bigint");
      expect(fromBigInt(b)).toBe(c);
    }
  });

  it("Number 精度を超える amount でも bigint で正確", () => {
    // 2^53 + 1 = 9007199254740993 (Number では 9007199254740992 に丸められる)
    const beyondNumber = "9007199254740993";
    const b = toBigInt(beyondNumber);
    expect(b).toBe(9007199254740993n);
    expect(fromBigInt(b)).toBe(beyondNumber);
  });

  it("invalid input は throw", () => {
    expect(() => toBigInt("1.5")).toThrow(InvalidAmountError);
    expect(() => toBigInt("-1")).toThrow(InvalidAmountError);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// human ↔ smallest unit
// ─────────────────────────────────────────────────────────────────────────────

describe("toHumanReadable", () => {
  it.each([
    // [smallest, decimals, expected]
    ["1500000", 6, "1.5"],
    ["500000000", 9, "0.5"],
    ["0", 6, "0"],
    ["1", 6, "0.000001"],
    ["1000000", 6, "1"],
    ["12345678", 6, "12.345678"],
    ["100", 0, "100"],
    ["1", 9, "0.000000001"],
    ["1000000000000", 6, "1000000"],
  ])("toHumanReadable('%s', %i) === '%s'", (amount, decimals, expected) => {
    expect(toHumanReadable(amount, decimals)).toBe(expected);
  });

  it("trailing zero を削る", () => {
    expect(toHumanReadable("1200000", 6)).toBe("1.2");
    expect(toHumanReadable("1230000", 6)).toBe("1.23");
  });

  it("invalid amount は throw", () => {
    expect(() => toHumanReadable("1.5", 6)).toThrow(InvalidAmountError);
  });

  it("decimals が負 / 非整数なら throw", () => {
    expect(() => toHumanReadable("1500000", -1)).toThrow(RangeError);
    expect(() => toHumanReadable("1500000", 1.5)).toThrow(RangeError);
  });
});

describe("toSmallestUnit", () => {
  it.each([
    // [human, decimals, expected]
    ["1.5", 6, "1500000"],
    ["0.5", 9, "500000000"],
    ["1", 6, "1000000"],
    ["0", 6, "0"],
    ["0.000001", 6, "1"],
    ["12.345", 6, "12345000"],
    ["100", 0, "100"],
  ])("toSmallestUnit('%s', %i) === '%s'", (human, decimals, expected) => {
    expect(toSmallestUnit(human, decimals)).toBe(expected);
  });

  it("decimals を超える小数桁数なら throw", () => {
    expect(() => toSmallestUnit("1.234567", 6)).not.toThrow();
    expect(() => toSmallestUnit("1.2345678", 6)).toThrow(RangeError);
  });

  it("不正な構文は throw", () => {
    expect(() => toSmallestUnit("-1", 6)).toThrow(InvalidAmountError);
    expect(() => toSmallestUnit("1e6", 6)).toThrow(InvalidAmountError);
    expect(() => toSmallestUnit("1.", 6)).toThrow(InvalidAmountError);
  });
});

describe("toHumanReadable / toSmallestUnit round-trip", () => {
  it.each([
    ["1.5", 6],
    ["0.5", 9],
    ["12345.678", 6],
    ["0.000001", 6],
    ["1000000", 6],
  ])("'%s' (decimals=%i) round-trip", (human, decimals) => {
    const smallest = toSmallestUnit(human, decimals);
    const back = toHumanReadable(smallest, decimals);
    expect(back).toBe(human);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// formatters
// ─────────────────────────────────────────────────────────────────────────────

describe("formatTokenAmount", () => {
  it("基本フォーマット (locale=en-US)", () => {
    expect(formatTokenAmount("1500000", 6)).toBe("1.5");
    expect(formatTokenAmount("1234567890", 6)).toBe("1,234.56789");
  });

  it("min/maxFractionDigits を尊重", () => {
    expect(
      formatTokenAmount("1234567890", 6, { minFractionDigits: 2, maxFractionDigits: 2 })
    ).toBe("1,234.57");
    expect(
      formatTokenAmount("1000000", 6, { minFractionDigits: 2 })
    ).toBe("1.00");
  });
});

describe("formatTokenAmount — 8.38 (F8) >2^53 guard", () => {
  it("整数部 16 桁以上は Number を通さず plain string (末尾桁が化けない)", () => {
    // 2^53+1 相当 (9007199254740993) — Number() だと …992 に化ける値
    const out = formatTokenAmount("9007199254740993000000", 6);
    expect(out).toBe("9007199254740993"); // plain human string、桁化けなし
  });

  it("15 桁以下は従来通り桁区切り", () => {
    expect(formatTokenAmount("1500000000", 6)).toBe("1,500");
  });
});

describe("formatUsd", () => {
  it("$1,234.57 形式", () => {
    expect(formatUsd("1234.56789012")).toBe("$1,234.57");
    expect(formatUsd("0")).toBe("$0.00");
  });

  it("invalid input は throw", () => {
    expect(() => formatUsd("1.234567891")).toThrow(InvalidAmountError);
  });
});

describe("formatPercentage", () => {
  it("0..1 を %", () => {
    expect(formatPercentage(0.0842)).toBe("8.42%");
    expect(formatPercentage(0.5)).toBe("50.00%");
  });

  it("signDisplay always", () => {
    expect(formatPercentage(0.0842, { signDisplay: "always" })).toBe("+8.42%");
    expect(formatPercentage(-0.012, { signDisplay: "always" })).toBe("-1.20%");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// constants
// ─────────────────────────────────────────────────────────────────────────────

describe("TOKEN_DECIMALS", () => {
  it("主要 token の decimals が正しい", () => {
    expect(TOKEN_DECIMALS.USDC).toBe(6);
    expect(TOKEN_DECIMALS.USDT).toBe(6);
    expect(TOKEN_DECIMALS.SOL).toBe(9);
    expect(TOKEN_DECIMALS.mSOL).toBe(9);
    expect(TOKEN_DECIMALS.jitoSOL).toBe(9);
    expect(TOKEN_DECIMALS.bSOL).toBe(9);
  });
});

describe("USD constants", () => {
  it("USD_ONE / USD_ZERO は 8 decimals string", () => {
    expect(USD_ONE).toBe("1.00000000");
    expect(USD_ZERO).toBe("0.00000000");
    expect(isValidUsdAmount(USD_ONE)).toBe(true);
    expect(isValidUsdAmount(USD_ZERO)).toBe(true);
  });
});

describe("usd8ToBigInt / compareUsd8 (§4.5、Phase 8.29)", () => {
  it("scale-8 bigint に変換 (整数 / 小数 / 端数)", () => {
    expect(usd8ToBigInt("500.00000001")).toBe(50000000001n);
    expect(usd8ToBigInt("500")).toBe(50000000000n);
    expect(usd8ToBigInt("0.00000001")).toBe(1n);
    expect(usd8ToBigInt("10000000.00000000")).toBe(1000000000000000n);
  });
  it("2^53 超も精度落ちしない", () => {
    // 9,007,199,254,740,993 USD (> Number.MAX_SAFE_INTEGER)
    expect(usd8ToBigInt("9007199254740993.00000000")).toBe(
      900719925474099300000000n
    );
  });
  it("不正は throw", () => {
    expect(() => usd8ToBigInt("1.5.5")).toThrow(InvalidAmountError);
    expect(() => usd8ToBigInt("-1")).toThrow(InvalidAmountError);
  });
  it("compareUsd8: bigint 比較", () => {
    expect(compareUsd8("500.00000000", "500.00000001")).toBe(-1);
    expect(compareUsd8("500.00000001", "500.00000000")).toBe(1);
    expect(compareUsd8("500", "500.00000000")).toBe(0);
  });
});
