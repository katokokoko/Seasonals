/**
 * GlassLayer — 画面全体を「クリームソーダのグラスの内側」に見立てる装飾レイヤ
 * (Phase 8.36、設計ハンドオフ §1-§7 / プロトタイプ seasonals-soda-tilt.html)
 *
 * 描画は @shopify/react-native-skia。物理積分 (glass-physics) は Reanimated の
 * useFrameCallback worklet 内で行い JS thread を経由しない。
 *
 * 8.81: 液面 / クリーム帯 / あふれ覆いは **SkSL fragment shader (GPU)** で描く
 * (liquid-shader.ts)。worklet は物理 + uniform 詰め替え + 泡・飛沫 path 2 本の
 * 再構築だけに縮小した。旧実装 (毎フレーム 9 path を CPU 構築) は Seeker 120Hz
 * でアイドル時 UI thread CPU 85% を占めていた。泡・飛沫は low tier (28/16) の
 * CPU path のまま。
 *
 * 装飾であって機能ではない (§1): pointerEvents="none" で touch 透過、
 * カレンダー可読性優先で液体 alpha は透過寄り。設定 Still / reduce-motion /
 * センサー不可のときは既存の MelonSodaBackground (static) へ、設定 Off なら
 * 何も描かずに退避する (§2.4 / 8.41 の backgroundMode 3 択)。
 *
 * 8.42/8.43: 全画面の薄緑 sky グラデとガラスのハイライト (白い縦筋) は撤去済。
 * 液面より上と半透明の液体越しに、アプリ本来の背景がそのまま見える。
 */

import React, { useCallback, useEffect, useMemo } from "react";
import { Dimensions, StyleSheet, View } from "react-native";
import {
  Canvas,
  Fill,
  Path,
  Shader,
  Skia,
} from "@shopify/react-native-skia";
import {
  runOnJS,
  useDerivedValue,
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
import {
  foamColorsFromFlavor,
  liquidColorsFromFlavor,
  makeFoamEffect,
  makeLiquidEffect,
  packFoamUniforms,
  packLiquidUniforms,
  type FoamDynamicUniforms,
  type LiquidDynamicUniforms,
} from "./liquid-shader";
import { useReduceMotion } from "./useReduceMotion";
import { TiltSensorBridge, useTiltRoll } from "./useTiltRoll";

const W = Dimensions.get("window").width;
const H = Dimensions.get("window").height;

function fireSloshHaptic(): void {
  Haptics.selectionAsync().catch(() => undefined);
}
function fireFizzHaptic(): void {
  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => undefined);
}

