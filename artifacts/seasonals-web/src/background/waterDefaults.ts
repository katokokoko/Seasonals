import { perfOn, perfVariant } from "./perfVariant";

/**
 * Water background parameters (docs/web/water-background-spec.md "Component API").
 * 各値は shader uniform に 1:1 で対応する。見た目の調整は shader ではなくここで行う。
 */
export type WaterParams = {
  /** time multiplier, 1 = as tuned */
  speed: number;
  /** caustic cells per viewport height */
  scale: number;
  /** caustic brightness */
  caustic: number;
  refraction: number;
  /** 0 = soda blue, 1 = melon */
  tint: number;
  /** 0 = ignore UI rects, 1 = fully calm under them */
  quiet: number;
  /** liquid glass lens strength under `data-water-glass` surfaces (0 = off) */
  glass: number;
  /** device pixel ratio cap */
  maxDpr: number;
  /** 描画の上限 fps (0 = 画面の rate のまま)。発熱対策 1 (2026-10-06): 120 Hz の画面で毎フレーム全画面を描くと GPU が飽和する */
  maxFps: number;
  /** false = 静止画 (preset の切り替えと quiet zone の変化の時だけ描く)。発熱対策 2: 作業画面の水は静かなので動かさない */
  animate: boolean;
};

/** Home (lobby) — spec の既定値そのまま (shader at its full expression) */
export const waterDefaults: WaterParams = {
  speed: 1,
  scale: 4.5,
  caustic: 0.5,
  refraction: 0.012,
  tint: 0.5,
  // Home は 0.6 (2026-10-06、0.4 を試した後にユーザー指定): 0.85 だと列ごとに束ねた quiet zone が画面のほぼ全体を淡いミントの膜にしていた。
  // カレンダーは不透明、portal card は文字の下に vanilla の楕円があるので、強く静めなくても読める
  quiet: 0.6,
  glass: 1,
  maxDpr: 1.25,
  maxFps: 30,
  animate: true,
};

/**
 * Work screen 用の calm preset (UI v2 §2 "Work screens": 同じ shader を静かな設定で)。
 * shader spec に calm preset が無いため、ここ (waterDefaults) に追加した (WORKLOG #8)。
 * caustic を下げ、動きを遅くし、content 領域全体を quiet zone として完全に静める。
 */
export const waterCalm: WaterParams = {
  ...waterDefaults,
  speed: 0.6,
  caustic: 0.28,
  refraction: 0.008,
  quiet: 1,
  glass: 0.7,
  animate: false,
};

export function resolveWaterParams(params?: Partial<WaterParams>): WaterParams {
  const p = { ...waterDefaults, ...params };
  // dev の比較スイッチ (perfVariant.ts の ?water-perf=) で対策 1〜3 を個別に入れ切りする
  if (!perfVariant) return p;
  return {
    ...p,
    maxFps: perfOn(1) ? 30 : 0,
    animate: perfOn(2) ? p.animate : true,
    maxDpr: perfOn(3) ? 1 : 1.25,
  };
}
