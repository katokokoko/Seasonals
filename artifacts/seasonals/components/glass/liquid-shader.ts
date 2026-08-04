/**
 * liquid-shader — 液体演出の SkSL fragment shader (Phase 8.81)
 *
 * 8.36-8.49 の実装は毎フレーム CPU (UI thread) で Skia path を 9 本作り直して
 * いた: 液面を 12px 刻みでサンプリング (sin/cos×4 + exp を約 100 回/frame) し、
 * 泡 110 個の円を path に詰める。Seeker の 120Hz では 60Hz 端末の 2 倍の頻度で
 * 回り、アイドル時ですら UI thread CPU 85% を占めていた (実測 2026-08-04)。
 *
 * 本モジュールは「形を決める」工程を GPU に移す:
 *   - 液面曲線 y_s(x) = 傾き + さざ波 + 定在波 1/2 次 + メニスカス
 *     (glass-physics.ts の surfaceYAt と同式) を **per-pixel で shader 内評価**
 *   - 液体 3-stop グラデ / 底の深み / クリーム帯 + ドット → LIQUID_SKSL (pass 1)
 *   - あふれ覆い (前線 + blob 前縁 + 内部泡テクスチャ §2.3) → FOAM_SKSL (pass 2)
 *   - CPU 側は毎フレーム uniform (float 十数個) を詰め替えるだけ
 * 泡・飛沫は形が単純で数も少ないため CPU path のまま (GlassLayer.tsx 側で
 * low tier 28/16 に減量)。
 *
 * FOAM_SEEDS / blob 列は golden-ratio の決定的生成なので shader 内で手続き計算
 * する (uniform 不要)。旧 BlurMask の疑似メタボールは smoothstep のソフトエッジで
 * 置換。数式の係数は GlassLayer.tsx 旧 worklet (8.36-8.49) の値をそのまま移植。
 *
 * RNSkia の RuntimeEffect は JS 側 API なので dev-client APK の再ビルドは不要。
 */

import { Skia, type SkRuntimeEffect } from "@shopify/react-native-skia";

import { GLASS_TUNING, surfaceSlope, type GlassState } from "./glass-physics";
import type { GlassFlavor } from "./glass-flavor";

// ─────────────────────────────────────────────────────────────────────────────
// SkSL sources
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pass 1: 液体本体。
 * 座標系は画面 px (Canvas と一致)。色 uniform は straight-alpha の RGBA、
 * 戻り値は premultiplied (Skia RuntimeEffect の規約)。
 */
