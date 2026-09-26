import { COLOR, mixHex, SURFACE_WEB, withAlpha } from "./design-system";

describe("web-derived tokens", () => {
  it("mixHex interpolates #RRGGBB", () => {
    expect(mixHex("#000000", "#FFFFFF", 0.5)).toBe("#808080");
    expect(mixHex(COLOR.sodaLight, COLOR.sodaLight, 0.3)).toBe(COLOR.sodaLight);
    expect(() => mixHex("red", "#FFFFFF", 0.5)).toThrow();
  });
  it("surfaces derive from bgPrimary", () => {
    expect(SURFACE_WEB.lobby).toBe(withAlpha(COLOR.bgPrimary, 0.92));
    expect(SURFACE_WEB.waterFallback).toMatch(/^#[0-9A-F]{6}$/);
  });
});
