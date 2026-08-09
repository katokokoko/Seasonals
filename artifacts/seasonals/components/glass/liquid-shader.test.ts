/**
 * liquid-shader — テスト (Phase 8.81 → 8.82 単一 pass 化)
 *
 * SkSL の compile / 描画結果は jest では検証できない (RuntimeEffect は
 * jest.setup.js で stub)。ここで固定するのは:
 *   - colorToVec4 の各入力形式 (flavor は #RRGGBBAA / rgba() 文字列が混在)
 *   - packGlassUniforms が旧 worklet と同じ式で uniform を組むこと
 *     (surfaceYAt との係数一致は shader 側の責務)
 *   - 泡・飛沫の uniform 配列: 固定長 / 番兵 / 「新しい方から N 個」/
 *     飛沫の表示半径 (life 減衰)
 */

import { GLASS_TUNING, createGlassState, surfaceSlope } from "./glass-physics";
import {
  BUBBLE_SLOTS,
  DROPLET_SLOTS,
  GLASS_SKSL,
  colorToVec4,
  glassColorsFromFlavor,
  packGlassUniforms,
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

  it("12 色すべて vec4 に変換される", () => {
    const flavor = flavorFromPalette(palette);
    const colors = glassColorsFromFlavor(flavor);
    expect(Object.keys(colors)).toHaveLength(12);
    for (const v of Object.values(colors)) {
      expect(v).toHaveLength(4);
      for (const c of v) {
        expect(c).toBeGreaterThanOrEqual(0);
        expect(c).toBeLessThanOrEqual(1);
      }
    }
    // withAlpha(p.mid, 0.5) → alpha ≈ 0.5 が保存されている
    expect(colors.uLiqTop[3]).toBeCloseTo(0x80 / 255, 2);
  });
});

describe("packGlassUniforms — スカラー", () => {
  it("静止 state: base = H*fill、slope/振幅ゼロ、creamH = 11、foam off", () => {
    const st = createGlassState(W, H, 4, seq());
    const u = packGlassUniforms(st, W, H);
    expect(u.uSize).toEqual([W, H]);
    expect(u.uBase).toBeCloseTo(H * GLASS_TUNING.fill, 8);
    expect(u.uSlope).toBe(0);
    expect(u.uAmp).toBeCloseTo(GLASS_TUNING.rippleBase, 8);
    expect(u.uS1).toBe(0);
    expect(u.uS2).toBe(0);
    expect(u.uMenisAmp).toBe(0);
    expect(u.uCreamH).toBeCloseTo(11, 8);
    // fizzState=0: uFoamA=0 + 前線は画面外の番兵 (shader 即 skip)
    expect(u.uFoamA).toBe(0);
    expect(u.uEdge).toBeGreaterThan(H);
  });

  it("傾き・energy が旧 worklet と同じ式で反映される", () => {
    const st = createGlassState(W, H, 4, seq());
    st.angle = 0.3;
    st.energy = 0.5;
    st.s1 = 12;
    st.s2 = -4;
    st.t = 1.25;
    const u = packGlassUniforms(st, W, H);
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
    expect(packGlassUniforms(st, W, H).uMenisX).toBe(W);
  });

  it("fizzState=1/2: foamEdge / foamAlpha / foamScroll をそのまま渡す", () => {
    const st = createGlassState(W, H, 4, seq());
    st.fizzState = 1;
    st.foamEdge = 320;
    st.foamAlpha = 1;
    st.foamScroll = 55;
    const u = packGlassUniforms(st, W, H);
    expect(u.uEdge).toBe(320);
    expect(u.uFoamA).toBe(1);
    expect(u.uScroll).toBe(55);
  });
});

