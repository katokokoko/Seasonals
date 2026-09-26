import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { canvasFrame, collectFloaters, collectGlassRects, collectQuietRects, packFloaters, GLASS_VARIANTS, packGlassRects, packQuietRects, sameRects, transformAngle } from "./quietZones";
import { resolveWaterParams, waterCalm, waterDefaults } from "./waterDefaults";

describe("water.frag.glsl", () => {
  it("is byte-identical to the shader spec (sha256 recorded at copy time)", () => {
    const buf = readFileSync(resolve(process.cwd(), "src/background/water.frag.glsl"));
    expect(createHash("sha256").update(buf).digest("hex")).toBe(
      "a3335ca656c0bc5ac86e5ba72ae5bc93e433c72b7e6fc17d6e3b752e27fe52b0"
    );
  });
});

describe("waterDefaults", () => {
  it("matches the spec defaults", () => {
    expect(waterDefaults).toEqual({ speed: 1, scale: 4.5, caustic: 0.5, refraction: 0.012, tint: 0.5, quiet: 0.85, glass: 1, maxDpr: 1.25 });
  });
  it("calm preset is quieter than defaults", () => {
    expect(waterCalm.caustic).toBeLessThan(waterDefaults.caustic);
    expect(waterCalm.quiet).toBe(1);
    expect(waterCalm.maxDpr).toBe(waterDefaults.maxDpr);
    expect(waterCalm.glass).toBeLessThan(waterDefaults.glass);
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
    const [r] = collectQuietRects(root, { left: 0, bottom: 800, scale: 2 });
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
    const rects = collectQuietRects(root, { left: 0, bottom: 800, scale: 1 });
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

describe("glass surfaces", () => {
  function glass(r: { left: number; top: number; width: number; height: number }, style: Partial<CSSStyleDeclaration> = {}, variant = "") {
    const d = document.createElement("div");
    d.setAttribute("data-water-glass", variant);
    Object.assign(d.style, style);
    d.getBoundingClientRect = () =>
      ({ ...r, right: r.left + r.width, bottom: r.top + r.height, x: r.left, y: r.top, toJSON() {} }) as DOMRect;
    document.body.append(d);
    return d;
  }
  afterEach(() => document.body.replaceChildren());

  it("reads the rotation angle from a computed transform", () => {
    const a = (2.5 * Math.PI) / 180;
    expect(transformAngle(`matrix(${Math.cos(a)}, ${Math.sin(a)}, ${-Math.sin(a)}, ${Math.cos(a)}, 0, 0)`)).toBeCloseTo(a, 6);
    expect(transformAngle(`matrix3d(${Math.cos(-a)}, ${Math.sin(-a)}, 0, 0, ${-Math.sin(-a)}, ${Math.cos(-a)}, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1)`)).toBeCloseTo(-a, 6);
    expect(transformAngle("none")).toBe(0);
    expect(transformAngle(undefined)).toBe(0);
  });
  it("uses the bbox centre, layout size, clamped radius and device px", () => {
    glass({ left: 100, top: 50, width: 200, height: 100 }, { borderTopLeftRadius: "9999px" });
    const [g] = collectGlassRects(document, { left: 0, bottom: 800, scale: 2 });
    expect(g).toEqual({ cx: 400, cy: (800 - 100) * 2, w: 400, h: 200, radius: 100, angle: 0, ...GLASS_VARIANTS.regular });
  });
  it("reads the clear / regular variant and skips invisible surfaces", () => {
    glass({ left: 0, top: 0, width: 300, height: 60 }, {}, "clear");
    glass({ left: 0, top: 100, width: 200, height: 60 }, {}, "regular");
    glass({ left: 0, top: 200, width: 100, height: 60 }, { opacity: "0" }, "clear");
    const rects = collectGlassRects(document, { left: 0, bottom: 800, scale: 1 });
    expect(rects.map((r) => [r.w, r.lens, r.frost])).toEqual([
      [300, GLASS_VARIANTS.clear.lens, GLASS_VARIANTS.clear.frost],
      [200, GLASS_VARIANTS.regular.lens, GLASS_VARIANTS.regular.frost],
    ]);
    expect(GLASS_VARIANTS.clear.frost).toBeLessThan(GLASS_VARIANTS.regular.frost);
    expect(GLASS_VARIANTS.clear.lens).toBeGreaterThan(GLASS_VARIANTS.regular.lens);
  });
  it("measures relative to the canvas box, not the viewport", () => {
    // canvas が viewport の (0,0) に無い / buffer 倍率が dpr と違う場合でも、canvas の中の位置で揃う
    glass({ left: 100, top: 60, width: 200, height: 40 }, {}, "clear");
    const canvas = document.createElement("canvas");
    canvas.width = 1250;
    canvas.height = 750;
    canvas.getBoundingClientRect = () => ({ left: 0, top: 25, right: 1000, bottom: 625, width: 1000, height: 600, x: 0, y: 25, toJSON() {} }) as DOMRect;
    const frame = canvasFrame(canvas);
    expect(frame).toEqual({ left: 0, bottom: 625, scale: 1.25 });
    const [g] = collectGlassRects(document, frame);
    // 中心 (200, 80) CSS → canvas 内 (200, 625 - 80 = 545) → buffer px ×1.25
    expect([g!.cx, g!.cy]).toEqual([250, 545 * 1.25]);
  });
  it("keeps the 6 largest and packs two vec4 per surface", () => {
    for (let i = 1; i <= 7; i++) glass({ left: 0, top: i * 10, width: i * 10, height: 10 }, { borderTopLeftRadius: "4px" });
    const rects = collectGlassRects(document, { left: 0, bottom: 800, scale: 1 });
    expect(rects.map((r) => r.w)).toEqual([70, 60, 50, 40, 30, 20]);
    const packed = packGlassRects(rects);
    expect(packed.rects).toHaveLength(24);
    expect(Array.from(packed.rects.slice(0, 4))).toEqual([35, 800 - 75, 70, 10]);
    expect(packed.meta).toHaveLength(24);
    expect(Array.from(packed.meta.slice(0, 4))).toEqual([4, 0, GLASS_VARIANTS.regular.lens, GLASS_VARIANTS.regular.frost]);
  });
});

describe("floaters", () => {
  afterEach(() => document.body.replaceChildren());
  function floater(r: { left: number; top: number; width: number; height: number }, value = "", style: Partial<CSSStyleDeclaration> = {}) {
    const d = document.createElement("img");
    d.setAttribute("data-water-floater", value);
    Object.assign(d.style, style);
    d.getBoundingClientRect = () =>
      ({ ...r, right: r.left + r.width, bottom: r.top + r.height, x: r.left, y: r.top, toJSON() {} }) as DOMRect;
    document.body.append(d);
    return d;
  }
  it("returns centre and body radius relative to the canvas box", () => {
    floater({ left: 100, top: 200, width: 160, height: 150 });
    const [f] = collectFloaters(document, { left: 0, bottom: 800, scale: 1.25 });
    expect(f).toEqual({ cx: 180 * 1.25, cy: (800 - 275) * 1.25, radius: 75 * 1.25, strength: 1 });
  });
  it("skips invisible floaters, caps at 2 and reads the strength", () => {
    floater({ left: 0, top: 0, width: 100, height: 100 }, "", { opacity: "0" });
    floater({ left: 0, top: 0, width: 100, height: 100 }, "0.5");
    floater({ left: 200, top: 0, width: 100, height: 100 });
    floater({ left: 400, top: 0, width: 100, height: 100 });
    const fs = collectFloaters(document, { left: 0, bottom: 800, scale: 1 });
    expect(fs.map((f) => [f.cx, f.strength])).toEqual([
      [50, 0.5],
      [250, 1],
    ]);
    const packed = packFloaters(fs);
    expect(packed).toHaveLength(8);
    expect(Array.from(packed.slice(0, 4))).toEqual([50, 750, 50, 0.5]);
  });
});
