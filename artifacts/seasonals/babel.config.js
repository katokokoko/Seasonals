/**
 * Babel config — Mobile (artifacts/seasonals)
 *
 * jest-expo preset が babel-jest を呼ぶ際にこの config を読む。
 * preset-expo は TypeScript / JSX / Expo Router を扱う公式 preset。
 *
 * 重要: react-native-reanimated/plugin は plugins 配列の **LAST** に置く必要がある
 * (worklet 変換が他 plugin の出力を読むため)。順序を変えると runtime crash する。
 */
module.exports = function (api) {
  api.cache(true);
  return {
    presets: ["babel-preset-expo"],
    plugins: ["react-native-reanimated/plugin"],
  };
};