export const LIQUID_SKSL = `
uniform float2 uSize;      // (W, H)
uniform float uBase;       // H * fill
uniform float uSlope;      // surfaceSlope(angle) — tan の飽和は CPU 側で計算済
uniform float uAmp;        // さざ波振幅 (energy 連動)
uniform float uT;          // 経過秒
uniform float uS1;         // スロッシュ 1 次振幅
uniform float uS2;         // 2 次振幅
uniform float uMenisX;     // メニスカスが立つ壁 (0 or W)
uniform float uMenisAmp;   // メニスカス振幅 (min(1,|angle|/0.6)*(base+energy*k))
uniform float uCreamH;     // クリーム帯の厚み (11 + energy*7)
uniform half4 uLiqTop;
uniform half4 uLiqMid;
uniform half4 uLiqBottom;
uniform half4 uDeep;
uniform half4 uCream;
uniform half4 uCreamDot;

const float PI = 3.141592653589793;

// glass-physics.ts surfaceYAt の SkSL 移植 (係数は同一)
float surfaceY(float x) {
  float W = uSize.x;
  float y = uBase + uSlope * (x - W * 0.5);
  y += uAmp * (0.6 * sin(x * 0.018 + uT * 3.1)
             + 0.4 * sin(x * 0.031 - uT * 4.3));
  y += uS1 * cos(PI * x / W);
  y += uS2 * cos(2.0 * PI * x / W);
  y -= uMenisAmp * exp(-abs(x - uMenisX) / 24.0);
  return y;
}

// straight-alpha src-over 合成
half4 blendOver(half4 dst, half4 src) {
  half a = src.a + dst.a * (1.0 - src.a);
  if (a < 0.001) { return half4(0.0); }
  half3 rgb = (src.rgb * src.a + dst.rgb * dst.a * (1.0 - src.a)) / a;
  return half4(rgb, a);
}

half4 main(float2 p) {
  float H = uSize.y;
  float ys = surfaceY(p.x);
  float d = p.y - ys; // > 0 = 液中
  half4 col = half4(0.0);

  if (d > -1.5) {
    // 液体 3-stop 縦グラデ (旧 LinearGradient: 0.25H→H, positions [0,0.45,1])
    float g = clamp((p.y - H * 0.25) / (H * 0.75), 0.0, 1.0);
    half4 liq = g < 0.45
      ? mix(uLiqTop, uLiqMid, half(g / 0.45))
      : mix(uLiqMid, uLiqBottom, half((g - 0.45) / 0.55));
    liq.a *= half(smoothstep(-1.5, 1.5, d)); // 液面の AA
    col = blendOver(col, liq);
    // 底の深み overlay (旧: transparent→deepShadow, 0.55H→H)
    half4 deep = uDeep;
    deep.a *= half(clamp((p.y - H * 0.55) / (H * 0.45), 0.0, 1.0));
    col = blendOver(col, deep);
  }

  // クリーム帯 + ドット — 液面近傍の pixel だけ評価 (warp 単位で分岐スキップ)
  if (abs(d) < uCreamH + 30.0) {
    // 帯 [ys-2, ys+uCreamH] (旧 creamPath と同区間、端 1px AA)
    half band = half(smoothstep(-3.0, -1.0, d)
                   * (1.0 - smoothstep(uCreamH - 1.0, uCreamH + 1.0, d)));
    half4 cream = uCream;
    cream.a *= band;
    col = blendOver(col, cream);
    // ドット 14 個 (旧 creamDotsPath: r = 4 + (i*37)%5 + sin(t*2+i)*1.2)
    float cellW = uSize.x / 14.0;
    for (int i = 0; i < 14; i++) {
      float fi = float(i);
      float cx = (fi + 0.5) * cellW;
      if (abs(p.x - cx) < 12.0) {
        float r = 4.0 + mod(fi * 37.0, 5.0) + sin(uT * 2.0 + fi) * 1.2;
        float cy = surfaceY(cx) + 1.0;
        half cov = half(1.0 - smoothstep(r - 1.0, r + 1.0, distance(p, float2(cx, cy))));
        half4 dotc = uCreamDot;
        dotc.a *= cov;
        col = blendOver(col, dotc);
      }
    }
  }
  return half4(col.rgb * col.a, col.a);
}
`;

/**
 * Pass 2: あふれ覆い (§2.3)。泡 (CPU path) の上に重ねるため別 pass。
 * uAlpha == 0 (通常時) は即 transparent を返し、GPU コストはほぼゼロ。
 */
