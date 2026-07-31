/**
 * theme — isDarkBackground (Phase 8.45)
 *
 * edge-to-edge のシステムバーアイコン色をアクティブテーマから決めるための判定。
 * ThemeMeta に明暗フラグが無いため bgPrimary の相対輝度で導いており、
 * **全テーマで期待どおりに分岐すること**を固定する (誤ると時計が背景に埋もれる)。
 */
import { isDarkBackground, THEME_CATALOG } from "./theme";

describe("isDarkBackground", () => {
  it("Cream Soda のバニラ背景は明るい判定", () => {
    expect(isDarkBackground("#FFF8E7")).toBe(false);
  });

  it("Midnight Orchard の背景は暗い判定", () => {
    expect(isDarkBackground("#1E1130")).toBe(true);
  });

  it("純白 / 純黒", () => {
    expect(isDarkBackground("#FFFFFF")).toBe(false);
    expect(isDarkBackground("#000000")).toBe(true);
  });

  it("catalog の各テーマで判定が破綻しない (bool が返る)", () => {
    for (const theme of THEME_CATALOG) {
      expect(typeof isDarkBackground(theme.ui.bgPrimary)).toBe("boolean");
    }
    // 淡い背景の 3 テーマは明るい、Midnight Orchard だけ暗い
    const dark = THEME_CATALOG.filter((t) => isDarkBackground(t.ui.bgPrimary));
    expect(dark.map((t) => t.id)).toEqual(["midnight_orchard"]);
  });

  it("不正な文字列は明るい扱い (fail-safe: 暗色アイコン)", () => {
    expect(isDarkBackground("#abc")).toBe(false);
    expect(isDarkBackground("")).toBe(false);
  });
});
