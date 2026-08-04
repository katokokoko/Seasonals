/**
 * liquid-shader — テスト (Phase 8.81)
 *
 * SkSL の compile / 描画結果は jest では検証できない (RuntimeEffect は
 * jest.setup.js で stub)。ここで固定するのは:
 *   - colorToVec4 の各入力形式 (flavor は #RRGGBBAA / rgba() 文字列が混在)
 *   - packLiquidUniforms / packFoamUniforms が旧 worklet と同じ式で
 *     uniform を組むこと (surfaceYAt との係数一致は shader 側の責務)
 */

import { GLASS_TUNING, createGlassState, surfaceSlope } from "./glass-physics";
import {
  FOAM_SKSL,
  LIQUID_SKSL,
  colorToVec4,
  foamColorsFromFlavor,
  liquidColorsFromFlavor,
  packFoamUniforms,
  packLiquidUniforms,
} from "./liquid-shader";
import { flavorFromPalette } from "./glass-flavor";
import type { ThemeBgPalette } from "../../stores/theme";

const W = 400;
const H = 800;
const seq = () => {
  let i = 0;
  return () => {
    i = (i + 0.37) % 1;
    return i;
  };
};

describe("colorToVec4", () => {
  it("#RRGGBB → alpha 1", () => {
    expect(colorToVec4("#FF0000")).toEqual([1, 0, 0, 1]);
  });

  it("#RRGGBBAA (withAlpha の出力形式)", () => {
    const [r, g, b, a] = colorToVec4("#00ACC180");
    expect(r).toBeCloseTo(0, 5);
    expect(g).toBeCloseTo(0xac / 255, 5);
    expect(b).toBeCloseTo(0xc1 / 255, 5);
    expect(a).toBeCloseTo(0x80 / 255, 5);
  });

  it("rgba(...) 文字列 (bubbleStroke 等)", () => {
    const [r, g, b, a] = colorToVec4("rgba(255, 255, 255, 0.55)");
    expect(r).toBe(1);
    expect(g).toBe(1);
    expect(b).toBe(1);
    expect(a).toBeCloseTo(0.55, 5);
  });

  it("未知形式は透明 (描画事故より fail-safe)", () => {
    expect(colorToVec4("hsl(120, 50%, 50%)")).toEqual([0, 0, 0, 0]);
  });
});

describe("flavor → color uniforms", () => {
  const palette: ThemeBgPalette = {
    top: "#B4F0C8",
    mid: "#7FD8A0",
    deep: "#3BAE6E",
    bottom: "#2E9968",
    pool: "#1E6B48",
  } as ThemeBgPalette;

  it("liquid 6 色 / foam 3 色すべて vec4 に変換される", () => {
    const flavor = flavorFromPalette(palette);
    const liq = liquidColorsFromFlavor(flavor);
    const foam = foamColorsFromFlavor(flavor);
    for (const v of [...Object.values(liq), ...Object.values(foam)]) {
      expect(v).toHaveLength(4);
      for (const c of v) {
        expect(c).toBeGreaterThanOrEqual(0);
        expect(c).toBeLessThanOrEqual(1);
      }
    }
    // withAlpha(p.mid, 0.5) → alpha ≈ 0.5 が保存されている
    expect(liq.uLiqTop[3]).toBeCloseTo(0x80 / 255, 2);
  });
});

