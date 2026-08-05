const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");

const config = getDefaultConfig(projectRoot);

// monorepo で `@workspace/lib` を解決するための 2 点セット。
// watchFolders (既定に workspace root を追記) + nodeModulesPaths 2 段の
// どちらが欠けても emulator / Expo が lib/ を見つけられず bundle エラーになる
// (regression 禁止)。symlink 解決は Metro 0.80+ (SDK 54) で既定になったため
// unstable_enableSymlinks は 8.87 で削除した (expo-doctor も undefined を期待する)。
config.watchFolders = [...(config.watchFolders ?? []), workspaceRoot];

config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules")
];

module.exports = config;