export const FOAM_SKSL = `
uniform float2 uSize;
uniform float uT;
uniform float uEdge;     // 前線 y (fizzState==0 のとき番兵で画面外)
uniform float uScroll;   // 内部テクスチャの上方向スクロール量
uniform float uAlpha;    // 覆い全体の不透明度 (旧 Group opacity)
uniform half4 uFoamTop;
uniform half4 uFoamBottom;
uniform half4 uFoamRing;

// 旧 worklet edgeY と同式
float edgeY(float x) {
  return uEdge + 10.0 * sin(x * 0.03 + uT * 5.0)
               + 4.0 * sin(x * 0.011 - uT * 3.2);
}

half4 main(float2 p) {
  if (uAlpha < 0.004) { return half4(0.0); }
  float W = uSize.x;
  float H = uSize.y;
  float ey = edgeY(p.x);

  // 本体 coverage (前縁 AA)
  float cov = smoothstep(-1.5, 1.5, p.y - ey);

  // 前縁 blob 列 (疑似メタボール — 旧 BlurMask blur=5 を smoothstep で置換)
  // 旧条件: edge > -(fizzCoverOvershoot + 5) = -(90 + 5)
  if (p.y < ey + 40.0 && uEdge > -95.0) {
    float cellW = W / 14.0;
    for (int i = 0; i < 14; i++) {
      float fi = float(i);
      float cx = (fi + 0.5) * cellW;
      if (abs(p.x - cx) < 34.0) {
        float r = 10.0 + mod(fi * 37.0, 16.0) + sin(uT * 3.0 + fi * 2.0) * 3.0;
        float cy = edgeY(cx) + 2.0;
        cov = max(cov, 1.0 - smoothstep(r - 4.0, r + 6.0, distance(p, float2(cx, cy))));
      }
    }
  }
  if (cov < 0.004) { return half4(0.0); }

  half4 col = mix(uFoamTop, uFoamBottom, half(clamp(p.y / H, 0.0, 1.0)));
  col.a *= half(cov);

  // 内部泡テクスチャ (golden-ratio seed 26 個、前線と同速で上に流れる — §2.3-3)
  // 旧 FOAM_SEEDS: x=(i*0.618)%1, y=(i*0.755+0.31)%1, r=12+(i*53)%26, 位相 i*1.7
  float span = H + 140.0;
  if (p.y > ey + 20.0) {
    for (int i = 0; i < 26; i++) {
      float fi = float(i);
      float sx = fract(fi * 0.618) * W;
      float sy = fract(fi * 0.755 + 0.31);
      float y = mod(sy * span + span - mod(uScroll, span), span) - 70.0;
      if (y >= ey + 30.0 && y <= H + 20.0) {
        float r = 12.0 + mod(fi * 53.0, 26.0) + sin(uT * 2.0 + fi * 1.7) * 2.0;
        half ring = half(1.0 - smoothstep(1.0, 2.0, abs(distance(p, float2(sx, y)) - r)));
        col.rgb = mix(col.rgb, uFoamRing.rgb, ring * uFoamRing.a);
      }
    }
  }

  col.a *= half(uAlpha);
  return half4(col.rgb * col.a, col.a);
}
`;

// ─────────────────────────────────────────────────────────────────────────────
// RuntimeEffect 初期化 (JS thread で 1 回)
// ─────────────────────────────────────────────────────────────────────────────

export function makeLiquidEffect(): SkRuntimeEffect | null {
  return Skia.RuntimeEffect.Make(LIQUID_SKSL);
}

export function makeFoamEffect(): SkRuntimeEffect | null {
  return Skia.RuntimeEffect.Make(FOAM_SKSL);
}

// ─────────────────────────────────────────────────────────────────────────────
// 色変換 — GlassFlavor (hex / rgba 文字列) → shader uniform vec4
// ─────────────────────────────────────────────────────────────────────────────

/**
 * "#RRGGBB" / "#RRGGBBAA" / "rgba(r, g, b, a)" → [r, g, b, a] (0..1)。
 * theme 切替時に 1 回だけ呼ぶ (per-frame では呼ばない)。
 */
export function colorToVec4(color: string): [number, number, number, number] {
  if (color.startsWith("#")) {
    const h = color.slice(1);
    const r = parseInt(h.slice(0, 2), 16) / 255;
    const g = parseInt(h.slice(2, 4), 16) / 255;
    const b = parseInt(h.slice(4, 6), 16) / 255;
    const a = h.length >= 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
    return [r, g, b, a];
  }
  const m = color.match(
    /rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)/
  );
  if (m) {
    return [
      Number(m[1]) / 255,
      Number(m[2]) / 255,
      Number(m[3]) / 255,
      m[4] !== undefined ? Number(m[4]) : 1,
    ];
  }
  // 未知形式は不可視 (描画事故より安全側)
  return [0, 0, 0, 0];
}

