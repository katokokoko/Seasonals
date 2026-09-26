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
};

/** Home (lobby) — spec の既定値そのまま (shader at its full expression) */
export const waterDefaults: WaterParams = {
  speed: 1,
  scale: 4.5,
  caustic: 0.5,
  refraction: 0.012,
  tint: 0.5,
  quiet: 0.85,
  glass: 1,
  maxDpr: 1.25,
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
};

export function resolveWaterParams(params?: Partial<WaterParams>): WaterParams {
  return { ...waterDefaults, ...params };
}
