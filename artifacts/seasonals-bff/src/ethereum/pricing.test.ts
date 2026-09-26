import { evaluatePeg, type ChainlinkPrice } from "./pricing";

const p = (answer: string, over: Partial<ChainlinkPrice> = {}): ChainlinkPrice => ({
  asset: "USDe",
  answer,
  decimals: 8,
  updatedAt: "2026-09-26T00:00:00.000Z",
  stale: false,
  source: "chainlink",
  ...over,
});

describe("evaluatePeg (fail-closed)", () => {
  it("within band → ok", () => {
    const r = evaluatePeg(p("99981676"), p("99987434", { asset: "USDC" }), 50);
    expect(r.ok).toBe(true);
    expect(r.deviationBps).toBe(1);
  });
  it("beyond band → refuse", () => {
    const r = evaluatePeg(p("98000000"), p("100000000"), 50);
    expect(r).toMatchObject({ ok: false, deviationBps: 200 });
  });
  it("missing / stale / non-positive → refuse", () => {
    expect(evaluatePeg(null, p("100000000"), 50).ok).toBe(false);
    expect(evaluatePeg(p("100000000", { stale: true }), p("100000000"), 50).reason).toMatch(/stale/);
    expect(evaluatePeg(p("0"), p("100000000"), 50).ok).toBe(false);
  });
  it("handles different decimals without floating point", () => {
    const r = evaluatePeg(p("1000000000000000000", { decimals: 18 }), p("100000000"), 1);
    expect(r).toMatchObject({ ok: true, deviationBps: 0 });
  });
});
