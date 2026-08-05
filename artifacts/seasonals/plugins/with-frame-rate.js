/**
 * with-frame-rate — liquid 120fps のための表示リフレッシュレート要求 (Phase 8.88)
 *
 * 背景 (実測 2026-08-05):
 *   RN 0.86 はアプリ surface に FrameRateCategory::Normal を投票し、Seeker では
 *   非タッチ時のパネルが 90Hz に落ちる (frameRateCategoryRate normal=60/high=90)。
 *   120Hz パネル上の 90fps は整数比でないためカクつきとして知覚される (user 報告)。
 *   liquid シェーダは半解像度化 (GlassLayer RES_DIVISOR=2) で 120Hz 予算に
 *   収まっているので、あとは表示側が 120Hz を維持すればよい。
 *
 * やること:
 *   MainActivity: window.attributes.preferredRefreshRate = パネル最高値。
 *   Window レベルの明示要求はカテゴリ投票より優先される。
 *   非 120Hz 端末では「その端末の最高値」を希望するだけで無害。
 *
 * with-edge-to-edge.js と同じく、prebuild --clean 再実行に対して冪等。
 */

const { withMainActivity } = require("@expo/config-plugins");

const MARKER = "// Phase 8.88: max refresh rate";

const withPreferredRefreshRate = (config) =>
  withMainActivity(config, (cfg) => {
    let src = cfg.modResults.contents;

    // 冪等: 既存の挿入を剥がしてから入れ直す
    src = src.replace(
      new RegExp(`\\n *${MARKER}[\\s\\S]*?// Phase 8\\.88 end`, "g"),
      ""
    );

    // アンカーは super.onCreate(null) (テンプレートに必ずある)。
    // 注意: mods は登録の逆順に走るため、with-edge-to-edge の挿入行 (decorFits)
    // はこの時点でまだ存在しない — それを前提にした実装にしないこと
    src = src.replace(
      /(super\.onCreate\(null\))/,
      `$1
    ${MARKER} — RN の省電力カテゴリ投票 (90Hz) を Window の明示要求で上書きする
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      val maxHz = display?.supportedModes?.maxOfOrNull { it.refreshRate } ?: 0f
      if (maxHz > 0f) {
        window.attributes = window.attributes.apply { preferredRefreshRate = maxHz }
      }
    }
    // Phase 8.88 end`
    );
    cfg.modResults.contents = src;
    return cfg;
  });

module.exports = function withFrameRate(config) {
  config = withPreferredRefreshRate(config);
  return config;
};
