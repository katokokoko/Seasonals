/**
 * React Native autolinking config — pnpm + Solana MWA 互換性のための manual declare
 *
 * 背景:
 *   `@solana-mobile/mobile-wallet-adapter-protocol` は package.json に
 *   `react-native.config.js` を持たず、autolink scanner が android/ ネイティブモジュール
 *   を検出できない (`npx react-native config` の dependencies に出てこない)。
 *
 *   この config で明示的に dep として宣言することで、Expo prebuild が
 *   MainApplication.kt に `SolanaMobileWalletAdapterPackage` を含めるようになる。
 *
 * 症状: 本 config なしで build した場合、ランタイムに以下の uncaught error がループする:
 *
 *     Invariant Violation: TurboModuleRegistry.getEnforcing(...):
 *     'SolanaMobileWalletAdapter' could not be found.
 *
 * @see CLAUDE.md §10 task #4 (MWA 接続)
 * @see CLAUDE.md §10 task #8 (Seed Vault 連携 = MWA 経由 = 本 config 必須)
 */
module.exports = {
  dependencies: {
    "@solana-mobile/mobile-wallet-adapter-protocol": {},
  },
};
