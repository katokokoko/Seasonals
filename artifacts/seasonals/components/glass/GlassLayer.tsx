/**
 * GlassLayer — 画面全体を「クリームソーダのグラスの内側」に見立てる装飾レイヤ
 * (Phase 8.36、設計ハンドオフ §1-§7 / プロトタイプ seasonals-soda-tilt.html)
 *
 * 描画は @shopify/react-native-skia。物理積分 (glass-physics) は Reanimated の
 * useFrameCallback worklet 内で行い JS thread を経由しない。各描画 path は
 * 同 worklet で毎フレーム構築して sharedValue へ代入する (UI thread 完結)。
 *
 * 装飾であって機能ではない (§1): pointerEvents="none" で touch 透過、
 * カレンダー可読性優先で液体 alpha は透過寄り。設定 off / reduce-motion /
 * センサー不可のときは既存の MelonSodaBackground (static) へ退避する (§2.4)。
 *
 * プロトタイプとの差分 (洗練、§5 への回答):
 * - ストロー / アイス浮きは v1 見送り (カレンダー UI と競合する具象物)
 * - あふれ覆いの前縁は「本体 path + BlurMask 付き blob 列」で泡の塊感を出す
 *   (シェーダなしの疑似メタボール)
 * - 液体は theme の 5-stop palette + 深度 overlay + 透過で「液越しの UI」感
 */

import React, { useCallback, useMemo } from "react";
import { Dimensions, StyleSheet, View } from "react-native";
import {
  BlurMask,
  Canvas,
  Group,
  LinearGradient,
  Path,
  Rect,
  RoundedRect,
  Skia,
  vec,
} from "@shopify/react-native-skia";
import {
  runOnJS,
  useFrameCallback,
  useSharedValue,
} from "react-native-reanimated";
import * as Haptics from "expo-haptics";

import { MelonSodaBackground } from "../decorative/MelonSodaBackground";
import { usePrefsStore } from "../../stores/prefs";
import {
  GLASS_TUNING,
  createGlassState,
  stepGlass,
  surfaceYAt,
} from "./glass-physics";
import { useGlassFlavor } from "./glass-flavor";
import { useReduceMotion } from "./useReduceMotion";
import { useTiltRoll } from "./useTiltRoll";

const W = Dimensions.get("window").width;
const H = Dimensions.get("window").height;

/** 液面 path の x 標本間隔 (事前分割 — 毎フレームこの点列だけ動かす) */
const SURF_STEP = 12;
/** あふれ内部テクスチャの seed (golden-ratio 配置、タイル境界レス) */
const FOAM_SEEDS = Array.from({ length: 26 }, (_, i) => ({
  x: (i * 0.618) % 1,
  y: (i * 0.755 + 0.31) % 1,
  r: 12 + ((i * 53) % 26),
  p: i * 1.7,
}));
/** あふれ前縁 blob の個数 */
const FOAM_EDGE_BLOBS = 14;

function fireSloshHaptic(): void {
  Haptics.selectionAsync().catch(() => undefined);
}
function fireFizzHaptic(): void {
  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => undefined);
}

