import { normalizeAssetSymbol, sameAssetSymbol } from "./asset-symbol";

describe("asset-symbol", () => {
  it("大文字小文字と WSOL を正規化する", () => {
    expect(normalizeAssetSymbol(" jupUSD ")).toBe("JUPUSD");
    expect(normalizeAssetSymbol("WSOL")).toBe("SOL");
    expect(normalizeAssetSymbol("wsol")).toBe("SOL");
  });
  it("sameAssetSymbol は undefined を不一致、表記揺れを一致にする", () => {
    expect(sameAssetSymbol("JupUSD", "jupUSD")).toBe(true);
    expect(sameAssetSymbol("SOL", "WSOL")).toBe(true);
    expect(sameAssetSymbol("USDC", "USDT")).toBe(false);
    expect(sameAssetSymbol(undefined, "USDC")).toBe(false);
  });
});
