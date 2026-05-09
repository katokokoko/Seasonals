/** @type {import("jest").Config} */
module.exports = {
  testEnvironment: "node",
  rootDir: ".",
  watchman: false,
  testMatch: ["<rootDir>/src/**/*.test.ts"],
  transform: {
    "^.+\\.ts$": ["ts-jest", { tsconfig: "<rootDir>/tsconfig.json" }],
  },
  moduleNameMapper: {
    "^@workspace/lib$": "<rootDir>/../../lib/index.ts",
    "^@workspace/lib/(.*)$": "<rootDir>/../../lib/$1",
  },
};
