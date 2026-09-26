import { decimalTo8 } from "./aave";

test("decimalTo8 normalizes API decimal strings without floating point", () => {
  expect(decimalTo8("5112220.983")).toBe("5112220.98300000");
  expect(decimalTo8("12")).toBe("12.00000000");
  expect(decimalTo8("0.123456789")).toBe("0.12345678");
  expect(decimalTo8("-1.0")).toBeNull();
  expect(decimalTo8(5)).toBeNull();
  // BigDecimal 風 object (toString で decimal を返す)
  expect(decimalTo8({ toString: () => "3.150237539981273268" })).toBe("3.15023753");
});
