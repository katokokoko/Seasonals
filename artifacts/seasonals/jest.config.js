/**
 * Mobile (artifacts/seasonals) — Jest config
 *
 * - jest-expo preset で React Native / Expo の transform を効かせる
 * - @workspace/lib/* は workspace 内の lib/ を直接読む (ts-jest 不要)
 * - jest.setup.js で expo-haptics 等の global mock を仕込む
 *
 * @see CLAUDE.md §5 / §8 (テスト規約)
 */

/** @type {import("jest").Config} */
module.exports = {
  preset: "jest-expo",
  rootDir: ".",
  testMatch: ["<rootDir>/**/*.test.{ts,tsx}"],
  // setupFiles はテストフレームワーク install 前に実行される。
  // jest.mock() は hoisting で問題なく動作する。
  // 8.81: RNGH 公式 jestSetup を追加 (jest-expo は含んでいない)。これが無いと
  // native module mock が入らず、fireGestureHandler のイベントが handler に届かない
  setupFiles: [
    "react-native-gesture-handler/jestSetup.js",
    "<rootDir>/jest.setup.js",
  ],
  // jest-expo / WarningArea の setTimeout 等の open handle があると Jest が
  // 1 秒待機して「did not exit」と警告する。CI hang 防止に forceExit。
  forceExit: true,
  moduleNameMapper: {
    "^@workspace/lib$": "<rootDir>/../../lib/index.ts",
    "^@workspace/lib/(.*)$": "<rootDir>/../../lib/$1",
  },
  // jest-expo (preset) の default transform regex は .mjs を含まない。
  // @solana/codecs-numbers などは React Native 向けに `.native.mjs` を export する
  // ため、明示的に .mjs / .cjs を babel-jest で transform 対象に含める。
  transform: {
    "^.+\\.(js|jsx|mjs|cjs|ts|tsx)$": "babel-jest",
  },
  // 全 node_modules を transform 対象にする (= 何も ignore しない)。
  // 理由: @solana/web3.js は uuid / jayson / @solana/codecs-* など ESM の transitive
  // dep が広範に渡り、許可リスト方式だとドミノ倒し的に拡張が必要になる。
  // 全 transform は初回のみ ~2s 増程度で、cache 後は追加コストほぼ無し。
  transformIgnorePatterns: [],
};
