/** @type {import("jest").Config} */
module.exports = {
  testEnvironment: "node",
  rootDir: ".",
  watchman: false,
  testMatch: ["<rootDir>/**/*.test.ts"],
  transform: {
    "^.+\\.ts$": ["ts-jest", { tsconfig: "<rootDir>/tsconfig.json" }]
  },
  moduleNameMapper: {
    "^@workspace/lib$": "<rootDir>/index.ts",
    "^@workspace/lib/(.*)$": "<rootDir>/$1"
  }
};