export function GlassLayer() {
  // 8.41: 背景 3 択 — liquid (本レイヤ) / static (静的ソーダ) / none (装飾なし)
  const mode = usePrefsStore((s) => s.backgroundMode);
  const liquidEnabled = mode === "liquid";
  const reduced = useReduceMotion();
  // 8.46: センサーは UI スレッド直結 (TiltSensorBridge)。senseActive の間だけ
  // mount してフォーカス外 / background で購読を止める
  const { roll, shake, available, senseActive, reportAvailable } = useTiltRoll(
    liquidEnabled && !reduced
  );
  const flavor = useGlassFlavor();

  // available === true になるまで静的退避 (未判定中に液体を一瞬出さない — F3)
  const active = liquidEnabled && !reduced && available === true;

  // 物理 state — 初期化は JS thread で 1 回だけ (Math.random 使用可)。
  // worklet から in-place 変異し、再レンダーには関与しない。
  // 8.81: 泡は low tier (28) — 形状生成が shader に移り、CPU path に残るのは
  // 泡・飛沫のみなので数も絞る (未配線だった bubbleCountLow の実配線)
  const initialState = useMemo(
    () => createGlassState(W, H, GLASS_TUNING.bubbleCountLow),
    []
  );
  const state = useSharedValue(initialState);

  // 描画出力 — 8.81: shader uniform 2 組 + CPU path 2 本 (泡・飛沫) に縮小
  const liquidDyn = useSharedValue<LiquidDynamicUniforms>(
    packLiquidUniforms(initialState, W, H)
  );
  const foamDyn = useSharedValue<FoamDynamicUniforms>(
    packFoamUniforms(initialState, W, H)
  );
  const bubblePath = useSharedValue(Skia.Path.Make());
  const bubbleHiPath = useSharedValue(Skia.Path.Make());
  const dropletPath = useSharedValue(Skia.Path.Make());

  // RuntimeEffect は JS thread で 1 回だけ compile
  const liquidEffect = useMemo(() => makeLiquidEffect(), []);
  const foamEffect = useMemo(() => makeFoamEffect(), []);

  // 色 uniform は theme 切替時のみ再計算し、動的 uniform と合成して Shader へ
  const liquidColors = useMemo(() => liquidColorsFromFlavor(flavor), [flavor]);
  const foamColors = useMemo(() => foamColorsFromFlavor(flavor), [flavor]);
  const liquidUniforms = useDerivedValue(
    () => ({ ...liquidDyn.value, ...liquidColors }),
    [liquidColors]
  );
  const foamUniforms = useDerivedValue(
    () => ({ ...foamDyn.value, ...foamColors }),
    [foamColors]
  );

  // F1: callback は useCallback で安定化し (毎レンダー再登録を防ぐ)、active の
  // 変化は返り値の setActive で追従する — useFrameCallback の第 2 引数 autostart
  // は reanimated 3.10 では初回登録時にしか効かないため (実装確認済)
  // 8.81: シミュレーション tick の累積時間 (60Hz 間引き用)
  const simAccMs = useSharedValue(0);

  const frameWorklet = useCallback((info: { timeSincePreviousFrame: number | null }) => {
    "worklet";
    // 8.81: 液体の物理 + uniform/path 更新は **60Hz に間引く**。
    // 120Hz 端末では毎フレーム redraw を焚くこと自体が UI thread の主コストで
    // (uniform 書き込み → Skia DOM 再記録が 1 write ごとに走る)、波の動きは
    // 60fps で視覚的に区別がつかない。表示・ジェスチャは 120Hz のまま。
    const dtMs = info.timeSincePreviousFrame ?? 16.7;
    simAccMs.value += dtMs;
    if (simAccMs.value < 15) return;
    const dt = Math.min(0.033, simAccMs.value / 1000);
    simAccMs.value = 0;
    const st = state.value;

    st.targetA = roll.value;
    st.shake = shake.value; // 8.47: 端末の揺さぶり → 泡あふれメーターの 2 系統目
    // 8.81: low tier cap を明示 (泡 28 / 飛沫 16 — 旧 60/36)
    stepGlass(
      st,
      dt,
      W,
      H,
      false,
      GLASS_TUNING.bubbleCountLow,
      GLASS_TUNING.dropletMaxLow
    );

    if (st.hapticSlosh) runOnJS(fireSloshHaptic)();
    if (st.hapticFizz) runOnJS(fireFizzHaptic)();

    // ── 液面 / クリーム帯 / あふれ覆いは shader (GPU)。uniform 詰め替えのみ ──
    liquidDyn.value = packLiquidUniforms(st, W, H);
    foamDyn.value = packFoamUniforms(st, W, H);

    // ── 泡 (液中のみ。輪郭 + ハイライトの 2 path に集約) ──
    // 8.81: クリーム帯が shader (下層) に移ったため、帯の下端より上の泡は
    // skip して「泡は帯の後ろに隠れる」旧描画順の見え方を保つ
    const fh = 11 + st.energy * 7;
    const bp = Skia.Path.Make();
    const bh = Skia.Path.Make();
    for (let i = 0; i < st.bubbles.length; i++) {
      const b = st.bubbles[i]!;
      if (b.y < surfaceYAt(st, b.x, W, H, false) + fh) continue;
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
    // 依存は全て安定参照 (sharedValue / module const) — callback は 1 回だけ登録される
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const frameCb = useFrameCallback(frameWorklet, false);
  useEffect(() => {
    frameCb.setActive(active);
  }, [active, frameCb]);

  // 8.46: センサー購読 (null render)。退避分岐より前に置き、available 未判定の
  // うちから登録を進める。senseActive=false なら mount されない = 購読停止
  const bridge = senseActive ? (
    <TiltSensorBridge
      roll={roll}
      shake={shake}
      onAvailable={reportAvailable}
    />
  ) : null;

  // 退避 (8.41): none = 背景装飾を一切描かない (うす緑も出さない)。
  // static / (liquid だが reduce-motion・センサー不可) → 静的ソーダ背景 (§2.4)。
  // 8.81: RuntimeEffect の compile 失敗 (想定外の SkSL 非互換) も静的側へ fail-safe
  if (!active || !liquidEffect || !foamEffect) {
    if (mode === "none") return bridge;
    return (
      <>
        {bridge}
        <MelonSodaBackground static />
      </>
    );
  }

  return (
    <>
      {bridge}
      <View pointerEvents="none" style={StyleSheet.absoluteFill} testID="glass-layer">
      <Canvas style={StyleSheet.absoluteFill}>
        {/* 1-2. 液体本体 + 底の深み + クリーム帯 (SkSL、8.81 — 旧 path 6 本分) */}
        <Fill>
          <Shader source={liquidEffect} uniforms={liquidUniforms} />
        </Fill>
        {/* 3. 炭酸の泡 (§2.2 — 世界座標上向き。CPU path、low tier 28) */}
        <Path
          path={bubblePath}
          style="stroke"
          strokeWidth={1.1}
          color={flavor.bubbleStroke}
        />
        <Path path={bubbleHiPath} color={flavor.bubbleFill} />
        {/* 4. 壁際の飛沫 (CPU path、low tier 16) */}
        <Path path={dropletPath} color={flavor.droplet} />
        {/* 5. あふれ覆い (§2.3 — SkSL。通常時は uAlpha=0 で即 transparent) */}
        <Fill>
          <Shader source={foamEffect} uniforms={foamUniforms} />
        </Fill>
      </Canvas>
      </View>
    </>
  );
}
