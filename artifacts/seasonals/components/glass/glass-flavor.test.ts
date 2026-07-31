/**
 * glass-flavor — 泡の色の導出 (Phase 8.44)
 *
 * 泡は「飲み物の色をごく薄くした白」。茶色く濁らせて背景から分離させようとして
 * 「汚い」と差し戻した経緯があるため、**明度を落とさない**ことを不変条件として固定する。
 */
import { flavorFromPalette } from "./glass-flavor";
import type { ThemeBgPalette } from "../../stores/theme";

const CREAM_SODA: ThemeBgPalette = {
  top: "#B4F0C8",
  mid: "#7DE1AF",
  deep: "#3CC382",
  bottom: "#0F6E4B",
  pool: "#084632",
};

/** "#RRGGBBAA" → [r,g,b] */
function rgb(color: string): [number, number, number] {
  const h = color.replace("#", "");
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [
    number,
    number,
    number,
  ];
}

describe("flavorFromPalette — 泡の色", () => {
  const f = flavorFromPalette(CREAM_SODA);

  it("クリーム帯は palette.top より白い (濁らせない)", () => {
    const top = rgb(CREAM_SODA.top);
    rgb(f.cream).forEach((v, i) => {
      expect(v).toBeGreaterThan(top[i]!); // 各チャンネルが白方向へ
      expect(v).toBeLessThanOrEqual(255);
    });
  });

  it("クリーム帯は飲み物の色相を残す (無彩色の白ではない)", () => {
    const [r, g, b] = rgb(f.cream);
    expect(g).toBeGreaterThan(r); // メロンなら緑が最も強い
    expect(g).toBeGreaterThan(b);
  });

  it("泡の粒は帯より明るい (帯の上で浮く)", () => {
    const band = rgb(f.cream);
    rgb(f.creamBubble).forEach((v, i) => {
      expect(v).toBeGreaterThan(band[i]!);
    });
  });

  it("液体は palette 由来のまま (泡の変更が液体に波及しない)", () => {
    expect(f.liquidTop.startsWith(CREAM_SODA.mid)).toBe(true);
    expect(f.liquidMid.startsWith(CREAM_SODA.deep)).toBe(true);
    expect(f.liquidBottom.startsWith(CREAM_SODA.bottom)).toBe(true);
  });
});
