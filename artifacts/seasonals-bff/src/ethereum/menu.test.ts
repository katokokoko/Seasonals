import { pendleMenuProducts } from "./menu";
import type { PendleMarket } from "./pendle";

const OBS = "2026-09-26T00:00:00.000Z";

function market(i: number, details: PendleMarket["details"]): PendleMarket {
  const hex = i.toString(16).padStart(40, "0");
  return {
    name: `TOK${i}`,
    address: `0x${hex}`,
    expiry: "2026-12-10T00:00:00.000Z",
    pt: `1-0x${hex}`,
    yt: `1-0x${hex}`,
    sy: `1-0x${hex}`,
    underlyingAsset: `1-0x${hex}`,
    details,
  };
}

test("each market yields a PT then its YT, side by side", () => {
  const out = pendleMenuProducts([market(1, { liquidity: 10, impliedApy: 0.12, ytFloatingApy: 0.3, underlyingApy: 0.1 })], OBS);
  expect(out.map((p) => [p.tokenKind, p.name])).toEqual([
    ["pt", "PT-TOK1"],
    ["yt", "YT-TOK1"],
  ]);
  expect(out[0]!.rate).toEqual({ label: "Fixed APY", value: 0.12, basis: "Fixed if held to maturity", source: "Pendle API" });
  expect(out[1]!.rate?.label).toBe("Long yield APY");
  expect(out[1]!.url).toContain("view=yt");
  // PT と YT は同じ market の facts (流動性は 8 桁 USD string) を持つ
  expect(out[1]!.facts).toEqual(out[0]!.facts);
  expect(out[0]!.facts[0]).toEqual({ label: "Liquidity", kind: "usd", value: "10.00000000" });
});

test("negative YT yield is kept as is and a missing one becomes null (never 0)", () => {
  const [, ytNeg] = pendleMenuProducts([market(1, { liquidity: 5, impliedApy: 0.1, ytFloatingApy: -0.7516 })], OBS);
  expect(ytNeg!.rate?.value).toBe(-0.7516);
  const [, ytNone] = pendleMenuProducts([market(2, { liquidity: 5, impliedApy: 0.1 })], OBS);
  expect(ytNone!.rate).toBeNull();
});

test("keeps the 8 most liquid markets, so 16 products in PT/YT pairs", () => {
  const markets = Array.from({ length: 12 }, (_, i) => market(i + 1, { liquidity: (i + 1) * 1000, impliedApy: 0.1, ytFloatingApy: 0.2 }));
  const out = pendleMenuProducts(markets, OBS);
  expect(out).toHaveLength(16);
  expect(out[0]!.name).toBe("PT-TOK12");
  expect(out[1]!.name).toBe("YT-TOK12");
  expect(out.at(-1)!.name).toBe("YT-TOK5");
});