describe("packLiquidUniforms", () => {
  it("静止 state: base = H*fill、slope/振幅ゼロ、creamH = 11", () => {
    const st = createGlassState(W, H, 4, seq());
    const u = packLiquidUniforms(st, W, H);
    expect(u.uSize).toEqual([W, H]);
    expect(u.uBase).toBeCloseTo(H * GLASS_TUNING.fill, 8);
    expect(u.uSlope).toBe(0);
    expect(u.uAmp).toBeCloseTo(GLASS_TUNING.rippleBase, 8);
    expect(u.uS1).toBe(0);
    expect(u.uS2).toBe(0);
    expect(u.uMenisAmp).toBe(0);
    expect(u.uCreamH).toBeCloseTo(11, 8);
  });

  it("傾き・energy が旧 worklet と同じ式で反映される", () => {
    const st = createGlassState(W, H, 4, seq());
    st.angle = 0.3;
    st.energy = 0.5;
    st.s1 = 12;
    st.s2 = -4;
    st.t = 1.25;
    const u = packLiquidUniforms(st, W, H);
    expect(u.uSlope).toBeCloseTo(surfaceSlope(0.3), 10);
    expect(u.uAmp).toBeCloseTo(
      GLASS_TUNING.rippleBase + 0.5 * GLASS_TUNING.rippleEnergy,
      8
    );
    expect(u.uS1).toBe(12);
    expect(u.uS2).toBe(-4);
    expect(u.uT).toBe(1.25);
    // 旧 worklet: fh = 11 + energy * 7
    expect(u.uCreamH).toBeCloseTo(11 + 0.5 * 7, 8);
    // メニスカス: min(1, |angle|/0.6) * (base + energy * k)、angle > 0 → 壁 x=0
    expect(u.uMenisX).toBe(0);
    expect(u.uMenisAmp).toBeCloseTo(
      (0.3 / 0.6) *
        (GLASS_TUNING.meniscusBase + 0.5 * GLASS_TUNING.meniscusEnergy),
      8
    );
    st.angle = -0.3;
    expect(packLiquidUniforms(st, W, H).uMenisX).toBe(W);
  });
});

describe("packFoamUniforms", () => {
  it("fizzState=0: uAlpha=0 + 前線は画面外の番兵 (shader 即 transparent)", () => {
    const st = createGlassState(W, H, 4, seq());
    st.foamAlpha = 0.7; // state 0 では読まれない
    const u = packFoamUniforms(st, W, H);
    expect(u.uAlpha).toBe(0);
    expect(u.uEdge).toBeGreaterThan(H);
  });

  it("fizzState=1/2: foamEdge / foamAlpha / foamScroll をそのまま渡す", () => {
    const st = createGlassState(W, H, 4, seq());
    st.fizzState = 1;
    st.foamEdge = 320;
    st.foamAlpha = 1;
    st.foamScroll = 55;
    st.t = 2;
    const u = packFoamUniforms(st, W, H);
    expect(u.uEdge).toBe(320);
    expect(u.uAlpha).toBe(1);
    expect(u.uScroll).toBe(55);
    expect(u.uT).toBe(2);
  });
});

describe("SkSL source — uniform 宣言と pack の整合", () => {
  it("pack が返す全 key が SkSL に uniform として宣言されている", () => {
    const st = createGlassState(W, H, 4, seq());
    const dynLiquid = Object.keys(packLiquidUniforms(st, W, H));
    const colLiquid = Object.keys(
      liquidColorsFromFlavor(
        flavorFromPalette({
          top: "#FFFFFF",
          mid: "#FFFFFF",
          deep: "#FFFFFF",
          bottom: "#FFFFFF",
          pool: "#FFFFFF",
        } as ThemeBgPalette)
      )
    );
    for (const k of [...dynLiquid, ...colLiquid]) {
      expect(LIQUID_SKSL).toMatch(new RegExp(`uniform (float2?|half4) ${k};`));
    }
    const dynFoam = Object.keys(packFoamUniforms(st, W, H));
    for (const k of dynFoam) {
      expect(FOAM_SKSL).toMatch(new RegExp(`uniform (float2?|half4) ${k};`));
    }
    expect(FOAM_SKSL).toMatch(/uniform half4 uFoamTop;/);
    expect(FOAM_SKSL).toMatch(/uniform half4 uFoamBottom;/);
    expect(FOAM_SKSL).toMatch(/uniform half4 uFoamRing;/);
  });
});