export function GlassLayer() {
  const liquidEnabled = usePrefsStore((s) => s.liquidEffect);
  const reduced = useReduceMotion();
  const { roll, available } = useTiltRoll(liquidEnabled && !reduced);
  const flavor = useGlassFlavor();

  const active = liquidEnabled && !reduced && available;

  // 物理 state (worklet から in-place 変異。再レンダーには関与しない)
  const state = useSharedValue(
    // 初期化は JS thread で 1 回だけ (Math.random 使用可)
    useMemo(() => createGlassState(W, H, GLASS_TUNING.bubbleCount), [])
  );

  // 描画出力 (Skia props に直結する sharedValue 群)
  const liquidPath = useSharedValue(Skia.Path.Make());
  const creamPath = useSharedValue(Skia.Path.Make());
  const creamDotsPath = useSharedValue(Skia.Path.Make());
  const bubblePath = useSharedValue(Skia.Path.Make());
  const bubbleHiPath = useSharedValue(Skia.Path.Make());
  const dropletPath = useSharedValue(Skia.Path.Make());
  const foamBodyPath = useSharedValue(Skia.Path.Make());
  const foamBlobPath = useSharedValue(Skia.Path.Make());
  const foamRingPath = useSharedValue(Skia.Path.Make());
  const foamAlpha = useSharedValue(0);

  useFrameCallback((info) => {
    "worklet";
    if (!active) return;
    const dtMs = info.timeSincePreviousFrame ?? 16.7;
    const dt = Math.min(0.033, dtMs / 1000);
    const st = state.value;

    st.targetA = roll.value;
    stepGlass(st, dt, W, H, false);

    if (st.hapticSlosh) runOnJS(fireSloshHaptic)();
    if (st.hapticFizz) runOnJS(fireFizzHaptic)();

    // ── 液面 path (事前分割した固定 x 標本列を動かす) ──
    const lp = Skia.Path.Make();
    lp.moveTo(-4, surfaceYAt(st, -4, W, H, false));
    for (let x = 0; x <= W + SURF_STEP; x += SURF_STEP) {
      lp.lineTo(x, surfaceYAt(st, x, W, H, false));
    }
    lp.lineTo(W + 4, H + 4);
    lp.lineTo(-4, H + 4);
    lp.close();
    liquidPath.value = lp;

    // ── クリーム帯 (液面に浮かぶ泡の層) ──
    const fh = 11 + st.energy * 7;
    const cp = Skia.Path.Make();
    cp.moveTo(-4, surfaceYAt(st, -4, W, H, false) - 2);
    for (let x = 0; x <= W + SURF_STEP; x += SURF_STEP) {
      cp.lineTo(x, surfaceYAt(st, x, W, H, false) - 2);
    }
    for (let x = W + SURF_STEP; x >= -SURF_STEP; x -= SURF_STEP) {
      cp.lineTo(x, surfaceYAt(st, x, W, H, false) + fh);
    }
    cp.close();
    creamPath.value = cp;
    const cd = Skia.Path.Make();
    for (let i = 0; i < 14; i++) {
      const x = (i + 0.5) * (W / 14);
      const r = 4 + ((i * 37) % 5) + Math.sin(st.t * 2 + i) * 1.2;
      cd.addCircle(x, surfaceYAt(st, x, W, H, false) + 1, r);
    }
    creamDotsPath.value = cd;

    // ── 泡 (液中のみ。輪郭 + ハイライトの 2 path に集約) ──
    const bp = Skia.Path.Make();
    const bh = Skia.Path.Make();
    for (let i = 0; i < st.bubbles.length; i++) {
      const b = st.bubbles[i]!;
      if (b.y < surfaceYAt(st, b.x, W, H, false)) continue;
      bp.addCircle(b.x, b.y, b.r);
      bh.addCircle(b.x - b.r * 0.35, b.y - b.r * 0.35, b.r * 0.35);
    }
    bubblePath.value = bp;
    bubbleHiPath.value = bh;

    // ── 飛沫 ──
    const dp = Skia.Path.Make();
    for (let i = 0; i < st.droplets.length; i++) {
      const p = st.droplets[i]!;
      dp.addCircle(p.x, p.y, p.r * Math.min(1, p.life * 1.5));
    }
    dropletPath.value = dp;

    // ── あふれ覆い (§2.3) ──
    foamAlpha.value = st.foamAlpha;
    if (st.fizzState === 0) {
      foamBodyPath.value = Skia.Path.Make();
      foamBlobPath.value = Skia.Path.Make();
      foamRingPath.value = Skia.Path.Make();
    } else {
      const edge = st.foamEdge;
      const edgeY = (x: number) =>
        edge +
        10 * Math.sin(x * 0.03 + st.t * 5) +
        4 * Math.sin(x * 0.011 - st.t * 3.2);
      const fb = Skia.Path.Make();
      fb.moveTo(-4, edgeY(0));
      for (let x = 0; x <= W + SURF_STEP; x += SURF_STEP) fb.lineTo(x, edgeY(x));
      fb.lineTo(W + 4, H + 4);
      fb.lineTo(-4, H + 4);
      fb.close();
      foamBodyPath.value = fb;

      // 前縁の blob 列 (本体と同色 + BlurMask で融合 = 疑似メタボール)
      const blobs = Skia.Path.Make();
      if (edge > -(GLASS_TUNING.fizzCoverOvershoot + 5)) {
        for (let i = 0; i < FOAM_EDGE_BLOBS; i++) {
          const x = (i + 0.5) * (W / FOAM_EDGE_BLOBS);
          const r = 10 + ((i * 37) % 16) + Math.sin(st.t * 3 + i * 2) * 3;
          blobs.addCircle(x, edgeY(x) + 2, r);
        }
      }
      foamBlobPath.value = blobs;

      // 内部の泡テクスチャ (前線と同じ速度で上に流れ続ける — §2.3-3)
      const rings = Skia.Path.Make();
      const span = H + 140;
      for (let i = 0; i < FOAM_SEEDS.length; i++) {
        const s = FOAM_SEEDS[i]!;
        const y = ((s.y * span + span - (st.foamScroll % span)) % span) - 70;
        if (y < edge + 30 || y > H + 20) continue;
        rings.addCircle(s.x * W, y, s.r + Math.sin(st.t * 2 + s.p) * 2);
      }
      foamRingPath.value = rings;
    }
  }, active);

  // 退避: 設定 off / reduce-motion / センサー不可 → 既存背景の静的版 (§2.4)
  if (!active) {
    return <MelonSodaBackground static />;
  }

  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill} testID="glass-layer">
      <Canvas style={StyleSheet.absoluteFill}>
        {/* 1. グラス上部 (液面より上) — ごく薄いソーダ色 */}
        <Rect x={0} y={0} width={W} height={H}>
          <LinearGradient
            start={vec(0, 0)}
            end={vec(0, H)}
            colors={[flavor.skyTop, flavor.skyBottom]}
          />
        </Rect>
        {/* 2. ガラスのハイライト (静的、控えめ) */}
        <RoundedRect
          x={W * 0.1}
          y={-20}
          width={W * 0.045}
          height={H + 40}
          r={24}
          color="rgba(255,255,255,0.20)"
        />
        <RoundedRect
          x={W * 0.17}
          y={-20}
          width={W * 0.016}
          height={H + 40}
          r={16}
          color="rgba(255,255,255,0.14)"
        />
        {/* 3. 液体本体 (5-stop palette 由来 3 stop、背後の UI を透かす) */}
        <Path path={liquidPath}>
          <LinearGradient
            start={vec(0, H * 0.25)}
            end={vec(0, H)}
            colors={[flavor.liquidTop, flavor.liquidMid, flavor.liquidBottom]}
            positions={[0, 0.45, 1]}
          />
        </Path>
        {/* 4. 底の深み (下層ほど暗い) */}
        <Path path={liquidPath}>
          <LinearGradient
            start={vec(0, H * 0.55)}
            end={vec(0, H)}
            colors={["transparent", flavor.deepShadow]}
          />
        </Path>
        {/* 5. 炭酸の泡 (§2.2 — 世界座標上向き) */}
        <Path
          path={bubblePath}
          style="stroke"
          strokeWidth={1.1}
          color={flavor.bubbleStroke}
        />
        <Path path={bubbleHiPath} color={flavor.bubbleFill} />
        {/* 6. 液面のクリーム帯 */}
        <Path path={creamPath} color={flavor.cream} />
        <Path path={creamDotsPath} color={flavor.creamBubble} />
        {/* 7. 壁際の飛沫 */}
        <Path path={dropletPath} color={flavor.droplet} />
        {/* 8. あふれ覆い (§2.3 — 前線 + 疑似メタボール前縁 + 内部テクスチャ) */}
        <Group opacity={foamAlpha}>
          <Path path={foamBodyPath}>
            <LinearGradient
              start={vec(0, 0)}
              end={vec(0, H)}
              colors={[flavor.foamTop, flavor.foamBottom]}
            />
          </Path>
          <Path path={foamBlobPath} color={flavor.foamTop}>
            <BlurMask blur={5} style="solid" />
          </Path>
          <Path
            path={foamRingPath}
            style="stroke"
            strokeWidth={2}
            color={flavor.foamRing}
          />
        </Group>
      </Canvas>
    </View>
  );
}
