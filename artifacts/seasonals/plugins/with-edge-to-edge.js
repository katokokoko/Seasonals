/**
 * with-edge-to-edge — Android を edge-to-edge にする config plugin (Phase 8.45)
 *
 * `app.config.ts` の `androidStatusBar` / `androidNavigationBar` だけでは足りない分を補う。
 * Expo の標準プラグインが書けるのは statusBarColor / navigationBarColor /
 * windowLight*Bar までで、以下は書けない:
 *
 *   1. android:enforce{Status,Navigation}BarContrast = false (API 29+)
 *      → これが無いと、バーを透明にしてもシステムが半透明スクリムを敷き、黒帯が薄く残る
 *   2. android:windowLayoutInDisplayCutoutMode = shortEdges
 *      → パンチホール (この端末は上端中央 120×78px) の領域まで描画を許可する
 *   3. MainActivity の WindowCompat.setDecorFitsSystemWindows(window, false)
 *      → **下端を広げる本体**。RN の StatusBar translucent は top inset しか 0 にしない
 *        (StatusBarModule.java の replaceSystemWindowInsets(left, 0, right, bottom)) ため、
 *        ナビゲーションバー分を取り戻すにはこれが要る
 *   4. values-night/styles.xml
 *      → ダークモード時の初期フレームでバーアイコンを白にする (JS の theme 追従が効く前)
 *
 * `android/` は git 管理下だが prebuild で再生成され得る (Phase 8.1 の前例)。
 * 直接編集ではなく本 plugin に置くことで、再生成しても同じ結果になる。
 */

const {
  withAndroidStyles,
  withMainActivity,
  withDangerousMod,
} = require("@expo/config-plugins");
const fs = require("fs");
const path = require("path");

/** AppTheme の <style> に item を足す (既存があれば値を上書き) */
function setStyleItem(styles, name, value, targetApi) {
  const app = styles.resources.style?.find((s) => s.$.name === "AppTheme");
  if (!app) return styles;
  app.item = app.item ?? [];
  const existing = app.item.find((i) => i.$.name === name);
  const attrs = { name };
  if (targetApi) attrs["tools:targetApi"] = targetApi;
  if (existing) {
    existing._ = value;
    Object.assign(existing.$, attrs);
  } else {
    app.item.push({ _: value, $: attrs });
  }
  return styles;
}

const withEdgeToEdgeStyles = (config) =>
  withAndroidStyles(config, (cfg) => {
    let styles = cfg.modResults;
    // 透明バーの上にシステムがスクリムを敷くのを止める (API 29+)
    styles = setStyleItem(styles, "android:enforceStatusBarContrast", "false", "29");
    styles = setStyleItem(styles, "android:enforceNavigationBarContrast", "false", "29");
    // パンチホール領域まで描く (API 27+)
    styles = setStyleItem(
      styles,
      "android:windowLayoutInDisplayCutoutMode",
      "shortEdges",
      "27"
    );
    cfg.modResults = styles;
    return cfg;
  });

/**
 * MainActivity.onCreate に setDecorFitsSystemWindows(false) を挿入。
 *
 * **`super.onCreate()` の後**に置くこと。前に置くと ReactActivityDelegate の
 * setContentView がビューツリーを組み直す際に打ち消され、実機で無効になる
 * (Phase 8.45 で実測: 前置きだと上下ともインセットが残ったまま)。
 */
const withDecorFitsSystemWindows = (config) =>
  withMainActivity(config, (cfg) => {
    let src = cfg.modResults.contents;

    // 既存の挿入があれば一旦剥がす (位置を移すため。prebuild の再実行に対して冪等)
    src = src.replace(
      /\n *\/\/ Phase 8\.45:[^\n]*\n *WindowCompat\.setDecorFitsSystemWindows\(window, false\)/g,
      ""
    );

    if (!src.includes("import androidx.core.view.WindowCompat")) {
      src = src.replace(
        "import android.os.Bundle",
        "import android.os.Bundle\nimport androidx.core.view.WindowCompat"
      );
    }
    src = src.replace(
      /(super\.onCreate\(null\))/,
      "$1\n    // Phase 8.45: edge-to-edge — コンテンツをシステムバーの裏まで広げる\n    WindowCompat.setDecorFitsSystemWindows(window, false)"
    );
    cfg.modResults.contents = src;
    return cfg;
  });

/**
 * values-night/styles.xml は **作らない**。
 *
 * Android のリソース解決では `values-night/styles.xml` に同名 `AppTheme` を書くと
 * light 側の style を **マージではなく丸ごと置換**するため、透明バーの指定
 * (statusBarColor / navigationBarColor / enforce*Contrast) が全部消える。
 * 実際 Phase 8.45 でこれをやって、ダークモード端末だけ灰色ステータスバー +
 * 黒ナビゲーションバーが残る現象を踏んだ。
 *
 * そもそも Seasonals のテーマは**端末のダークモードではなくユーザー選択**
 * (stores/theme.ts) なので、system の night 修飾子で分岐させるのは誤り。
 * ネイティブ側は default テーマ (Cream Soda = 明るい背景 → 暗色アイコン) に
 * 合わせておき、テーマ切替への追従は _layout.tsx の StatusBar.setBarStyle が担う。
 */
const removeNightBarStyles = (config) =>
  withDangerousMod(config, [
    "android",
    async (cfg) => {
      const f = path.join(
        cfg.modRequest.platformProjectRoot,
        "app/src/main/res/values-night/styles.xml"
      );
      if (fs.existsSync(f)) fs.rmSync(f);
      return cfg;
    },
  ]);

module.exports = function withEdgeToEdge(config) {
  config = withEdgeToEdgeStyles(config);
  config = withDecorFitsSystemWindows(config);
  config = removeNightBarStyles(config);
  return config;
};
