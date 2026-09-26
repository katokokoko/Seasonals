import { lightAngleDeg } from "./useGlassLight";

test("light angle is CSS-style: 0deg up, clockwise", () => {
  expect(lightAngleDeg(0, 1)).toBeCloseTo(0);
  expect(lightAngleDeg(1, 0)).toBeCloseTo(90);
  expect(lightAngleDeg(0, -1)).toBeCloseTo(180);
  expect(lightAngleDeg(-1, 0)).toBeCloseTo(270);
  // shader の既定 uLight (-0.6, 0.8) と CSS の既定 323deg が一致
  expect(lightAngleDeg(-0.6, 0.8)).toBeCloseTo(323.13, 1);
});
