/**
 * glass-flavor — 液体演出のフレーバー (色) 導出 (Phase 8.36)
 *
 * Seasonals の theme catalog (stores/theme.ts) は最初から 5-stop の液体パレット
 * (ThemeBgPalette) を持っている。液体演出はこれを唯一のソースとして読むことで、
 * テーマ切替 = フレーバー切替 (季節テーマ、ハンドオフ §6) が追加コストゼロで成立する。
 * hex 直書きはクリーム (泡・あふれ) 系の中立色のみ (§6 規約の DS carve-out として
 * ここに集約 — 液体色は theme、泡は乳白で全テーマ共通)。
 */

import { withAlpha } from "@workspace/lib/design-system";

import { useActiveTheme, type ThemeBgPalette } from "../../stores/theme";

export interface GlassFlavor {
  /** 液体本体 3 stop (上→下、背後の UI がわずかに透ける alpha) */
  liquidTop: string;
  liquidMid: string;
  liquidBottom: string;
  /** 底の深み overlay (透明 → 濃) */
  deepShadow: string;
  /** 液面のクリーム帯 */
  cream: string;
  creamBubble: string;
  /** 泡 (輪郭 / ハイライト) */
  bubbleStroke: string;
  bubbleFill: string;
  /** 飛沫 */
  droplet: string;
  /** あふれ覆い (前線グラデ 2 stop + 内部泡テクスチャ) */
  foamTop: string;
  foamBottom: string;
  foamRing: string;
}

/** ThemeBgPalette → GlassFlavor (純関数、テスト可能) */
export function flavorFromPalette(p: ThemeBgPalette): GlassFlavor {
  return {
    // 液体は下層ほど濃く・彩度高く。~0.55-0.7 alpha で背後の bgPrimary を透かす
    // (「液越しに UI が見える」ハンドオフ §6 の深度表現)
    liquidTop: withAlpha(p.mid, 0.5),
    liquidMid: withAlpha(p.deep, 0.6),
    liquidBottom: withAlpha(p.bottom, 0.72),
    deepShadow: withAlpha(p.pool, 0.35),
    cream: "rgba(255, 247, 224, 0.92)",
    creamBubble: "rgba(255, 251, 236, 0.9)",
    bubbleStroke: "rgba(255, 255, 255, 0.55)",
    bubbleFill: "rgba(255, 255, 255, 0.35)",
    droplet: withAlpha(p.deep, 0.8),
    foamTop: "#FFFBF0",
    foamBottom: "#FFEFD2",
    foamRing: "rgba(240, 205, 150, 0.45)",
  };
}

/** active theme からフレーバーを導出する hook */
export function useGlassFlavor(): GlassFlavor {
  const { bgPalette } = useActiveTheme();
  return flavorFromPalette(bgPalette);
}