describe("packGlassUniforms — 泡・飛沫の uniform 配列", () => {
  it("泡: 常に固定長 (BUBBLE_SLOTS×4)、未使用 slot は画面外の番兵", () => {
    const st = createGlassState(W, H, 3, seq()); // 3 個だけ
    const u = packGlassUniforms(st, W, H);
    expect(u.uBubbles).toHaveLength(BUBBLE_SLOTS * 4);
    // 先頭 3 slot は実データ (x は画面近傍)
    expect(u.uBubbles[0]).toBe(st.bubbles[0]!.x);
    expect(u.uBubbles[1]).toBe(st.bubbles[0]!.y);
    expect(u.uBubbles[2]).toBe(st.bubbles[0]!.r);
    // 4 slot 目以降は番兵
    expect(u.uBubbles[3 * 4]).toBeLessThan(-1000);
  });

  it("泡が slot 超過 (あふれ前兆) の時は新しい方から BUBBLE_SLOTS 個", () => {
    const st = createGlassState(W, H, BUBBLE_SLOTS + 10, seq());
    const u = packGlassUniforms(st, W, H);
    expect(u.uBubbles).toHaveLength(BUBBLE_SLOTS * 4);
    // 先頭 slot = bubbles[10] (古い 10 個を落とす)
    expect(u.uBubbles[0]).toBe(st.bubbles[10]!.x);
    // 最終 slot = 最新の泡
    const last = st.bubbles[st.bubbles.length - 1]!;
    expect(u.uBubbles[(BUBBLE_SLOTS - 1) * 4]).toBe(last.x);
  });

  it("飛沫: 表示半径は r·min(1, life·1.5) (旧 dropletPath と同式)、uDropN 反映", () => {
    const st = createGlassState(W, H, 2, seq());
    st.droplets.push(
      { x: 100, y: 200, vx: 0, vy: 0, r: 3, life: 1 }, // min(1, 1.5)=1 → 3
      { x: 120, y: 210, vx: 0, vy: 0, r: 4, life: 0.4 } // 0.6 → 2.4
    );
    const u = packGlassUniforms(st, W, H);
    expect(u.uDroplets).toHaveLength(DROPLET_SLOTS * 4);
    expect(u.uDropN).toBe(2);
    expect(u.uDroplets[2]).toBeCloseTo(3, 8);
    expect(u.uDroplets[4 + 2]).toBeCloseTo(4 * 0.6, 8);
    // 3 slot 目以降は番兵
    expect(u.uDroplets[2 * 4]).toBeLessThan(-1000);
  });

  it("飛沫ゼロなら uDropN=0 (shader は loop 全体を skip)", () => {
    const st = createGlassState(W, H, 2, seq());
    expect(packGlassUniforms(st, W, H).uDropN).toBe(0);
  });
});

describe("SkSL source — uniform 宣言と pack の整合", () => {
  /** 実行時に Shader へ渡される uniform key の全体 (動的 + 色) */
  const suppliedKeys = (): string[] => {
    const st = createGlassState(W, H, 4, seq());
    return [
      ...Object.keys(packGlassUniforms(st, W, H)),
      ...Object.keys(
        glassColorsFromFlavor(
          flavorFromPalette({
            top: "#FFFFFF",
            mid: "#FFFFFF",
            deep: "#FFFFFF",
            bottom: "#FFFFFF",
            pool: "#FFFFFF",
          } as ThemeBgPalette)
        )
      ),
    ];
  };

  /** SkSL が宣言している uniform 名 (配列は添字を落として名前だけ) */
  const declaredKeys = (): string[] =>
    [...GLASS_SKSL.matchAll(/^uniform\s+\w+\s+(\w+)\s*(?:\[\d+\])?\s*;/gm)].map(
      (m) => m[1]!
    );

  it("pack が返す全 key が SkSL に uniform として宣言されている", () => {
    for (const k of suppliedKeys()) {
      expect(GLASS_SKSL).toMatch(
        new RegExp(`uniform (float2?|half4|float4) ${k}(\\[\\d+\\])?;`)
      );
    }
  });

  /**
   * 逆方向 — こちらが破れると **jest は green のまま実機だけが赤画面**になる。
   * Skia は宣言済み uniform に値が無いと描画時に throw する
   * ("Exception in HostFunction: Missing uniform value for: X")。
   * 2026-08-05 に uScale で同メッセージを実機で踏んだのが追加の動機
   * (その時は Fast Refresh のステール状態が原因でコード欠陥ではなかったが、
   *  SkSL に uniform を足して pack を書き忘れれば同じ結末になる)。
   */
  it("SkSL が宣言した全 uniform に値が供給されている", () => {
    const supplied = new Set(suppliedKeys());
    const unsupplied = declaredKeys().filter((k) => !supplied.has(k));
    expect(unsupplied).toEqual([]);
  });

  it("配列長は GLASS_TUNING の low tier と一致 (loop 反復数の定数性)", () => {
    expect(BUBBLE_SLOTS).toBe(GLASS_TUNING.bubbleCountLow);
    expect(DROPLET_SLOTS).toBe(GLASS_TUNING.dropletMaxLow);
    expect(GLASS_SKSL).toContain(`uniform float4 uBubbles[${BUBBLE_SLOTS}];`);
    expect(GLASS_SKSL).toContain(`uniform float4 uDroplets[${DROPLET_SLOTS}];`);
  });
});