export interface LiquidColorUniforms {
  uLiqTop: [number, number, number, number];
  uLiqMid: [number, number, number, number];
  uLiqBottom: [number, number, number, number];
  uDeep: [number, number, number, number];
  uCream: [number, number, number, number];
  uCreamDot: [number, number, number, number];
}

export interface FoamColorUniforms {
  uFoamTop: [number, number, number, number];
  uFoamBottom: [number, number, number, number];
  uFoamRing: [number, number, number, number];
}

export function liquidColorsFromFlavor(f: GlassFlavor): LiquidColorUniforms {
  return {
    uLiqTop: colorToVec4(f.liquidTop),
    uLiqMid: colorToVec4(f.liquidMid),
    uLiqBottom: colorToVec4(f.liquidBottom),
    uDeep: colorToVec4(f.deepShadow),
    uCream: colorToVec4(f.cream),
    uCreamDot: colorToVec4(f.creamBubble),
  };
}

export function foamColorsFromFlavor(f: GlassFlavor): FoamColorUniforms {
  return {
    uFoamTop: colorToVec4(f.foamTop),
    uFoamBottom: colorToVec4(f.foamBottom),
    uFoamRing: colorToVec4(f.foamRing),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// uniform 詰め替え (frame worklet から毎フレーム呼ぶ、pure / worklet-safe)
// ─────────────────────────────────────────────────────────────────────────────

export interface LiquidDynamicUniforms {
  uSize: [number, number];
  uBase: number;
  uSlope: number;
  uAmp: number;
  uT: number;
  uS1: number;
  uS2: number;
  uMenisX: number;
  uMenisAmp: number;
  uCreamH: number;
}

export interface FoamDynamicUniforms {
  uSize: [number, number];
  uT: number;
  uEdge: number;
  uScroll: number;
  uAlpha: number;
}

/**
 * GlassState → 液体 pass の動的 uniform。
 * 式は旧 worklet / glass-physics.surfaceYAt と同一:
 *   - slope: surfaceSlope(angle) — tan + 飽和を CPU で 1 回だけ
 *   - amp: rippleBase + energy * rippleEnergy
 *   - meniscus: min(1,|angle|/0.6) * (meniscusBase + energy * meniscusEnergy)
 *   - creamH: 11 + energy * 7 (旧 fh)
 */
export function packLiquidUniforms(
  st: GlassState,
  W: number,
  H: number
): LiquidDynamicUniforms {
  "worklet";
  const T = GLASS_TUNING;
  return {
    uSize: [W, H],
    uBase: H * T.fill,
    uSlope: surfaceSlope(st.angle),
    uAmp: T.rippleBase + st.energy * T.rippleEnergy,
    uT: st.t,
    uS1: st.s1,
    uS2: st.s2,
    uMenisX: st.angle > 0 ? 0 : W,
    uMenisAmp:
      Math.min(1, Math.abs(st.angle) / 0.6) *
      (T.meniscusBase + st.energy * T.meniscusEnergy),
    uCreamH: 11 + st.energy * 7,
  };
}

/**
 * GlassState → あふれ pass の動的 uniform。
 * fizzState==0 は uAlpha=0 + uEdge を画面外の番兵に (shader は即 transparent)。
 */
export function packFoamUniforms(
  st: GlassState,
  W: number,
  H: number
): FoamDynamicUniforms {
  "worklet";
  return {
    uSize: [W, H],
    uT: st.t,
    uEdge: st.fizzState === 0 ? H + 1000 : st.foamEdge,
    uScroll: st.foamScroll,
    uAlpha: st.fizzState === 0 ? 0 : st.foamAlpha,
  };
}
