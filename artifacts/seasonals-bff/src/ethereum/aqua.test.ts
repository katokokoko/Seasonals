import { deriveStrategyReviewEvent, validateAquaShip } from "./aqua";

const now = Date.parse("2026-09-26T00:00:00.000Z");
const ok = {
  maker: "0x283Ac701577ca85327aA9f371a4E6cD631FC383b",
  template: "PEGGED_STABLE",
  usdcAmount: "40000000",
  usdeAmount: "40000000000000000000",
  bandBps: 50,
  reviewAt: "2026-10-10T00:00:00.000Z",
};

describe("validateAquaShip (the app validates the agent's template choice)", () => {
  it("accepts the pegged template with sane parameters", () => {
    expect(validateAquaShip(ok, now)).toBeNull();
  });
  it("rejects other templates, zero / non-integer amounts, out-of-range bands and review dates", () => {
    expect(validateAquaShip({ ...ok, template: "CUSTOM_PROGRAM" }, now)).toMatch(/PEGGED_STABLE/);
    expect(validateAquaShip({ ...ok, usdcAmount: "0" }, now)).toMatch(/greater than 0/);
    expect(validateAquaShip({ ...ok, usdeAmount: "1.5" }, now)).toMatch(/integers/);
    expect(validateAquaShip({ ...ok, bandBps: 5 }, now)).toMatch(/band/);
    expect(validateAquaShip({ ...ok, bandBps: 500 }, now)).toMatch(/band/);
    expect(validateAquaShip({ ...ok, feeBps: 0 }, now)).toMatch(/fee/);
    expect(validateAquaShip({ ...ok, feeBps: 100 }, now)).toMatch(/fee/);
    expect(validateAquaShip({ ...ok, reviewAt: "2026-09-01T00:00:00.000Z" }, now)).toMatch(/180 days/);
    expect(validateAquaShip({ ...ok, reviewAt: "2027-09-01T00:00:00.000Z" }, now)).toMatch(/180 days/);
  });
});

test("strategy review is a user plan with a dock action, settled once docked", () => {
  const s = { maker: ok.maker, strategy: "0x", strategyHash: "0xABC", bandBps: 50, usdcAmount: ok.usdcAmount, usdeAmount: ok.usdeAmount, reviewAt: ok.reviewAt, shippedAt: "", docked: false };
  const e = deriveStrategyReviewEvent(s, "2026-09-26T00:00:00.000Z");
  expect(e).toMatchObject({ class: "user_plan", kind: "strategy_review", protocol: "aqua", settled: false, at: ok.reviewAt });
  expect(e.actions[0]).toMatchObject({ actionType: "aqua_dock", availability: "available", params: { strategyHash: "0xABC" } });
  const d = deriveStrategyReviewEvent({ ...s, docked: true }, "2026-09-26T00:00:00.000Z");
  expect(d.settled).toBe(true);
  expect(d.actions[0]!.availability).toBe("not_yet");
});
