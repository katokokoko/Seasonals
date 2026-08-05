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
import { Canvas, Fill, Shader } from "@shopify/react-native-skia";
import {
  runOnJS,
  useDerivedValue,
  useFrameCallback,
  useSharedValue,
} from "react-native-reanimated";
import * as Haptics from "expo-haptics";

import { MelonSodaBackground } from "../decorative/MelonSodaBackground";
import { usePrefsStore } from "../../stores/prefs";
import { GLASS_TUNING, createGlassState, stepGlass } from "./glass-physics";
import { useGlassFlavor } from "./glass-flavor";
import {
  glassColorsFromFlavor,
  makeGlassEffect,
  packGlassUniforms,
  type GlassDynamicUniforms,
} from "./liquid-shader";
import { useReduceMotion } from "./useReduceMotion";
import { TiltSensorBridge, useTiltRoll } from "./useTiltRoll";

const W = Dimensions.get("window").width;
const H = Dimensions.get("window").height;

// 8.88: liquid は 1/2 解像度で描き view の scale で全画面に拡大する (採用済)。
// 根拠 (実測 2026-08-05): フル解像度の全画面 SkSL は GPU 中央値 9ms で 120Hz 予算
// (8.3ms) を超え 68〜87fps に落ちるが、半解像度 (画素 1/4) なら 119〜120fps に
// 張り付く。画質差は液体内部のエッジがわずかに柔らかくなるのみ (ズーム比較で
// 確認、UI レイヤーは無影響) — user 確認済み「許容範囲内」。
// 1 に戻すとフル解像度 (画質優先・90fps 上限) になる
const RES_DIVISOR = 2;

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

  // 描画出力 — 8.82: 単一 shader の uniform 1 組のみ (path sharedValue は全廃)
  const glassDyn = useSharedValue<GlassDynamicUniforms>(
    packGlassUniforms(initialState, W, H, RES_DIVISOR)
  );

  // RuntimeEffect は JS thread で 1 回だけ compile
  const glassEffect = useMemo(() => makeGlassEffect(), []);

  // 色 uniform は theme 切替時のみ再計算し、動的 uniform と合成して Shader へ
  const glassColors = useMemo(() => glassColorsFromFlavor(flavor), [flavor]);
  const glassUniforms = useDerivedValue(
    () => ({ ...glassDyn.value, ...glassColors }),
    [glassColors]
  );

  // F1: callback は useCallback で安定化し (毎レンダー再登録を防ぐ)、active の
  // 変化は返り値の setActive で追従する — useFrameCallback の第 2 引数 autostart
  // は reanimated 3.10 では初回登録時にしか効かないため (実装確認済)
  const frameWorklet = useCallback((info: { timeSincePreviousFrame: number | null }) => {
    "worklet";
    // 8.82: tick は毎フレーム (Seeker では 120Hz)。8.81 の 60Hz 間引きは、
    // Canvas を Fill 1 node に縮小して tick 単価を下げたことで撤去した
    const dtMs = info.timeSincePreviousFrame ?? 16.7;
    const dt = Math.min(0.033, dtMs / 1000);
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

    // ── 描画はすべて shader (GPU)。CPU は uniform 詰め替え 1 回のみ ──
    glassDyn.value = packGlassUniforms(st, W, H, RES_DIVISOR);
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
  if (!active || !glassEffect) {
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
      <Canvas
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          width: W / RES_DIVISOR,
          height: H / RES_DIVISOR,
          // 縮小 canvas を左上原点で拡大して全画面に敷く (低解像度レンダ)
          transformOrigin: "0% 0%",
          transform: [{ scale: RES_DIVISOR }],
        }}
      >
        {/* 8.82: 全描画を単一 SkSL に統合 (液体 + 泡 + クリーム帯 + 飛沫 + あふれ)。
            Canvas を Fill 1 node にすることで tick ごとの再記録を最小化する */}
        <Fill>
          <Shader source={glassEffect} uniforms={glassUniforms} />
        </Fill>
      </Canvas>
      </View>
    </>
  );
}
