const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");

const config = getDefaultConfig(projectRoot);

// monorepo で `@workspace/lib` を解決するための 3 点セット。
// watchFolders + nodeModulesPaths 2 段 + symlink 解決のどれが欠けても
// emulator / Expo が lib/ を見つけられず bundle エラーになる (regression 禁止)。
config.watchFolders = [workspaceRoot];

config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules")
];

config.resolver.unstable_enableSymlinks = true;

module.exports = config;
