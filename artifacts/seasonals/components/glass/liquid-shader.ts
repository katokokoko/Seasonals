/**
 * liquid-shader — 液体演出の SkSL fragment shader (Phase 8.81 → 8.82 単一 pass 化)
 *
 * 8.36-8.49 の実装は毎フレーム CPU (UI thread) で Skia path を 9 本作り直して
 * いた: 液面を 12px 刻みでサンプリング (sin/cos×4 + exp を約 100 回/frame) し、
 * 泡 110 個の円を path に詰める。Seeker の 120Hz では 60Hz 端末の 2 倍の頻度で
 * 回り、アイドル時ですら UI thread CPU 85% を占めていた (実測 2026-08-04)。
 *
 * 8.81 で液面・クリーム帯・あふれ覆いを 2 pass の SkSL に移し、8.82 で
 * **全描画を 1 本の shader に統合**した (Canvas は Fill 1 node のみ):
 *   - 液面曲線 y_s(x) = 傾き + さざ波 + 定在波 1/2 次 + メニスカス
 *     (glass-physics.ts の surfaceYAt と同式) を per-pixel で shader 内評価
 *   - 液体 3-stop グラデ / 底の深み / クリーム帯 + ドット / あふれ覆い (§2.3)
 *   - 泡・飛沫は **CPU 物理を維持**し (§2.2「世界座標の上へ」の見た目を保つ)、
 *     位置を uniform 配列 (float4[N]) で渡して shader が円/リングを描く。
 *     CPU から消えるのは Skia Path 構築と path node の再記録で、tick 単価が
 *     下がる = 120Hz tick が維持できる (8.82 の狙い)
 *
 * FOAM_SEEDS / blob 列は golden-ratio の決定的生成なので shader 内で手続き計算
 * する (uniform 不要)。旧 BlurMask の疑似メタボールは smoothstep のソフトエッジで
 * 置換。数式の係数は GlassLayer.tsx 旧 worklet (8.36-8.49) の値をそのまま移植。
 *
 * RNSkia の RuntimeEffect は JS 側 API なので dev-client APK の再ビルドは不要。
 *
 * NOTE (泡の描画上限): stepGlass はあふれ前兆で泡を一時的に cap の 4-5 倍まで
 * 増やすが、shader の配列は bubbleCountLow (28) 固定で、**新しい方から 28 個**
 * だけ描く。per-pixel loop の反復数を定数に保つためのトレードオフで、前兆の
 * 「泡が増える」演出は泡あふれ本体 (foam) が担う。
 */

import { PixelRatio } from "react-native";
import { Skia, type SkRuntimeEffect } from "@shopify/react-native-skia";

import { GLASS_TUNING, surfaceSlope, type GlassState } from "./glass-physics";
import type { GlassFlavor } from "./glass-flavor";

/**
 * 8.82: AA (エッジのぼかし) 幅の単位補正。
 * Canvas / shader の座標系は **dp** で、Seeker は 1dp = 3 物理px。SkSL 内の
 * smoothstep 幅を「1〜1.5 (物理px のつもり)」で書くと実際は 3〜4.5 物理px の
 * ソフトエッジになり、旧 path 描画 (Skia の解析的 AA ≈1px) より明確に甘く見える
 * (user 報告「解像感が甘い」の実因)。エッジ幅は uAA = 1 物理px 相当の dp で渡す。
 */
const AA_DP = 1 / PixelRatio.get();

/** shader が描く泡・飛沫の slot 数 (SkSL の配列長と一致させる) */
export const BUBBLE_SLOTS = GLASS_TUNING.bubbleCountLow; // 28
export const DROPLET_SLOTS = GLASS_TUNING.dropletMaxLow; // 16

/** 画面外の番兵 (未使用 slot / 非表示)。x 早期 reject で 1 比較で落ちる */
const SENTINEL_X = -10000;

