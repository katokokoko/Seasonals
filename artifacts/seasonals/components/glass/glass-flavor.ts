/**
 * glass-flavor — 液体演出のフレーバー (色) 導出 (Phase 8.36)
 *
 * Seasonals の theme catalog (stores/theme.ts) は最初から 5-stop の液体パレット
 * (ThemeBgPalette) を持っている。液体演出はこれを唯一のソースとして読むことで、
 * テーマ切替 = フレーバー切替 (季節テーマ、ハンドオフ §6) が追加コストゼロで成立する。
 * hex 直書きは中立色 (泡の輪郭・あふれ覆い) のみ (§6 規約の DS carve-out)。
 *
 * 8.44: 液面のクリーム帯は **palette.top を白に寄せた「飲み物の泡の色」** から導出する。
 * メロンソーダの泡は淡い緑白、ベリーなら淡いピンク白 — 実際の飲み物と同じく泡は
 * 中身の色を帯びる。暖色の乳白 (プロトタイプ由来 rgba(255,247,224)) は、8.42 で
 * 液面より上のソーダ色レイヤを撤去した結果、背景バニラ #FFF8E7 に埋もれてしまう
 * (ΔRGB 20)。かといって濃く/茶色くすると「濁った液体」に見えて泡に見えない。
 * 白に寄せつつ飲み物の色相を残すことで、清潔感を保ったまま暖色の背景から分離する。
 */

import { withAlpha } from "@workspace/lib/design-system";

import { useActiveTheme, type ThemeBgPalette } from "../../stores/theme";

/**
 * hex を白に寄せる (t=0 で元の色、t=1 で純白)。
 * 泡 = 「飲み物の色をごく薄くした白」を作るための内部ヘルパ。
 */
function towardWhite(hex: string, t: number): string {
  const h = hex.replace("#", "");
  const ch = [0, 2, 4].map((i) => {
    const v = parseInt(h.slice(i, i + 2), 16);
    return Math.round(v + (255 - v) * t);
  });
  return `#${ch.map((v) => v.toString(16).padStart(2, "0").toUpperCase()).join("")}`;
}

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
    // 8.44: 泡は palette.top (各フレーバーの一番淡い色) を白に寄せたもの。
    // cream_soda なら #B4F0C8 → 淡い緑白。合成結果は背景バニラと色相が違うので
    // 明度を落とさずに分離する。粒はさらに白く、帯の上で明るく浮かせる
    cream: withAlpha(towardWhite(p.top, 0.5), 0.95),
    creamBubble: withAlpha(towardWhite(p.top, 0.82), 0.92),
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
