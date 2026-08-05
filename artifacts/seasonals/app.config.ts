/**
 * Expo app config (Phase 8.1 — env-aware variant)
 *
 * APP_VARIANT=onchain で:
 *   - android.package = "app.seasonals.onchain"
 *   - expo.name = "Seasonals (onchain)"
 *   - expo.extra.useOnchain = true (services/config.ts USE_ONCHAIN)
 *
 * APP_VARIANT 未設定 / 任意値:
 *   - 既存 "Seasonals" (app.seasonals.mobile) として build
 *   - useOnchain = false (BFF /positions を fixture で受ける従来動作)
 *
 * 両 variant とも同じ JS bundle / native module を使うため、`pnpm android` と
 * `pnpm android:onchain` で 2 つの APK を Seeker に並べて install できる。
 *
 * @see eas.json `onchain` profile
 * @see services/config.ts USE_ONCHAIN
 */

import type { ExpoConfig } from "expo/config";

const variant = process.env.APP_VARIANT;
const isOnchain = variant === "onchain";

const config: ExpoConfig = {
  name: isOnchain ? "Seasonals (onchain)" : "Seasonals",
  slug: "seasonals",
  version: "0.0.1",
  orientation: "portrait",
  scheme: "seasonals",
  userInterfaceStyle: "automatic",
  // 8.87: SDK 54 で New Architecture へ移行 (SDK 55 で legacy 廃止のため前倒し)。
  // 未指定 = newArch 有効が SDK 54 の既定
  icon: "./assets/images/icon.png",
  // Phase 8.45: edge-to-edge。バーを透明にしてアプリ描画領域を画面全体へ広げる。
  // translucent:true → styles.xml の android:statusBarColor = @android:color/transparent
  // barStyle:"dark-content" → windowLight{Status,Navigation}Bar = true (バニラ地に暗色アイコン)
  androidStatusBar: {
    translucent: true,
    barStyle: "dark-content",
  },
  // 8.87 (SDK 57): androidNavigationBar は ExpoConfig から削除された
  // (edge-to-edge 標準化により navigation bar は常に透過)。
  // バーアイコン色は with-edge-to-edge plugin の windowLight*Bar が引き続き担う
  // 8.87 (SDK 57): top-level splash は ExpoConfig から削除された。
  // splash 設定は下の expo-splash-screen plugin (backgroundColor #FFF8E7) が canonical
  android: {
    package: isOnchain ? "app.seasonals.onchain" : "app.seasonals.mobile",
    adaptiveIcon: {
      foregroundImage: "./assets/images/icon.png",
      backgroundColor: "#FFF8E7",
    },
  },
  ios: {
    bundleIdentifier: isOnchain
      ? "app.seasonals.onchain"
      : "app.seasonals.mobile",
    supportsTablet: false,
  },
  web: {
    favicon: "./assets/images/favicon.png",
  },
  plugins: [
    "expo-router",
    "expo-font",
    "expo-status-bar",
    "expo-secure-store",
    "expo-notifications",
    // 8.87 (SDK 54): 新 splash (SplashScreenManager) は logo drawable を必須参照する。
    // 画像なし backgroundColor のみだと splashscreen_logo 不在で resource link error
    [
      "expo-splash-screen",
      {
        backgroundColor: "#FFF8E7",
        image: "./assets/images/icon.png",
        imageWidth: 150,
      },
    ],
    // Phase 8.45: prebuild が書けない edge-to-edge 設定 (contrast scrim / cutout /
    // decorFitsSystemWindows / values-night) を再現可能にする
    "./plugins/with-edge-to-edge",
  ],
  experiments: {
    typedRoutes: false,
  },
  extra: {
    // services/config.ts USE_ONCHAIN が参照
    useOnchain: isOnchain,
    eas: {
      // 8.87: EAS プロジェクト紐付け (expo.dev で作成した seasonals プロジェクト)
      projectId: "6de0c8ab-80b1-491b-8317-cf8b48890496",
    },
  },
};

export default config;