// ─────────────────────────────────────────────────────────────────────────────
// SkSL source (単一 pass)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 合成順は旧 Canvas の draw 順と同一:
 *   液体グラデ + 深み → 泡 → クリーム帯/ドット → 飛沫 → あふれ覆い (α)
 * 座標系は画面 px (Canvas と一致)。色 uniform は straight-alpha の RGBA、
 * 戻り値は premultiplied (Skia RuntimeEffect の規約)。
 */
export const GLASS_SKSL = `
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
uniform float uEdge;       // あふれ前線 y (通常時は画面外の番兵)
uniform float uScroll;     // あふれ内部テクスチャのスクロール量
uniform float uFoamA;      // あふれ覆いの不透明度 (旧 Group opacity)
uniform float uDropN;      // 生きている飛沫数 (0 なら loop 全体を skip)
uniform float uAA;         // 1 物理px 相当の dp (エッジ AA の半幅)
uniform half4 uLiqTop;
uniform half4 uLiqMid;
uniform half4 uLiqBottom;
uniform half4 uDeep;
uniform half4 uCream;
uniform half4 uCreamDot;
uniform half4 uBubbleStroke;
uniform half4 uBubbleFill;
uniform half4 uDropletC;
uniform half4 uFoamTop;
uniform half4 uFoamBottom;
uniform half4 uFoamRing;
uniform float4 uBubbles[${BUBBLE_SLOTS}];   // (x, y, r, 0) 番兵 x=-10000
uniform float4 uDroplets[${DROPLET_SLOTS}]; // (x, y, 表示半径, 0) 番兵 x=-10000

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

// 旧 worklet edgeY と同式 (あふれ前線)
float edgeY(float x) {
  return uEdge + 10.0 * sin(x * 0.03 + uT * 5.0)
               + 4.0 * sin(x * 0.011 - uT * 3.2);
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

  // ── 1. 液体本体 + 底の深み ──
  if (d > -1.5) {
    float g = clamp((p.y - H * 0.25) / (H * 0.75), 0.0, 1.0);
    half4 liq = g < 0.45
      ? mix(uLiqTop, uLiqMid, half(g / 0.45))
      : mix(uLiqMid, uLiqBottom, half((g - 0.45) / 0.55));
    liq.a *= half(smoothstep(-uAA, uAA, d)); // 液面の AA (~1 物理px)
    col = blendOver(col, liq);
    half4 deep = uDeep;
    deep.a *= half(clamp((p.y - H * 0.55) / (H * 0.45), 0.0, 1.0));
    col = blendOver(col, deep);

    // ── 2. 泡 (輪郭 stroke 1.1 相当 + ハイライト円) ──
    // 物理側の recycle 条件により alive な泡は常に液面下 (§2.2)。
    // x/y の早期 reject (減算 + 比較) で近傍 pixel 以外は本体を skip。
    // NOTE: loop 内で continue を使わない — Seeker (Mali) 実機で continue が
    // break 同様に振る舞い、slot 0 の泡しか描かれない不具合を確認した (8.82)
    for (int i = 0; i < ${BUBBLE_SLOTS}; i++) {
      float4 b = uBubbles[i];
      float dx = p.x - b.x;
      float dy = p.y - b.y;
      if (abs(dx) <= b.z + 2.0 && abs(dy) <= b.z + 2.0) {
        float dist = length(float2(dx, dy));
        // stroke: |dist - r| < 0.55 (幅 1.1、旧 strokeWidth と同値) + AA
        half ring = half(1.0 - smoothstep(0.55 - uAA, 0.55 + uAA, abs(dist - b.z)));
        half4 sc = uBubbleStroke;
        sc.a *= ring;
        col = blendOver(col, sc);
        // ハイライト: 中心を (-0.35r, -0.35r) にずらした半径 0.35r の塗り円
        float hr = b.z * 0.35;
        float hd = length(float2(dx + hr, dy + hr));
        half hi = half(1.0 - smoothstep(hr - uAA, hr + uAA, hd));
        half4 fc = uBubbleFill;
        fc.a *= hi;
        col = blendOver(col, fc);
      }
    }
  }

  // ── 3. クリーム帯 + ドット (液面近傍のみ) ──
  if (abs(d) < uCreamH + 30.0) {
    half band = half(smoothstep(-2.0 - uAA, -2.0 + uAA, d)
                   * (1.0 - smoothstep(uCreamH - uAA, uCreamH + uAA, d)));
    half4 cream = uCream;
    cream.a *= band;
    col = blendOver(col, cream);
    float cellW = uSize.x / 14.0;
    for (int i = 0; i < 14; i++) {
      float fi = float(i);
      float cx = (fi + 0.5) * cellW;
      if (abs(p.x - cx) < 12.0) {
        float r = 4.0 + mod(fi * 37.0, 5.0) + sin(uT * 2.0 + fi) * 1.2;
        float cy = surfaceY(cx) + 1.0;
        half cov = half(1.0 - smoothstep(r - uAA, r + uAA, distance(p, float2(cx, cy))));
        half4 dotc = uCreamDot;
        dotc.a *= cov;
        col = blendOver(col, dotc);
      }
    }
  }

  // ── 4. 飛沫 (存在する時だけ loop。continue 禁止 — 泡の NOTE 参照) ──
  if (uDropN > 0.5) {
    for (int i = 0; i < ${DROPLET_SLOTS}; i++) {
      float4 dr = uDroplets[i];
      float dx = p.x - dr.x;
      float dy = p.y - dr.y;
      if (abs(dx) <= dr.z + 1.5 && abs(dy) <= dr.z + 1.5) {
        half cov = half(1.0 - smoothstep(dr.z - uAA, dr.z + uAA, length(float2(dx, dy))));
        half4 dc = uDropletC;
        dc.a *= cov;
        col = blendOver(col, dc);
      }
    }
  }

  // ── 5. あふれ覆い (§2.3、通常時は uFoamA=0 で skip) ──
  if (uFoamA > 0.004) {
    float W = uSize.x;
    float ey = edgeY(p.x);
    float cov = smoothstep(-uAA, uAA, p.y - ey);
    // 前縁 blob 列 (疑似メタボール — 旧 BlurMask blur=5 を smoothstep で置換)。
    // 旧条件: edge > -(fizzCoverOvershoot + 5) = -95
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
    if (cov > 0.004) {
      half4 foam = mix(uFoamTop, uFoamBottom, half(clamp(p.y / H, 0.0, 1.0)));
      foam.a *= half(cov);
      // 内部泡テクスチャ (golden-ratio seed 26 個、前線と同速で上に流れる)
      float span = H + 140.0;
      if (p.y > ey + 20.0) {
        for (int i = 0; i < 26; i++) {
          float fi = float(i);
          float sx = fract(fi * 0.618) * W;
          float sy = fract(fi * 0.755 + 0.31);
          float y = mod(sy * span + span - mod(uScroll, span), span) - 70.0;
          if (y >= ey + 30.0 && y <= H + 20.0) {
            float r = 12.0 + mod(fi * 53.0, 26.0) + sin(uT * 2.0 + fi * 1.7) * 2.0;
            // stroke 幅 2 (旧 strokeWidth) = 半幅 1.0 + AA
            half ring = half(1.0 - smoothstep(1.0 - uAA, 1.0 + uAA, abs(distance(p, float2(sx, y)) - r)));
            foam.rgb = mix(foam.rgb, uFoamRing.rgb, ring * uFoamRing.a);
          }
        }
      }
      foam.a *= half(uFoamA);
      col = blendOver(col, foam);
    }
  }

  return half4(col.rgb * col.a, col.a); // premultiply
}
`;

