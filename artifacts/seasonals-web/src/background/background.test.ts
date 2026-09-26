import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { collectQuietRects, packQuietRects, sameRects } from "./quietZones";
import { resolveWaterParams, waterCalm, waterDefaults } from "./waterDefaults";

describe("water.frag.glsl", () => {
  it("is byte-identical to the shader spec (sha256 recorded at copy time)", () => {
    const buf = readFileSync(resolve(process.cwd(), "src/background/water.frag.glsl"));
    expect(createHash("sha256").update(buf).digest("hex")).toBe(
      "23df542fa49cb76888418452ed472c2106edbc72dd6eed7ea020dc3101ae4d58"
    );
  });
});

describe("waterDefaults", () => {
  it("matches the spec defaults", () => {
    expect(waterDefaults).toEqual({ speed: 1, scale: 4.5, caustic: 0.5, refraction: 0.012, tint: 0.5, quiet: 0.85, maxDpr: 1.25 });
  });
  it("calm preset is quieter than defaults", () => {
    expect(waterCalm.caustic).toBeLessThan(waterDefaults.caustic);
    expect(waterCalm.quiet).toBe(1);
    expect(waterCalm.maxDpr).toBe(waterDefaults.maxDpr);
  });
  it("partial params fall back to defaults", () => {
    expect(resolveWaterParams({ tint: 1 })).toEqual({ ...waterDefaults, tint: 1 });
  });
});

describe("quiet zones", () => {
  function el(group: string | null, r: { left: number; top: number; width: number; height: number }) {
    const d = document.createElement("div");
    d.setAttribute("data-water-quiet", group ?? "");
    d.getBoundingClientRect = () =>
      ({ ...r, right: r.left + r.width, bottom: r.top + r.height, x: r.left, y: r.top, toJSON() {} }) as DOMRect;
    return d;
  }
  it("converts to device px with bottom-left origin", () => {
    const root = document.createElement("div");
    root.append(el(null, { left: 10, top: 20, width: 100, height: 50 }));
    const [r] = collectQuietRects(root, { width: 1000, height: 800 }, 2);
    expect(r).toEqual({ x: 20, y: (800 - 70) * 2, w: 200, h: 100 });
  });
  it("unions same-group elements and keeps the 4 largest", () => {
    const root = document.createElement("div");
    root.append(
      el("left", { left: 0, top: 0, width: 100, height: 100 }),
      el("left", { left: 0, top: 300, width: 100, height: 100 }),
      el(null, { left: 500, top: 0, width: 10, height: 10 }),
      el(null, { left: 500, top: 100, width: 20, height: 20 }),
      el(null, { left: 500, top: 200, width: 30, height: 30 }),
      el(null, { left: 500, top: 300, width: 40, height: 40 })
    );
    const rects = collectQuietRects(root, { width: 1000, height: 800 }, 1);
    expect(rects).toHaveLength(4);
    expect(rects[0]).toEqual({ x: 0, y: 400, w: 100, h: 400 });
    expect(rects.map((r) => r.w)).toEqual([100, 40, 30, 20]);
  });
  it("packs into Float32Array(16)", () => {
    const a = packQuietRects([{ x: 1, y: 2, w: 3, h: 4 }]);
    expect(Array.from(a.slice(0, 5))).toEqual([1, 2, 3, 4, 0]);
    expect(sameRects(a, packQuietRects([{ x: 1, y: 2, w: 3, h: 4 }]))).toBe(true);
    expect(sameRects(a, packQuietRects([]))).toBe(false);
  });
});
