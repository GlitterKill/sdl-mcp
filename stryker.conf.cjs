/**
 * Stryker mutation testing config.
 *
 * Notes:
 * - Keep scope intentionally small for CI/dev ergonomics.
 * - Uses Node's built-in test runner via a command.
 */
module.exports = {
  mutate: ["src/util/paths.ts"],
  testRunner: "command",
  commandRunner: {
    command: "node --import tsx --test tests/mutation/paths.mutation.test.ts",
  },
  reporters: ["clear-text", "progress"],
  coverageAnalysis: "off",
  disableTypeChecks: false,
  ignorePatterns: [
    "/.tmp",
    "/dist",
    "/dist-tests",
    "/native/target",
    "/data",
    "/benchmarks",
    "/docs",
  ],
};