// ─────────────────────────────────────────────────────────────────────────────
// RuntimeEffect 初期化 (JS thread で 1 回)
// ─────────────────────────────────────────────────────────────────────────────

export function makeGlassEffect(): SkRuntimeEffect | null {
  return Skia.RuntimeEffect.Make(GLASS_SKSL);
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

export interface GlassColorUniforms {
  uLiqTop: [number, number, number, number];
  uLiqMid: [number, number, number, number];
  uLiqBottom: [number, number, number, number];
  uDeep: [number, number, number, number];
  uCream: [number, number, number, number];
  uCreamDot: [number, number, number, number];
  uBubbleStroke: [number, number, number, number];
  uBubbleFill: [number, number, number, number];
  uDropletC: [number, number, number, number];
  uFoamTop: [number, number, number, number];
  uFoamBottom: [number, number, number, number];
  uFoamRing: [number, number, number, number];
}

export function glassColorsFromFlavor(f: GlassFlavor): GlassColorUniforms {
  return {
    uLiqTop: colorToVec4(f.liquidTop),
    uLiqMid: colorToVec4(f.liquidMid),
    uLiqBottom: colorToVec4(f.liquidBottom),
    uDeep: colorToVec4(f.deepShadow),
    uCream: colorToVec4(f.cream),
    uCreamDot: colorToVec4(f.creamBubble),
    uBubbleStroke: colorToVec4(f.bubbleStroke),
    uBubbleFill: colorToVec4(f.bubbleFill),
    uDropletC: colorToVec4(f.droplet),
    uFoamTop: colorToVec4(f.foamTop),
    uFoamBottom: colorToVec4(f.foamBottom),
    uFoamRing: colorToVec4(f.foamRing),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// uniform 詰め替え (frame worklet から毎フレーム呼ぶ、pure / worklet-safe)
// ─────────────────────────────────────────────────────────────────────────────

export interface GlassDynamicUniforms {
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
  uEdge: number;
  uScroll: number;
  uFoamA: number;
  uDropN: number;
  uAA: number;
  /** flat (x, y, r, 0) × BUBBLE_SLOTS */
  uBubbles: number[];
  /** flat (x, y, 表示半径, 0) × DROPLET_SLOTS */
  uDroplets: number[];
}

/**
 * GlassState → 動的 uniform 一式。
 * 式は旧 worklet / glass-physics.surfaceYAt と同一:
 *   - slope: surfaceSlope(angle) — tan + 飽和を CPU で 1 回だけ
 *   - amp: rippleBase + energy * rippleEnergy
 *   - meniscus: min(1,|angle|/0.6) * (meniscusBase + energy * meniscusEnergy)
 *   - creamH: 11 + energy * 7 (旧 fh)
 *   - 飛沫の表示半径: r * min(1, life * 1.5) (旧 dropletPath と同式)
 * 泡は新しい方から BUBBLE_SLOTS 個 (冒頭 NOTE)。未使用 slot は番兵。
 */
export function packGlassUniforms(
  st: GlassState,
  W: number,
  H: number
): GlassDynamicUniforms {
  "worklet";
  const T = GLASS_TUNING;

  const bubbles: number[] = [];
  const start = Math.max(0, st.bubbles.length - BUBBLE_SLOTS);
  for (let i = start; i < st.bubbles.length; i++) {
    const b = st.bubbles[i]!;
    bubbles.push(b.x, b.y, b.r, 0);
  }
  while (bubbles.length < BUBBLE_SLOTS * 4) {
    bubbles.push(SENTINEL_X, 0, 0, 0);
  }

  const droplets: number[] = [];
  const dropN = Math.min(st.droplets.length, DROPLET_SLOTS);
  for (let i = 0; i < dropN; i++) {
    const p = st.droplets[i]!;
    droplets.push(p.x, p.y, p.r * Math.min(1, p.life * 1.5), 0);
  }
  while (droplets.length < DROPLET_SLOTS * 4) {
    droplets.push(SENTINEL_X, 0, 0, 0);
  }

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
    uEdge: st.fizzState === 0 ? H + 1000 : st.foamEdge,
    uScroll: st.foamScroll,
    uFoamA: st.fizzState === 0 ? 0 : st.foamAlpha,
    uDropN: dropN,
    uAA: AA_DP,
    uBubbles: bubbles,
    uDroplets: droplets,
  };
}
